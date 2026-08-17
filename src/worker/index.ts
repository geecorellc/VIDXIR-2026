/**
 * The worker process (§10, §31).
 *
 * A separate process from the web server, because §10 forbids running long jobs
 * inside an HTTP request and because a render must not be killed by a deploy of
 * the frontend. Started with `npm run worker`.
 *
 * Responsibilities of the harness in this file, as opposed to the handlers:
 *
 *  - Mirror every state change into the `jobs` table, so the UI can see work that
 *    Redis has already trimmed (§45).
 *  - Decide what is worth retrying. A rate limit is; a missing API key is not.
 *    Retrying an unconfigurable job forever is how a queue silently fills.
 *  - Shut down gracefully. `SIGTERM` stops accepting new jobs and lets in-flight
 *    ones finish, because a half-completed pipeline stage is worse than a slow
 *    deploy.
 *
 * Handlers are registered per queue and the harness knows nothing about them.
 */
import { Worker, type Job } from "bullmq";
import { closeDb } from "@/lib/db";
import { isAppError } from "@/lib/errors";
import { logger, newTraceId } from "@/lib/logger";
import { closeQueues, workerQueueOptions, type QueueName } from "@/lib/queue/queues";
import {
  markJobFailed,
  markJobRunning,
  markJobSucceeded,
} from "@/lib/queue/jobs";
import { closeRedis, workerConnection } from "@/lib/queue/redis";
import { RESEARCH_JOB_NAME } from "@/lib/research/service";
import { SCRIPT_JOB_NAME } from "@/lib/scripts/service";
import { researchHandler } from "@/worker/handlers/research";
import { scriptHandler } from "@/worker/handlers/script";
import { videoHandlers } from "@/worker/handlers/video";
import type { JobHandler } from "@/worker/types";

const log = logger.child({ component: "worker" });

/** Handlers by queue, then by job name. */
const HANDLERS: Partial<Record<QueueName, Record<string, JobHandler>>> = {
  research: {
    [RESEARCH_JOB_NAME]: researchHandler,
  },
  pipeline: {
    [SCRIPT_JOB_NAME]: scriptHandler,
    // Scene plan through render. Each stage enqueues the next, so all seven land
    // on this queue rather than on one queue per stage.
    ...videoHandlers,
  },
};

/**
 * Concurrency per queue.
 *
 * `research` is low because it is YouTube-quota bound, not CPU bound — running
 * twenty concurrent runs would exhaust a day's quota in a minute. `publish` is 1
 * deliberately: a duplicated upload cannot be undone.
 */
const CONCURRENCY: Record<QueueName, number> = {
  research: 3,
  pipeline: 4,
  publish: 1,
  analytics: 2,
  maintenance: 2,
};

function process_(queue: QueueName) {
  return async (job: Job): Promise<Record<string, unknown> | void> => {
    const handlers = HANDLERS[queue] ?? {};
    const handler = handlers[job.name];

    // The row id is the BullMQ job id (see `enqueue`), with the payload copy as
    // a fallback for a job enqueued by an older build.
    const jobId =
      typeof job.data?.["jobId"] === "string" ? job.data["jobId"] : job.id;

    if (!jobId) {
      // Nothing to correlate this to. Fail loudly rather than doing work whose
      // outcome cannot be recorded anywhere the user can see.
      throw new Error(`Job ${job.name} has no id.`);
    }

    if (!handler) {
      const error = new Error(
        `No handler registered for ${queue}/${job.name}.`,
      );
      await markJobFailed(jobId, error);
      throw error;
    }

    const traceId = newTraceId();
    const attempt = job.attemptsMade + 1;
    const startedAt = Date.now();

    await markJobRunning(jobId, attempt, "Starting");

    log.info("job started", {
      jobId,
      traceId,
      queue,
      name: job.name,
      attempt,
      status: "running",
    });

    try {
      const result = await handler({
        jobId,
        payload: (job.data ?? {}) as Record<string, unknown>,
        traceId,
        attempt,
      });

      await markJobSucceeded(jobId, result ?? {}, "Complete");

      log.info("job succeeded", {
        jobId,
        traceId,
        queue,
        name: job.name,
        attempt,
        status: "succeeded",
        durationMs: Date.now() - startedAt,
      });

      return result ?? undefined;
    } catch (error) {
      const retryable = shouldRetry(error);
      const attemptsLeft = attempt < (job.opts.attempts ?? 1);
      const willRetry = retryable && attemptsLeft;

      await markJobFailed(jobId, error, { willRetry });

      log.error("job failed", {
        jobId,
        traceId,
        queue,
        name: job.name,
        attempt,
        status: willRetry ? "retrying" : "failed",
        durationMs: Date.now() - startedAt,
        retryable,
        error,
      });

      if (!retryable) {
        // Tell BullMQ not to schedule another attempt. Without this a
        // permanently-broken job — a missing API key, a malformed payload —
        // burns its full retry budget for nothing. `discard()` is synchronous: it
        // sets a flag the worker reads when the throw below propagates.
        job.discard();
      }

      throw error;
    }
  };
}

/**
 * Whether another attempt could plausibly succeed.
 *
 * `AppError.retryable` carries the provider-specific judgement (429 yes, 401
 * no). A plain `Error` from unexpected code is treated as retryable once,
 * because the common cause is a transient network fault; the attempt limit stops
 * it from looping.
 */
function shouldRetry(error: unknown): boolean {
  if (isAppError(error)) return error.retryable;
  if (error instanceof Error && "retryable" in error) {
    return Boolean((error as { retryable?: unknown }).retryable);
  }
  return true;
}

const workers: Worker[] = [];

function start(): void {
  for (const queue of Object.keys(HANDLERS) as QueueName[]) {
    const worker = new Worker(queue, process_(queue), {
      connection: workerConnection(),
      concurrency: CONCURRENCY[queue],
      ...workerQueueOptions(),
    });

    worker.on("error", (error) => {
      // Worker-level errors are infrastructure (Redis dropped, script failure),
      // distinct from a job that failed. They must not be silent.
      log.error("worker error", { queue, error });
    });

    workers.push(worker);
    log.info("worker listening", { queue, concurrency: CONCURRENCY[queue] });
  }

  if (workers.length === 0) {
    log.warn("no queues registered — worker has nothing to do");
  }
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("worker shutting down", { signal });

  // `close()` without force lets in-flight jobs finish. A stage killed mid-flight
  // would leave a project stuck between states, which is exactly what §20's
  // persisted state machine exists to avoid.
  await Promise.allSettled(workers.map((w) => w.close()));
  await closeQueues();
  await closeRedis();
  await closeDb();

  log.info("worker stopped", { signal });
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection in worker", { error: reason });
});

start();

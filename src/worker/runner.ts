/**
 * The job harness: what happens around every handler (§10, §20, §30, §31).
 *
 * Split out of `worker/index.ts` so it can be exercised directly. That file
 * constructs BullMQ `Worker`s at import time, so importing it from a test starts
 * consuming the real queue — which is how a test suite ends up racing a
 * developer's worker for the same messages.
 *
 * Responsibilities here, as opposed to in the handlers:
 *
 *  - Mirror every state change into the `jobs` table, so the UI can see work that
 *    Redis has already trimmed (§45).
 *  - Decide what is worth retrying. A rate limit is; a missing API key is not.
 *    Retrying an unconfigurable job forever is how a queue silently fills.
 *  - Resolve the durable row id, which is what every log line and API response
 *    correlates on.
 */
import { AppError, isAppError } from "@/lib/errors";
import { logger, newTraceId } from "@/lib/logger";
import {
  markJobFailed,
  markJobRunning,
  markJobSucceeded,
} from "@/lib/queue/jobs";
import type { QueueName } from "@/lib/queue/queues";
import type { JobHandler } from "@/worker/types";

const log = logger.child({ component: "worker" });

/**
 * The part of a BullMQ `Job` the harness uses.
 *
 * Structural rather than the real class, so a test can drive the harness with a
 * plain object and assert that `discard()` was called. Every field here is
 * present on a real `Job` with the same meaning.
 */
export interface RunnableJob {
  id?: string | undefined;
  name: string;
  data?: Record<string, unknown> | undefined;
  attemptsMade: number;
  opts: { attempts?: number | undefined };
  /** Tells BullMQ not to schedule another attempt. */
  discard(): void;
}

/** What the harness decided, for callers that need to assert on it. */
export interface RunOutcome {
  jobId: string;
  status: "succeeded" | "failed" | "retrying";
  result?: Record<string, unknown> | undefined;
}

/**
 * Whether another attempt could plausibly succeed.
 *
 * `AppError.retryable` carries the provider-specific judgement (429 yes, 401
 * no). A plain `Error` from unexpected code is treated as retryable once, because
 * the common cause is a transient network fault; the attempt limit stops it from
 * looping. Anything that is *known* to be permanent — a malformed payload, a
 * missing job row, an unregistered handler — must therefore be thrown as a typed
 * `AppError`, or it burns the full retry budget on a certainty.
 */
export function shouldRetry(error: unknown): boolean {
  if (isAppError(error)) return error.retryable;
  if (error instanceof Error && "retryable" in error) {
    return Boolean((error as { retryable?: unknown }).retryable);
  }
  return true;
}

/**
 * Resolve the durable `jobs` row id for a message.
 *
 * The BullMQ job id *is* the row id (see `enqueue`), with the payload copy as a
 * fallback for a job enqueued by an older build.
 */
export function resolveJobId(job: RunnableJob): string | null {
  const fromPayload = job.data?.["jobId"];
  if (typeof fromPayload === "string" && fromPayload.length > 0) {
    return fromPayload;
  }
  return job.id ?? null;
}

/**
 * Run one job through the harness.
 *
 * Rethrows on failure, because BullMQ decides a job failed by observing the
 * throw. The returned outcome is for the success path and for tests.
 */
export async function runJob(
  queue: QueueName,
  handlers: Record<string, JobHandler>,
  job: RunnableJob,
): Promise<RunOutcome> {
  const handler = handlers[job.name];
  const jobId = resolveJobId(job);

  if (!jobId) {
    // Nothing to correlate this to. Fail loudly rather than doing work whose
    // outcome cannot be recorded anywhere the user can see. Not retryable: the
    // message will never grow an id.
    job.discard();
    throw new AppError({
      code: "validation_failed",
      message: `Job ${job.name} has no id.`,
      retryable: false,
    });
  }

  if (!handler) {
    /**
     * Explicitly not retryable. The handler set is fixed at boot, so waiting
     * cannot conjure one; the real causes are a message from a newer build than
     * this worker, or a job name that was removed. Retrying either only delays
     * the failure the operator needs to see.
     */
    const error = new AppError({
      code: "internal_error",
      message: `No handler registered for ${queue}/${job.name}.`,
      retryable: false,
    });
    await markJobFailed(jobId, error);
    job.discard();
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

    return { jobId, status: "succeeded", result: result ?? undefined };
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
      // permanently-broken job — a missing API key, a malformed payload — burns
      // its full retry budget for nothing. `discard()` is synchronous: it sets a
      // flag the worker reads when the throw below propagates.
      job.discard();
    }

    throw error;
  }
}

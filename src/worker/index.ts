/**
 * The worker process (§10, §31).
 *
 * A separate process from the web server, because §10 forbids running long jobs
 * inside an HTTP request and because a render must not be killed by a deploy of
 * the frontend. Started with `npm run worker`.
 *
 * This file is deliberately only process wiring — connect, register, shut down.
 * What happens around a handler lives in `worker/runner.ts` and which handler
 * runs what lives in `worker/registry.ts`, both of which are importable without
 * starting to consume the queue.
 *
 * Graceful shutdown matters here: `SIGTERM` stops accepting new jobs and lets
 * in-flight ones finish, because a half-completed pipeline stage is worse than a
 * slow deploy.
 */
// First, and before anything that reads `env()`. Next loads `.env.local` itself;
// a `tsx` process does not, so without this the worker boots with an empty
// environment and dies on the first required variable — or worse, silently runs
// with mock providers while the web app uses real ones.
import "@/lib/load-env";
import { Worker, type Job } from "bullmq";
import { closeDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import { closeQueues, workerQueueOptions, type QueueName } from "@/lib/queue/queues";
import { closeRedis, workerConnection } from "@/lib/queue/redis";
import { CONCURRENCY, HANDLERS } from "@/worker/registry";
import { runJob } from "@/worker/runner";

const log = logger.child({ component: "worker" });

const workers: Worker[] = [];

function start(): void {
  for (const queue of Object.keys(HANDLERS) as QueueName[]) {
    const handlers = HANDLERS[queue] ?? {};

    const worker = new Worker(
      queue,
      // A real BullMQ `Job` satisfies `RunnableJob` structurally; the narrower
      // interface is what lets the harness be driven from a test.
      async (job: Job) => (await runJob(queue, handlers, job)).result,
      {
        connection: workerConnection(),
        concurrency: CONCURRENCY[queue],
        ...workerQueueOptions(),
      },
    );

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

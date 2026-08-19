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
import { readiness } from "@/lib/health";
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

/**
 * Crash visibility (§15, §22).
 *
 * An uncaught exception exits, and does so through the logger rather than Node's
 * default stderr dump — which would bypass redaction and produce a line no log
 * aggregator can parse. Exiting is deliberate: after an uncaught throw the
 * process state is unknown, and a worker that keeps pulling jobs in an unknown
 * state fails them one by one until the retry limits are gone. Better to die and
 * be restarted; BullMQ returns the in-flight job to the queue when the lock
 * lapses, and the durable `jobs` row means nothing disappears.
 *
 * `close(true)` forces, unlike the graceful path: the state that made this
 * unsafe to continue also makes it unsafe to wait.
 */
process.on("uncaughtException", (error) => {
  log.error("uncaught exception in worker, exiting", { error });
  void Promise.allSettled(workers.map((w) => w.close(true))).finally(() => {
    process.exit(1);
  });
});

process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection in worker, exiting", {
    error: reason instanceof Error ? reason : new Error(String(reason)),
  });
  void Promise.allSettled(workers.map((w) => w.close(true))).finally(() => {
    process.exit(1);
  });
});

/**
 * Dependency preflight before consuming anything (§10, §16, §22).
 *
 * Without this the worker starts happily against an unreachable Postgres and
 * discovers it one job at a time — each job leaving a `failed` row and burning an
 * attempt, so a dependency outage that lasted a minute arrives as a batch of
 * permanently-failed work an operator has to find and requeue by hand. Checking
 * once at boot turns that into a single legible log line.
 *
 * `worker` mode is the right question here: unlike the web tier, this process
 * cannot do anything at all without both Redis and Postgres, so Redis counts as a
 * hard failure rather than a degradation.
 *
 * Not fatal. A supervisor restarting a worker into an outage produces a crash
 * loop, and BullMQ's own reconnect handles a Redis blip better than a restart
 * does — so this reports loudly and starts anyway, having made the cause visible.
 */
async function preflight(): Promise<void> {
  try {
    const report = await readiness("worker");
    if (report.status === "ready") {
      log.info("worker preflight ok", { mode: report.mode });
      return;
    }
    log.error("worker preflight not ready — starting anyway", {
      mode: report.mode,
      // Names and statuses only; `detail` strings name capabilities and unset
      // variables, never values.
      checks: report.checks
        .filter((check) => check.status !== "ok")
        .map((check) => `${check.name}=${check.status}`),
    });
  } catch (error) {
    // `readiness()` itself throwing means `env()` rejected the configuration,
    // which is worth surfacing before the first job rather than inside it.
    log.error("worker preflight failed", { error });
  }
}

void preflight().finally(() => {
  start();
});

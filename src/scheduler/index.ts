/**
 * Scheduler process (§19, §31).
 *
 * A separate process from the web tier, because §19 is explicit: automation must
 * not depend on the user's browser being open. Anything time-driven runs here.
 *
 * Session pruning, channel stats, analytics ingestion (which since Phase 9 also
 * re-evaluates running thumbnail tests), and — since Phase 7 — the automation
 * engine, which chooses a topic and starts a video on the user's cadence.
 *
 * Design notes:
 *  - Tasks are plain async functions on fixed intervals, not cron expressions.
 *    Everything here is "every N minutes"; a cron parser would be ceremony.
 *  - A task that throws is logged and the loop continues. One channel with a
 *    dead grant must not stop the other channels' refreshes.
 *  - Overlap is prevented twice over. The in-process `Set` stops a slow pass from
 *    stacking behind itself; a Redis lock stops a *second replica* from running
 *    the same task on the same tick. The second guard is what makes running two
 *    schedulers safe, which is in turn what makes a rolling restart safe.
 *    `runAutomationTick` was already independently safe — it claims each channel's
 *    slot with a conditional UPDATE — and keeps that claim regardless.
 */
import "@/lib/load-env";
import { closeDb } from "@/lib/db";
import { readiness } from "@/lib/health";
import { logger } from "@/lib/logger";
import { acquireLock, type Lock } from "@/lib/queue/lock";
import { closeRedis } from "@/lib/queue/redis";

const log = logger.child({ component: "scheduler" });
import { TASKS } from "./tasks";
type Task = typeof TASKS[number];

const timers: NodeJS.Timeout[] = [];
/** Tasks currently mid-run, so a slow pass cannot overlap itself. */
const running = new Set<string>();

async function runTask(task: Task): Promise<void> {
  // First guard: this process is already mid-pass.
  if (running.has(task.name)) {
    log.warn("task still running, skipping this tick", { task: task.name });
    return;
  }

  // Second guard: another replica is mid-pass. Acquired *before* marking the
  // task as running locally, so a Redis outage cannot leave a permanent local
  // flag; and released in the same `finally`, so a thrown task frees it.
  let lock: Lock | null;
  try {
    lock = await acquireLock(`scheduler:${task.name}`, {
      ttlMs: task.lockTtlMs,
    });
  } catch (error) {
    /**
     * Redis is unreachable. Skip rather than fail open.
     *
     * The rate limiter fails *open* because rejecting logins during a cache blip
     * would turn a degraded cache into an outage. The trade-off inverts here:
     * every task in this file is periodic and idempotent, so a skipped tick costs
     * a few minutes of lateness, while an unguarded tick across two replicas
     * doubles YouTube quota spend — and quota, unlike a delay, does not come back.
     */
    log.error("could not reach the lock service, skipping tick", {
      task: task.name,
      error,
    });
    return;
  }
  if (!lock) {
    log.info("task claimed by another scheduler, skipping tick", {
      task: task.name,
    });
    return;
  }

  running.add(task.name);
  const startedAt = Date.now();
  try {
    await task.run();
    log.debug("task finished", {
      task: task.name,
      durationMs: Date.now() - startedAt,
      status: "ok",
    });
  } catch (error) {
    log.error("task failed", {
      task: task.name,
      durationMs: Date.now() - startedAt,
      status: "error",
      error,
    });
  } finally {
    running.delete(task.name);
    // Released even on failure: a failed pass must not block the next one, which
    // is §11's "a failed job does not permanently block the schedule".
    await lock.release();
  }
}

function start(): void {
  log.info("scheduler starting", { tasks: TASKS.map((t) => t.name) });

  for (const task of TASKS) {
    const kick = () => {
      void runTask(task);
      timers.push(setInterval(() => void runTask(task), task.everyMs));
    };
    if (task.delayMs) {
      timers.push(setTimeout(kick, task.delayMs));
    } else {
      kick();
    }
  }
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  // A second SIGTERM during the drain must not start a second drain, which would
  // close Redis under the first one.
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("scheduler shutting down", { signal });
  for (const timer of timers) clearInterval(timer);
  // Let an in-flight pass finish rather than tearing the connection out from
  // under it; a partial analytics write is harder to reason about than a wait.
  const deadline = Date.now() + 15_000;
  while (running.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await closeRedis().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

/**
 * Crash visibility (§15, §22).
 *
 * Node's default for an uncaught exception is to print to stderr and exit — the
 * exit is right, the unstructured print is not: it bypasses the redaction in
 * `lib/logger`, and in a log-aggregated deployment an unparseable line is a line
 * nobody alerts on. So both handlers log through the logger and then exit
 * deliberately.
 *
 * Exiting rather than continuing is the point. After an uncaught exception the
 * process state is unknown, and a scheduler that keeps ticking in an unknown
 * state is how a task starts half-completing on every pass. A supervisor restarts
 * it; the Redis locks it held expire on their own.
 */
process.on("uncaughtException", (error) => {
  log.error("uncaught exception, exiting", { error });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection, exiting", {
    error: reason instanceof Error ? reason : new Error(String(reason)),
  });
  process.exit(1);
});

/**
 * Dependency preflight (§11, §16, §22).
 *
 * Same reasoning as the worker's, with one addition specific to here: every task
 * takes a Redis lock before doing anything, so with Redis unreachable this
 * process ticks forever, fails to acquire on every pass, and logs "lock held
 * elsewhere" at debug — a scheduler that has silently stopped scheduling. One
 * error line at boot is the difference between diagnosing that in a minute and
 * discovering it when a user asks why automation stopped.
 *
 * Reports rather than exits, for the same reason: a restart loop into an outage
 * helps nobody, and the tasks recover on their own once the dependency returns.
 */
async function preflight(): Promise<void> {
  try {
    const report = await readiness("worker");
    if (report.status === "ready") {
      log.info("scheduler preflight ok", { mode: report.mode });
      return;
    }
    log.error("scheduler preflight not ready — starting anyway", {
      mode: report.mode,
      checks: report.checks
        .filter((check) => check.status !== "ok")
        .map((check) => `${check.name}=${check.status}`),
    });
  } catch (error) {
    log.error("scheduler preflight failed", { error });
  }
}

void preflight().finally(() => {
  start();
});

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
import { runAutomationTick } from "@/lib/automation/service";
// Not `@/lib/auth/session`: that module carries `server-only` for its cookie
// access, and this process is plain Node. See the note in session-maintenance.
import { pruneSessions } from "@/lib/auth/session-maintenance";
import { channelsNeedingStatsRefresh, refreshChannelStats } from "@/lib/channels/service";
import {
  defaultWindow,
  ingestChannelAnalytics,
} from "@/lib/channels/analytics";
import {
  concludeExperiment,
  runningExperimentIds,
} from "@/lib/analytics/experiments";
import { isAppError } from "@/lib/errors";
import { closeRedis } from "@/lib/queue/redis";

const log = logger.child({ component: "scheduler" });

const MINUTE = 60_000;

interface Task {
  name: string;
  everyMs: number;
  /** Wait this long after boot before the first run. */
  delayMs?: number;
  /**
   * Lock lifetime. Sized to the task's own worst case, since it is also the delay
   * before a crashed replica's work is retried: a short TTL recovers fast but
   * risks lapsing mid-pass, and the heartbeat in `lib/queue/lock` is what lets
   * these stay short.
   */
  lockTtlMs: number;
  run: () => Promise<void>;
}

/** Stats older than this are refreshed. */
const STATS_TTL_MS = 6 * 60 * MINUTE;

const TASKS: Task[] = [
  {
    name: "prune-sessions",
    everyMs: 60 * MINUTE,
    delayMs: MINUTE,
    lockTtlMs: 2 * MINUTE,
    run: async () => {
      const deleted = await pruneSessions();
      if (deleted > 0) log.info("sessions pruned", { deleted });
    },
  },
  {
    name: "refresh-channel-stats",
    everyMs: 30 * MINUTE,
    delayMs: 10_000,
    // Up to 50 channels, each a YouTube round trip.
    lockTtlMs: 10 * MINUTE,
    run: async () => {
      const stale = await channelsNeedingStatsRefresh(
        new Date(Date.now() - STATS_TTL_MS),
      );
      for (const channel of stale) {
        try {
          await refreshChannelStats(channel.userId, channel.id);
        } catch (error) {
          // A channel awaiting re-authorisation is expected, not exceptional:
          // refreshChannelStats has already recorded it on the row, and the user
          // sees a reconnect prompt. Logged at info so it does not read as a bug.
          const expected =
            isAppError(error) && error.code === "oauth_reauth_required";
          const level = expected ? "info" : "warn";
          log[level]("channel stats refresh skipped", {
            userId: channel.userId,
            channelId: channel.id,
            errorCode: isAppError(error) ? error.code : "unknown",
            ...(expected ? {} : { error }),
          });
        }
      }
      if (stale.length > 0) {
        log.info("channel stats pass complete", { considered: stale.length });
      }
    },
  },
  {
    /**
     * The automation engine (§19).
     *
     * Every five minutes, which sets the worst-case lateness of a scheduled video:
     * a slot at 18:00 starts by 18:05. A finer interval would poll Postgres for
     * nothing, and a coarser one makes "18:00" a claim Tally does not keep.
     *
     * `runAutomationTick` handles per-channel failures internally, so nothing here
     * needs a try/catch beyond `runTask`'s.
     */
    name: "automation",
    everyMs: 5 * MINUTE,
    delayMs: 20_000,
    // Shorter than the interval, so a lapsed lock cannot stall the next tick.
    // The per-channel CAS remains the actual correctness guarantee here.
    lockTtlMs: 4 * MINUTE,
    run: async () => {
      await runAutomationTick();
    },
  },
  {
    name: "ingest-analytics",
    everyMs: 6 * 60 * MINUTE,
    delayMs: 2 * MINUTE,
    // The longest pass: up to 200 channels of YouTube Analytics, then every
    // running experiment. This is the task whose duplication costs quota.
    lockTtlMs: 30 * MINUTE,
    run: async () => {
      // Same candidate set as the stats refresh: connected, not awaiting re-auth.
      // A wider window would waste quota on channels that cannot answer.
      const candidates = await channelsNeedingStatsRefresh(new Date(), 200);
      const window = defaultWindow(new Date());
      for (const channel of candidates) {
        try {
          await ingestChannelAnalytics(channel.userId, channel.id, window);
        } catch (error) {
          log.warn("analytics ingest failed", {
            userId: channel.userId,
            channelId: channel.id,
            errorCode: isAppError(error) ? error.code : "unknown",
            error,
          });
        }
      }

      /**
       * Re-check running thumbnail tests in the same pass (Phase 9 §11).
       *
       * Folded in here rather than given its own task: the decision reads the
       * observations this pass just refreshed, so a separate interval would either
       * duplicate the work or evaluate stale numbers. `concludeExperiment` only
       * closes a test that has cleared the policy — an `insufficient_data` result
       * leaves it running, so this is safe to call every pass.
       */
      const experiments = await runningExperimentIds();
      for (const experiment of experiments) {
        try {
          await concludeExperiment(experiment.userId, experiment.id);
        } catch (error) {
          log.warn("experiment evaluation failed", {
            userId: experiment.userId,
            channelId: experiment.channelId,
            errorCode: isAppError(error) ? error.code : "unknown",
            error,
          });
        }
      }
      if (experiments.length > 0) {
        log.info("thumbnail experiments evaluated", {
          considered: experiments.length,
        });
      }
    },
  },
];

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

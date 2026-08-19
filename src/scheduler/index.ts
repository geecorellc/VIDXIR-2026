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
 *  - Overlap is prevented per task, so a slow ingest cannot stack up behind
 *    itself and multiply quota spend. That guard is *per process*, which is why
 *    `runAutomationTick` does not rely on it: it claims each channel's slot with
 *    a conditional UPDATE, so two schedulers cannot both start the same video.
 */
import "@/lib/load-env";
import { closeDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import { runAutomationTick } from "@/lib/automation/service";
import { pruneSessions } from "@/lib/auth/session";
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
  run: () => Promise<void>;
}

/** Stats older than this are refreshed. */
const STATS_TTL_MS = 6 * 60 * MINUTE;

const TASKS: Task[] = [
  {
    name: "prune-sessions",
    everyMs: 60 * MINUTE,
    delayMs: MINUTE,
    run: async () => {
      const deleted = await pruneSessions();
      if (deleted > 0) log.info("sessions pruned", { deleted });
    },
  },
  {
    name: "refresh-channel-stats",
    everyMs: 30 * MINUTE,
    delayMs: 10_000,
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
    run: async () => {
      await runAutomationTick();
    },
  },
  {
    name: "ingest-analytics",
    everyMs: 6 * 60 * MINUTE,
    delayMs: 2 * MINUTE,
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
  if (running.has(task.name)) {
    log.warn("task still running, skipping this tick", { task: task.name });
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

async function shutdown(signal: string): Promise<void> {
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

start();

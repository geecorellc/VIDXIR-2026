import { logger } from "@/lib/logger";
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

export const TASKS: Task[] = [
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
     * nothing, and a coarser one makes "18:00" a claim Vidxir AI does not keep.
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

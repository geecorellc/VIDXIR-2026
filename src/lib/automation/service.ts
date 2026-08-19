/**
 * The automation engine (§19).
 *
 * This is what makes Tally an automation platform rather than a set of buttons: on
 * a schedule, with no browser open, it picks the highest-scoring idea a channel's
 * research produced and starts a video from it.
 *
 * **Idempotency is the whole problem.** The scheduler's in-process `running` set
 * stops a task overlapping *itself*; it says nothing about a second scheduler
 * process, a restart mid-tick, or two ticks racing after a slow database call. And
 * the failure mode is not a wasted cycle — it is two projects, two script
 * generations and two videos billed against one slot. So the claim is made in
 * Postgres, not in memory:
 *
 *     UPDATE automation_settings
 *        SET next_run_at = <recomputed>, last_run_at = now()
 *      WHERE channel_id = ? AND next_run_at IS [NOT] DISTINCT FROM <observed>
 *
 * A compare-and-swap on the value the caller read. Exactly one of two racing
 * processes gets `rowCount = 1`; the loser gets 0 and skips the channel. The claim
 * is committed *before* any project is created, so a crash between the two loses a
 * slot rather than duplicating one — the safe direction, since a missed video is
 * visible and recoverable and a duplicate upload is neither.
 *
 * A second guard sits behind it: `hasActiveJob` for the script job, and a check for
 * an unfinished automation project on the channel. Those catch the case the CAS
 * cannot — a slot legitimately claimed hours ago whose video is still rendering.
 *
 * What this file does **not** do: it does not publish. `level: "autopilot"` and
 * `autoPublish` decide whether the *finished* video publishes itself, and that
 * decision is made at the end of the pipeline where a rendered file and a chosen
 * thumbnail actually exist. Here the job is to start work.
 */
import { and, asc, desc, eq, inArray, isNull, isNotNull, lte, ne, or } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  automationSettings,
  channelSettings,
  channels,
  ideas,
  projects,
} from "@/lib/db/schema";
import { isAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { assertCanStartVideo, currentTier } from "@/lib/plans/enforce";
import { planByTier, type PlanTier } from "@/lib/plans";
import { createProject } from "@/lib/projects/service";
import { hasActiveJob } from "@/lib/queue/jobs";
import { SCRIPT_JOB_NAME, startScriptGeneration } from "@/lib/scripts/service";
import { cadenceIsRunnable, nextSlot, safeZone } from "@/lib/automation/cadence";

const log = logger.child({ component: "automation" });

/** Channels considered per tick. A ceiling, not a target. */
const MAX_CHANNELS_PER_TICK = 50;

/**
 * Statuses that mean "this channel already has automation work in flight".
 *
 * Everything except the two terminal-ish ends: PUBLISHED is done, and FAILED is
 * done-and-visible — a failed automation project must not block the next
 * scheduled video for ever, or one bad run silently ends a channel's automation.
 */
const IN_FLIGHT_STATUSES = [
  "IDEA",
  "SCRIPT_GENERATING",
  "SCRIPT_READY",
  "ASSETS_GENERATING",
  "ASSETS_READY",
  "RENDERING",
  "VIDEO_READY",
  "THUMBNAIL_GENERATING",
  "READY_TO_PUBLISH",
  "SCHEDULED",
  "PUBLISHING",
] as const;

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface AutomationCandidate {
  channelId: string;
  userId: string;
  level: "manual" | "assisted" | "autopilot";
  publishDays: number[];
  publishTimes: string[];
  timezone: string;
  videosPerWeek: number;
  autoPublish: boolean;
  requireApproval: boolean;
  /** The value the CAS will compare against. Null means "never computed". */
  nextRunAt: Date | null;
  lastRunAt: Date | null;
}

/**
 * Channels whose automation is due.
 *
 * `next_run_at IS NULL` counts as due. That is not an accident of the query:
 * `updateAutomation` nulls the column on every cadence edit precisely so the
 * scheduler recomputes it, and treating null as "not due" would mean a user who
 * changed their schedule never ran again.
 *
 * Disconnected channels are excluded, and so are channels awaiting re-authorisation
 * — starting a video for a channel that cannot publish it spends AI and render
 * budget on something the user must fix first.
 */
export async function dueChannels(
  now: Date,
  limit = MAX_CHANNELS_PER_TICK,
): Promise<AutomationCandidate[]> {
  return db
    .select({
      channelId: automationSettings.channelId,
      userId: automationSettings.userId,
      level: automationSettings.level,
      publishDays: automationSettings.publishDays,
      publishTimes: automationSettings.publishTimes,
      timezone: automationSettings.timezone,
      videosPerWeek: automationSettings.videosPerWeek,
      autoPublish: automationSettings.autoPublish,
      requireApproval: automationSettings.requireApproval,
      nextRunAt: automationSettings.nextRunAt,
      lastRunAt: automationSettings.lastRunAt,
    })
    .from(automationSettings)
    .innerJoin(channels, eq(channels.id, automationSettings.channelId))
    .where(
      and(
        eq(automationSettings.enabled, true),
        // Both predicates on the join: the settings row's own tenant column and
        // the channel's. They cannot disagree, and requiring both means a future
        // bug that made them disagree fails closed.
        eq(channels.userId, automationSettings.userId),
        isNull(channels.disconnectedAt),
        isNull(channels.reauthRequiredAt),
        or(
          isNull(automationSettings.nextRunAt),
          /**
           * `lte`, not a `sql` template.
           *
           * A raw template has no column to map the parameter through, so a `Date`
           * reaches postgres.js unconverted and the statement dies at Bind with
           * `The "string" argument must be of type string ... Received an instance
           * of Date` — on *every* call, whatever the rows contain. `lte` runs the
           * value through the column's own `mapToDriverValue`, which is the same
           * conversion the rest of the file's `eq(...)` predicates already rely on.
           */
          lte(automationSettings.nextRunAt, now),
        ),
      ),
    )
    // Oldest claim first, so a backlog drains in order rather than one channel
    // starving the rest. Nulls first: a channel whose schedule was just changed
    // has been waiting since the change.
    .orderBy(asc(automationSettings.nextRunAt), asc(automationSettings.channelId))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export interface AutomationTickResult {
  considered: number;
  started: number;
  skipped: number;
  failed: number;
}

/**
 * One pass of the automation engine. Registered as a scheduler task.
 *
 * Every channel is independent: one with a dead grant, an exhausted plan or no
 * ideas must not stop the others, so each is wrapped and logged rather than
 * allowed to abort the pass (§19).
 */
export async function runAutomationTick(
  now = new Date(),
): Promise<AutomationTickResult> {
  const candidates = await dueChannels(now);
  const result: AutomationTickResult = {
    considered: candidates.length,
    started: 0,
    skipped: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    try {
      const outcome = await runForChannel(candidate, now);
      if (outcome.started) result.started += 1;
      else result.skipped += 1;
    } catch (error) {
      result.failed += 1;
      /**
       * A failure here has already had its slot claimed, so the channel does not
       * retry immediately — it waits for its next cadence slot. That is
       * deliberate: a channel failing every tick because its plan is exhausted
       * would otherwise re-attempt every minute for the rest of the month.
       */
      log.warn("automation run failed for channel", {
        userId: candidate.userId,
        channelId: candidate.channelId,
        errorCode: isAppError(error) ? error.code : "unknown",
        error,
      });
    }
  }

  if (candidates.length > 0) {
    log.info("automation pass complete", { ...result });
  }
  return result;
}

export interface ChannelRunOutcome {
  started: boolean;
  /** Why nothing was started. Null when a project was created. */
  reason: string | null;
  projectId?: string;
  jobId?: string;
}

/**
 * Claim a channel's slot, then start one video.
 *
 * Public so an integration test can exercise a single channel, and so a future
 * "run automation now" action has a seam. Not reachable from an API route today.
 */
export async function runForChannel(
  candidate: AutomationCandidate,
  now = new Date(),
): Promise<ChannelRunOutcome> {
  const zone = safeZone(candidate.timezone);
  if (zone !== candidate.timezone) {
    log.warn("unrecognised automation timezone, using UTC", {
      userId: candidate.userId,
      channelId: candidate.channelId,
    });
  }

  const cadence = {
    publishDays: candidate.publishDays,
    publishTimes: candidate.publishTimes,
    timezone: zone,
  };

  /**
   * A cadence with no days or no times can never fire. The slot is *not* claimed
   * — there is nothing to recompute it to, and writing null would leave the
   * channel permanently due, logging on every tick.
   */
  if (!cadenceIsRunnable(cadence)) {
    log.warn("automation enabled with an empty cadence", {
      userId: candidate.userId,
      channelId: candidate.channelId,
    });
    return { started: false, reason: "empty_cadence" };
  }

  /**
   * The claim, before any work. Whoever wins this UPDATE owns the slot; everyone
   * else moves on. `nextRunAt` recomputed from `now` rather than from the claimed
   * slot, so a scheduler that was down for a day resumes at the next real slot
   * instead of firing once per missed slot to catch up.
   */
  const claimed = await claimSlot(candidate, nextSlot(cadence, now), now);
  if (!claimed) {
    // The overwhelmingly common cause is a concurrent scheduler, which is exactly
    // what the CAS is for. Debug rather than warn: it is the mechanism working.
    log.debug("automation slot already claimed", {
      userId: candidate.userId,
      channelId: candidate.channelId,
    });
    return { started: false, reason: "slot_taken" };
  }

  /**
   * A project still in flight from a previous slot. The CAS cannot see this — that
   * slot was claimed legitimately — and starting a second video would mean two
   * concurrent pipelines on one channel, racing on `hasActiveJob` for every stage.
   */
  const inFlight = await inFlightProject(candidate.userId, candidate.channelId);
  if (inFlight) {
    log.info("automation skipped: a video is still in progress", {
      userId: candidate.userId,
      channelId: candidate.channelId,
      projectId: inFlight,
    });
    return { started: false, reason: "video_in_progress" };
  }

  if (await hasActiveJob(candidate.userId, candidate.channelId, SCRIPT_JOB_NAME)) {
    return { started: false, reason: "script_job_active" };
  }

  /**
   * The plan limit, checked before the project exists rather than after. A
   * PlanLimitError is not a bug and not retryable — the channel simply waits for
   * the month to roll over — so it is a skip, not a failure.
   */
  const tier = await currentTier(candidate.userId);
  try {
    await assertCanStartVideo(candidate.userId, tier);
  } catch (error) {
    if (isAppError(error) && error.code === "plan_limit_reached") {
      log.info("automation skipped: monthly video allowance used", {
        userId: candidate.userId,
        channelId: candidate.channelId,
        tier,
      });
      return { started: false, reason: "plan_limit_reached" };
    }
    throw error;
  }

  const idea = await bestIdea(candidate.userId, candidate.channelId);
  if (!idea) {
    /**
     * No idea to make. Not an error: research runs on its own schedule, and a new
     * channel legitimately has nothing yet. The slot has already moved on, so the
     * channel tries again next slot by which time research may have run.
     */
    log.info("automation skipped: no scored idea available", {
      userId: candidate.userId,
      channelId: candidate.channelId,
    });
    return { started: false, reason: "no_idea" };
  }

  return startVideoFor(candidate, idea, tier);
}

/**
 * Create the project and queue its script.
 *
 * `createProject` marks the idea `used` in the same transaction that creates the
 * project, so a crash between the two cannot leave an idea consumed by a project
 * that does not exist — or, worse, re-offer an idea a video was already made from.
 */
async function startVideoFor(
  candidate: AutomationCandidate,
  idea: { id: string; title: string },
  tier: PlanTier,
): Promise<ChannelRunOutcome> {
  const preferred = await preferredLength(candidate.userId, candidate.channelId);

  let project;
  try {
    project = await createProject({
      userId: candidate.userId,
      channelId: candidate.channelId,
      title: idea.title,
      ideaId: idea.id,
      origin: "automation",
      targetDurationSeconds: preferred,
      // Enforced atomically inside the transaction. It matters more here than on
      // the manual path: automation for several channels of one user can tick
      // simultaneously, so the pre-check above is genuinely racy (§13).
      maxVideosPerMonth: planByTier(tier).maxVideosPerMonth,
    });
  } catch (error) {
    /**
     * The atomic claim refused. Reachable when two of this user's channels fire
     * on the same tick and the last allowance slot goes to the other one — the
     * pre-check above passed for both.
     *
     * Reported as a skip, matching the pre-check's own handling: an exhausted
     * allowance is a state, not a fault, and counting it as `failed` would make
     * the pass metrics say something broke when nothing did.
     */
    if (isAppError(error) && error.code === "plan_limit_reached") {
      log.info("automation skipped: allowance claimed by a concurrent start", {
        userId: candidate.userId,
        channelId: candidate.channelId,
        tier,
      });
      return { started: false, reason: "plan_limit_reached" };
    }
    throw error;
  }

  try {
    const { jobId } = await startScriptGeneration({
      userId: candidate.userId,
      projectId: project.id,
      tier,
      traceId: project.traceId,
    });

    log.info("automation started a video", {
      userId: candidate.userId,
      channelId: candidate.channelId,
      projectId: project.id,
      ideaId: idea.id,
      jobId,
      level: candidate.level,
    });

    return { started: true, reason: null, projectId: project.id, jobId };
  } catch (error) {
    /**
     * The project exists and its script could not be queued.
     * `startScriptGeneration` has already recorded FAILED on it, so the user sees
     * a project they can retry rather than a silently missing video. Rethrown so
     * the tick counts it as a failure.
     */
    log.error("automation could not queue the script", {
      userId: candidate.userId,
      channelId: candidate.channelId,
      projectId: project.id,
      error,
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

/**
 * Compare-and-swap the slot. True when this process won it.
 *
 * `IS NOT DISTINCT FROM` rather than `=`, because the observed value is legitimately
 * null — `updateAutomation` writes null on every cadence change — and `null = null`
 * is null in SQL, so an equality predicate would never match the exact case the
 * engine most needs to claim.
 *
 * `nextRunAt` may be null on the way out too, when the cadence has no reachable
 * slot inside the search window. That leaves the channel due, which is correct: it
 * will be reconsidered and skipped by `cadenceIsRunnable` with a log line, rather
 * than silently disabled.
 */
async function claimSlot(
  candidate: AutomationCandidate,
  next: Date | null,
  now: Date,
): Promise<boolean> {
  const updated = await db
    .update(automationSettings)
    .set({ nextRunAt: next, lastRunAt: now, updatedAt: now })
    .where(
      and(
        eq(automationSettings.channelId, candidate.channelId),
        eq(automationSettings.userId, candidate.userId),
        // Still enabled: a user who switched automation off between the read and
        // the claim must not get one more video.
        eq(automationSettings.enabled, true),
        candidate.nextRunAt === null
          ? isNull(automationSettings.nextRunAt)
          : and(
              isNotNull(automationSettings.nextRunAt),
              eq(automationSettings.nextRunAt, candidate.nextRunAt),
            ),
      ),
    )
    .returning({ channelId: automationSettings.channelId });

  return updated.length > 0;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** An unfinished project on this channel, or null. */
async function inFlightProject(
  userId: string,
  channelId: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.userId, userId),
        eq(projects.channelId, channelId),
        inArray(projects.status, [...IN_FLIGHT_STATUSES]),
      ),
    )
    .orderBy(desc(projects.createdAt))
    .limit(1);

  return rows[0]?.id ?? null;
}

/**
 * The highest-scoring unused idea for a channel.
 *
 * Ordered by the Tally Opportunity Score, which is the whole point of §8: the
 * engine picks by the score the research pass computed, not by recency. An idea
 * with no score is excluded rather than sorted last — an unscored idea means
 * scoring did not complete, and automating on it would make a video from something
 * the system never judged.
 *
 * `used` and `rejected` are excluded. `saved` is included: a user marking an idea
 * saved is expressing preference for it, not withdrawing it from automation.
 */
async function bestIdea(
  userId: string,
  channelId: string,
): Promise<{ id: string; title: string } | null> {
  const rows = await db
    .select({ id: ideas.id, title: ideas.title })
    .from(ideas)
    .where(
      and(
        eq(ideas.userId, userId),
        eq(ideas.channelId, channelId),
        ne(ideas.state, "used"),
        ne(ideas.state, "rejected"),
        isNotNull(ideas.tallyScore),
      ),
    )
    .orderBy(desc(ideas.tallyScore), desc(ideas.createdAt))
    .limit(1);

  return rows[0] ?? null;
}

/** The channel's target video length, seeded onto the project like the UI does. */
async function preferredLength(
  userId: string,
  channelId: string,
): Promise<number | null> {
  const rows = await db
    .select({ seconds: channelSettings.preferredLengthSeconds })
    .from(channelSettings)
    .where(
      and(
        eq(channelSettings.channelId, channelId),
        eq(channelSettings.userId, userId),
      ),
    )
    .limit(1);

  return rows[0]?.seconds ?? null;
}

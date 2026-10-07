/**
 * Thumbnail A/B testing (Phase 9 §8-§10).
 *
 * An experiment attaches to an **already-published video** — a `published_videos`
 * row, which only exists once YouTube confirmed the upload (§42). Before that
 * there are no impressions to measure, so a "test" on a draft project would be a
 * test of nothing.
 *
 * What this module deliberately does *not* do:
 *
 *  - **It does not generate thumbnails.** Arms reference existing
 *    `thumbnail_variants` rows produced by the Phase 6/6a pipeline. There is no
 *    second render path (§8).
 *  - **It does not swap production thumbnails.** Declaring a winner records a
 *    decision; applying it to YouTube is a separate, explicit act by the user.
 *    Silently replacing a live thumbnail because a number moved is exactly what §8
 *    forbids.
 *  - **It does not accept a winner, a CTR, or an arm assignment from a client.**
 *    Assignment is derived server-side from the arm's stored `position`; the
 *    winner is derived server-side from stored observations. §9 requires that a
 *    caller cannot select itself into the winning arm, so no request field here
 *    influences either.
 *  - **It does not claim significance it has not got.** The decision policy has
 *    minimum impressions, minimum observation days and a minimum relative lift,
 *    and the outcome vocabulary includes `insufficient_data` and `tie` precisely
 *    so a 12-impression difference is never reported as a result (§10).
 *
 * Totals are recomputed from `thumbnail_experiment_observations` rather than
 * incremented, so re-ingesting a day converges instead of inflating (§5).
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { atomic } from "@/lib/db/atomic";
import {
  publishedVideos,
  thumbnailExperimentArms,
  thumbnailExperimentObservations,
  thumbnailExperiments,
  thumbnailVariants,
  thumbnails,
} from "@/lib/db/schema";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { MetricSource } from "@/lib/channels/analytics";

const log = logger.child({ component: "thumbnail-experiments" });

// ---------------------------------------------------------------------------
// Decision policy
// ---------------------------------------------------------------------------

export interface DecisionPolicy {
  /** Impressions each arm needs before it is comparable at all. */
  minImpressionsPerArm: number;
  /** Distinct days each arm needs, so one viral hour cannot decide a test. */
  minObservationDays: number;
  /** Arms required for the comparison to mean anything. */
  minArms: number;
  /**
   * How much better the leader must be, relative to the runner-up, before it is
   * called a winner rather than a tie. A fraction: 0.1 is "10% higher CTR".
   */
  minRelativeLift: number;
}

/**
 * Defaults chosen to be conservative rather than responsive.
 *
 * These are thresholds for *declaring a result*, not for showing data — the UI
 * shows figures as soon as they exist, labelled insufficient. 1,000 impressions
 * and 3 days per arm is well short of what a statistician would want, and the
 * decision record says so; it is enough to stop the system from announcing a
 * winner off a handful of clicks, which is the failure §10 names.
 */
export const DEFAULT_DECISION_POLICY: DecisionPolicy = {
  minImpressionsPerArm: 1000,
  minObservationDays: 3,
  minArms: 2,
  minRelativeLift: 0.1,
};

export type ExperimentOutcome =
  | "winner"
  | "no_winner"
  | "tie"
  | "insufficient_data"
  | "stopped";

export type ExperimentStatus = "draft" | "running" | "completed" | "cancelled";

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface CreateExperimentInput {
  userId: string;
  publishedVideoId: string;
  /**
   * Variants to test, in the order the caller listed them. Order determines
   * `position`, which determines assignment — but since assignment is a pure
   * function of position and both are stored server-side, a caller reordering
   * this list changes *which arm is which*, never *which arm wins*.
   */
  variantIds: string[];
  /** Which variant is already live. Must be one of `variantIds`. */
  controlVariantId: string;
  policy?: Partial<DecisionPolicy>;
}

export interface ExperimentArmRecord {
  id: string;
  position: number;
  thumbnailVariantId: string;
  isControl: boolean;
  headline: string | null;
  imageAssetId: string | null;
  impressions: number | null;
  clicks: number | null;
  views: number | null;
  /** Exact fraction as a string, or null when nothing has been observed. */
  ctr: string | null;
  metricsSource: MetricSource | null;
  observationDays: number;
  lastObservedAt: Date | null;
}

export interface ExperimentRecord {
  id: string;
  userId: string;
  channelId: string;
  publishedVideoId: string;
  youtubeVideoId: string;
  status: ExperimentStatus;
  startedAt: Date | null;
  endedAt: Date | null;
  decidedAt: Date | null;
  outcome: ExperimentOutcome | null;
  winningArmId: string | null;
  policy: DecisionPolicy;
  /**
   * The decision as it was recorded, or null while the test is open.
   *
   * Kept alongside the live `decide()` result rather than replaced by it: a test
   * concluded under an older policy must be reported the way it was concluded, not
   * re-narrated under today's thresholds.
   */
  decision: { outcome: ExperimentOutcome; rationale: string } | null;
  arms: ExperimentArmRecord[];
}

const MAX_ARMS = 4;

/**
 * Create a draft experiment over existing variants of a published video.
 *
 * Every id is re-resolved with the tenant predicate in the query rather than
 * trusted from the input (§12). The variants must belong to the *same project*
 * as the published video: testing another project's thumbnails on this video
 * would attribute one video's impressions to an unrelated image.
 */
export async function createExperiment(
  input: CreateExperimentInput,
): Promise<ExperimentRecord> {
  const { userId, publishedVideoId } = input;

  const unique = [...new Set(input.variantIds)];
  if (unique.length < 2) {
    throw new ValidationError("An A/B test needs at least two thumbnails.");
  }
  if (unique.length > MAX_ARMS) {
    throw new ValidationError(
      `An A/B test can compare at most ${MAX_ARMS} thumbnails.`,
    );
  }
  if (!unique.includes(input.controlVariantId)) {
    throw new ValidationError(
      "The current thumbnail must be one of the variants under test.",
    );
  }

  const video = await requireOwnedPublishedVideo(userId, publishedVideoId);

  /**
   * Resolve the variants through `thumbnails` so the project link is checked in
   * SQL. A variant that is not this user's, or belongs to a different project,
   * simply does not come back — and the count check below turns that into a 403
   * rather than a silently smaller experiment.
   */
  const variants = await db
    .select({
      id: thumbnailVariants.id,
      headline: thumbnailVariants.headline,
      imageAssetId: thumbnailVariants.imageAssetId,
    })
    .from(thumbnailVariants)
    .innerJoin(thumbnails, eq(thumbnails.id, thumbnailVariants.thumbnailId))
    .where(
      and(
        inArray(thumbnailVariants.id, unique),
        eq(thumbnailVariants.userId, userId),
        eq(thumbnails.projectId, video.projectId),
      ),
    );

  if (variants.length !== unique.length) {
    throw new ForbiddenError(
      "One or more thumbnails are not available for this video.",
    );
  }

  /**
   * An arm with no composited image cannot be shown, so it could never earn an
   * impression — including it would guarantee a permanently `insufficient_data`
   * test.
   */
  const missingImage = variants.find((v) => !v.imageAssetId);
  if (missingImage) {
    throw new ValidationError(
      `“${missingImage.headline}” has no rendered image, so it cannot be tested.`,
    );
  }

  const policy: DecisionPolicy = { ...DEFAULT_DECISION_POLICY, ...input.policy };
  assertPolicy(policy);

  const now = new Date();

  try {
    const experimentId = crypto.randomUUID();
    await atomic([
      db.insert(thumbnailExperiments).values({ id: experimentId, userId, channelId: video.channelId,
        publishedVideoId: video.id, status: "draft", decisionPolicy: policy, createdAt: now, updatedAt: now }),
      db.insert(thumbnailExperimentArms).values(unique.map((variantId, position) => ({
        experimentId, userId, thumbnailVariantId: variantId, position, isControl: variantId === input.controlVariantId,
        createdAt: now, updatedAt: now,
      }))),
    ]);
    const record = await loadExperiment(db, userId, experimentId);
    if (!record) throw new ConflictError("Could not create the test.");
    return record;
  } catch (error) {
    /**
     * The partial unique index on `(published_video_id) where status in
     * ('draft','running')` is what actually prevents two live tests on one
     * video. Translating its violation here — rather than checking first — is
     * what makes two concurrent requests safe (§5).
     */
    if (isUniqueViolation(error, "thumbnail_experiments_live_video_key")) {
      throw new ConflictError("This video already has a thumbnail test running.");
    }
    throw error;
  }
}

function assertPolicy(policy: DecisionPolicy): void {
  const invalid =
    !Number.isInteger(policy.minImpressionsPerArm) ||
    policy.minImpressionsPerArm < 1 ||
    !Number.isInteger(policy.minObservationDays) ||
    policy.minObservationDays < 1 ||
    !Number.isInteger(policy.minArms) ||
    policy.minArms < 2 ||
    !Number.isFinite(policy.minRelativeLift) ||
    policy.minRelativeLift < 0;
  if (invalid) {
    throw new ValidationError("The test thresholds are not valid.");
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Move a draft to `running`.
 *
 * `startedAt` is set here and never overwritten, because the observation window
 * is measured from it. The status predicate is in the `WHERE`, so a second
 * concurrent start updates zero rows rather than resetting the clock.
 */
export async function startExperiment(
  userId: string,
  experimentId: string,
  now = new Date(),
): Promise<ExperimentRecord> {
  const updated = await db
    .update(thumbnailExperiments)
    .set({ status: "running", startedAt: now, updatedAt: now })
    .where(
      and(
        eq(thumbnailExperiments.id, experimentId),
        eq(thumbnailExperiments.userId, userId),
        eq(thumbnailExperiments.status, "draft"),
      ),
    )
    .returning({ id: thumbnailExperiments.id });

  if (updated.length === 0) {
    // Either not the user's, or not a draft. Both are refusals, and telling them
    // apart would leak which ids exist.
    const existing = await getExperiment(userId, experimentId);
    if (!existing) throw new ForbiddenError("Test not found or not accessible.");
    throw new ConflictError(`This test is already ${existing.status}.`);
  }

  const record = await getExperiment(userId, experimentId);
  if (!record) throw new NotFoundError("Test not found.");
  return record;
}

/** Stop a test without declaring a winner. An explicit, recorded outcome. */
export async function cancelExperiment(
  userId: string,
  experimentId: string,
  now = new Date(),
): Promise<ExperimentRecord> {
  const updated = await db
    .update(thumbnailExperiments)
    .set({
      status: "cancelled",
      outcome: "stopped",
      endedAt: now,
      decidedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(thumbnailExperiments.id, experimentId),
        eq(thumbnailExperiments.userId, userId),
        inArray(thumbnailExperiments.status, ["draft", "running"]),
      ),
    )
    .returning({ id: thumbnailExperiments.id });

  if (updated.length === 0) {
    const existing = await getExperiment(userId, experimentId);
    if (!existing) throw new ForbiddenError("Test not found or not accessible.");
    throw new ConflictError(`This test is already ${existing.status}.`);
  }

  const record = await getExperiment(userId, experimentId);
  if (!record) throw new NotFoundError("Test not found.");
  return record;
}

// ---------------------------------------------------------------------------
// Deterministic assignment (§9)
// ---------------------------------------------------------------------------

/**
 * Which arm a given viewer bucket sees.
 *
 * Deterministic, server-side, and a pure function of values Vidxir AI controls: the
 * experiment id, the video id and the bucket. The same inputs always give the
 * same arm, so a viewer's experience is stable across requests, and because the
 * result is derived from the *stored* arm positions, a client cannot influence it
 * — which is the §9 requirement that nobody can select themselves into an arm.
 *
 * Note this decides *display*, not outcome. The winner call
 * (`evaluateExperiment`) never looks at assignment.
 */
export function assignArm(
  experimentId: string,
  publishedVideoId: string,
  bucket: string,
  armCount: number,
): number {
  if (armCount <= 0) {
    throw new ValidationError("An experiment must have at least one arm.");
  }
  const hash = fnv1a32(`${experimentId}:${publishedVideoId}:${bucket}`);
  return hash % armCount;
}

/**
 * FNV-1a, 32-bit.
 *
 * Not a cryptographic hash and does not need to be: it is a spreader, and no
 * security property rests on it. It is here rather than `crypto` because it must
 * be identical in every process and cheap enough to call per request; a
 * `Math.random()` or time-seeded choice would make assignment unstable, which is
 * the one thing §9 forbids.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // >>> 0 keeps it an unsigned 32-bit value; Math.imul does the wrap.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Observation ingest
// ---------------------------------------------------------------------------

export interface ArmObservation {
  armId: string;
  /** UTC date the figures cover. */
  date: Date;
  impressions: number | null;
  clicks: number | null;
  views: number | null;
  source: MetricSource;
}

/**
 * Record per-arm observations for a day, then recompute the arms' totals.
 *
 * Two properties:
 *
 *  - **Idempotent.** Each observation upserts on `(arm_id, date)`, so re-running a
 *    day replaces it. Totals are then recomputed with `SUM` over the observation
 *    rows rather than incremented, so no path exists by which a repeated ingest
 *    inflates an arm (§5).
 *  - **Tenant-scoped.** Arm ids are re-resolved against the experiment and the
 *    user before anything is written; an arm id from another tenant is dropped,
 *    not stored.
 */
export async function recordObservations(
  userId: string,
  experimentId: string,
  observations: ArmObservation[],
  now = new Date(),
): Promise<{ written: number; skipped: number }> {
  if (observations.length === 0) return { written: 0, skipped: 0 };

  const arms = await db
    .select({ id: thumbnailExperimentArms.id })
    .from(thumbnailExperimentArms)
    .innerJoin(
      thumbnailExperiments,
      eq(thumbnailExperiments.id, thumbnailExperimentArms.experimentId),
    )
    .where(
      and(
        eq(thumbnailExperimentArms.experimentId, experimentId),
        eq(thumbnailExperimentArms.userId, userId),
        eq(thumbnailExperiments.userId, userId),
      ),
    );

  const ownArmIds = new Set(arms.map((a) => a.id));
  let written = 0;
  let skipped = 0;

  for (const observation of observations) {
    if (!ownArmIds.has(observation.armId)) {
      skipped += 1;
      continue;
    }
    await db
      .insert(thumbnailExperimentObservations)
      .values({
        experimentId,
        armId: observation.armId,
        userId,
        date: utcMidnight(observation.date),
        impressions: observation.impressions,
        clicks: observation.clicks,
        views: observation.views,
        source: observation.source,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          thumbnailExperimentObservations.armId,
          thumbnailExperimentObservations.date,
        ],
        set: {
          impressions: observation.impressions,
          clicks: observation.clicks,
          views: observation.views,
          source: observation.source,
          updatedAt: now,
        },
      });
    written += 1;
  }

  if (written > 0) {
    await recomputeArmTotals(userId, experimentId, now);
  }

  return { written, skipped };
}

/**
 * Recompute every arm's totals from its observations.
 *
 * A single correlated `UPDATE ... FROM` rather than a read-modify-write loop:
 * the numbers are derived in the database from the rows that are the source of
 * truth, so there is no window in which a concurrent ingest can be lost.
 *
 * CTR is computed as `clicks / impressions` in `numeric` arithmetic, and left
 * null when impressions are zero or absent — a 0/0 rendered as 0.0% would read
 * as "nobody clicked" rather than "nothing was shown" (§6).
 *
 * `now` is bound as UTC epoch milliseconds, not as a
 * `Date`. Drizzle's column-aware serialisation does not apply inside a raw `sql`
 * template, so postgres.js receives the value untranslated and rejects it at Bind
 * with `The "string" argument must be of type string ... Received an instance of
 * Date`. Phase 7 hit the identical failure in `lib/queue/jobs.ts`; the cast is the
 * house convention for a timestamp inside raw SQL.
 */
export async function recomputeArmTotals(
  userId: string,
  experimentId: string,
  now = new Date(),
): Promise<void> {
  await db.run(sql`
    update ${thumbnailExperimentArms} as arm
    set
      impressions = totals.impressions,
      clicks = totals.clicks,
      views = totals.views,
      ctr = case
        when totals.impressions is null or totals.impressions = 0 then null
        when totals.clicks is null then null
        else round(1.0 * totals.clicks / totals.impressions, 6)
      end,
      metrics_source = totals.source,
      observation_days = totals.days,
      last_observed_at = totals.last_date,
      updated_at = ${now.getTime()}
    from (
      select
        obs.arm_id as arm_id,
        sum(obs.impressions) as impressions,
        sum(obs.clicks) as clicks,
        sum(obs.views) as views,
        count(distinct obs.date) as days,
        max(obs.date) as last_date,
        max(obs.source) as source
      from ${thumbnailExperimentObservations} as obs
      where obs.experiment_id = ${experimentId}
        and obs.user_id = ${userId}
      group by obs.arm_id
    ) as totals
    where arm.id = totals.arm_id
      and arm.experiment_id = ${experimentId}
      and arm.user_id = ${userId}
  `);
}

// ---------------------------------------------------------------------------
// Winner policy (§10)
// ---------------------------------------------------------------------------

export interface ArmSummary {
  armId: string;
  position: number;
  thumbnailVariantId: string;
  isControl: boolean;
  impressions: number | null;
  clicks: number | null;
  /** Exact CTR as a decimal string, or null when not measurable. */
  ctr: string | null;
  observationDays: number;
  /** Whether this arm on its own clears the policy's minimums. */
  eligible: boolean;
  /** Why not, when it is not. */
  ineligibleReason?: "no_impressions" | "below_min_impressions" | "below_min_days";
}

export interface ExperimentDecision {
  experimentId: string;
  outcome: ExperimentOutcome;
  winningArmId: string | null;
  policy: DecisionPolicy;
  arms: ArmSummary[];
  /** The leader's CTR advantage over the runner-up, as a fraction. Null if N/A. */
  relativeLift: number | null;
  /**
   * Plain-language basis for the outcome, stored with the decision. Not a
   * significance claim — see `statisticalConfidence`.
   */
  rationale: string;
  /**
   * Deliberately always `"not_established"`.
   *
   * Impression-level A/B data is not available from the YouTube Analytics API, so
   * whatever observations exist here came from a limited or manual source. §10
   * forbids overstating significance, and the honest answer with this data is
   * that no significance test has been run — a p-value computed over provider
   * data Vidxir AI cannot obtain would be a fabricated number.
   */
  statisticalConfidence: "not_established";
}

/**
 * Evaluate a test without writing anything.
 *
 * The order of checks is the substance of §10 — in particular, the eligibility
 * gates come *before* the comparison. Sorting by CTR and taking the top row
 * would produce a "winner" from two impressions, which is the specific behaviour
 * the spec rules out.
 */
export async function evaluateExperiment(
  userId: string,
  experimentId: string,
): Promise<ExperimentDecision> {
  const experiment = await getExperiment(userId, experimentId);
  if (!experiment) throw new ForbiddenError("Test not found or not accessible.");
  return decide(experiment);
}

/** The pure decision function, so it is testable without a database. */
export function decide(experiment: ExperimentRecord): ExperimentDecision {
  const policy = experiment.policy;
  const arms: ArmSummary[] = experiment.arms.map((arm) => {
    const summary: ArmSummary = {
      armId: arm.id,
      position: arm.position,
      thumbnailVariantId: arm.thumbnailVariantId,
      isControl: arm.isControl,
      impressions: arm.impressions,
      clicks: arm.clicks,
      ctr: arm.ctr,
      observationDays: arm.observationDays,
      eligible: false,
    };

    if (arm.impressions === null || arm.impressions === 0) {
      return { ...summary, ineligibleReason: "no_impressions" };
    }
    if (arm.impressions < policy.minImpressionsPerArm) {
      return { ...summary, ineligibleReason: "below_min_impressions" };
    }
    if (arm.observationDays < policy.minObservationDays) {
      return { ...summary, ineligibleReason: "below_min_days" };
    }
    // An arm that cleared the impression bar but has no CTR means clicks were
    // never recorded — measurable exposure, unmeasurable performance.
    if (arm.ctr === null) {
      return { ...summary, ineligibleReason: "no_impressions" };
    }
    return { ...summary, eligible: true };
  });

  const base = {
    experimentId: experiment.id,
    policy,
    arms,
    statisticalConfidence: "not_established" as const,
  };

  const comparable = arms.filter((a) => a.eligible);

  if (experiment.arms.length < policy.minArms) {
    return {
      ...base,
      outcome: "insufficient_data",
      winningArmId: null,
      relativeLift: null,
      rationale: `The test has ${experiment.arms.length} thumbnail(s); ${policy.minArms} are required to compare.`,
    };
  }

  if (comparable.length < policy.minArms) {
    return {
      ...base,
      outcome: "insufficient_data",
      winningArmId: null,
      relativeLift: null,
      rationale:
        `Only ${comparable.length} of ${arms.length} thumbnails have enough data ` +
        `(${policy.minImpressionsPerArm}+ impressions over ${policy.minObservationDays}+ days).`,
    };
  }

  /**
   * Compare on the stored decimal strings via `compareDecimal`, not by casting to
   * float: two CTRs that differ in the sixth decimal place must not compare equal
   * because of a representation artefact.
   */
  const ranked = [...comparable].sort((a, b) => {
    const byCtr = compareDecimal(b.ctr ?? "0", a.ctr ?? "0");
    if (byCtr !== 0) return byCtr;
    // Ties break on impressions, then on the stable position — never on row order,
    // which would make the same data decide differently on different reads.
    if ((b.impressions ?? 0) !== (a.impressions ?? 0)) {
      return (b.impressions ?? 0) - (a.impressions ?? 0);
    }
    return a.position - b.position;
  });

  const leader = ranked[0];
  const runnerUp = ranked[1];
  if (!leader || !runnerUp) {
    return {
      ...base,
      outcome: "insufficient_data",
      winningArmId: null,
      relativeLift: null,
      rationale: "Not enough comparable thumbnails to rank.",
    };
  }

  /**
   * The comparison itself is done on scaled integers, not on the floats.
   *
   * `(0.11 - 0.10) / 0.10` is `0.09999999999999998` in IEEE-754, so a float gate
   * against a 10% minimum calls that pair a tie — the decision flips on a
   * representation artefact rather than on the data. `clearsLift` below does the
   * same test by cross-multiplication in `BigInt`.
   */
  const width = Math.max(fracWidth(leader.ctr ?? "0"), fracWidth(runnerUp.ctr ?? "0"));
  const leaderScaled = scaleDecimal(leader.ctr ?? "0", width);
  const runnerScaled = scaleDecimal(runnerUp.ctr ?? "0", width);

  if (runnerScaled === 0n) {
    // The runner-up got impressions but no clicks. A relative lift is undefined
    // (division by zero), so this is reported as a winner on absolute grounds
    // only if the leader actually earned clicks.
    if (leaderScaled === 0n) {
      return {
        ...base,
        outcome: "no_winner",
        winningArmId: null,
        relativeLift: null,
        rationale: "No thumbnail earned any clicks, so none outperformed another.",
      };
    }
    return {
      ...base,
      outcome: "winner",
      winningArmId: leader.armId,
      relativeLift: null,
      rationale:
        `The leading thumbnail earned clicks (${leader.clicks ?? 0}) where the ` +
        "next best earned none.",
    };
  }

  /**
   * `relativeLift` is a float because it is *reported*, not decided on — a
   * percentage in a sentence does not need the sixth decimal place. The gate
   * uses the exact comparison.
   */
  const relativeLift =
    Number(leaderScaled - runnerScaled) / Number(runnerScaled);

  if (!clearsLift(leaderScaled, runnerScaled, policy.minRelativeLift)) {
    return {
      ...base,
      outcome: "tie",
      winningArmId: null,
      relativeLift,
      rationale:
        `The best thumbnail is only ${(relativeLift * 100).toFixed(1)}% ahead, ` +
        `below the ${(policy.minRelativeLift * 100).toFixed(0)}% margin required ` +
        "to call a winner. Treat these as equivalent.",
    };
  }

  return {
    ...base,
    outcome: "winner",
    winningArmId: leader.armId,
    relativeLift,
    rationale:
      `The leading thumbnail's click-through rate is ${(relativeLift * 100).toFixed(1)}% ` +
      `higher than the next best, over ${leader.observationDays} days and ` +
      `${leader.impressions ?? 0} impressions.`,
  };
}

/**
 * Compare two decimal strings numerically, without floats.
 *
 * Returns a negative number when `a < b`, matching `Array#sort`'s contract. Both
 * sides are scaled to a common number of fractional digits and compared as
 * `BigInt`, so `0.100000` and `0.1` compare equal while `0.100001` does not — a
 * distinction that `parseFloat` would preserve here but that becomes unreliable
 * as soon as the values are arithmetic rather than literal.
 */
export function compareDecimal(a: string, b: string): number {
  const width = Math.max(fracWidth(a), fracWidth(b));
  const scaledA = scaleDecimal(a, width);
  const scaledB = scaleDecimal(b, width);
  if (scaledA === scaledB) return 0;
  return scaledA < scaledB ? -1 : 1;
}

function fracWidth(value: string): number {
  return value.trim().split(".")[1]?.length ?? 0;
}

/**
 * Whether `leader / runnerUp - 1 >= minRelativeLift`, decided exactly.
 *
 * Both CTRs arrive already scaled to a common width, so the ratio test becomes a
 * cross-multiplication:
 *
 *     (leader - runner) / runner >= minLift
 *   ⇔ (leader - runner) * D      >= minLift * D * runner        [D > 0]
 *
 * where `minLift * D` is rounded to an integer numerator `N`. `D` is 10^9, which
 * expresses a threshold to nine decimal places — far finer than a UI ever
 * displays and enough that the rounding cannot move a decision that was not
 * already at the exact boundary. `runner` is known non-zero here, and both sides
 * are non-negative because `leader` is the ranked maximum, so no sign case arises.
 *
 * Exported for the unit tests: this predicate *is* the winner/tie boundary, and a
 * float version of it silently mis-decides pairs like 0.11 vs 0.10 (§10).
 */
export function clearsLift(
  leaderScaled: bigint,
  runnerScaled: bigint,
  minRelativeLift: number,
): boolean {
  if (runnerScaled <= 0n) return false;
  const D = 1_000_000_000n;
  const numerator = BigInt(Math.round(minRelativeLift * Number(D)));
  return (leaderScaled - runnerScaled) * D >= numerator * runnerScaled;
}

/** A decimal string as an integer scaled by `10 ** width`. */
function scaleDecimal(value: string, width: number): bigint {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const [whole = "0", frac = ""] = trimmed.replace(/^[+-]/, "").split(".");
  const magnitude =
    BigInt(whole || "0") * 10n ** BigInt(width) +
    BigInt(frac.padEnd(width, "0").slice(0, width) || "0");
  return negative ? -magnitude : magnitude;
}

/**
 * Evaluate and persist the outcome.
 *
 * Only a decisive outcome closes the test: `insufficient_data` leaves it running,
 * because "we do not know yet" is not a reason to stop collecting. `winner`
 * records the arm but does **not** touch the live thumbnail — applying a winner is
 * a separate user action, per §8.
 */
export async function concludeExperiment(
  userId: string,
  experimentId: string,
  now = new Date(),
): Promise<{ decision: ExperimentDecision; concluded: boolean }> {
  const decision = await evaluateExperiment(userId, experimentId);

  if (decision.outcome === "insufficient_data") {
    return { decision, concluded: false };
  }

  const updated = await db
    .update(thumbnailExperiments)
    .set({
      status: "completed",
      outcome: decision.outcome,
      winningArmId: decision.winningArmId,
      decision: decision as unknown as Record<string, unknown>,
      decidedAt: now,
      endedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(thumbnailExperiments.id, experimentId),
        eq(thumbnailExperiments.userId, userId),
        eq(thumbnailExperiments.status, "running"),
      ),
    )
    .returning({ id: thumbnailExperiments.id });

  const concluded = updated.length > 0;
  if (concluded) {
    log.info("thumbnail experiment concluded", {
      userId,
      experimentId,
      outcome: decision.outcome,
      winningArmId: decision.winningArmId,
    });
  }

  return { decision, concluded };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getExperiment(
  userId: string,
  experimentId: string,
): Promise<ExperimentRecord | null> {
  return loadExperiment(db, userId, experimentId);
}

/** Every experiment for a channel, newest first. */
export async function listExperiments(
  userId: string,
  channelId: string,
  limit = 25,
): Promise<ExperimentRecord[]> {
  const rows = await db
    .select({ id: thumbnailExperiments.id })
    .from(thumbnailExperiments)
    .where(
      and(
        eq(thumbnailExperiments.userId, userId),
        eq(thumbnailExperiments.channelId, channelId),
      ),
    )
    .orderBy(sql`${thumbnailExperiments.createdAt} desc`)
    .limit(limit);

  const records: ExperimentRecord[] = [];
  for (const row of rows) {
    const record = await loadExperiment(db, userId, row.id);
    if (record) records.push(record);
  }
  return records;
}

/** Running experiments across all channels — what the worker sweeps. */
export async function runningExperimentIds(
  limit = 200,
): Promise<Array<{ id: string; userId: string; channelId: string }>> {
  return db
    .select({
      id: thumbnailExperiments.id,
      userId: thumbnailExperiments.userId,
      channelId: thumbnailExperiments.channelId,
    })
    .from(thumbnailExperiments)
    .where(eq(thumbnailExperiments.status, "running"))
    .orderBy(asc(thumbnailExperiments.startedAt))
    .limit(limit);
}

/** Shared loader, usable inside a transaction. */
type Queryable = Pick<typeof db, "select">;

async function loadExperiment(
  tx: Queryable,
  userId: string,
  experimentId: string,
): Promise<ExperimentRecord | null> {
  const rows = await tx
    .select({
      id: thumbnailExperiments.id,
      userId: thumbnailExperiments.userId,
      channelId: thumbnailExperiments.channelId,
      publishedVideoId: thumbnailExperiments.publishedVideoId,
      youtubeVideoId: publishedVideos.youtubeVideoId,
      status: thumbnailExperiments.status,
      startedAt: thumbnailExperiments.startedAt,
      endedAt: thumbnailExperiments.endedAt,
      decidedAt: thumbnailExperiments.decidedAt,
      outcome: thumbnailExperiments.outcome,
      winningArmId: thumbnailExperiments.winningArmId,
      policy: thumbnailExperiments.decisionPolicy,
      decision: thumbnailExperiments.decision,
    })
    .from(thumbnailExperiments)
    .innerJoin(
      publishedVideos,
      eq(publishedVideos.id, thumbnailExperiments.publishedVideoId),
    )
    .where(
      and(
        eq(thumbnailExperiments.id, experimentId),
        eq(thumbnailExperiments.userId, userId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const arms = await tx
    .select({
      id: thumbnailExperimentArms.id,
      position: thumbnailExperimentArms.position,
      thumbnailVariantId: thumbnailExperimentArms.thumbnailVariantId,
      isControl: thumbnailExperimentArms.isControl,
      headline: thumbnailVariants.headline,
      imageAssetId: thumbnailVariants.imageAssetId,
      impressions: thumbnailExperimentArms.impressions,
      clicks: thumbnailExperimentArms.clicks,
      views: thumbnailExperimentArms.views,
      ctr: thumbnailExperimentArms.ctr,
      metricsSource: thumbnailExperimentArms.metricsSource,
      observationDays: thumbnailExperimentArms.observationDays,
      lastObservedAt: thumbnailExperimentArms.lastObservedAt,
    })
    .from(thumbnailExperimentArms)
    .innerJoin(
      thumbnailVariants,
      eq(thumbnailVariants.id, thumbnailExperimentArms.thumbnailVariantId),
    )
    .where(
      and(
        eq(thumbnailExperimentArms.experimentId, experimentId),
        eq(thumbnailExperimentArms.userId, userId),
      ),
    )
    .orderBy(asc(thumbnailExperimentArms.position));

  return {
    id: row.id,
    userId: row.userId,
    channelId: row.channelId,
    publishedVideoId: row.publishedVideoId,
    youtubeVideoId: row.youtubeVideoId,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    decidedAt: row.decidedAt,
    outcome: row.outcome,
    winningArmId: row.winningArmId,
    // A row written before a policy existed falls back to the current default
    // rather than crashing a read.
    policy: row.policy ?? DEFAULT_DECISION_POLICY,
    decision: storedDecision(row.decision),
    arms,
  };
}

/**
 * Narrow the `jsonb` decision blob to the two fields readers need.
 *
 * Validated rather than cast: the column is `Record<string, unknown>` and a row
 * written by an older build may not carry these keys. Returning null for an
 * unrecognised shape is what stops a read from rendering `undefined`.
 */
function storedDecision(
  raw: Record<string, unknown> | null,
): { outcome: ExperimentOutcome; rationale: string } | null {
  if (!raw) return null;
  const outcome = raw.outcome;
  const rationale = raw.rationale;
  const known: readonly string[] = [
    "winner",
    "no_winner",
    "tie",
    "insufficient_data",
    "stopped",
  ];
  if (typeof outcome !== "string" || !known.includes(outcome)) return null;
  if (typeof rationale !== "string") return null;
  return { outcome: outcome as ExperimentOutcome, rationale };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a published video the user owns.
 *
 * Lives here rather than in `api/guard.ts` because the worker needs it too and
 * cannot import a `server-only` module.
 */
export async function requireOwnedPublishedVideo(
  userId: string,
  publishedVideoId: string,
): Promise<{
  id: string;
  projectId: string;
  channelId: string;
  youtubeVideoId: string;
}> {
  const rows = await db
    .select({
      id: publishedVideos.id,
      projectId: publishedVideos.projectId,
      channelId: publishedVideos.channelId,
      youtubeVideoId: publishedVideos.youtubeVideoId,
    })
    .from(publishedVideos)
    .where(
      and(
        eq(publishedVideos.id, publishedVideoId),
        eq(publishedVideos.userId, userId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new ForbiddenError("Video not found or not accessible.");
  }
  return row;
}

function utcMidnight(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/** Whether an error is a unique-violation on a specific index. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; constraint_name?: unknown };
  if (candidate.code !== "23505") return false;
  return (
    typeof candidate.constraint_name !== "string" ||
    candidate.constraint_name === constraint
  );
}

/**
 * Analytics job handlers (Phase 9 §11, §12).
 *
 * These run on the **existing** `analytics` queue, which was declared in
 * `QUEUE_NAMES` with `CONCURRENCY.analytics = 2` from the start but had no
 * handlers registered. Phase 9 fills that seam; it does not add a queue, a
 * scheduler, or a worker process.
 *
 * Same contract as every other handler in this directory, and it matters here for
 * the same reason: the payload arrives over Redis and is treated as untrusted
 * data, while the **owning user comes from the `jobs` row**. A worker that trusted
 * a `userId` in an analytics payload would let anyone who can write to Redis read
 * another tenant's revenue — or spend that tenant's YouTube quota (§12).
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  defaultWindow,
  ingestChannelAnalytics,
  isRetryableIngestError,
} from "@/lib/channels/analytics";
import { concludeExperiment } from "@/lib/analytics/experiments";
import { logger } from "@/lib/logger";
import type { JobHandler } from "@/worker/types";

const log = logger.child({ component: "analytics-worker" });

/** Job names on the `analytics` queue. */
export const ANALYTICS_INGEST_JOB = "analytics-ingest";
export const EXPERIMENT_EVALUATE_JOB = "experiment-evaluate";

/**
 * An ISO date, validated by shape rather than by `new Date()`.
 *
 * `new Date("nonsense")` yields an Invalid Date that stringifies into a query
 * parameter YouTube rejects with a 400 — which the taxonomy would classify as a
 * provider fault rather than as our own malformed request.
 */
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), {
    message: "must be a real date",
  });

const IngestPayloadSchema = z.object({
  channelId: z.string().uuid(),
  /** Both or neither. Omitted means "the default resettle window". */
  startDate: IsoDate.optional(),
  endDate: IsoDate.optional(),
});

/**
 * Ingest a channel's analytics.
 *
 * Enqueued by the scheduler's existing `ingest-analytics` task for channels that
 * need a pull, and available for a user-triggered refresh. Idempotent by
 * construction — see the upsert notes in `lib/channels/analytics.ts` — so a
 * retried or duplicated job converges rather than double-counting.
 */
export const analyticsIngestHandler: JobHandler = async ({ jobId, payload }) => {
  const parsed = IngestPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    // Typed so `shouldRetry` reads `retryable: false`: a malformed payload is
    // malformed on every attempt, and each retry costs YouTube quota.
    throw new ValidationError(
      `Invalid analytics payload: ${parsed.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    );
  }

  const rows = await db
    .select({ userId: jobs.userId, channelId: jobs.channelId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);

  const row = rows[0];
  // Discarded, not retried: a row missing now cannot appear fifteen seconds later.
  if (!row) throw new NotFoundError(`Job row ${jobId} not found.`);

  if (row.channelId && row.channelId !== parsed.data.channelId) {
    // The payload is not describing this job. No retry changes the comparison.
    throw new ForbiddenError("Job payload channel does not match the job record.");
  }

  const window =
    parsed.data.startDate && parsed.data.endDate
      ? { startDate: parsed.data.startDate, endDate: parsed.data.endDate }
      : defaultWindow(new Date());

  try {
    const result = await ingestChannelAnalytics(
      row.userId,
      parsed.data.channelId,
      window,
    );
    return {
      channelId: result.channelId,
      startDate: result.startDate,
      endDate: result.endDate,
      channelRows: result.channelRows,
      videoRows: result.videoRows,
      unmatchedVideos: result.unmatchedVideoIds.length,
      revenueState: result.revenue.state,
    };
  } catch (error) {
    /**
     * A missing scope, a dead grant or an unsupported metric will fail
     * identically on every attempt, so those are surfaced as terminal rather than
     * replayed against the same quota (§13). `isRetryableIngestError` is where
     * that judgement lives; re-throwing unchanged for genuinely transient faults
     * lets BullMQ's backoff do its job.
     */
    if (!isRetryableIngestError(error)) {
      log.info("analytics ingest not retryable", {
        jobId,
        channelId: parsed.data.channelId,
        // The error itself is logged by the harness; naming the decision here is
        // what makes a terminal failure legible in the log.
        status: "error",
      });
    }
    throw error;
  }
};

const EvaluatePayloadSchema = z.object({
  experimentId: z.string().uuid(),
});

/**
 * Re-evaluate one thumbnail experiment against the winner policy.
 *
 * Writes only a decision. It does not change the video's live thumbnail: §8
 * forbids silently replacing a production thumbnail, so applying a winner stays
 * an explicit user action.
 *
 * An `insufficient_data` outcome is a success, not a failure — the test simply
 * keeps running. Throwing here would retry a job whose answer is "wait longer".
 */
export const experimentEvaluateHandler: JobHandler = async ({ jobId, payload }) => {
  const parsed = EvaluatePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid experiment payload: ${parsed.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    );
  }

  const rows = await db
    .select({ userId: jobs.userId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError(`Job row ${jobId} not found.`);

  // `concludeExperiment` re-queries with this userId in the predicate, so an
  // experiment id belonging to another tenant resolves to a refusal.
  const { decision, concluded } = await concludeExperiment(
    row.userId,
    parsed.data.experimentId,
  );

  return {
    experimentId: decision.experimentId,
    outcome: decision.outcome,
    winningArmId: decision.winningArmId,
    concluded,
    comparableArms: decision.arms.filter((a) => a.eligible).length,
    totalArms: decision.arms.length,
  };
};

export const analyticsHandlers = {
  [ANALYTICS_INGEST_JOB]: analyticsIngestHandler,
  [EXPERIMENT_EVALUATE_JOB]: experimentEvaluateHandler,
};

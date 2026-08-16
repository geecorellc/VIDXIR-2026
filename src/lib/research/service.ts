/**
 * Research run orchestration (§7, §10, §20, §45).
 *
 * Two halves, deliberately separated:
 *
 *  - `startResearchRun()` runs inside the HTTP request. It validates, enforces
 *    plan limits and rate limits, creates the `research_runs` row, and enqueues
 *    the job. Fast and bounded.
 *  - `executeResearchRun()` runs in the **worker**. It talks to YouTube and
 *    Claude, which takes tens of seconds. §10 forbids doing that in a request
 *    handler, and §45 requires the run to survive the browser closing.
 *
 * The run row is the durable record. Its status mirrors the job's, so the
 * Research screen shows the truth whether the page was open the whole time or
 * opened fresh an hour later.
 */
import "server-only";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, researchRuns } from "@/lib/db/schema";
import {
  ConflictError,
  NotFoundError,
  errorCodeOf,
  isAppError,
  isBlockingCode,
  userMessageOf,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { queuePriorityFor } from "@/lib/plans/enforce";
import { enqueue, hasActiveJob, reportProgress } from "@/lib/queue/jobs";
import { generateIdeas, persistIdeas } from "@/lib/research/ideas";
import {
  collectSignals,
  loadResearchContext,
  persistSignals,
} from "@/lib/research/signals";
import type { PlanTier } from "@/lib/plans";

const log = logger.child({ component: "research" });

/** The job name the worker dispatches on. */
export const RESEARCH_JOB_NAME = "research-run";

export interface StartRunInput {
  userId: string;
  channelId: string;
  tier: PlanTier;
  /** `manual` from the UI, `automation` from the scheduler (§19). */
  trigger?: "manual" | "automation";
  traceId?: string | null;
}

export interface StartRunResult {
  runId: string;
  jobId: string;
}

/**
 * Create and enqueue a research run.
 *
 * Refuses a second concurrent run for the same channel. Two runs would both
 * spend ~600 quota units and interleave their results into one confusing view,
 * and the second adds nothing the first will not produce.
 */
export async function startResearchRun(
  input: StartRunInput,
): Promise<StartRunResult> {
  const context = await loadResearchContext(input.userId, input.channelId);
  if (!context) throw new NotFoundError("Channel not found.");

  if (await hasActiveJob(input.userId, input.channelId, RESEARCH_JOB_NAME)) {
    throw new ConflictError(
      "Research is already running for this channel. Wait for it to finish.",
    );
  }

  const inserted = await db
    .insert(researchRuns)
    .values({
      userId: input.userId,
      channelId: input.channelId,
      status: "queued",
      trigger: input.trigger ?? "manual",
      niche: context.niche,
      keywords: context.keywords,
      sources: [],
    })
    .returning({ id: researchRuns.id });

  const run = inserted[0];
  if (!run) throw new Error("Failed to create research run.");

  try {
    const job = await enqueue({
      queue: "research",
      name: RESEARCH_JOB_NAME,
      userId: input.userId,
      channelId: input.channelId,
      stage: "RESEARCH",
      payload: { runId: run.id, channelId: input.channelId },
      priority: queuePriorityFor(input.tier),
      traceId: input.traceId ?? null,
      statusMessage: "Queued",
    });

    return { runId: run.id, jobId: job.id };
  } catch (error) {
    // The queue push failed, so nothing will ever pick this run up. Fail the row
    // now rather than leaving a permanent "queued" the UI would spin on (§30).
    await db
      .update(researchRuns)
      .set({
        status: "failed",
        error: "Could not reach the job queue. Please try again.",
        errorCode: "internal_error",
        completedAt: new Date(),
      })
      .where(eq(researchRuns.id, run.id));
    throw error;
  }
}

export interface ExecuteRunInput {
  userId: string;
  channelId: string;
  runId: string;
  jobId: string;
  traceId?: string | null;
}

export interface ExecuteRunResult {
  resultCount: number;
  ideaCount: number;
  sources: string[];
}

/**
 * Execute a research run. Called by the worker, never by a request handler.
 *
 * Failure handling is the interesting part. A run that throws is marked failed
 * with the real reason, and the error is rethrown so the worker can decide
 * whether to retry — a rate limit is worth another attempt, a missing API key is
 * not. Either way the row is never left `running`, because a permanently
 * "researching" screen is the §30 failure mode.
 */
export async function executeResearchRun(
  input: ExecuteRunInput,
): Promise<ExecuteRunResult> {
  const startedAt = new Date();

  // Ownership is re-verified here rather than trusted from the payload: the job
  // arrives from Redis, and a payload is not an authorisation.
  const runRows = await db
    .select({ id: researchRuns.id, channelId: researchRuns.channelId })
    .from(researchRuns)
    .where(
      and(
        eq(researchRuns.id, input.runId),
        eq(researchRuns.userId, input.userId),
        eq(researchRuns.channelId, input.channelId),
      ),
    )
    .limit(1);

  if (!runRows[0]) throw new NotFoundError("Research run not found.");

  await db
    .update(researchRuns)
    .set({ status: "running", startedAt, error: null, errorCode: null })
    .where(eq(researchRuns.id, input.runId));

  try {
    const context = await loadResearchContext(input.userId, input.channelId);
    if (!context) throw new NotFoundError("Channel not found.");

    await reportProgress(input.jobId, 10, "Reading YouTube signals");

    const collected = await collectSignals(input.userId, context, {
      traceId: input.traceId ?? undefined,
    });

    if (collected.signals.length === 0) {
      // Every source failed or the niche returned nothing. §42: report that
      // honestly rather than persisting an empty run that reads as "no
      // opportunities exist".
      throw new ResearchNoSignalsError();
    }

    await reportProgress(input.jobId, 45, "Scoring opportunities");

    const evidence = await persistSignals(
      input.userId,
      input.channelId,
      input.runId,
      collected.signals,
    );

    await db
      .update(researchRuns)
      .set({
        sources: collected.sources,
        demandSeries: collected.demandSeries,
      })
      .where(eq(researchRuns.id, input.runId));

    await reportProgress(input.jobId, 65, "Generating original angles");

    const generated = await generateIdeas({
      userId: input.userId,
      context,
      evidence,
      ownTopPerformers: collected.ownTopPerformers,
      jobId: input.jobId,
      traceId: input.traceId ?? null,
    });

    const ideaIds = await persistIdeas(
      input.userId,
      input.channelId,
      input.runId,
      generated,
    );

    await reportProgress(input.jobId, 95, "Finishing up");

    const completedAt = new Date();
    await db
      .update(researchRuns)
      .set({ status: "succeeded", completedAt, error: null, errorCode: null })
      .where(eq(researchRuns.id, input.runId));

    log.info("research run complete", {
      userId: input.userId,
      channelId: input.channelId,
      jobId: input.jobId,
      traceId: input.traceId ?? undefined,
      stage: "RESEARCH",
      status: "succeeded",
      durationMs: completedAt.getTime() - startedAt.getTime(),
      resultCount: evidence.length,
      ideaCount: ideaIds.length,
      sources: collected.sources,
    });

    return {
      resultCount: evidence.length,
      ideaCount: ideaIds.length,
      sources: collected.sources,
    };
  } catch (error) {
    // An empty provider balance is grouped with a missing key deliberately: in
    // both cases the run cannot proceed until an operator acts, and no number of
    // retries changes that. `errorCode` below records which of the two it was.
    const notConfigured = isAppError(error) && isBlockingCode(error.code);

    await db
      .update(researchRuns)
      .set({
        // §48: a missing credential is a configuration state, not a crash. The
        // Research screen renders it as "connect this provider", naming the
        // variable, rather than as an error the user cannot act on.
        status: notConfigured ? "blocked_not_configured" : "failed",
        error: userMessageOf(error),
        // Which of the two blocking causes this was. `blocked_not_configured`
        // is deliberately one status — both need an operator — but the screen
        // has to say either "set this variable" or "top up this account".
        errorCode: errorCodeOf(error),
        completedAt: new Date(),
      })
      .where(eq(researchRuns.id, input.runId));

    log.error("research run failed", {
      userId: input.userId,
      channelId: input.channelId,
      jobId: input.jobId,
      traceId: input.traceId ?? undefined,
      stage: "RESEARCH",
      status: "failed",
      errorCode: errorCodeOf(error),
      error,
    });

    throw error;
  }
}

/**
 * No signal source responded with anything usable.
 *
 * Retryable: the common causes are a transient YouTube 5xx or a quota window
 * that resets. A genuinely empty niche will fail again and surface to the user
 * after the attempts are exhausted, which is the honest outcome.
 */
export class ResearchNoSignalsError extends Error {
  readonly retryable = true;
  constructor() {
    super(
      "No research signals could be collected from YouTube. This is usually a " +
        "temporary API problem or an exhausted daily quota.",
    );
    this.name = "ResearchNoSignalsError";
  }
}

/** The most recent run for a channel, whatever its status. */
export async function latestRun(
  userId: string,
  channelId: string,
): Promise<{ id: string; status: string; createdAt: Date } | null> {
  const rows = await db
    .select({
      id: researchRuns.id,
      status: researchRuns.status,
      createdAt: researchRuns.createdAt,
    })
    .from(researchRuns)
    .where(
      and(eq(researchRuns.userId, userId), eq(researchRuns.channelId, channelId)),
    )
    .orderBy(desc(researchRuns.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Channels due an automated research run (§19).
 *
 * Used by the scheduler in Phase 7. Kept here so the "when is research stale"
 * rule lives beside the run logic rather than in the scheduler loop.
 */
export async function channelsDueForResearch(
  maxAgeHours: number,
): Promise<Array<{ userId: string; channelId: string }>> {
  const cutoff = new Date(Date.now() - maxAgeHours * 3_600_000);

  // The newest successful run per connected channel, computed in SQL. A channel
  // that has never had one yields NULL, which is "due" — that is the case that
  // matters most, so it must not be filtered out by the join.
  const rows = await db
    .select({
      userId: channels.userId,
      channelId: channels.id,
      lastRunAt: sql<Date | null>`MAX(${researchRuns.createdAt})`,
    })
    .from(channels)
    .leftJoin(
      researchRuns,
      and(
        eq(researchRuns.channelId, channels.id),
        eq(researchRuns.status, "succeeded"),
      ),
    )
    .where(isNull(channels.disconnectedAt))
    .groupBy(channels.id, channels.userId);

  return rows
    .filter((row) => row.lastRunAt === null || new Date(row.lastRunAt) < cutoff)
    .map((row) => ({ userId: row.userId, channelId: row.channelId }));
}

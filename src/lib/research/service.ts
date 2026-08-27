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
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, researchRuns } from "@/lib/db/schema";
import {
  ConflictError,
  NotConfiguredError,
  NotFoundError,
  ProviderError,
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
  channelSignalReader,
  collectSignals,
  contextFromSource,
  loadResearchContext,
  persistSignals,
  publicSignalReader,
  type ResearchContext,
  type SignalReader,
} from "@/lib/research/signals";
import {
  analyzeVideoId,
  toStoredAnalysis,
  type SourceAnalysis,
} from "@/lib/youtube/source-analysis";
import type { IdeaSourceSeed } from "@/lib/research/ideas";
import type { PlanTier } from "@/lib/plans";
import type { YouTubeLinkForm } from "@/lib/youtube/url";

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
    return failQueuedRun(run.id, error);
  }
}

// ---------------------------------------------------------------------------
// Link mode (Phase 11 §4, §6, §7)
// ---------------------------------------------------------------------------

export interface StartLinkRunInput {
  userId: string;
  /** Already-validated video id. The route parses the URL; this trusts nothing. */
  videoId: string;
  tier: PlanTier;
  /**
   * The project this research belongs to.
   *
   * Required, and it is what makes the duplicate guard work without a channel:
   * `hasActiveJob` scopes on the project instead, so pasting the same link twice
   * is refused while researching a *different* link concurrently is not.
   */
  projectId: string;
  /** Which URL form was pasted, for the analysis record. */
  linkForm?: YouTubeLinkForm;
  traceId?: string | null;
}

/**
 * Create and enqueue a research run seeded by a pasted link (§4).
 *
 * Note what this does *not* do: it does not analyse the source video. That is a
 * network read of unbounded latency, and §10 keeps those out of request handlers —
 * the worker does it as the run's first step, so a slow or unreachable YouTube
 * shows up as a job the user can watch rather than a request that hangs.
 */
export async function startLinkResearchRun(
  input: StartLinkRunInput,
): Promise<StartRunResult> {
  if (
    await hasActiveJob(input.userId, null, RESEARCH_JOB_NAME, input.projectId)
  ) {
    throw new ConflictError(
      "Research is already running for this video. Wait for it to finish.",
    );
  }

  const inserted = await db
    .insert(researchRuns)
    .values({
      userId: input.userId,
      // §4: no channel, and none required.
      channelId: null,
      status: "queued",
      trigger: "youtube_link",
      sourceVideoId: input.videoId,
      // `niche` and `keywords` are filled in by the worker once the source has
      // been read. Left empty rather than guessed from the id.
      keywords: [],
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
      channelId: null,
      projectId: input.projectId,
      stage: "RESEARCH",
      payload: {
        runId: run.id,
        sourceVideoId: input.videoId,
        linkForm: input.linkForm ?? "bare_id",
      },
      priority: queuePriorityFor(input.tier),
      traceId: input.traceId ?? null,
      statusMessage: "Queued",
    });

    return { runId: run.id, jobId: job.id };
  } catch (error) {
    return failQueuedRun(run.id, error);
  }
}

/** Shared tail of both start functions: the queue push failed. */
async function failQueuedRun(runId: string, error: unknown): Promise<never> {
  // Nothing will ever pick this run up. Fail the row now rather than leaving a
  // permanent "queued" the UI would spin on (§30).
  await db
    .update(researchRuns)
    .set({
      status: "failed",
      error: "Could not reach the job queue. Please try again.",
      errorCode: "internal_error",
      completedAt: new Date(),
    })
    .where(eq(researchRuns.id, runId));
  throw error;
}

export interface ExecuteRunInput {
  userId: string;
  /** Null for a link-mode run (Phase 11 §4). */
  channelId: string | null;
  runId: string;
  jobId: string;
  /** Set for a link-mode run: the pasted video to seed from. */
  sourceVideoId?: string | null;
  linkForm?: YouTubeLinkForm;
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
 * One function for both modes (Phase 11 §3, §6). What differs is decided in the
 * first twenty lines — where the context comes from, and which credential reads
 * YouTube — and everything after that is the Phase 7 pipeline unchanged: collect,
 * score, persist, generate angles. That is the point: link mode is a second way
 * *in*, not a second implementation.
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
  // arrives from Redis, and a payload is not an authorisation. The channel
  // predicate is `IS NULL` for a link-mode run rather than omitted, so a payload
  // claiming no channel cannot be used to reach a channel-mode run.
  const runRows = await db
    .select({
      id: researchRuns.id,
      channelId: researchRuns.channelId,
      sourceVideoId: researchRuns.sourceVideoId,
    })
    .from(researchRuns)
    .where(
      and(
        eq(researchRuns.id, input.runId),
        eq(researchRuns.userId, input.userId),
        input.channelId
          ? eq(researchRuns.channelId, input.channelId)
          : isNull(researchRuns.channelId),
      ),
    )
    .limit(1);

  const runRow = runRows[0];
  if (!runRow) throw new NotFoundError("Research run not found.");

  await db
    .update(researchRuns)
    .set({ status: "running", startedAt, error: null, errorCode: null })
    .where(eq(researchRuns.id, input.runId));

  try {
    // The stored id wins over the payload's. Both are written by Tally, but only
    // the row was written inside the request that authorised this run.
    const sourceVideoId = runRow.sourceVideoId ?? input.sourceVideoId ?? null;

    let context: ResearchContext;
    let reader: SignalReader;
    let source: IdeaSourceSeed | null = null;

    if (input.channelId) {
      const loaded = await loadResearchContext(input.userId, input.channelId);
      if (!loaded) throw new NotFoundError("Channel not found.");
      context = loaded;
      reader = channelSignalReader(input.userId, input.channelId);
    } else {
      if (!sourceVideoId) {
        // A run with neither a channel nor a source has nothing to research. This
        // is unreachable through either start function; it is here because the
        // alternative is researching whatever the empty context happens to yield.
        throw new NotFoundError(
          "This research run has no channel and no source video.",
        );
      }

      await reportProgress(input.jobId, 5, "Analysing the source video");

      const analysis = await analyzeSourceOrThrow(sourceVideoId, input);
      context = contextFromSource(analysis);
      reader = publicSignalReader();
      source = sourceSeed(analysis);

      // Persist the analysis before researching. If the research half fails, the
      // screen can still show what the pasted video was — and §5's degradation
      // states are only useful if they survive the job that produced them.
      await db
        .update(researchRuns)
        .set({
          sourceTitle: analysis.title,
          sourceChannelTitle: analysis.channelTitle,
          sourceAnalysis: toStoredAnalysis(analysis),
          niche: context.niche,
          keywords: context.keywords,
        })
        .where(eq(researchRuns.id, input.runId));
    }

    await reportProgress(input.jobId, 10, "Reading YouTube signals");

    const collected = await collectSignals(reader, input.userId, context, {
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
      source,
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
      channelId: input.channelId ?? undefined,
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
      channelId: input.channelId ?? undefined,
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
 * Read the source video, or fail the run with the right kind of error (§5, §42).
 *
 * `analyzeVideoId` returns a state rather than throwing, because the *route* needs
 * to render every outcome. The worker needs the opposite: a run that cannot be
 * researched must stop, and its status has to say why. So the six states are mapped
 * back onto the error taxonomy the worker already classifies:
 *
 *  - `not_configured` → `NotConfiguredError`, which becomes
 *    `blocked_not_configured` and names `YOUTUBE_API_KEY` on screen. Not retried,
 *    because retrying a missing key fails identically.
 *  - `quota_exceeded` / `unavailable` → retryable `ProviderError`. The quota window
 *    resets and a 5xx passes.
 *  - `not_found` / `forbidden` → `NotFoundError` / non-retryable `ProviderError`.
 *    The video will not become readable by trying again.
 *
 * The message carried through is the one `analyzeVideoId` wrote for a user, never a
 * provider string (§21).
 */
async function analyzeSourceOrThrow(
  videoId: string,
  input: ExecuteRunInput,
): Promise<SourceAnalysis> {
  const result = await analyzeVideoId(videoId, input.linkForm ?? "bare_id", {
    userId: input.userId,
    traceId: input.traceId ?? null,
  });

  if (result.state === "ok") return result.analysis;

  if (result.state === "not_configured") {
    throw new NotConfiguredError(
      "YouTube public reads",
      result.missingEnvVars.length > 0
        ? result.missingEnvVars
        : ["YOUTUBE_API_KEY"],
    );
  }

  if (result.state === "not_found") {
    throw new NotFoundError(result.message);
  }

  throw new ProviderError("YouTube", result.message, {
    retryable: result.retryable,
    status: result.state === "forbidden" ? 403 : 502,
    details: { sourceState: result.state },
  });
}

/**
 * The subset of the analysis the angle prompt is allowed to see (§7, §22).
 *
 * Built here rather than passing the whole analysis, so what reaches a generative
 * prompt is a decision made in one visible place. The description is excluded
 * deliberately: it is the longest piece of the source creator's own prose, and the
 * topic is already carried by `niche` and `topics`.
 */
function sourceSeed(analysis: SourceAnalysis): IdeaSourceSeed {
  return {
    title: analysis.title,
    channelTitle: analysis.channelTitle,
    niche: analysis.niche,
    topics: analysis.topics,
    viewCount: analysis.viewCount,
    durationSeconds: analysis.durationSeconds,
  };
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

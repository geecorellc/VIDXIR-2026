/**
 * The durable job record (§20, §37, §45).
 *
 * Every enqueued unit of work exists twice: as a BullMQ job in Redis (the thing
 * that actually runs) and as a row in `jobs` (the thing the product can see).
 * Redis is deliberately not the source of truth for the UI — completed jobs are
 * trimmed from it, and §45's question "what should persist if the browser is
 * closed?" answers itself: the row.
 *
 * The order in `enqueue()` matters. The row is written **first**, then the job is
 * pushed to Redis. Reversed, a worker could pick up and finish a job before its
 * row existed and then write a completion onto nothing. In the chosen order the
 * worst case is a row that is `queued` forever because Redis rejected the push —
 * and that is a visible, reportable state rather than silent loss (§30, §42).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import {
  errorCodeOf,
  isAppError,
  isBlockingCode,
  userMessageOf,
  withDatabaseErrors,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getQueue, type QueueName } from "@/lib/queue/queues";

const log = logger.child({ component: "queue" });

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "blocked_not_configured";

export type PipelineStage =
  | "RESEARCH"
  | "SCRIPT"
  | "SCENE_PLAN"
  | "VOICEOVER"
  | "VISUALS"
  | "MUSIC"
  | "CAPTIONS"
  | "TIMELINE"
  | "RENDER"
  | "QUALITY_CHECK"
  | "THUMBNAIL"
  | "METADATA"
  | "PUBLISH";

export interface EnqueueInput {
  queue: QueueName;
  /** Job type, e.g. `research-run`. Must match a handler in `src/worker`. */
  name: string;
  userId: string;
  channelId?: string | null;
  projectId?: string | null;
  stage?: PipelineStage | null;
  /** Serialisable job input. Never put a credential in here. */
  payload?: Record<string, unknown>;
  /** Lower runs first (BullMQ semantics). Derived from the plan tier. */
  priority?: number;
  maxAttempts?: number;
  /** Delay before the job becomes eligible to run. */
  delayMs?: number;
  traceId?: string | null;
  statusMessage?: string | null;
}

export interface EnqueuedJob {
  /** The `jobs` row id. This is the id the API and UI use. */
  id: string;
  queue: QueueName;
  name: string;
  status: JobStatus;
}

/**
 * Record a job and enqueue it.
 *
 * The BullMQ job id is set to the row id, so a job seen in Redis, in a log line
 * and in the API all carry the same identifier. It also makes the push
 * idempotent: BullMQ ignores a duplicate id, so a retried enqueue of the same
 * row cannot produce two runs of the same work.
 */
export async function enqueue(input: EnqueueInput): Promise<EnqueuedJob> {
  const inserted = await db
    .insert(jobs)
    .values({
      userId: input.userId,
      channelId: input.channelId ?? null,
      projectId: input.projectId ?? null,
      queue: input.queue,
      name: input.name,
      stage: input.stage ?? null,
      status: "queued",
      progress: 0,
      statusMessage: input.statusMessage ?? null,
      priority: input.priority ?? 5,
      maxAttempts: input.maxAttempts ?? 3,
      traceId: input.traceId ?? null,
      payload: input.payload ?? {},
      ...(input.delayMs && input.delayMs > 0
        ? { scheduledFor: new Date(Date.now() + input.delayMs) }
        : {}),
    })
    .returning({ id: jobs.id });

  const row = inserted[0];
  if (!row) throw new Error("Failed to record job row.");

  try {
    const queue = getQueue(input.queue);
    const job = await queue.add(
      input.name,
      { jobId: row.id, ...(input.payload ?? {}) },
      {
        jobId: row.id,
        priority: input.priority ?? 5,
        attempts: input.maxAttempts ?? 3,
        ...(input.delayMs && input.delayMs > 0 ? { delay: input.delayMs } : {}),
      },
    );

    await db
      .update(jobs)
      .set({ queueJobId: job.id ?? row.id, updatedAt: new Date() })
      .where(eq(jobs.id, row.id));

    log.info("job enqueued", {
      jobId: row.id,
      userId: input.userId,
      channelId: input.channelId ?? undefined,
      projectId: input.projectId ?? undefined,
      stage: input.stage ?? undefined,
      queue: input.queue,
      name: input.name,
      traceId: input.traceId ?? undefined,
      status: "queued",
    });
  } catch (error) {
    // Redis is unreachable. Mark the row failed so the UI reports a real problem
    // instead of a spinner that never resolves (§30: "Never leave the UI
    // permanently stuck on 'Generating'").
    await db
      .update(jobs)
      .set({
        status: "failed",
        error: "Could not reach the job queue. Please try again.",
        errorCode: "internal_error",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, row.id));

    log.error("enqueue failed", {
      jobId: row.id,
      userId: input.userId,
      queue: input.queue,
      name: input.name,
      error,
    });
    throw error;
  }

  return { id: row.id, queue: input.queue, name: input.name, status: "queued" };
}

/**
 * Mark a job as started. Called by the worker, once per attempt.
 *
 * Classified (§14): this is one of the few places where "database failure" versus
 * "internal error" changes what happens next. The worker's `shouldRetry()` treats
 * an unclassified `Error` as retryable, so a dropped connection here already gets
 * another attempt — but so does a permanent fault, which then burns the whole
 * attempt budget before the operator sees anything. `withDatabaseErrors` makes the
 * distinction explicit rather than accidental.
 */
export async function markJobRunning(
  jobId: string,
  attempt: number,
  statusMessage?: string,
): Promise<void> {
  await withDatabaseErrors("mark job running", async () => {
    await db
      .update(jobs)
      .set({
        status: "running",
        attempt,
        startedAt: new Date(),
        // A retry must clear the previous attempt's error, or the UI shows a stale
        // failure beside a running job.
        error: null,
        errorCode: null,
        notConfiguredProvider: null,
        ...(statusMessage === undefined ? {} : { statusMessage }),
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, jobId));
  });
}

/**
 * Report progress (§37, §38).
 *
 * Progress is only ever written from real work completed. Where a provider gives
 * no percentage the caller passes no number and the UI shows an indeterminate
 * indicator — §42 forbids inventing one.
 */
export async function reportProgress(
  jobId: string,
  progress: number | null,
  statusMessage?: string,
): Promise<void> {
  await db
    .update(jobs)
    .set({
      ...(progress === null
        ? {}
        : { progress: Math.max(0, Math.min(100, Math.round(progress))) }),
      ...(statusMessage === undefined ? {} : { statusMessage }),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));
}

/**
 * Mark a job succeeded, recording its result and duration.
 *
 * Classified for the same reason as `markJobRunning`, with a sharper consequence:
 * the handler's work is already done and its side effects are already committed, so
 * a failure to record the success is the case where a retry duplicates real work.
 * A transient fault should retry (the row is still `running`, and every handler is
 * idempotent by §10); a permanent one should stop and be visible instead.
 */
export async function markJobSucceeded(
  jobId: string,
  result?: Record<string, unknown>,
  statusMessage?: string,
): Promise<void> {
  const finishedAt = new Date();
  await withDatabaseErrors("mark job succeeded", async () => {
    await db
      .update(jobs)
      .set({
        status: "succeeded",
        progress: 100,
        result: result ?? {},
        finishedAt,
        // Computed in SQL so the duration reflects the stored start time rather
        // than a timestamp this process happens to hold.
        durationMs: sql`GREATEST(0, (EXTRACT(EPOCH FROM (${finishedAt.toISOString()}::timestamptz - COALESCE(${jobs.startedAt}, ${jobs.createdAt}))) * 1000)::int)`,
        error: null,
        errorCode: null,
        ...(statusMessage === undefined ? {} : { statusMessage }),
        updatedAt: finishedAt,
      })
      .where(eq(jobs.id, jobId));
  });
}

/**
 * Mark a job failed.
 *
 * `blocked_not_configured` is a distinct terminal status rather than a failure,
 * because §48 requires a missing credential to read as a configuration state the
 * user can act on — not an error that looks like a bug in Tally. It also must not
 * be retried: no number of attempts will conjure an API key.
 *
 * An exhausted provider balance is classified the same way. The credential is
 * valid, so it is not an auth failure, and retrying an empty account just
 * produces identical failures — it is a state an operator clears.
 */
export async function markJobFailed(
  jobId: string,
  error: unknown,
  options: { willRetry?: boolean } = {},
): Promise<void> {
  const notConfigured = isAppError(error) && isBlockingCode(error.code);

  const provider =
    notConfigured && typeof error.details?.["provider"] === "string"
      ? (error.details["provider"] as string)
      : null;

  // A retry is still pending: keep the row `running` so the UI shows work in
  // progress with a note, rather than flashing "Failed" and then un-failing.
  const status: JobStatus = notConfigured
    ? "blocked_not_configured"
    : options.willRetry
      ? "running"
      : "failed";

  const finishedAt = new Date();
  const terminal = status !== "running";

  await db
    .update(jobs)
    .set({
      status,
      error: userMessageOf(error),
      errorCode: errorCodeOf(error),
      notConfiguredProvider: provider,
      ...(terminal
        ? {
            finishedAt,
            durationMs: sql`GREATEST(0, (EXTRACT(EPOCH FROM (${finishedAt.toISOString()}::timestamptz - COALESCE(${jobs.startedAt}, ${jobs.createdAt}))) * 1000)::int)`,
          }
        : {}),
      updatedAt: finishedAt,
    })
    .where(eq(jobs.id, jobId));
}

export interface JobView {
  id: string;
  queue: string;
  name: string;
  stage: string | null;
  status: JobStatus;
  progress: number;
  statusMessage: string | null;
  attempt: number;
  maxAttempts: number;
  error: string | null;
  errorCode: string | null;
  notConfiguredProvider: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

const JOB_VIEW_COLUMNS = {
  id: jobs.id,
  queue: jobs.queue,
  name: jobs.name,
  stage: jobs.stage,
  status: jobs.status,
  progress: jobs.progress,
  statusMessage: jobs.statusMessage,
  attempt: jobs.attempt,
  maxAttempts: jobs.maxAttempts,
  error: jobs.error,
  errorCode: jobs.errorCode,
  notConfiguredProvider: jobs.notConfiguredProvider,
  createdAt: jobs.createdAt,
  startedAt: jobs.startedAt,
  finishedAt: jobs.finishedAt,
} as const;

/** One job, scoped to its owner. Tenant isolation is in the predicate (§34). */
export async function getJob(
  userId: string,
  jobId: string,
): Promise<JobView | null> {
  const rows = await db
    .select(JOB_VIEW_COLUMNS)
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Active jobs for a channel, for the status polling endpoint. */
export async function getActiveJobs(
  userId: string,
  channelId: string,
): Promise<JobView[]> {
  return db
    .select(JOB_VIEW_COLUMNS)
    .from(jobs)
    .where(
      and(
        eq(jobs.userId, userId),
        eq(jobs.channelId, channelId),
        inArray(jobs.status, ["queued", "running"]),
      ),
    );
}

/**
 * Active jobs for one project (Phase 11 §4, §18).
 *
 * The channel-less counterpart of `getActiveJobs`. A project created from a
 * pasted link has no channel, so there is no channel to poll by — but every job
 * it enqueues carries its `projectId`, which is a *narrower* scope than the
 * channel and therefore the better one to show a single video's progress from.
 *
 * §18 requires progress to come from the real job records, and this is the read
 * that makes that possible without a channel. Owner-scoped in the predicate, like
 * every other read here (§34).
 */
export async function getActiveProjectJobs(
  userId: string,
  projectId: string,
): Promise<JobView[]> {
  return db
    .select(JOB_VIEW_COLUMNS)
    .from(jobs)
    .where(
      and(
        eq(jobs.userId, userId),
        eq(jobs.projectId, projectId),
        inArray(jobs.status, ["queued", "running"]),
      ),
    )
    .orderBy(sql`${jobs.createdAt} DESC`);
}

/**
 * True when a job of this name is already queued or running for the channel.
 *
 * Used to refuse a second research run on the same channel: the first would have
 * spent the quota anyway, and two concurrent runs writing results for the same
 * channel produce a confusing half-merged view.
 *
 * Since Phase 11 (§4) work can exist without a channel, so the scope is a
 * parameter rather than always the channel:
 *
 *  - `channelId` set  — the original behaviour, unchanged.
 *  - `projectId` set  — scope to one project. The right narrowing for a
 *    channel-less project: it still stops a double-submit on *this* video without
 *    stopping the user from working on another link at the same time.
 *
 * Passing neither would match every channel-less job of that name for the user,
 * which is a broader lock than any caller wants, so it is refused rather than
 * silently applied.
 */
export async function hasActiveJob(
  userId: string,
  channelId: string | null,
  name: string,
  projectId?: string,
): Promise<boolean> {
  if (!channelId && !projectId) {
    throw new Error(
      "hasActiveJob needs a channelId or a projectId to scope the check",
    );
  }

  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.userId, userId),
        ...(channelId ? [eq(jobs.channelId, channelId)] : []),
        ...(projectId ? [eq(jobs.projectId, projectId)] : []),
        eq(jobs.name, name),
        inArray(jobs.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

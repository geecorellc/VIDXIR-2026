/**
 * Project persistence and transitions (§20, §45).
 *
 * All state changes go through `transition()`, which validates against the state
 * machine and writes a `project_events` row in the same transaction as the
 * status update. There is deliberately no "just set the status" escape hatch:
 * every path that could produce a wrong status is the path that has to prove the
 * transition is legal.
 */
import "server-only";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  ideas,
  projectEvents,
  projects,
  usageCounters,
} from "@/lib/db/schema";
import { ForbiddenError, InvalidStateTransitionError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { newTraceId } from "@/lib/logger";
import { PIPELINE_STAGES, type PipelineStage } from "@/lib/stages";
import {
  canTransition,
  projectReach,
  type ProjectStatus,
} from "@/lib/projects/state-machine";

const log = logger.child({ component: "projects" });

export interface ProjectRecord {
  id: string;
  userId: string;
  channelId: string;
  ideaId: string | null;
  title: string;
  status: ProjectStatus;
  currentStage: PipelineStage | null;
  progress: number;
  failedStage: PipelineStage | null;
  errorMessage: string | null;
  errorCode: string | null;
  failedAt: Date | null;
  retryCount: number;
  origin: string;
  traceId: string | null;
  targetDurationSeconds: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = {
  id: projects.id,
  userId: projects.userId,
  channelId: projects.channelId,
  ideaId: projects.ideaId,
  title: projects.title,
  status: projects.status,
  currentStage: projects.currentStage,
  progress: projects.progress,
  failedStage: projects.failedStage,
  errorMessage: projects.errorMessage,
  errorCode: projects.errorCode,
  failedAt: projects.failedAt,
  retryCount: projects.retryCount,
  origin: projects.origin,
  traceId: projects.traceId,
  targetDurationSeconds: projects.targetDurationSeconds,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
} as const;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Load a project the user owns. Throws rather than returning null (§34). */
export async function getProject(
  userId: string,
  projectId: string,
): Promise<ProjectRecord> {
  const rows = await db
    .select(COLUMNS)
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);

  const row = rows[0];
  if (!row) throw new ForbiddenError("Project not found or not accessible.");
  return row;
}

/**
 * The project the dashboard's stage screens operate on: the most recently
 * updated project that has not been published yet. The prototype held a single
 * `project` object in state; this is the persisted equivalent.
 */
export async function getActiveProject(
  userId: string,
  channelId?: string,
): Promise<ProjectRecord | null> {
  const rows = await db
    .select(COLUMNS)
    .from(projects)
    .where(
      and(
        eq(projects.userId, userId),
        ne(projects.status, "PUBLISHED"),
        ...(channelId ? [eq(projects.channelId, channelId)] : []),
      ),
    )
    .orderBy(desc(projects.updatedAt))
    .limit(1);

  return rows[0] ?? null;
}

export async function listProjects(
  userId: string,
  options: { channelId?: string; statuses?: ProjectStatus[]; limit?: number } = {},
): Promise<ProjectRecord[]> {
  const { channelId, statuses, limit = 50 } = options;
  return db
    .select(COLUMNS)
    .from(projects)
    .where(
      and(
        eq(projects.userId, userId),
        ...(channelId ? [eq(projects.channelId, channelId)] : []),
        ...(statuses && statuses.length > 0
          ? [inArray(projects.status, statuses)]
          : []),
      ),
    )
    .orderBy(desc(projects.updatedAt))
    .limit(Math.min(limit, 200));
}

export interface ProjectEvent {
  fromStatus: ProjectStatus | null;
  toStatus: ProjectStatus;
  stage: PipelineStage | null;
  message: string | null;
  createdAt: Date;
}

/** Transition history, shown on the video status screen (§37). */
export async function listEvents(
  userId: string,
  projectId: string,
  limit = 50,
): Promise<ProjectEvent[]> {
  return db
    .select({
      fromStatus: projectEvents.fromStatus,
      toStatus: projectEvents.toStatus,
      stage: projectEvents.stage,
      message: projectEvents.message,
      createdAt: projectEvents.createdAt,
    })
    .from(projectEvents)
    .where(
      and(
        eq(projectEvents.projectId, projectId),
        eq(projectEvents.userId, userId),
      ),
    )
    .orderBy(desc(projectEvents.createdAt))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface CreateProjectInput {
  userId: string;
  channelId: string;
  title: string;
  ideaId?: string | null;
  origin?: "manual" | "automation";
  targetDurationSeconds?: number | null;
}

/**
 * Create a project in the IDEA state and increment the month's usage counter in
 * the same transaction, so the quota reflects work actually started.
 *
 * Plan limits are checked by the caller (`assertCanStartVideo`) before this runs;
 * the counter here is the record, not the gate.
 */
export async function createProject(
  input: CreateProjectInput,
): Promise<ProjectRecord> {
  const traceId = newTraceId();
  const period = currentPeriod();

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(projects)
      .values({
        userId: input.userId,
        channelId: input.channelId,
        ideaId: input.ideaId ?? null,
        title: input.title,
        status: "IDEA",
        origin: input.origin ?? "manual",
        traceId,
        targetDurationSeconds: input.targetDurationSeconds ?? null,
      })
      .returning(COLUMNS);

    if (!row) throw new Error("Failed to create project");

    await tx.insert(projectEvents).values({
      projectId: row.id,
      userId: input.userId,
      fromStatus: null,
      toStatus: "IDEA",
      message: `Project created from ${input.origin ?? "manual"} trigger`,
    });

    await tx
      .insert(usageCounters)
      .values({ userId: input.userId, period, videosStarted: 1 })
      .onConflictDoUpdate({
        target: [usageCounters.userId, usageCounters.period],
        set: {
          videosStarted: sql`${usageCounters.videosStarted} + 1`,
          updatedAt: new Date(),
        },
      });

    // Mark the source idea as used so research does not re-offer it.
    if (input.ideaId) {
      await tx
        .update(ideas)
        .set({ state: "used", updatedAt: new Date() })
        .where(
          and(eq(ideas.id, input.ideaId), eq(ideas.userId, input.userId)),
        );
    }

    return row;
  });

  log.info("project created", {
    projectId: created.id,
    channelId: input.channelId,
    traceId,
  });
  return created;
}

/** `YYYY-MM` in UTC — the key `usage_counters` is bucketed by. */
export function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export interface TransitionOptions {
  stage?: PipelineStage | null;
  message?: string;
  /** Extra context recorded on the event row, e.g. provider or job id. */
  meta?: Record<string, unknown>;
  /** Set when moving to FAILED. */
  error?: { code: string; message: string; stage?: PipelineStage };
  /** Overall progress 0-100. Omit to leave it derived/unchanged. */
  progress?: number;
  /** Bump the retry counter (used when re-entering a generating state). */
  incrementRetry?: boolean;
}

/**
 * Move a project to a new status.
 *
 * Concurrency: the UPDATE carries the expected current status in its WHERE
 * clause, so two workers racing to advance the same project produce one winner
 * and one InvalidStateTransitionError rather than a lost update.
 */
export async function transition(
  userId: string,
  projectId: string,
  to: ProjectStatus,
  options: TransitionOptions = {},
): Promise<ProjectRecord> {
  const current = await getProject(userId, projectId);

  if (!canTransition(current.status, to)) {
    throw new InvalidStateTransitionError(current.status, to);
  }

  const now = new Date();

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(projects)
      .set({
        status: to,
        currentStage:
          options.stage !== undefined ? options.stage : current.currentStage,
        ...(options.progress !== undefined
          ? { progress: clampProgress(options.progress) }
          : {}),
        ...(to === "FAILED"
          ? {
              failedStage: options.error?.stage ?? current.currentStage,
              errorCode: options.error?.code ?? null,
              errorMessage: options.error?.message ?? null,
              failedAt: now,
            }
          : {
              // Leaving FAILED clears the previous failure so the UI does not
              // keep showing a resolved error next to live progress.
              failedStage: null,
              errorCode: null,
              errorMessage: null,
              failedAt: null,
            }),
        ...(options.incrementRetry
          ? { retryCount: sql`${projects.retryCount} + 1` }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.userId, userId),
          // Optimistic guard against a concurrent transition.
          eq(projects.status, current.status),
        ),
      )
      .returning(COLUMNS);

    if (!row) {
      // Someone else moved it between our read and our write.
      throw new InvalidStateTransitionError(current.status, to);
    }

    await tx.insert(projectEvents).values({
      projectId,
      userId,
      fromStatus: current.status,
      toStatus: to,
      stage: options.stage ?? current.currentStage,
      message: options.message ?? options.error?.message ?? null,
      meta: options.meta ?? null,
    });

    return row;
  });

  log.info("project transition", {
    projectId,
    fromStatus: current.status,
    toStatus: to,
    stage: updated.currentStage ?? undefined,
    traceId: current.traceId ?? undefined,
  });

  return updated;
}

/** Record a failure. Thin wrapper so worker code reads clearly. */
export async function failProject(
  userId: string,
  projectId: string,
  error: { code: string; message: string; stage?: PipelineStage },
): Promise<ProjectRecord> {
  return transition(userId, projectId, "FAILED", { error });
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Overall progress derived from which stages are finished (§42: real progress
 * only). `completed` is the set of stages that have actually produced their
 * output; the weights come from `PIPELINE_STAGES`.
 */
export function deriveProgress(completed: readonly PipelineStage[]): number {
  const done = new Set(completed);
  const total = PIPELINE_STAGES.reduce(
    (sum, stage) => sum + (done.has(stage.stage) ? stage.weight : 0),
    0,
  );
  return clampProgress(total);
}

/** Update only the progress figure — used by render polling. */
export async function setProgress(
  userId: string,
  projectId: string,
  progress: number,
): Promise<void> {
  await db
    .update(projects)
    .set({ progress: clampProgress(progress), updatedAt: new Date() })
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
}

/** How far the user's current project has got, for sidebar gating. */
export async function reachOf(userId: string): Promise<
  "none" | "idea" | "script" | "video"
> {
  const active = await getActiveProject(userId);
  if (!active) return "none";
  return projectReach(active.status);
}

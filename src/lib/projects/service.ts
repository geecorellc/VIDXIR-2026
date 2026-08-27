/**
 * Project persistence and transitions (§20, §45).
 *
 * All state changes go through `transition()`, which validates against the state
 * machine and writes a `project_events` row in the same transaction as the
 * status update. There is deliberately no "just set the status" escape hatch:
 * every path that could produce a wrong status is the path that has to prove the
 * transition is legal.
 */
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  ideas,
  projectEvents,
  projects,
  usageCounters,
} from "@/lib/db/schema";
import {
  ConflictError,
  ForbiddenError,
  InvalidStateTransitionError,
  PlanLimitError,
} from "@/lib/errors";
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
  /** Null for a project created from a pasted YouTube link (Phase 11 §4). */
  channelId: string | null;
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
  /** Phase 11 §9-§10, §16. Null on any project that predates the choice. */
  generationMode: string | null;
  generationModel: string | null;
  videoFormat: string | null;
  /** The pasted video this project was seeded from — provenance only (§22). */
  sourceVideoId: string | null;
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
  generationMode: projects.generationMode,
  generationModel: projects.generationModel,
  videoFormat: projects.videoFormat,
  sourceVideoId: projects.sourceVideoId,
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
  /**
   * Null creates a channel-less project (Phase 11 §4).
   *
   * Optional rather than removed: every Phase 1-10 caller passes a validated
   * channel id and behaves identically. A link-mode project passes null, and the
   * publish path is what refuses it later.
   */
  channelId: string | null;
  title: string;
  ideaId?: string | null;
  /** `youtube_link` marks a project seeded by a pasted URL (§4). */
  origin?: "manual" | "automation" | "youtube_link";
  targetDurationSeconds?: number | null;
  /** Phase 11 §9-§10, §16. Server-validated before it reaches here. */
  generationMode?: string | null;
  generationModel?: string | null;
  videoFormat?: string | null;
  /** Provenance for a link-mode project. Never read as generation input (§22). */
  sourceVideoId?: string | null;
  /**
   * The plan's monthly video allowance, or null for unlimited.
   *
   * Passed in rather than resolved here so this module does not depend on plan
   * enforcement — but supplied by every caller, because it is what makes the
   * counter increment below atomic against the limit. See the note on the upsert.
   */
  maxVideosPerMonth: number | null;
}

/**
 * Create a project in the IDEA state and increment the month's usage counter in
 * the same transaction, so the quota reflects work actually started.
 *
 * The caller still runs `assertCanStartVideo` first — that is what produces the
 * useful error before any work is done, and it reads the same counter. But that
 * check is a read→decision→write, and two simultaneous starts both pass it (§13).
 * So the increment here carries the limit as a predicate and is the actual gate:
 * the caller's check is the good error message, this one is the guarantee.
 */
export async function createProject(
  input: CreateProjectInput,
): Promise<ProjectRecord> {
  const traceId = newTraceId();
  const period = currentPeriod();

  const created = await db.transaction(async (tx) => {
    /**
     * Claim the month's quota slot first, conditionally (§13).
     *
     * Ordered before the project insert so a refusal costs nothing: the
     * transaction rolls back having written no row and no event.
     *
     * `setWhere` makes the UPDATE branch of the upsert conditional on the stored
     * count still being below the allowance. Under two concurrent starts at the
     * boundary, both transactions contend on the same `(userId, period)` row — the
     * second blocks on the first's lock, re-evaluates the predicate against the
     * *committed* value, and its update matches nothing. `returning` is then
     * empty, which is how the loser learns it lost.
     *
     * This is the same shape as the automation slot claim: a compare-and-swap
     * predicate inside the write, rather than a check before it.
     */
    if (input.maxVideosPerMonth !== null) {
      const claimed = await tx
        .insert(usageCounters)
        .values({ userId: input.userId, period, videosStarted: 1 })
        .onConflictDoUpdate({
          target: [usageCounters.userId, usageCounters.period],
          set: {
            videosStarted: sql`${usageCounters.videosStarted} + 1`,
            updatedAt: new Date(),
          },
          setWhere: sql`${usageCounters.videosStarted} < ${input.maxVideosPerMonth}`,
        })
        .returning({ videosStarted: usageCounters.videosStarted });

      if (!claimed[0]) {
        throw new PlanLimitError(
          `Your plan includes ${input.maxVideosPerMonth} videos a month and you have used all of them. Upgrade for unlimited videos.`,
          {
            limit: input.maxVideosPerMonth,
            used: input.maxVideosPerMonth,
            tier: "unknown",
            resource: "videos",
          },
        );
      }
    }

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
        generationMode: input.generationMode ?? null,
        generationModel: input.generationModel ?? null,
        videoFormat: input.videoFormat ?? null,
        sourceVideoId: input.sourceVideoId ?? null,
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

    // Unlimited plans still need the counter maintained — the dashboard reports
    // it, and a tier change must not start the month over — but with no predicate.
    if (input.maxVideosPerMonth === null) {
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
    }

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
    channelId: input.channelId ?? undefined,
    traceId,
  });
  return created;
}

// ---------------------------------------------------------------------------
// Configuration — the angle and the generation choice (Phase 11 §7, §9, §10)
// ---------------------------------------------------------------------------

export interface ConfigureProjectInput {
  userId: string;
  projectId: string;
  /**
   * The chosen angle. Undefined leaves the current one; null is not accepted,
   * because "unselect the angle" is not a step in the flow and would leave a
   * project the script stage cannot brief.
   */
  ideaId?: string;
  /** Already validated by `validateSelection` — never a raw request field. */
  generationMode?: string;
  generationModel?: string | null;
  videoFormat?: string;
}

/**
 * Statuses in which the angle or the generation method may still be changed.
 *
 * Before a script exists (IDEA), between a script and a build (SCRIPT_READY), and
 * after something went wrong (FAILED). Deliberately *not* mid-generation or after
 * assets exist: switching a project from stock to AI video once the visuals stage
 * has run would leave a video whose clips were made one way and whose record says
 * the other, which is exactly the kind of quiet inconsistency §42 forbids.
 */
const CONFIGURABLE_STATUSES: readonly ProjectStatus[] = [
  "IDEA",
  "SCRIPT_READY",
  "FAILED",
];

/**
 * Attach an angle and/or a generation choice to an existing project (§7, §9).
 *
 * Link mode needs this because its project row is created *before* the research
 * that produces the angles: the project is what scopes the research job, and the
 * user chooses from the results afterwards. Channel mode creates the project from
 * an already-chosen idea and never calls this.
 *
 * The generation fields arrive pre-validated — `validateSelection` has already
 * decided the mode exists, the model is configured, and the caller's plan includes
 * it. What this function is responsible for is the *ownership* half: the idea must
 * belong to this user and to the same channel as the project (both null in link
 * mode), which is what stops an idea id from another tenant or another channel
 * being written onto a project (§34).
 */
export async function configureProject(
  input: ConfigureProjectInput,
): Promise<ProjectRecord> {
  const project = await getProject(input.userId, input.projectId);

  if (!CONFIGURABLE_STATUSES.includes(project.status)) {
    throw new ConflictError(
      "This video has already started building. Start a new video to change the " +
        "angle or the generation method.",
    );
  }

  return db.transaction(async (tx) => {
    let ideaId = project.ideaId;

    if (input.ideaId && input.ideaId !== project.ideaId) {
      const rows = await tx
        .select({
          id: ideas.id,
          title: ideas.title,
          channelId: ideas.channelId,
          state: ideas.state,
        })
        .from(ideas)
        .where(
          and(eq(ideas.id, input.ideaId), eq(ideas.userId, input.userId)),
        )
        .limit(1);

      const idea = rows[0];
      // Same message for "not yours" and "does not exist", so the endpoint cannot
      // be used to test which idea ids are real.
      if (!idea) throw new ForbiddenError("Angle not found or not accessible.");

      // A channel-mode idea must not land on a channel-less project, or on a
      // project belonging to a different channel: both would cross a boundary the
      // research was scoped by (§34).
      if ((idea.channelId ?? null) !== (project.channelId ?? null)) {
        throw new ForbiddenError("Angle not found or not accessible.");
      }

      ideaId = idea.id;

      await tx
        .update(ideas)
        .set({ state: "used", updatedAt: new Date() })
        .where(and(eq(ideas.id, idea.id), eq(ideas.userId, input.userId)));

      // The title follows the chosen angle. The project was created with a
      // placeholder derived from the source link, and leaving it would mean every
      // screen downstream naming somebody else's video.
      await tx
        .update(projects)
        .set({ title: idea.title })
        .where(eq(projects.id, project.id));
    }

    const [row] = await tx
      .update(projects)
      .set({
        ideaId,
        ...(input.generationMode === undefined
          ? {}
          : { generationMode: input.generationMode }),
        ...(input.generationModel === undefined
          ? {}
          : { generationModel: input.generationModel }),
        ...(input.videoFormat === undefined
          ? {}
          : { videoFormat: input.videoFormat }),
        updatedAt: new Date(),
      })
      .where(
        and(eq(projects.id, project.id), eq(projects.userId, input.userId)),
      )
      .returning(COLUMNS);

    if (!row) throw new ForbiddenError("Project not found or not accessible.");

    await tx.insert(projectEvents).values({
      projectId: row.id,
      userId: input.userId,
      fromStatus: project.status,
      toStatus: project.status,
      message: input.ideaId
        ? "Angle and generation method selected"
        : "Generation method selected",
      meta: {
        generationMode: row.generationMode,
        generationModel: row.generationModel,
        videoFormat: row.videoFormat,
      },
    });

    return row;
  });
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

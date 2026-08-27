/**
 * Script generation, versioning and approval (§9, §20, §45).
 *
 * Split the same way research is: `startScriptGeneration()` runs in the request
 * and returns once a job is queued; `executeScriptGeneration()` runs in the
 * worker and makes the model call. §10 forbids a multi-second provider call
 * inside a request handler, and §45 requires the script to be there whether or
 * not the tab stayed open.
 *
 * Two decisions are worth stating outright:
 *
 *  - **Versions are append-only.** Regenerating writes version N+1 and repoints
 *    `scripts.active_version_id`; it never overwrites. A user who regenerates and
 *    preferred the previous draft has not lost it, and §9's "store scripts with
 *    versioning" is a real guarantee rather than a column that happens to say 2.
 *  - **Approval is a separate, explicit act.** Generation moves the project to
 *    SCRIPT_READY, not to ASSETS_GENERATING. Nothing downstream spends money on a
 *    voiceover or a render until a human (or an explicit autopilot policy) has
 *    said yes, which is what §37's honesty about state costs in practice.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  brandKits,
  channelSettings,
  channels,
  ideas,
  researchResults,
  scriptVersions,
  scripts,
} from "@/lib/db/schema";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  errorCodeOf,
  userMessageOf,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { queuePriorityFor } from "@/lib/plans/enforce";
import { aiModelName, aiProviderName, generateJson } from "@/lib/providers/ai";
import { enqueue, hasActiveJob, reportProgress } from "@/lib/queue/jobs";
import { getProject, transition } from "@/lib/projects/service";
import { loadOwnPerformance } from "@/lib/research/signals";
import {
  SCRIPT_JSON_SCHEMA,
  SCRIPT_SYSTEM_PROMPT,
  ScriptDraftSchema,
  buildScriptPrompt,
  countSpokenWords,
  estimateDuration,
  type ScriptBrief,
  type ScriptDraft,
} from "@/lib/scripts/prompt";
import { generationPlanFor } from "@/lib/video/generation-plan";
import type { PlanTier } from "@/lib/plans";

const log = logger.child({ component: "scripts" });

/** The job name the worker dispatches on. */
export const SCRIPT_JOB_NAME = "script-generate";

/** Source titles shown to the writer as evidence of demand. */
const MAX_SOURCE_TITLES = 12;

/** Own past titles included for voice-matching. */
const MAX_OWN_TITLES = 8;

/** Ceiling on an operator's revision note, so it cannot become the prompt. */
const MAX_FEEDBACK_CHARS = 1_000;

export interface StartScriptInput {
  userId: string;
  projectId: string;
  tier: PlanTier;
  /** Free-text steer for a regeneration ("punchier hook"). */
  feedback?: string | null;
  traceId?: string | null;
}

export interface StartScriptResult {
  jobId: string;
  /** The version number this run will produce, so the UI can name it. */
  nextVersion: number;
}

/**
 * Queue a script generation for a project.
 *
 * Refuses when one is already running: a second run would spend a second set of
 * tokens to produce a draft the first was already producing, and both would race
 * to claim the same version number.
 */
export async function startScriptGeneration(
  input: StartScriptInput,
): Promise<StartScriptResult> {
  const project = await getProject(input.userId, input.projectId);

  if (project.status === "PUBLISHED") {
    throw new ConflictError(
      "This video has already been published. Start a new video to write a new script.",
    );
  }

  /**
   * Duplicate-job protection is per channel, or per project when there is none.
   *
   * `hasActiveJob` scopes by channel because writing two scripts for one channel at
   * once wastes tokens and races on the version number. A link-mode project has no
   * channel (Phase 11 §4), so the natural scope narrows to the project itself —
   * which still prevents the double-submit this guard exists for, and correctly
   * does *not* stop a user researching two pasted links at the same time.
   */
  if (
    await hasActiveJob(
      input.userId,
      project.channelId ?? null,
      SCRIPT_JOB_NAME,
      project.channelId ? undefined : project.id,
    )
  ) {
    throw new ConflictError(
      "A script is already being written. Wait for it to finish.",
    );
  }

  const feedback = normaliseFeedback(input.feedback);

  // Read the current version count before enqueueing so the UI can say "writing
  // v2" rather than discovering the number after the fact.
  const existing = await db
    .select({ version: scriptVersions.version })
    .from(scriptVersions)
    .innerJoin(scripts, eq(scripts.id, scriptVersions.scriptId))
    .where(
      and(
        eq(scripts.projectId, project.id),
        eq(scriptVersions.userId, input.userId),
      ),
    )
    .orderBy(desc(scriptVersions.version))
    .limit(1);

  const nextVersion = (existing[0]?.version ?? 0) + 1;

  // The transition happens before the enqueue, and deliberately so: if the queue
  // push fails the catch below moves the project to FAILED, which is a state the
  // user can see and retry. The reverse order could leave a worker writing a
  // script for a project still displayed as IDEA.
  await transition(input.userId, project.id, "SCRIPT_GENERATING", {
    stage: "SCRIPT",
    message: nextVersion === 1 ? "Writing the script" : `Rewriting (v${nextVersion})`,
    progress: 5,
    incrementRetry: project.status === "FAILED",
  });

  try {
    const job = await enqueue({
      queue: "pipeline",
      name: SCRIPT_JOB_NAME,
      userId: input.userId,
      channelId: project.channelId,
      projectId: project.id,
      stage: "SCRIPT",
      payload: {
        projectId: project.id,
        ...(feedback ? { feedback } : {}),
      },
      priority: queuePriorityFor(input.tier),
      traceId: input.traceId ?? project.traceId,
      statusMessage: "Queued",
    });

    return { jobId: job.id, nextVersion };
  } catch (error) {
    await transition(input.userId, project.id, "FAILED", {
      stage: "SCRIPT",
      error: {
        code: "internal_error",
        message: "Could not reach the job queue. Please try again.",
        stage: "SCRIPT",
      },
    });
    throw error;
  }
}

export interface ExecuteScriptInput {
  userId: string;
  projectId: string;
  jobId: string;
  feedback?: string | null;
  traceId?: string | null;
}

export interface ExecuteScriptResult {
  scriptId: string;
  versionId: string;
  version: number;
  wordCount: number;
  estimatedDurationSeconds: number;
}

/**
 * Generate and store a script version. Worker-only.
 *
 * A failure moves the project to FAILED with the real reason and rethrows, so the
 * worker decides on a retry. The project is never left in SCRIPT_GENERATING —
 * §30's rule against a UI stuck on "Generating" is enforced here, not in the
 * component.
 */
export async function executeScriptGeneration(
  input: ExecuteScriptInput,
): Promise<ExecuteScriptResult> {
  const startedAt = Date.now();

  try {
    const brief = await buildBrief(input.userId, input.projectId);

    await reportProgress(input.jobId, 15, "Reading the brief");

    const draft = await generateJson({
      system: SCRIPT_SYSTEM_PROMPT,
      prompt: buildScriptPrompt({
        ...brief,
        feedback: normaliseFeedback(input.feedback),
      }),
      schema: ScriptDraftSchema,
      jsonSchema: SCRIPT_JSON_SCHEMA,
      // A 10-minute script is ~1,500 spoken words, and the JSON carries talking
      // points and headings on top of that. 16k leaves room without inviting a
      // truncated object.
      maxTokens: 16_000,
      usage: {
        operation: "script.generate",
        userId: input.userId,
        projectId: input.projectId,
        jobId: input.jobId,
        traceId: input.traceId ?? null,
      },
    });

    await reportProgress(input.jobId, 80, "Saving the draft");

    const stored = await persistScriptVersion({
      userId: input.userId,
      projectId: input.projectId,
      draft,
      source: "ai",
    });

    await transition(input.userId, input.projectId, "SCRIPT_READY", {
      stage: "SCRIPT",
      message: `Script v${stored.version} ready for review`,
      progress: 20,
      meta: { versionId: stored.versionId, wordCount: stored.wordCount },
    });

    log.info("script generated", {
      userId: input.userId,
      projectId: input.projectId,
      jobId: input.jobId,
      traceId: input.traceId ?? undefined,
      stage: "SCRIPT",
      status: "succeeded",
      durationMs: Date.now() - startedAt,
      version: stored.version,
      wordCount: stored.wordCount,
    });

    return stored;
  } catch (error) {
    // The project carries the failure so every screen agrees on why nothing
    // happened. `markJobFailed` records the job side; this records the product
    // side, and the two are read by different screens.
    await failScriptStage(input.userId, input.projectId, error);
    throw error;
  }
}

/**
 * Record a script-stage failure on the project.
 *
 * Tolerant of an illegal transition: if the project has already been moved (a
 * cancellation, a concurrent retry), the original provider error is the one worth
 * reporting, and masking it with "invalid transition" would hide the cause.
 */
async function failScriptStage(
  userId: string,
  projectId: string,
  error: unknown,
): Promise<void> {
  try {
    await transition(userId, projectId, "FAILED", {
      stage: "SCRIPT",
      error: {
        code: errorCodeOf(error),
        message: userMessageOf(error),
        stage: "SCRIPT",
      },
    });
  } catch (transitionError) {
    log.error("could not record script failure on project", {
      userId,
      projectId,
      error: transitionError,
    });
  }
}

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

/**
 * Assemble everything the writer needs.
 *
 * All of it is read from the database rather than passed in: the job payload
 * arrives over Redis and is data, not authority, and a brief assembled from
 * request input would let a caller choose which channel's brand voice to use.
 */
export async function buildBrief(
  userId: string,
  projectId: string,
): Promise<ScriptBrief> {
  const project = await getProject(userId, projectId);

  /**
   * Channel context, when there is a channel (Phase 11 §4).
   *
   * All three lookups supply *voice*: who the channel talks to, in what style, with
   * what CTA. A link-mode project has none of that yet, and the brief is still
   * complete without it — the topic, the chosen angle and the research findings are
   * what the script is actually written from. Every field below is already nullable
   * because a channel whose settings screen was never filled in produces the same
   * empty brief, so the model has no new case to handle.
   */
  const channelId = project.channelId;
  const [channelRows, settingsRows, brandRows] = channelId
    ? await Promise.all([
        db
          .select({ title: channels.title })
          .from(channels)
          .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
          .limit(1),
        db
          .select({
            niche: channelSettings.niche,
            targetAudience: channelSettings.targetAudience,
            contentLanguage: channelSettings.contentLanguage,
            preferredLengthSeconds: channelSettings.preferredLengthSeconds,
            contentStyle: channelSettings.contentStyle,
          })
          .from(channelSettings)
          .where(
            and(
              eq(channelSettings.channelId, channelId),
              eq(channelSettings.userId, userId),
            ),
          )
          .limit(1),
        db
          .select({
            brandName: brandKits.brandName,
            defaultCta: brandKits.defaultCta,
          })
          .from(brandKits)
          .where(
            and(
              eq(brandKits.channelId, channelId),
              eq(brandKits.userId, userId),
            ),
          )
          .limit(1),
      ])
    : ([[], [], []] as const);

  const settings = settingsRows[0];

  const idea = project.ideaId
    ? await loadIdea(userId, project.ideaId)
    : null;

  const sourceTitles = idea
    ? await loadSourceTitles(userId, idea.sourceResultIds)
    : [];

  // "What has worked for you before" needs a channel to have a before. Empty for
  // a link-mode project, which the prompt already handles — a new channel's first
  // script has the same empty list.
  const own = channelId ? await loadOwnPerformance(userId, channelId) : [];

  return {
    projectTitle: project.title,
    channelTitle: channelRows[0]?.title ?? null,
    niche: settings?.niche ?? null,
    targetAudience: settings?.targetAudience ?? null,
    contentLanguage: settings?.contentLanguage ?? "en-US",
    contentStyle: settings?.contentStyle ?? null,
    // The project's own target wins when set — a user who asked for a 3-minute
    // video on this one video meant this one video, not the channel default.
    targetDurationSeconds:
      project.targetDurationSeconds ?? settings?.preferredLengthSeconds ?? 480,
    idea: idea
      ? {
          title: idea.title,
          angle: idea.angle ?? "",
          rationale: idea.rationale ?? "",
          topic: idea.topic ?? "",
          targetKeywords: idea.targetKeywords,
          hook: idea.hook,
          trendSignal: idea.trendSignal,
        }
      : null,
    sourceTitles,
    ownTopPerformers: own.slice(0, MAX_OWN_TITLES).map((v) => v.title),
    brand: {
      brandName: brandRows[0]?.brandName ?? null,
      defaultCta: brandRows[0]?.defaultCta ?? null,
    },
    generation: generationBrief(project),
  };
}

/**
 * How the video will be made, for the prompt (Phase 11 §8, §16).
 *
 * Returns null for a project with no stored choice — a pre-Phase-11 project, and
 * saying nothing is right: it will render stock, but the script was written without
 * that in mind and retrofitting the instruction changes nothing about the draft
 * already stored.
 *
 * Note the `catch`. `generationPlanFor` throws when a stored model has since been
 * removed or its credential rotated away, and that is the correct behaviour *in the
 * visuals stage*, which is about to spend money on it. Here it would fail the script
 * for a reason that has nothing to do with writing, so the choice is dropped from
 * the prompt and the visuals stage remains the place that reports it (§42).
 */
function generationBrief(project: {
  generationMode: string | null;
  generationModel: string | null;
  videoFormat: string | null;
}): ScriptBrief["generation"] {
  if (!project.generationMode) return null;

  try {
    const plan = generationPlanFor(project);
    return {
      mode: plan.mode,
      modelLabel: plan.model?.label ?? null,
      maxClipSeconds: plan.model?.maxClipSeconds ?? null,
      format: plan.format,
    };
  } catch (error) {
    log.warn("could not resolve the generation plan for the script brief", {
      error,
    });
    return null;
  }
}

async function loadIdea(userId: string, ideaId: string) {
  const rows = await db
    .select({
      title: ideas.title,
      angle: ideas.angle,
      rationale: ideas.rationale,
      topic: ideas.topic,
      targetKeywords: ideas.targetKeywords,
      sourceResultIds: ideas.sourceResultIds,
      hook: ideas.hook,
      trendSignal: ideas.trendSignal,
    })
    .from(ideas)
    .where(and(eq(ideas.id, ideaId), eq(ideas.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Titles of the public videos behind the idea.
 *
 * The `userId` predicate stays alongside the id filter: it is what stops a
 * forged id in a `source_result_ids` array from reading another tenant's
 * research (§34).
 */
async function loadSourceTitles(
  userId: string,
  sourceResultIds: string[],
): Promise<string[]> {
  if (sourceResultIds.length === 0) return [];

  const rows = await db
    .select({ title: researchResults.title })
    .from(researchResults)
    .where(
      and(
        eq(researchResults.userId, userId),
        // `inArray` with an empty list generates invalid SQL; the early return
        // above is what makes this safe.
        inArray(researchResults.id, sourceResultIds),
      ),
    )
    .limit(MAX_SOURCE_TITLES);

  return rows.map((r) => r.title);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface PersistScriptInput {
  userId: string;
  projectId: string;
  draft: ScriptDraft;
  /** `ai` for a generated draft, `user_edit` for a hand-edited one. */
  source: "ai" | "user_edit";
}

/**
 * Write a new script version and make it active.
 *
 * One transaction, and the version number is computed inside it from the rows
 * that exist rather than from a counter held elsewhere — two concurrent writes
 * cannot both claim v3, because the unique index on (script_id, version) refuses
 * the second.
 */
export async function persistScriptVersion(
  input: PersistScriptInput,
): Promise<ExecuteScriptResult> {
  const wordCount = countSpokenWords(input.draft);
  const estimated = estimateDuration(wordCount);

  return db.transaction(async (tx) => {
    // Upsert the script row. `onConflictDoUpdate` rather than a read-then-insert
    // so a regeneration racing a first generation cannot create two script rows
    // for one project — the unique index on project_id decides.
    const [script] = await tx
      .insert(scripts)
      .values({ projectId: input.projectId, userId: input.userId })
      .onConflictDoUpdate({
        target: scripts.projectId,
        set: { updatedAt: new Date() },
      })
      .returning({ id: scripts.id });

    if (!script) throw new Error("Failed to create script row.");

    const [latest] = await tx
      .select({ version: scriptVersions.version })
      .from(scriptVersions)
      .where(eq(scriptVersions.scriptId, script.id))
      .orderBy(desc(scriptVersions.version))
      .limit(1);

    const version = (latest?.version ?? 0) + 1;

    const [inserted] = await tx
      .insert(scriptVersions)
      .values({
        scriptId: script.id,
        userId: input.userId,
        version,
        title: input.draft.title,
        titleIdeas: input.draft.titleIdeas,
        hook: input.draft.hook,
        introduction: input.draft.introduction,
        sections: input.draft.sections,
        conclusion: input.draft.conclusion,
        cta: input.draft.cta,
        storyStructure: input.draft.storyStructure,
        references: input.draft.references,
        estimatedDurationSeconds: estimated,
        wordCount,
        source: input.source,
        // Recorded per version: with two transports the question "what wrote
        // this?" has to be answerable from the row, not inferred from today's
        // configuration (§29).
        provider: input.source === "ai" ? aiProviderName() : null,
        model: input.source === "ai" ? aiModelName() : null,
      })
      .returning({ id: scriptVersions.id });

    if (!inserted) throw new Error("Failed to store script version.");

    await tx
      .update(scripts)
      .set({
        activeVersionId: inserted.id,
        // A new version supersedes the approval: approving v1 does not approve
        // the v2 that replaced it, and letting it carry over would let a
        // regenerated script reach the video builder unreviewed (§42).
        approvedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(scripts.id, script.id));

    return {
      scriptId: script.id,
      versionId: inserted.id,
      version,
      wordCount,
      estimatedDurationSeconds: estimated,
    };
  });
}

/**
 * Approve the active script version.
 *
 * Returns the approved version so the caller can record what was approved. The
 * project transition to ASSETS_GENERATING is *not* done here — approval and
 * "start spending money on assets" are separate decisions, and Phase 5's video
 * build is the thing that makes the second one.
 */
export async function approveScript(
  userId: string,
  projectId: string,
): Promise<{ scriptId: string; versionId: string; version: number }> {
  const project = await getProject(userId, projectId);

  const rows = await db
    .select({
      scriptId: scripts.id,
      activeVersionId: scripts.activeVersionId,
      version: scriptVersions.version,
    })
    .from(scripts)
    .leftJoin(scriptVersions, eq(scriptVersions.id, scripts.activeVersionId))
    .where(
      and(eq(scripts.projectId, projectId), eq(scripts.userId, userId)),
    )
    .limit(1);

  const row = rows[0];
  if (!row?.activeVersionId || row.version === null) {
    throw new NotFoundError(
      "There is no script to approve yet. Generate one first.",
    );
  }

  if (project.status === "SCRIPT_GENERATING") {
    throw new ConflictError(
      "A new version is still being written. Wait for it to finish, then approve.",
    );
  }

  await db
    .update(scripts)
    .set({ approvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(scripts.id, row.scriptId), eq(scripts.userId, userId)));

  log.info("script approved", {
    userId,
    projectId,
    version: row.version,
    stage: "SCRIPT",
  });

  return {
    scriptId: row.scriptId,
    versionId: row.activeVersionId,
    version: row.version,
  };
}

/** Version history for a project, newest first. */
export async function listScriptVersions(
  userId: string,
  projectId: string,
): Promise<
  Array<{
    id: string;
    version: number;
    title: string;
    wordCount: number | null;
    estimatedDurationSeconds: number | null;
    source: string;
    isActive: boolean;
    createdAt: Date;
  }>
> {
  const rows = await db
    .select({
      id: scriptVersions.id,
      version: scriptVersions.version,
      title: scriptVersions.title,
      wordCount: scriptVersions.wordCount,
      estimatedDurationSeconds: scriptVersions.estimatedDurationSeconds,
      source: scriptVersions.source,
      activeVersionId: scripts.activeVersionId,
      createdAt: scriptVersions.createdAt,
    })
    .from(scriptVersions)
    .innerJoin(scripts, eq(scripts.id, scriptVersions.scriptId))
    .where(
      and(
        eq(scripts.projectId, projectId),
        eq(scriptVersions.userId, userId),
      ),
    )
    .orderBy(desc(scriptVersions.version));

  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    title: row.title,
    wordCount: row.wordCount,
    estimatedDurationSeconds: row.estimatedDurationSeconds,
    source: row.source,
    isActive: row.activeVersionId === row.id,
    createdAt: row.createdAt,
  }));
}

/**
 * Make an earlier version active again.
 *
 * Reverting is a real product need — a user regenerates, prefers the original,
 * and should not have to ask a model to reproduce it. Because versions are
 * append-only, this is just a pointer move.
 */
export async function activateScriptVersion(
  userId: string,
  projectId: string,
  versionId: string,
): Promise<{ version: number }> {
  const rows = await db
    .select({ scriptId: scripts.id, version: scriptVersions.version })
    .from(scriptVersions)
    .innerJoin(scripts, eq(scripts.id, scriptVersions.scriptId))
    .where(
      and(
        eq(scriptVersions.id, versionId),
        eq(scriptVersions.userId, userId),
        eq(scripts.projectId, projectId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError("That script version does not exist.");

  await db
    .update(scripts)
    .set({
      activeVersionId: versionId,
      // Switching versions clears approval for the same reason generating does:
      // what was approved is not what is now active.
      approvedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(scripts.id, row.scriptId), eq(scripts.userId, userId)));

  return { version: row.version };
}

/** Trim and bound an operator note. Empty becomes null, not "". */
function normaliseFeedback(feedback: string | null | undefined): string | null {
  if (typeof feedback !== "string") return null;
  const trimmed = feedback.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_FEEDBACK_CHARS) {
    throw new ValidationError(
      `Keep revision notes under ${MAX_FEEDBACK_CHARS} characters.`,
    );
  }
  return trimmed;
}

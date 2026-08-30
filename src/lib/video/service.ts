/**
 * The video pipeline (§10, §20, §31, §42).
 *
 * Seven stages between an approved script and a playable MP4: scene plan,
 * voiceover, visuals, music, captions, timeline, render. Each is a separate job,
 * and each **enqueues the next one when it finishes** rather than one long job
 * doing all seven.
 *
 * That chaining is the central design decision, and the reasons are worth
 * stating because a single job would be less code:
 *
 *  - A ten-minute render is minutes of work. One job means one failure loses all
 *    of it; separate jobs mean a render that fails retries the render, not the
 *    voiceover it already paid ElevenLabs for.
 *  - `jobs.stage` is what the studio screen displays. Seven rows is a real
 *    per-stage status list; one row can only ever say "working".
 *  - BullMQ retries per job. Stages have genuinely different retry profiles — a
 *    stock search that 429s should back off, a filter graph that ffmpeg rejected
 *    should not be attempted again.
 *
 * Progress is derived, never animated: `deriveProgress()` sums the weights of the
 * stages that have actually produced their output. A stage in flight contributes
 * nothing until it has, so the bar can sit still for a minute — which is honest,
 * and is what §37 and §42 ask for.
 *
 * Every stage function here is worker-only and re-reads what it needs from the
 * database. The job payload arrives over Redis and is data, not authority.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  assets,
  brandKits,
  captions,
  channelSettings,
  musicTracks,
  renders,
  scenes as scenesTable,
  scriptVersions,
  scripts,
  voiceovers,
} from "@/lib/db/schema";
import {
  AssetMissingError,
  ConflictError,
  InsufficientCreditsError,
  NotFoundError,
  RenderError,
  ValidationError,
  errorCodeOf,
  isAppError,
  userMessageOf,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  checkContinuity,
  continuityContextFor,
  loadContext as loadContinuityContext,
  persistSceneStates,
  planContinuity,
  recordScenePrompt,
  referenceImagePlan,
  referencesForScene,
  regenerationPromptFor,
  scenesToRegenerate,
} from "@/lib/continuity/service";
import {
  countRegeneration,
  getReferenceImages,
  latestContinuityCheck,
  referenceAssetMeta,
  type StoredReference,
} from "@/lib/continuity/store";
import type { ReferenceKind } from "@/lib/continuity/prompt";
import {
  chargeCredits,
  creditBalanceFor,
  ensureMonthlyGrant,
  imageChargeKey,
  refundCredits,
  sceneChargeKey,
} from "@/lib/credits/service";
import { creditCostFor, type CreditOperation } from "@/lib/credits/pricing";
import { assertCanStartVideo, queuePriorityFor } from "@/lib/plans/enforce";
import { acquireMusic, isMusicConfigured } from "@/lib/providers/music";
import {
  pollRender,
  renderProviderName,
  submitRender,
  toSrt,
  toVtt,
  type RenderOutput,
} from "@/lib/providers/render";
import {
  isTranscriptionConfigured,
  transcribe,
  transcriptionProviderName,
} from "@/lib/providers/transcription";
import {
  acquireVisual,
  isVisualsConfigured,
  type AcquiredVisual,
} from "@/lib/providers/visuals";
import {
  assertImageQuality,
  generateClip,
  generateImage,
  isGenerationMode,
  isVideoGenConfigured,
  type GenerationMode,
  type ReferenceImageInput,
} from "@/lib/providers/video-gen";
import { isVoiceConfigured, synthesize } from "@/lib/providers/voice";
import {
  deriveProgress,
  getProject,
  setProgress,
  transition,
  type ProjectRecord,
} from "@/lib/projects/service";
import {
  enqueue,
  hasActiveJob,
  hasActiveSceneJob,
  reportProgress,
} from "@/lib/queue/jobs";
import type { ScriptDraft } from "@/lib/scripts/prompt";
import {
  getObjectBuffer,
  putObject,
  signedReadUrl,
  storageKey,
} from "@/lib/storage";
import type { PipelineStage } from "@/lib/stages";
import type { CompiledEdit } from "@/lib/video/edit-document";
import { compileProjectEdit, markEditRendered } from "@/lib/video/edit-service";
import { formatSpec, type VideoFormat } from "@/lib/video/format";
import type { VideoQuality } from "@/lib/video/quality";
import {
  generationPlanFor,
  type GenerationPlan,
} from "@/lib/video/generation-plan";
import { directScenes, segmentScript } from "@/lib/video/scenes";
import { buildTimeline, type TimelineDocument } from "@/lib/video/timeline";
import type { PlanTier } from "@/lib/plans";

const log = logger.child({ component: "video" });

/** Job names. Each maps to a handler in `src/worker/handlers`. */
export const SCENE_PLAN_JOB = "video-scene-plan";
export const VOICEOVER_JOB = "video-voiceover";
export const VISUALS_JOB = "video-visuals";
export const MUSIC_JOB = "video-music";
export const CAPTIONS_JOB = "video-captions";
export const TIMELINE_JOB = "video-timeline";
export const RENDER_JOB = "video-render";
/**
 * Continuity QC. Fills the `QUALITY_CHECK` stage, which has been declared in
 * `stages.ts` and in the `pipeline_stage` enum since Phase 2 with no executor.
 *
 * Enqueued by the render stage rather than chained the way the earlier stages are,
 * and it is deliberately *not* on the critical path: the video is already
 * `VIDEO_READY` before this runs. A continuity check that could hold up a finished
 * render would be a quality feature blocking delivery.
 */
export const CONTINUITY_JOB = "video-continuity-check";
/**
 * Regenerating one scene's visual. One job per scene, not one job per batch.
 *
 * Per scene because that is what makes retries honest: a provider that fails on
 * scene 12 retries scene 12, rather than re-billing the three scenes that already
 * succeeded. It reuses `enqueue`, the `pipeline` queue, the `jobs` row and
 * `hasActiveJob` — there is no second queue and no second worker.
 */
export const SCENE_REGEN_JOB = "video-scene-regenerate";
/**
 * Generating the story bible's reference stills (Phase 12 §5, §6).
 *
 * A job rather than part of the scene-plan stage, for two reasons that pull the same
 * way. It is a paid provider call per entity — up to thirty for a full bible — and
 * putting that inside the scene plan would make a stage whose job is *thinking* about
 * the video also the most expensive one, retried in full whenever any part of it
 * failed. And a reference is worth having on its own: a user who wants to see the cast
 * before committing to eighty scenes can ask for them without starting a build.
 *
 * On the `pipeline` queue with the other visual work, and stamped `SCENE_PLAN` rather
 * than a new stage — the stills belong to the plan, and `pipeline_stage` is a database
 * enum that a new member would need a migration to extend for no behaviour change.
 */
export const REFERENCE_IMAGES_JOB = "video-reference-images";

/** Stages completed by the time each job finishes, for the progress derivation. */
const COMPLETED_AFTER: Record<string, PipelineStage[]> = {
  [SCENE_PLAN_JOB]: ["SCRIPT", "SCENE_PLAN"],
  [VOICEOVER_JOB]: ["SCRIPT", "SCENE_PLAN", "VOICEOVER"],
  [VISUALS_JOB]: ["SCRIPT", "SCENE_PLAN", "VOICEOVER", "VISUALS"],
  [MUSIC_JOB]: ["SCRIPT", "SCENE_PLAN", "VOICEOVER", "VISUALS", "MUSIC"],
  [CAPTIONS_JOB]: [
    "SCRIPT",
    "SCENE_PLAN",
    "VOICEOVER",
    "VISUALS",
    "MUSIC",
    "CAPTIONS",
  ],
  [TIMELINE_JOB]: [
    "SCRIPT",
    "SCENE_PLAN",
    "VOICEOVER",
    "VISUALS",
    "MUSIC",
    "CAPTIONS",
    "TIMELINE",
  ],
};

/**
 * How often a hosted render is polled.
 *
 * 15 seconds: a 1080p render takes minutes, and polling every second would spend
 * an API call to learn nothing. The studio screen polls Tally every 4 seconds and
 * reads the stored value, so the number a user sees is at most 15 seconds stale —
 * which is invisible against a multi-minute render.
 */
const RENDER_POLL_MS = 15_000;

/** Ceiling on a hosted render. Beyond this the provider has silently died. */
const RENDER_MAX_WAIT_MS = 90 * 60_000;

/** Signed-URL lifetime for assets handed to a hosted renderer. */
const RENDER_URL_TTL_SECONDS = 6 * 3600;

// ---------------------------------------------------------------------------
// Start (request side)
// ---------------------------------------------------------------------------

export interface StartVideoInput {
  userId: string;
  projectId: string;
  tier: PlanTier;
  traceId?: string | null;
}

export interface StartVideoResult {
  jobId: string;
  sceneCount: number;
}

/**
 * Queue a video build. Runs inside the request; does no provider work.
 *
 * The plan check happens here rather than in the worker because this is where a
 * user is present to be told. §23's monthly limit is enforced by
 * `assertCanStartVideo` against the persisted counter — never against anything
 * the frontend sent.
 */
export async function startVideoBuild(
  input: StartVideoInput,
): Promise<StartVideoResult> {
  const project = await getProject(input.userId, input.projectId);

  if (project.status === "PUBLISHED") {
    throw new ConflictError(
      "This video has already been published. Start a new video to build another.",
    );
  }

  const script = await loadApprovedScript(input.userId, input.projectId);

  await assertCanStartVideo(input.userId, input.tier);

  /**
   * One build per project at a time. A second would spend a second voiceover and
   * a second render to produce a duplicate of what the first is producing.
   *
   * Scoped by channel when there is one, and by the project itself when there is
   * not (Phase 11 §4). Passing a null channel with no fallback would throw inside
   * `hasActiveJob`, which is why the narrowing is explicit here: a link-mode
   * project must still be protected against a double-submit.
   */
  const scope = project.channelId ? undefined : project.id;
  for (const name of [
    SCENE_PLAN_JOB,
    VOICEOVER_JOB,
    VISUALS_JOB,
    MUSIC_JOB,
    CAPTIONS_JOB,
    TIMELINE_JOB,
    RENDER_JOB,
  ]) {
    if (
      await hasActiveJob(input.userId, project.channelId ?? null, name, scope)
    ) {
      throw new ConflictError(
        "A video is already being built. Wait for it to finish.",
      );
    }
  }

  // Scene count up front so the studio's filmstrip has something to draw before
  // the worker has written a single row.
  const planned = segmentScript(script.draft);

  await transition(input.userId, project.id, "ASSETS_GENERATING", {
    stage: "SCENE_PLAN",
    message: "Planning scenes",
    progress: deriveProgress(["SCRIPT"]),
    incrementRetry: project.status === "FAILED",
  });

  try {
    const job = await enqueue({
      queue: "pipeline",
      name: SCENE_PLAN_JOB,
      userId: input.userId,
      channelId: project.channelId,
      projectId: project.id,
      stage: "SCENE_PLAN",
      payload: { projectId: project.id, tier: input.tier },
      priority: queuePriorityFor(input.tier),
      traceId: input.traceId ?? project.traceId,
      statusMessage: "Queued",
    });

    return { jobId: job.id, sceneCount: planned.length };
  } catch (error) {
    await transition(input.userId, project.id, "FAILED", {
      stage: "SCENE_PLAN",
      error: {
        code: "internal_error",
        message: "Could not reach the job queue. Please try again.",
        stage: "SCENE_PLAN",
      },
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Export the editor's cut (Phase C)
// ---------------------------------------------------------------------------

export interface StartEditExportResult {
  jobId: string;
  /** The cut's compiled length, so the UI can show what it is about to render. */
  durationMs: number;
  sceneCount: number;
}

/**
 * Re-render a project from its saved cut.
 *
 * The editor's Export button. It queues the *existing* `RENDER_JOB` and nothing else,
 * which is the whole point: `executeRender` already reads the saved cut through
 * `compileProjectEdit` and already prefers it over the scene rows, so exporting an edit
 * needs no second render path, no second provider call and no new stage. Assets are not
 * regenerated — there is no voiceover, visuals or captions work here, so an export
 * spends render time and no generation credit.
 *
 * Refused when the project has no saved cut: there is nothing to export that the normal
 * build would not produce, and silently falling back to a scene-row render would tell the
 * user their edit had been exported when it had not.
 */
export async function startEditExport(input: {
  userId: string;
  projectId: string;
  tier: PlanTier;
  traceId?: string | null;
}): Promise<StartEditExportResult> {
  const project = await getProject(input.userId, input.projectId);

  if (project.status === "PUBLISHED") {
    throw new ConflictError(
      "This video has already been published. Start a new video to publish another cut.",
    );
  }

  const edit = await compileProjectEdit(input.userId, input.projectId);
  if (!edit) {
    throw new ConflictError(
      "This video has no saved edit yet. Open it in the editor first.",
    );
  }

  if (edit.timeline.scenes.length === 0) {
    // Caught here rather than in the worker so the user is told now, while they are
    // looking at the timeline they emptied.
    throw new ValidationError(
      "This cut has no visible clips to render. Add a clip or unhide a track first.",
    );
  }

  // Same guard `startVideoBuild` uses, and scoped the same way: one render per project
  // at a time, because a second would spend a second render to produce a duplicate.
  const scope = project.channelId ? undefined : project.id;
  for (const name of [
    SCENE_PLAN_JOB,
    VOICEOVER_JOB,
    VISUALS_JOB,
    MUSIC_JOB,
    CAPTIONS_JOB,
    TIMELINE_JOB,
    RENDER_JOB,
  ]) {
    if (
      await hasActiveJob(input.userId, project.channelId ?? null, name, scope)
    ) {
      throw new ConflictError(
        "This video is already being built or exported. Wait for it to finish.",
      );
    }
  }

  await transition(input.userId, project.id, "RENDERING", {
    stage: "RENDER",
    message: "Exporting your edit",
    progress: deriveProgress(COMPLETED_AFTER[TIMELINE_JOB] ?? []),
    incrementRetry: project.status === "FAILED",
  });

  try {
    const job = await enqueue({
      queue: "pipeline",
      name: RENDER_JOB,
      userId: input.userId,
      channelId: project.channelId,
      projectId: project.id,
      stage: "RENDER",
      payload: { projectId: project.id, tier: input.tier },
      priority: queuePriorityFor(input.tier),
      traceId: input.traceId ?? project.traceId,
      statusMessage: "Queued",
    });

    log.info("queued an edit export", {
      userId: input.userId,
      projectId: project.id,
      durationMs: edit.durationMs,
      scenes: edit.timeline.scenes.length,
    });

    return {
      jobId: job.id,
      durationMs: edit.durationMs,
      sceneCount: edit.timeline.scenes.length,
    };
  } catch (error) {
    await transition(input.userId, project.id, "FAILED", {
      stage: "RENDER",
      error: {
        code: "internal_error",
        message: "Could not reach the job queue. Please try again.",
        stage: "RENDER",
      },
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Stage 1 — scene plan
// ---------------------------------------------------------------------------

export interface StageInput {
  userId: string;
  projectId: string;
  jobId: string;
  tier: PlanTier;
  traceId?: string | null;
}

/**
 * Split the approved script into scenes and direct each one.
 *
 * Rows are replaced rather than updated: a rebuild after a script revision must
 * not leave scene 9 of a previous, longer plan behind, and `scenes` has a unique
 * index on (project, index) that an upsert would have to fight.
 */
export async function executeScenePlan(input: StageInput): Promise<{
  sceneCount: number;
  mood: string;
}> {
  return runStage(input, "SCENE_PLAN", async () => {
    const script = await loadApprovedScript(input.userId, input.projectId);
    const settings = await loadSettings(input.userId, input.projectId);

    await reportProgress(input.jobId, 10, "Splitting the script into scenes");

    const planned = segmentScript(script.draft);
    if (planned.length === 0) {
      throw new AssetMissingError(
        "a script with narration to split into scenes",
      );
    }

    /**
     * The continuity layer sits here: after segmentation, before direction.
     *
     * That is the only point in the pipeline where the narration exists and the
     * visual prompts do not, which is exactly what a continuity supervisor needs —
     * it decides what must stay the same, and the director then directs into those
     * decisions rather than inventing a subject per scene and being corrected
     * afterwards.
     *
     * `planContinuity` never throws and returns an inert context when the flag is
     * off, the project is stock, the plan does not allow it, or planning failed.
     * In every one of those cases `plannerContext` is "" and the `directScenes`
     * call below is byte-identical to the pre-continuity one.
     */
    const project = await getProject(input.userId, input.projectId);
    const continuity = await planContinuity({
      userId: input.userId,
      project: {
        projectId: input.projectId,
        channelId: project.channelId,
        generationMode: isGenerationMode(project.generationMode)
          ? project.generationMode
          : null,
        tier: input.tier,
      },
      scenes: planned.map((scene) => ({
        index: scene.index,
        label: scene.label,
        narration: scene.narration,
      })),
      title: script.draft.title,
      niche: settings.niche,
      usage: { jobId: input.jobId, traceId: input.traceId ?? null },
    });

    await reportProgress(input.jobId, 30, `Directing ${planned.length} scenes`);

    const directed = await directScenes({
      scenes: planned,
      title: script.draft.title,
      niche: settings.niche,
      videoStyle: settings.videoStyle,
      continuity: continuity.plannerContext,
      usage: {
        userId: input.userId,
        projectId: input.projectId,
        jobId: input.jobId,
        traceId: input.traceId ?? null,
      },
    });

    await reportProgress(input.jobId, 80, "Saving the storyboard");

    await db.transaction(async (tx) => {
      await tx
        .delete(scenesTable)
        .where(
          and(
            eq(scenesTable.projectId, input.projectId),
            eq(scenesTable.userId, input.userId),
          ),
        );

      await tx.insert(scenesTable).values(
        directed.scenes.map((scene) => ({
          projectId: input.projectId,
          userId: input.userId,
          scriptVersionId: script.versionId,
          index: scene.index,
          label: scene.label,
          narration: scene.narration,
          visualPrompt: scene.visualPrompt,
          searchTerms: scene.searchTerms,
          onScreenText: scene.onScreenText,
          transition: scene.transition,
          // Deliberately null: real offsets are written by the timeline stage
          // from measured audio. A value here would be a guess, and every
          // consumer prefers `scenes.startMs` when it is set (§42).
          startMs: null,
          durationMs: null,
        })),
      );
    });

    // After the scene rows exist, not before: the states are keyed by scene index
    // and are written onto those rows, so writing them earlier would update nothing.
    // A no-op when continuity is inert.
    await persistSceneStates({
      userId: input.userId,
      projectId: input.projectId,
      context: continuity.context,
    });

    // The mood rides on the music row rather than a project column, because it is
    // an input to the music search and nothing else reads it.
    await upsertMusicMood(input, directed.mood);

    await chain(input, VOICEOVER_JOB, "VOICEOVER", SCENE_PLAN_JOB);

    return { sceneCount: directed.scenes.length, mood: directed.mood };
  });
}

// ---------------------------------------------------------------------------
// Stage 2 — voiceover
// ---------------------------------------------------------------------------

/**
 * Synthesise narration, one audio file per scene.
 *
 * Per scene rather than one long file, because that is what makes the offsets in
 * `voiceovers.segments` measurements rather than estimates: each segment's
 * duration is read from the audio that was actually produced. The timeline then
 * accumulates them, so `scenes.start_ms` — and therefore the chapter list — is
 * correct to the millisecond at minute nine of a video, not just at minute one.
 */
export async function executeVoiceover(input: StageInput): Promise<{
  segments: number;
  durationMs: number;
}> {
  return runStage(input, "VOICEOVER", async () => {
    const sceneRows = await loadScenes(input.userId, input.projectId);
    const settings = await loadSettings(input.userId, input.projectId);

    await reportProgress(input.jobId, 5, `Narrating ${sceneRows.length} scenes`);

    const result = await synthesize({
      segments: sceneRows.map((scene) => ({
        sceneIndex: scene.index,
        text: scene.narration,
      })),
      voiceId: settings.voiceId,
      style: settings.voiceStyle,
      speed: settings.voiceSpeed,
      language: settings.language,
      usage: {
        userId: input.userId,
        projectId: input.projectId,
        jobId: input.jobId,
        traceId: input.traceId ?? null,
      },
      onSegment: async (done, total) => {
        // Real progress: `done` segments of audio exist. 5-70% of this stage.
        await reportProgress(
          input.jobId,
          5 + Math.round((done / Math.max(1, total)) * 65),
          `Narrated ${done} of ${total} scenes`,
        );
      },
    });

    await reportProgress(input.jobId, 75, "Storing the narration");

    // One asset row per segment. The timeline needs to place each scene's audio
    // independently, and a single concatenated file could not be re-cut when a
    // scene is regenerated.
    const stored: Array<{ sceneIndex: number; assetId: string; durationMs: number }> =
      [];

    for (const segment of result.segments) {
      if (segment.bytes.byteLength === 0) {
        // A legitimately silent scene (a title card). No file, no asset row, and
        // the timeline treats a missing narration key as silence.
        stored.push({ sceneIndex: segment.sceneIndex, assetId: "", durationMs: 0 });
        continue;
      }

      const asset = await storeAsset({
        userId: input.userId,
        projectId: input.projectId,
        folder: "voiceover",
        kind: "voiceover",
        bytes: segment.bytes,
        mimeType: result.mimeType,
        extension: result.extension,
        durationMs: segment.durationMs,
        provider: result.provider,
        meta: { sceneIndex: segment.sceneIndex },
      });

      stored.push({
        sceneIndex: segment.sceneIndex,
        assetId: asset.id,
        durationMs: segment.durationMs,
      });
    }

    // Offsets accumulated in scene order. Written here as well as on the timeline
    // so `voiceovers.segments` is meaningful on its own.
    let cursor = 0;
    const segments = stored.map((segment) => {
      const entry = {
        sceneIndex: segment.sceneIndex,
        startMs: cursor,
        durationMs: segment.durationMs,
      };
      cursor += segment.durationMs;
      return entry;
    });

    await db.transaction(async (tx) => {
      await tx
        .delete(voiceovers)
        .where(
          and(
            eq(voiceovers.projectId, input.projectId),
            eq(voiceovers.userId, input.userId),
          ),
        );

      await tx.insert(voiceovers).values({
        projectId: input.projectId,
        userId: input.userId,
        // The first segment's asset stands as the row's asset; per-scene files are
        // linked through `meta.sceneIndex` on their own asset rows.
        assetId: stored.find((s) => s.assetId)?.assetId ?? null,
        provider: result.provider,
        voiceId: result.voiceId,
        voiceName: result.voiceName,
        language: settings.language,
        speed: settings.voiceSpeed,
        style: settings.voiceStyle,
        durationMs: result.totalDurationMs,
        segments,
        charactersBilled: result.charactersBilled,
      });
    });

    await chain(input, VISUALS_JOB, "VISUALS", VOICEOVER_JOB);

    return { segments: segments.length, durationMs: result.totalDurationMs };
  });
}

// ---------------------------------------------------------------------------
// Stage 3 — visuals
// ---------------------------------------------------------------------------

/**
 * Acquire one visual per scene.
 *
 * Sequential, and that is a considered choice: fanning out eighty stock searches
 * concurrently is the fastest way to earn a 429 from Pexels and lose the whole
 * stage. Sequential also lets each scene exclude the provider asset ids already
 * used, which is what prevents the same clip appearing four times in one video.
 *
 * Phase 11 (§9, §17) adds a second way to fill a scene. This is the single place
 * where "stock or AI" is decided, and it is a branch inside the existing stage
 * rather than a new stage: an AI clip and a stock clip both end up as one asset row
 * with a `visualAssetId` on the scene, so everything downstream — the timeline, the
 * renderer, the FFmpeg assembly that holds a short clip to fill its slot — is
 * untouched. Adding an eighth stage would have meant two paths through the pipeline
 * and two places for progress, retries and failure to diverge.
 */
export async function executeVisuals(input: StageInput): Promise<{
  acquired: number;
}> {
  return runStage(input, "VISUALS", async () => {
    const sceneRows = await loadScenes(input.userId, input.projectId);
    const narration = await loadNarrationDurations(input.userId, input.projectId);

    // Resolved once for the whole stage, and before any provider call: a project
    // whose chosen model has become unavailable should fail having spent nothing,
    // not halfway through scene nine.
    const project = await getProject(input.userId, input.projectId);
    const plan = generationPlanFor(project);

    /**
     * Continuity, also resolved once.
     *
     * The bible and every scene state are read here rather than per scene: the loop
     * below runs up to 120 times and none of this data can change mid-stage, so a
     * query inside the loop would be 120 round trips for the same answer.
     *
     * Inert unless the flag is on, the project generates AI video and a bible was
     * planned — in which case `continuityContextFor` returns the prompt unchanged
     * and this stage behaves exactly as it did before the layer existed.
     */
    const continuity = await loadContinuityContext(input.userId, {
      projectId: input.projectId,
      channelId: project.channelId,
      generationMode: isGenerationMode(project.generationMode)
        ? project.generationMode
        : null,
      tier: input.tier,
    });

    /**
     * The project's stored reference stills — read once, and only when they can be used.
     *
     * The §6 reuse path. Three conditions have to hold before this costs anything: the
     * continuity layer is active, this is an AI project, and the **selected model
     * declares `referenceImages`**. No catalogued model does today, so this is an empty
     * array on every current build and the loop below behaves exactly as it did.
     *
     * Gated on the capability *here* as well as in `generateClip` for a reason that is
     * about bytes rather than correctness: selecting references means downloading them
     * from object storage, and doing that for a model that will discard them is real
     * I/O for no output. `generateClip` still refuses them independently — this is the
     * cost guard, that is the contract.
     */
    const references =
      continuity.active && plan.mode === "AI_VIDEO" && plan.model?.capabilities.referenceImages
        ? await loadContinuityReferences(input.userId, input.projectId)
        : [];

    /**
     * The whole build's credit cost, checked before scene one is generated (§10).
     *
     * AI mode only: stock footage is included in the plan's video allowance, which
     * `assertCanStartVideo` already enforced at the request that started the build.
     * Charging credits for it as well would bill twice for one video.
     *
     * The durations are the same map the loop reads, with the same 6s fallback, so the
     * estimate is the sum of the charges rather than an approximation of them.
     */
    if (plan.mode === "AI_VIDEO" && plan.model) {
      const affordability = await assertCanAffordScenes({
        userId: input.userId,
        modelId: plan.model.id,
        quality: plan.quality,
        durations: sceneRows.map((scene) => narration.get(scene.index) ?? 6_000),
      });
      log.info("visuals stage is affordable", {
        userId: input.userId,
        projectId: input.projectId,
        scenes: sceneRows.length,
        estimate: affordability.estimate,
        available: affordability.available,
      });
    }

    const used = new Set<string>();
    let acquired = 0;

    for (const [position, scene] of sceneRows.entries()) {
      await reportProgress(
        input.jobId,
        Math.round((position / Math.max(1, sceneRows.length)) * 95),
        plan.mode === "AI_VIDEO"
          ? `Generating scene ${position + 1} of ${sceneRows.length}`
          : `Finding b-roll for scene ${position + 1} of ${sceneRows.length}`,
      );

      const durationMs = narration.get(scene.index) ?? 6_000;
      const usage = {
        userId: input.userId,
        projectId: input.projectId,
        jobId: input.jobId,
        traceId: input.traceId ?? null,
      };

      /**
       * The continuity block for this scene, and the prompt it produces.
       *
       * Computed for every scene, including in stock mode, because the function is
       * pure and returns the prompt unchanged when the context is inert — a branch
       * here would be a second place for the two modes to diverge.
       */
      const sceneContinuity = continuityContextFor({
        context: continuity,
        sceneIndex: scene.index,
        visualPrompt: basePromptFor(scene),
      });

      const visual =
        plan.mode === "AI_VIDEO" && plan.model
          ? await generateSceneClip({
              plan,
              modelId: plan.model.id,
              scene,
              prompt: sceneContinuity.prompt,
              durationMs,
              /**
               * The first generation of this scene, always.
               *
               * Not `job.attemptsMade`: a retried visuals stage is the *same*
               * generation of the scene and must charge once in total, which a
               * per-attempt key would defeat — three BullMQ attempts would be three
               * charges for one clip. Continuity regeneration is the only thing that
               * advances this, and it passes its own count.
               */
              attempt: 1,
              usage,
              /**
               * The stills for the entities *this* scene commits to.
               *
               * Empty unless the model accepts references, because `references` is
               * empty in that case. The selection is the continuity layer's decision,
               * as every other continuity decision in this loop is.
               */
              references: referencesForScene({
                context: continuity,
                sceneIndex: scene.index,
                stored: references,
              }),
            })
          : await acquireVisual(
              {
                sceneIndex: scene.index,
                visualPrompt: scene.visualPrompt,
                searchTerms: scene.searchTerms,
                durationMs,
                format: plan.format,
                exclude: used,
              },
              { usage },
            );

      if (visual.providerAssetId) used.add(visual.providerAssetId);

      const asset = await storeAsset({
        userId: input.userId,
        projectId: input.projectId,
        folder: "visual",
        kind: visual.kind,
        bytes: visual.bytes,
        mimeType: visual.mimeType,
        extension: visual.extension,
        width: visual.width,
        height: visual.height,
        durationMs: visual.durationMs,
        provider: visual.provider,
        providerAssetId: visual.providerAssetId,
        sourceUrl: visual.sourceUrl,
        license: visual.license,
        attribution: visual.attribution,
        authorName: visual.authorName,
        meta: { sceneIndex: scene.index, matchedOn: visual.matchedOn },
      });

      await db
        .update(scenesTable)
        .set({ visualAssetId: asset.id, updatedAt: new Date() })
        .where(
          and(
            eq(scenesTable.projectId, input.projectId),
            eq(scenesTable.userId, input.userId),
            eq(scenesTable.index, scene.index),
          ),
        );

      // What this scene was *actually* generated with, so the check validates the
      // request that was sent rather than recomputing one from the current bible.
      if (continuity.active) {
        await recordScenePrompt({
          userId: input.userId,
          projectId: input.projectId,
          sceneIndex: scene.index,
          state:
            continuity.states.find((s) => s.sceneIndex === scene.index) ?? null,
          block: sceneContinuity.block,
        });
      }

      acquired += 1;
    }

    await chain(input, MUSIC_JOB, "MUSIC", VISUALS_JOB);

    return { acquired };
  });
}

/**
 * A scene's visual direction, before any continuity constraints.
 *
 * Lifted out of `generateSceneClip` so the continuity block can be attached to the
 * same string the adapter would have built, and so there is exactly one definition
 * of the fallback for an undirected scene. Previously inline; behaviour unchanged.
 */
function basePromptFor(scene: {
  visualPrompt: string | null;
  searchTerms: string[];
}): string {
  return (
    scene.visualPrompt?.trim() ||
    scene.searchTerms.filter(Boolean).join(", ") ||
    // Nothing to go on. Better than an empty prompt, and the scene director
    // producing no direction at all is itself a defect worth seeing in the output.
    "A clean, well-lit establishing shot relevant to the narration"
  );
}

/**
 * Charge for one generation, run it, and refund it if it produced nothing (§10–§13).
 *
 * Every provider call that costs credits goes through here, so there is exactly one
 * definition of the order of operations. It is charge-then-generate, which §10 requires:
 * generating first and charging after would let an empty balance consume unlimited
 * provider spend, because the refusal would arrive once the money was already gone.
 *
 * ## What a retry costs
 *
 * Nothing, and that is the point of `idempotencyKey`. A BullMQ retry of the visuals
 * stage replays the same key per scene, loses the ledger insert, and charges zero — so a
 * build that failed at scene 40 and is rebuilt pays for scenes 1–40 exactly once in
 * total, then full price for 41 onwards. The customer pays once per scene *generated*,
 * however many attempts the pipeline needed.
 *
 * ## The one place a credit is given away
 *
 * When the provider call throws, the charge is refunded — we took money and produced no
 * asset. The ledger row keeps its key, so the *next* attempt at that same generation
 * finds the key used and charges zero. That single generation is therefore free.
 *
 * The alternative is worse in both directions: not refunding bills a customer for a
 * still that does not exist, and clearing the key to make it re-chargeable would break
 * `refundCredits`' own `refund:{key}` guard on the second failure. One generation per
 * failure, in the customer's favour, is the smallest leak available and the safe
 * direction to leak in.
 *
 * A refusal — `InsufficientCreditsError` — propagates untouched and writes nothing, so
 * an unaffordable scene leaves no charge and no refund to reconcile.
 */
async function paidGeneration<T>(args: {
  userId: string;
  projectId: string;
  operation: CreditOperation;
  modelId: string;
  quality: VideoQuality;
  /** Required for `video_scene`; the image rate ignores it. */
  durationMs?: number;
  idempotencyKey: string;
  /** Shown on the history screen. Must never name a vendor (§3). */
  description: string;
  meta?: Record<string, unknown>;
  generate: () => Promise<T>;
}): Promise<T> {
  const charge = await chargeCredits({
    userId: args.userId,
    projectId: args.projectId,
    operation: args.operation,
    modelId: args.modelId,
    quality: args.quality,
    ...(args.durationMs === undefined ? {} : { durationMs: args.durationMs }),
    idempotencyKey: args.idempotencyKey,
    description: args.description,
    ...(args.meta ? { meta: args.meta } : {}),
  });

  try {
    return await args.generate();
  } catch (error) {
    /**
     * Refunded on the way past, never instead of the error.
     *
     * `refundCredits` does not throw for a charge it cannot find, so this cannot
     * replace a readable provider failure with an accounting one — but it is wrapped
     * anyway, because a refund that failed for an unrelated reason must not hide what
     * actually went wrong with the generation.
     */
    try {
      const refund = await refundCredits({
        userId: args.userId,
        chargeIdempotencyKey: args.idempotencyKey,
        reason: `${args.operation === "image" ? "Image" : "Scene"} generation failed`,
        meta: { projectId: args.projectId, modelId: args.modelId },
      });
      if (refund.refunded > 0) {
        log.info("refunded a generation that failed after being charged", {
          userId: args.userId,
          projectId: args.projectId,
          operation: args.operation,
          refunded: refund.refunded,
        });
      }
    } catch (refundError) {
      log.error("could not refund a failed generation", {
        userId: args.userId,
        projectId: args.projectId,
        operation: args.operation,
        idempotencyKey: args.idempotencyKey,
        error: refundError,
      });
    }

    // Unchanged. What the user needs to see is why the generation failed, and
    // `charge.charged` credits being back is not that.
    void charge;
    throw error;
  }
}

/**
 * Refuse a build the balance cannot finish, before any of it is generated (§10).
 *
 * Advisory, and deliberately so: `chargeCredits` is the authority, charges per scene
 * against a locked row, and refuses on its own. This exists for a different reason —
 * cost. Without it a user with five credits gets scene one generated at Tally's expense
 * and then a failed project, and the eighty-scene version of that is eighty provider
 * calls for a video that could never complete.
 *
 * It grants first, because a subscriber whose period has just rolled over has a stale
 * zero balance until something grants it, and refusing their build for that would be a
 * bug that reads as a billing failure. Granting from a worker stage is what
 * `ensureMonthlyGrant` is for; the tier is re-read from `subscriptions` inside it rather
 * than taken from the job payload, which is data and not authority.
 *
 * The estimate can be wrong in one direction only. Between this check and the last
 * scene's charge a concurrent build can spend the balance down, in which case that scene
 * is refused by the charge — correctly. It cannot be wrong the other way: the per-scene
 * prices summed here are the same `creditCostFor` calls the charges will make.
 */
async function assertCanAffordScenes(args: {
  userId: string;
  modelId: string;
  quality: VideoQuality;
  durations: readonly number[];
}): Promise<{ estimate: number; available: number }> {
  const estimate = args.durations.reduce(
    (total, durationMs) =>
      total +
      creditCostFor({
        operation: "video_scene",
        modelId: args.modelId,
        quality: args.quality,
        durationMs,
      }),
    0,
  );

  await ensureMonthlyGrant(args.userId, {});
  const balance = await creditBalanceFor(args.userId);

  if (balance.available < estimate) {
    throw new InsufficientCreditsError({
      required: estimate,
      available: balance.available,
      operation: "video_scene",
      modelId: args.modelId,
    });
  }

  return { estimate, available: balance.available };
}

/**
 * Generate one scene's clip with the selected AI model (§9, §15).
 *
 * An adapter, and only an adapter: it turns a scene row into a prompt and a
 * `GeneratedClip` back into the `AcquiredVisual` shape the rest of the stage already
 * stores. Nothing new is invented about how an asset is persisted, which is what
 * keeps the AI branch and the stock branch from drifting apart.
 *
 * Two details worth stating:
 *
 *  - **The prompt is the scene's visual direction, not its narration.** The scene
 *    director already writes `visualPrompt` as a description of a shot; handing a
 *    model the spoken words instead would produce footage of someone talking. The
 *    prompt arrives ready-made from the caller — `basePromptFor` with any continuity
 *    constraints already attached — because deciding what a scene must look like is
 *    not an adapter's job.
 *  - **`kind` follows the bytes, not the intent.** A provider that returned a still
 *    is recorded as `generated_image`, so the timeline holds it for its slot rather
 *    than expecting motion. Recording it as `generated_video` because AI mode was
 *    requested is exactly the sort of claim §42 forbids.
 *
 * ## The charge lives here, not at the call sites (§12)
 *
 * Both callers — the visuals stage and continuity regeneration — pay through
 * `paidGeneration` inside this function. Charging here rather than in each caller means a
 * third caller cannot be added that generates for free, which is the failure mode that
 * matters: an unpaid generation costs real vendor money and looks like nothing at all.
 */
async function generateSceneClip(args: {
  plan: GenerationPlan;
  modelId: string;
  scene: { index: number };
  /** The full prompt, continuity constraints included. */
  prompt: string;
  durationMs: number;
  /**
   * Which generation of this scene this is, from 1 (§13).
   *
   * The charge key's discriminator, and therefore what separates a *deliberate*
   * regeneration from an *accidental* retry. A BullMQ retry of the visuals stage passes 1
   * again, loses the ledger insert and charges nothing; a continuity regeneration passes
   * its own attempt number and is charged, which is correct — it is a second clip.
   */
  attempt: number;
  usage: {
    userId: string;
    projectId: string;
    jobId: string;
    traceId: string | null;
  };
  /**
   * Stored continuity references for this scene's entities (§6).
   *
   * Already filtered by the caller to the entities this scene commits to, and empty
   * unless the model accepts them. Their bytes are fetched here rather than by the
   * caller so a scene whose references are unreadable still generates.
   */
  references?: readonly StoredReference[];
}): Promise<AcquiredVisual> {
  const { plan, modelId, scene, prompt, durationMs, usage } = args;

  const clip = await paidGeneration({
    userId: usage.userId,
    projectId: usage.projectId,
    operation: "video_scene",
    modelId,
    quality: plan.quality,
    durationMs,
    idempotencyKey: sceneChargeKey({
      projectId: usage.projectId,
      sceneIndex: scene.index,
      attempt: args.attempt,
    }),
    // Names the scene, never the vendor behind the model (§3).
    description: `Scene ${scene.index + 1} — ${plan.model?.label ?? "AI video"} (${plan.quality})`,
    meta: { sceneIndex: scene.index, attempt: args.attempt },
    generate: async () => {
      /**
       * The reference bytes are fetched inside the paid block, after the charge.
       *
       * Deliberate: a download that fails is a failure of this generation, and having
       * it inside means it is refunded like any other. Fetching them before the charge
       * would spend storage I/O on a scene that is about to be refused for having no
       * credits.
       */
      const referenceImages = await referenceBytes(args.references ?? [], usage);
      return generateClip(
        {
          prompt,
          modelId,
          format: plan.format,
          durationMs,
          sceneIndex: scene.index,
          referenceImages,
        },
        { usage: { ...usage, operation: "video.scene.generate" } },
      );
    },
  });

  return {
    provider: clip.provider,
    kind: clip.mimeType.startsWith("video/")
      ? "generated_video"
      : "generated_image",
    bytes: clip.bytes,
    mimeType: clip.mimeType,
    extension: clip.extension,
    width: clip.width,
    height: clip.height,
    durationMs: clip.durationMs,
    providerAssetId: clip.providerAssetId,
    // No source URL: the bytes came from a generation call, not from a page a user
    // could be sent to. A fabricated attribution link would be worse than none.
    sourceUrl: null,
    license: clip.license,
    attribution: clip.attribution,
    authorName: null,
    matchedOn: clip.matchedOn,
  };
}

/**
 * The project's stored continuity references, or none.
 *
 * A wrapper whose only job is to never throw. The reuse path is an enhancement over
 * textual continuity, so a failed read has to degrade to the behaviour that existed
 * before it — failing eighty scenes because a reference lookup timed out would make
 * the feature a liability.
 */
async function loadContinuityReferences(
  userId: string,
  projectId: string,
): Promise<StoredReference[]> {
  try {
    return await getReferenceImages(userId, projectId);
  } catch (error) {
    log.warn("could not load continuity references; using textual continuity", {
      userId,
      projectId,
      error,
    });
    return [];
  }
}

/**
 * Fetch the bytes for a scene's references, skipping any that cannot be read.
 *
 * Concurrent because these are small stills from object storage and a scene may commit
 * to five entities; sequential would add a round trip per entity to every scene of the
 * build.
 *
 * A reference that fails to download is dropped rather than fatal, for the same reason
 * the loader above returns an empty array: the fallback is the textual constraint the
 * prompt already carries. Its absence is logged, because a scene silently generating
 * without the reference the operator paid for is the failure worth seeing.
 */
async function referenceBytes(
  references: readonly StoredReference[],
  usage: { userId: string; projectId: string },
): Promise<ReferenceImageInput[] | undefined> {
  if (references.length === 0) return undefined;

  const loaded = await Promise.all(
    references.map(async (reference) => {
      try {
        const bytes = await getObjectBuffer(reference.storageKey);
        return {
          kind: reference.kind,
          entityId: reference.entityId,
          bytes,
          // Stored references are always images; the fallback is the format every
          // adapter here already produces stills in.
          mimeType: reference.mimeType ?? "image/png",
        } satisfies ReferenceImageInput;
      } catch (error) {
        log.warn("could not read a continuity reference; skipping it", {
          userId: usage.userId,
          projectId: usage.projectId,
          entityId: reference.entityId,
          referenceKind: reference.kind,
          error,
        });
        return null;
      }
    }),
  );

  const usable = loaded.filter((entry): entry is ReferenceImageInput => entry !== null);
  return usable.length > 0 ? usable : undefined;
}

// ---------------------------------------------------------------------------
// Stage 4 — music
// ---------------------------------------------------------------------------

/**
 * Find a background bed.
 *
 * The only stage allowed to fail softly. A video with no music is a video; a
 * video with no b-roll is not. So a missing track is logged, the music row is
 * left empty, and the pipeline continues — §13 treats the bed as decoration, and
 * failing a paid render over background audio would be the wrong trade.
 */
export async function executeMusic(input: StageInput): Promise<{
  acquired: boolean;
}> {
  return runStage(input, "MUSIC", async () => {
    const durations = await loadNarrationDurations(input.userId, input.projectId);
    const totalMs = [...durations.values()].reduce((sum, ms) => sum + ms, 0);

    const existing = await db
      .select({ id: musicTracks.id, mood: musicTracks.mood })
      .from(musicTracks)
      .where(
        and(
          eq(musicTracks.projectId, input.projectId),
          eq(musicTracks.userId, input.userId),
        ),
      )
      .limit(1);

    let acquired = false;

    if (isMusicConfigured()) {
      await reportProgress(input.jobId, 20, "Finding a background track");

      try {
        const music = await acquireMusic(
          { mood: existing[0]?.mood ?? null, durationMs: Math.max(30_000, totalMs) },
          {
            usage: {
              userId: input.userId,
              projectId: input.projectId,
              jobId: input.jobId,
              traceId: input.traceId ?? null,
            },
          },
        );

        const asset = await storeAsset({
          userId: input.userId,
          projectId: input.projectId,
          folder: "music",
          kind: "music",
          bytes: music.bytes,
          mimeType: music.mimeType,
          extension: music.extension,
          durationMs: music.durationMs,
          provider: music.provider,
          providerAssetId: music.providerAssetId,
          sourceUrl: music.sourceUrl,
          license: music.license,
          attribution: music.attribution,
          authorName: music.authorName,
        });

        const row = existing[0];
        if (row) {
          await db
            .update(musicTracks)
            .set({ assetId: asset.id, durationMs: music.durationMs })
            .where(
              and(
                eq(musicTracks.id, row.id),
                eq(musicTracks.userId, input.userId),
              ),
            );
        } else {
          await db.insert(musicTracks).values({
            projectId: input.projectId,
            userId: input.userId,
            assetId: asset.id,
            mood: music.mood,
            durationMs: music.durationMs,
          });
        }

        acquired = true;
      } catch (error) {
        // Soft failure, logged with the real reason. The status message says so
        // rather than claiming success (§42).
        log.warn("music stage continuing without a track", {
          userId: input.userId,
          projectId: input.projectId,
          jobId: input.jobId,
          error,
        });
        await reportProgress(
          input.jobId,
          90,
          "No suitable CC0 track found — continuing without music",
        );
      }
    } else {
      await reportProgress(input.jobId, 90, "Music provider not configured — skipped");
    }

    await chain(input, CAPTIONS_JOB, "CAPTIONS", MUSIC_JOB);

    return { acquired };
  });
}

// ---------------------------------------------------------------------------
// Stage 5 — captions
// ---------------------------------------------------------------------------

/**
 * Transcribe the narration into caption cues.
 *
 * Per scene, then offset into video time. Transcribing each scene's audio
 * separately means every cue's timestamp is relative to a file whose position on
 * the timeline is already measured, so the cues cannot drift from the narration
 * even if a scene's audio is regenerated.
 *
 * Like music, this degrades rather than fails: captions are an accessibility and
 * retention win, not a precondition for a video existing.
 */
export async function executeCaptions(input: StageInput): Promise<{
  cues: number;
}> {
  return runStage(input, "CAPTIONS", async () => {
    if (!isTranscriptionConfigured()) {
      await reportProgress(
        input.jobId,
        90,
        "Transcription provider not configured — skipped",
      );
      await chain(input, TIMELINE_JOB, "TIMELINE", CAPTIONS_JOB);
      return { cues: 0 };
    }

    const sceneRows = await loadScenes(input.userId, input.projectId);
    const settings = await loadSettings(input.userId, input.projectId);
    const audio = await loadNarrationAssets(input.userId, input.projectId);

    const cues: Array<{ startMs: number; endMs: number; text: string }> = [];
    let offsetMs = 0;
    let failures = 0;

    for (const [position, scene] of sceneRows.entries()) {
      const segment = audio.get(scene.index);
      if (!segment) continue;

      await reportProgress(
        input.jobId,
        Math.round((position / Math.max(1, sceneRows.length)) * 85),
        `Transcribing scene ${position + 1} of ${sceneRows.length}`,
      );

      try {
        const bytes = await getObjectBuffer(segment.storageKey);

        const result = await transcribe({
          audio: bytes,
          filename: `scene-${scene.index}.${extensionOf(segment.mimeType)}`,
          mimeType: segment.mimeType,
          language: settings.language,
          scriptHint: scene.narration,
          usage: {
            userId: input.userId,
            projectId: input.projectId,
            jobId: input.jobId,
            traceId: input.traceId ?? null,
          },
        });

        for (const cue of result.cues) {
          cues.push({
            startMs: cue.startMs + offsetMs,
            endMs: cue.endMs + offsetMs,
            text: cue.text,
          });
        }
      } catch (error) {
        failures += 1;
        log.warn("scene transcription failed", {
          projectId: input.projectId,
          sceneIndex: scene.index,
          error,
        });
      }

      // The offset advances by the segment's measured duration whether or not the
      // transcription succeeded, so one failed scene shifts nothing after it.
      offsetMs += segment.durationMs;
    }

    if (cues.length > 0) {
      const srt = toSrt(cues);
      const vtt = toVtt(cues);

      const [srtAsset, vttAsset] = await Promise.all([
        storeAsset({
          userId: input.userId,
          projectId: input.projectId,
          folder: "caption",
          kind: "caption_file",
          bytes: Buffer.from(srt, "utf8"),
          mimeType: "application/x-subrip",
          extension: "srt",
          provider: transcriptionProviderName(),
        }),
        storeAsset({
          userId: input.userId,
          projectId: input.projectId,
          folder: "caption",
          kind: "caption_file",
          bytes: Buffer.from(vtt, "utf8"),
          mimeType: "text/vtt",
          extension: "vtt",
          provider: transcriptionProviderName(),
        }),
      ]);

      await db.transaction(async (tx) => {
        await tx
          .delete(captions)
          .where(
            and(
              eq(captions.projectId, input.projectId),
              eq(captions.userId, input.userId),
            ),
          );

        await tx.insert(captions).values({
          projectId: input.projectId,
          userId: input.userId,
          language: settings.language ?? "en",
          provider: transcriptionProviderName(),
          cues,
          srtAssetId: srtAsset.id,
          vttAssetId: vttAsset.id,
        });
      });
    }

    if (failures > 0) {
      log.warn("captions incomplete", {
        projectId: input.projectId,
        failures,
        total: sceneRows.length,
      });
    }

    await chain(input, TIMELINE_JOB, "TIMELINE", CAPTIONS_JOB);

    return { cues: cues.length };
  });
}

// ---------------------------------------------------------------------------
// Stage 6 — timeline
// ---------------------------------------------------------------------------

/**
 * Assemble the timeline and write the measured offsets back.
 *
 * The point at which estimates stop existing. Until now `scenes.start_ms` has
 * been null; this stage fills it from accumulated audio lengths, and everything
 * downstream — the chapter list, the studio's scene rail, the render — reads those
 * numbers rather than deriving its own.
 */
export async function executeTimeline(input: StageInput): Promise<{
  durationMs: number;
  scenes: number;
}> {
  return runStage(input, "TIMELINE", async () => {
    await reportProgress(input.jobId, 20, "Assembling the timeline");

    const timeline = await assembleTimeline(input.userId, input.projectId);

    await reportProgress(input.jobId, 60, "Writing scene offsets");

    // Offsets onto the scene rows, in one transaction: a half-written set would
    // put the scene rail and the render out of agreement.
    await db.transaction(async (tx) => {
      for (const scene of timeline.scenes) {
        await tx
          .update(scenesTable)
          .set({
            startMs: scene.startMs,
            durationMs: scene.durationMs,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(scenesTable.projectId, input.projectId),
              eq(scenesTable.userId, input.userId),
              eq(scenesTable.index, scene.index),
            ),
          );
      }
    });

    // Assets are complete and aligned. ASSETS_READY exists for exactly this
    // moment, and the state machine has no ASSETS_GENERATING → RENDERING edge, so
    // it is passed through rather than skipped.
    await transition(input.userId, input.projectId, "ASSETS_READY", {
      stage: "TIMELINE",
      message: "Assets ready",
      progress: deriveProgress(COMPLETED_AFTER[TIMELINE_JOB] ?? []),
      meta: { durationMs: timeline.durationMs, scenes: timeline.scenes.length },
    });

    await enqueueNext(input, RENDER_JOB, "RENDER");

    return { durationMs: timeline.durationMs, scenes: timeline.scenes.length };
  });
}

// ---------------------------------------------------------------------------
// Stage 7 — render
// ---------------------------------------------------------------------------

/**
 * Render the video.
 *
 * The render row is written before submission, so a render that dies at the
 * provider leaves a row with its timeline attached and can be diagnosed — and
 * re-submitted — without regenerating a single asset.
 *
 * Progress comes from the provider, or from ffmpeg's own `out_time_ms`, and
 * nowhere else. `renders.progress` sitting at 0 for a minute is a truthful
 * report that the provider has not said anything yet; the studio screen already
 * shows an indeterminate bar for that case.
 */
export async function executeRender(input: StageInput): Promise<{
  renderId: string;
  assetId: string;
  durationMs: number | null;
}> {
  const project = await getProject(input.userId, input.projectId);

  // RENDERING is entered here rather than in the timeline stage so the project is
  // only ever in RENDERING while a render job is actually running.
  if (project.status !== "RENDERING") {
    await transition(input.userId, input.projectId, "RENDERING", {
      stage: "RENDER",
      message: "Rendering",
      progress: deriveProgress(COMPLETED_AFTER[TIMELINE_JOB] ?? []),
    });
  }

  return runStage(input, "RENDER", async () => {
    /**
     * The project's saved cut, if it has one (Phase B).
     *
     * Null for a project that was never opened in the editor, and that is what keeps an
     * unedited render on exactly the path it was on before the editor existed. When a cut
     * *does* exist it is the source of truth: its compiled timeline replaces the one
     * assembled from scene rows, so a render cannot quietly ignore an edit the user made
     * and saved.
     */
    const edit = await compileProjectEdit(input.userId, input.projectId);

    // `assembleTimeline` is still called when there is no cut — it is the pipeline's own
    // assembly, unchanged. When there is one, the compiler already produced the same
    // document shape in the same pass that produced the clip list, so re-assembling from
    // rows would discard the edit.
    const timeline = edit
      ? edit.timeline
      : await assembleTimeline(input.userId, input.projectId);

    if (timeline.scenes.length === 0) {
      // A cut with every clip deleted compiles to a document with no scenes. Refusing
      // here names the cause; `submitRender` would otherwise reject it as an empty
      // timeline, which reads like a pipeline fault rather than an edit.
      throw new RenderError("the saved edit has no visible clips to render", {
        retryable: false,
      });
    }

    const [renderRow] = await db
      .insert(renders)
      .values({
        projectId: input.projectId,
        userId: input.userId,
        provider: renderProviderName(),
        status: "running",
        progress: 0,
        timeline: timeline as unknown as Record<string, unknown>,
        width: timeline.width,
        height: timeline.height,
        fps: timeline.fps,
        durationMs: timeline.durationMs,
        startedAt: new Date(),
      })
      .returning({ id: renders.id });

    if (!renderRow) throw new RenderError("could not record the render");

    try {
      const urls = await signTimelineAssets(timeline, edit);

      await reportProgress(input.jobId, 5, "Submitting the render");

      const submission = await submitRender(
        timeline,
        { urls },
        {
          projectId: input.projectId,
          userId: input.userId,
          traceId: input.traceId ?? null,
          edit,
          onProgress: async (progress) => {
            await recordRenderProgress(input, renderRow.id, progress);
          },
        },
      );

      await db
        .update(renders)
        .set({ providerRenderId: submission.providerRenderId })
        .where(
          and(eq(renders.id, renderRow.id), eq(renders.userId, input.userId)),
        );

      const output =
        submission.output ??
        (await awaitRender(input, renderRow.id, submission.providerRenderId));

      await reportProgress(input.jobId, 95, "Storing the video");

      const asset = await storeAsset({
        userId: input.userId,
        projectId: input.projectId,
        folder: "video",
        kind: "render_output",
        bytes: output.bytes,
        mimeType: output.mimeType,
        extension: output.extension,
        width: timeline.width,
        height: timeline.height,
        durationMs: output.durationMs ?? timeline.durationMs,
        provider: submission.provider,
      });

      await db
        .update(renders)
        .set({
          status: "succeeded",
          progress: 100,
          outputAssetId: asset.id,
          durationMs: output.durationMs ?? timeline.durationMs,
          completedAt: new Date(),
          error: null,
        })
        .where(
          and(eq(renders.id, renderRow.id), eq(renders.userId, input.userId)),
        );

      // Stamp the cut as exported, so the editor can show whether the saved edit is the
      // one in the finished video. Only when there was a cut, and only after the render
      // actually succeeded.
      if (edit) await markEditRendered(input.userId, input.projectId);

      await transition(input.userId, input.projectId, "VIDEO_READY", {
        stage: "RENDER",
        message: "Video ready",
        // Through RENDER only. QUALITY_CHECK, THUMBNAIL and METADATA are later
        // stages that have not run, and counting them here would show 100% on a
        // video that still has no thumbnail.
        progress: deriveProgress([
          ...(COMPLETED_AFTER[TIMELINE_JOB] ?? []),
          "RENDER",
        ]),
        meta: { renderId: renderRow.id, assetId: asset.id },
      });

      log.info("render complete", {
        userId: input.userId,
        projectId: input.projectId,
        jobId: input.jobId,
        stage: "RENDER",
        status: "succeeded",
        provider: submission.provider,
        bytes: output.bytes.byteLength,
        durationMs: output.durationMs ?? timeline.durationMs,
      });

      /**
       * Queue the continuity check, after the video is ready and outside the render's
       * own success path.
       *
       * `.catch` rather than `await` bare: the render has succeeded, the project is
       * `VIDEO_READY`, and failing to enqueue a quality check must not turn that into
       * a failed render (§22). A missing check is visible in the studio screen as no
       * continuity score, which is honest.
       */
      await enqueueContinuityCheck(input).catch((error: unknown) => {
        log.warn("could not queue the continuity check", {
          projectId: input.projectId,
          error,
        });
      });

      return {
        renderId: renderRow.id,
        assetId: asset.id,
        durationMs: output.durationMs ?? timeline.durationMs,
      };
    } catch (error) {
      // The render row carries the failure independently of the job row: the
      // studio screen reads the render, and a row left `running` forever is
      // exactly the stuck spinner §30 prohibits.
      await db
        .update(renders)
        .set({
          status: "failed",
          error: userMessageOf(error),
          completedAt: new Date(),
        })
        .where(
          and(eq(renders.id, renderRow.id), eq(renders.userId, input.userId)),
        )
        .catch(() => {});

      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// Stage 8 — continuity check (§10, §11, §12, §13)
// ---------------------------------------------------------------------------

/**
 * Validate the video's continuity, and regenerate the scenes that failed.
 *
 * This is the `QUALITY_CHECK` stage. It has existed in `PIPELINE_STAGES` and in the
 * `pipeline_stage` enum since Phase 2 with nothing behind it; the continuity layer
 * is its first occupant. The findings go into the existing `quality_checks` table
 * with the existing `pass|warn|fail` verdict, so the studio screen reads them
 * through the query it already has.
 *
 * Three things this stage deliberately does not do:
 *
 *  - **It does not fail the project.** By the time it runs the video is
 *    `VIDEO_READY` and the render is paid for. A continuity problem is recorded and
 *    shown, and the state machine is left alone. §22.
 *  - **It does not block publishing.** `publishReadiness` is unchanged. A video with
 *    a warn verdict is still a video, and the operator decides.
 *  - **It does not re-render.** Regenerating a scene replaces that scene's asset;
 *    the user re-exports from the editor when they want the change in an MP4. Kicking
 *    off a second render automatically would double the cost of every failed check.
 */
export async function executeContinuityCheck(input: StageInput): Promise<{
  checked: boolean;
  score: number | null;
  status: string | null;
  regenerating: number;
}> {
  return runStage(input, "QUALITY_CHECK", async () => {
    const project = await getProject(input.userId, input.projectId);
    const sceneRows = await loadScenes(input.userId, input.projectId);

    const continuityProject = {
      projectId: input.projectId,
      channelId: project.channelId,
      generationMode: isGenerationMode(project.generationMode)
        ? project.generationMode
        : null,
      tier: input.tier,
    };

    await reportProgress(input.jobId, 30, "Checking continuity");

    /**
     * The prompt each scene was generated with, reassembled.
     *
     * `continuityPrompt` is the block as *sent*, so this is the request the provider
     * saw rather than one recomputed from the current bible. That distinction is the
     * whole value of the check: recomputing would validate the bible against itself
     * and pass even if the visuals stage had dropped the block entirely.
     */
    const promptRows = await loadScenePrompts(input.userId, input.projectId);

    const { report, context } = await checkContinuity({
      userId: input.userId,
      project: continuityProject,
      visuals: sceneRows.map((scene) => {
        const block = promptRows.get(scene.index) ?? null;
        const base = basePromptFor(scene);
        return {
          sceneIndex: scene.index,
          visualPrompt: block ? `${base}\n\n${block}` : base,
          searchTerms: scene.searchTerms,
          /**
           * The shot alone, for repetition detection.
           *
           * Both halves are passed because the two checks need different things: the
           * constraint checks read the full prompt to confirm the block survived into
           * the request, while repetition must compare only the direction — the block
           * is identical by design on every scene sharing a cast, and comparing it
           * would make two unrelated shots of one character read as a duplicate.
           */
          shotPrompt: base,
        };
      }),
    });

    if (!report) {
      // Continuity did not apply, or could not be evaluated. Not a failure: this is
      // every project built before the layer existed, and every stock video.
      await setProgress(
        input.userId,
        input.projectId,
        deriveProgress([
          ...(COMPLETED_AFTER[TIMELINE_JOB] ?? []),
          "RENDER",
          "QUALITY_CHECK",
        ]),
      );
      return { checked: false, score: null, status: null, regenerating: 0 };
    }

    await reportProgress(input.jobId, 70, `Continuity score ${report.score}`);

    const toRegenerate = await scenesToRegenerate({
      userId: input.userId,
      projectId: input.projectId,
      context,
      report,
    });

    for (const sceneIndex of toRegenerate) {
      await enqueueSceneRegeneration(input, sceneIndex);
    }

    await setProgress(
      input.userId,
      input.projectId,
      deriveProgress([
        ...(COMPLETED_AFTER[TIMELINE_JOB] ?? []),
        "RENDER",
        "QUALITY_CHECK",
      ]),
    );

    log.info("continuity check complete", {
      userId: input.userId,
      projectId: input.projectId,
      jobId: input.jobId,
      stage: "QUALITY_CHECK",
      score: report.score,
      verdict: report.status,
      regenerating: toRegenerate.length,
    });

    return {
      checked: true,
      score: report.score,
      status: report.status,
      regenerating: toRegenerate.length,
    };
  });
}

/**
 * Regenerate one scene's visual with the continuity failures in the prompt (§13).
 *
 * Reuses the visuals stage's machinery exactly: `generateSceneClip` → `storeAsset` →
 * `UPDATE scenes SET visual_asset_id`. The only difference is the prompt, which
 * carries what was wrong with the previous attempt — a model told "the coat was blue
 * and must be brown" can act on that, while one told "try again" produces another
 * draw from the same distribution at the same price.
 *
 * The old asset row is left in place rather than deleted. It is provenance: the
 * regeneration is recorded in `scenes.continuity_regenerations`, and an asset that
 * no scene points at is already how the editor's replaced clips behave.
 */
export async function executeSceneRegeneration(
  input: StageInput & { sceneIndex: number },
): Promise<{ regenerated: boolean; attempt: number }> {
  return runStage(input, "QUALITY_CHECK", async () => {
    const project = await getProject(input.userId, input.projectId);
    const plan = generationPlanFor(project);

    if (plan.mode !== "AI_VIDEO" || !plan.model) {
      // Continuity only regenerates generated scenes. A stock clip is not wrong
      // because it differs from the last one — it is a different clip by nature.
      return { regenerated: false, attempt: 0 };
    }

    const continuityProject = {
      projectId: input.projectId,
      channelId: project.channelId,
      generationMode: isGenerationMode(project.generationMode)
        ? project.generationMode
        : null,
      tier: input.tier,
    };

    const context = await loadContinuityContext(input.userId, continuityProject);
    if (!context.active) return { regenerated: false, attempt: 0 };

    const sceneRows = await loadScenes(input.userId, input.projectId);
    const scene = sceneRows.find((row) => row.index === input.sceneIndex);
    if (!scene) {
      throw new NotFoundError(
        `Scene ${input.sceneIndex} is not in this project's plan.`,
      );
    }

    const check = await latestContinuityCheck(input.userId, input.projectId);
    const issues = (check?.findings ?? [])
      .filter(
        (finding) =>
          finding.severity === "fail" &&
          (finding.detail ?? "").includes(`scene ${input.sceneIndex}`),
      )
      .map((finding) => finding.message);

    /**
     * Counted before the provider call, not after.
     *
     * The count is a spend ceiling, so it has to be incremented by the attempt
     * rather than by the success. A generation that fails halfway through still cost
     * money, and a scene that could fail forever without ever incrementing would
     * defeat the cap.
     */
    const attempt = await countRegeneration({
      userId: input.userId,
      projectId: input.projectId,
      sceneIndex: input.sceneIndex,
    });

    if (attempt > context.thresholds.maxRegenerations) {
      log.info("scene has reached its regeneration ceiling", {
        projectId: input.projectId,
        sceneIndex: input.sceneIndex,
        attempt,
      });
      return { regenerated: false, attempt };
    }

    const narration = await loadNarrationDurations(input.userId, input.projectId);
    const durationMs = narration.get(scene.index) ?? 6_000;

    const usage = {
      userId: input.userId,
      projectId: input.projectId,
      jobId: input.jobId,
      traceId: input.traceId ?? null,
    };

    await reportProgress(
      input.jobId,
      20,
      `Regenerating scene ${input.sceneIndex + 1} for continuity`,
    );

    const prompt = regenerationPromptFor({
      context,
      report: {
        // Only `issues` is read by `regenerationPromptFor`, via `issuesForScene`.
        // Reconstructed from the stored findings so the prompt carries the failures
        // this job was queued for rather than a fresh, possibly different, opinion.
        score: 0,
        status: "fail",
        components: {
          characterConsistency: 0,
          environmentConsistency: 0,
          propContinuity: 0,
          storyContinuity: 0,
          styleConsistency: 0,
          duplicateRisk: 0,
        },
        issues: issues.map((message) => ({
          code: "continuity.regenerate",
          severity: "fail" as const,
          message,
          sceneIndex: input.sceneIndex,
          entityId: null,
        })),
        affectedScenes: [input.sceneIndex],
        affectedEntities: [],
        repetitions: [],
      },
      sceneIndex: input.sceneIndex,
      visualPrompt: basePromptFor(scene),
    });

    /**
     * The same references the first attempt would have had (§6).
     *
     * A regeneration exists because continuity *failed*, so it is the attempt that
     * most needs whatever constraint is available — omitting the references here would
     * mean the retry was given less to go on than the attempt that already lost.
     * Same capability gate, same fallback to textual continuity when there is nothing
     * stored or the model cannot use it.
     */
    const references = plan.model.capabilities.referenceImages
      ? referencesForScene({
          context,
          sceneIndex: scene.index,
          stored: await loadContinuityReferences(input.userId, input.projectId),
        })
      : [];

    const visual = await generateSceneClip({
      plan,
      modelId: plan.model.id,
      scene: { index: scene.index },
      prompt,
      durationMs,
      /**
       * Offset by one, because the visuals stage already used 1.
       *
       * `countRegeneration` returns 1 for the *first* regeneration, and the original
       * generation of this scene charged under `attempt: 1`. Passing the raw count would
       * collide with that key, lose the ledger insert, and give away every first
       * regeneration for free — the one case that costs most, since a project that
       * fails continuity usually fails it on several scenes.
       *
       * Charging for a regeneration is intended: §12 makes it a second generation, and
       * the ceiling in `context.thresholds.maxRegenerations` is what bounds the spend.
       */
      attempt: attempt + 1,
      usage,
      references,
    });

    const asset = await storeAsset({
      userId: input.userId,
      projectId: input.projectId,
      folder: "visual",
      kind: visual.kind,
      bytes: visual.bytes,
      mimeType: visual.mimeType,
      extension: visual.extension,
      width: visual.width,
      height: visual.height,
      durationMs: visual.durationMs,
      provider: visual.provider,
      providerAssetId: visual.providerAssetId,
      sourceUrl: visual.sourceUrl,
      license: visual.license,
      attribution: visual.attribution,
      authorName: visual.authorName,
      meta: {
        sceneIndex: scene.index,
        matchedOn: visual.matchedOn,
        // Provenance: this asset exists because continuity rejected the last one.
        continuityRegeneration: attempt,
      },
    });

    await db
      .update(scenesTable)
      .set({ visualAssetId: asset.id, updatedAt: new Date() })
      .where(
        and(
          eq(scenesTable.projectId, input.projectId),
          eq(scenesTable.userId, input.userId),
          eq(scenesTable.index, scene.index),
        ),
      );

    log.info("scene regenerated for continuity", {
      userId: input.userId,
      projectId: input.projectId,
      jobId: input.jobId,
      sceneIndex: scene.index,
      attempt,
    });

    return { regenerated: true, attempt };
  });
}

// ---------------------------------------------------------------------------
// Reference stills for the story bible (§5, §6)
// ---------------------------------------------------------------------------

export interface ReferenceImagesResult {
  /** Stills actually stored by this run. */
  generated: number;
  /** Entities that were wanted but could not be produced. */
  failed: number;
  /** Entities that already had a reference and were left alone. */
  skipped: number;
  /** Why nothing was generated, when nothing was. Shown verbatim. */
  reason: string;
}

/**
 * Generate the story bible's character, environment and prop reference stills.
 *
 * This is where §5's image capability meets §6's continuity layer, and the division of
 * labour is the point:
 *
 *  - `lib/continuity` decides *what* to draw and writes the prompt. It reads the same
 *    bible fields, in the same order, that the scene prompts render, so a reference is
 *    a reference rather than a second opinion.
 *  - This stage spends the money, using the project's **own selected model**. A
 *    reference drawn by a different model than the scenes would be a picture of what
 *    some other generator thinks the character looks like — worse than having none,
 *    because it reads as approved.
 *  - `storeAsset` persists it, on the existing `assets` table, flagged in `meta` so
 *    `getReferenceImages` can find it again.
 *
 * One entity failing costs that entity its still, not the run: eight characters and one
 * refused prompt should leave seven references, not zero. Nothing here fails the
 * project — by the time this runs the scene plan is stored, and a missing reference
 * degrades to the textual continuity every model already relies on (§8).
 */
export async function executeReferenceImages(
  input: StageInput,
): Promise<ReferenceImagesResult> {
  return runStage(input, "SCENE_PLAN", async () => {
    const project = await getProject(input.userId, input.projectId);
    const plan = generationPlanFor(project);

    if (plan.mode !== "AI_VIDEO" || !plan.model) {
      // Stock projects have no bible to illustrate, and `resolveFor` would return an
      // inert context anyway. Returned as a reason rather than an error: this is the
      // ordinary state of most projects.
      return {
        generated: 0,
        failed: 0,
        skipped: 0,
        reason: "Stock footage: there is no story bible to illustrate.",
      };
    }

    /**
     * Refused before anything is spent, not per entity.
     *
     * Every branded model generates stills, so this is reachable only for a legacy
     * model a project stored before it was retired (§17). Failing here with the
     * model's own name is more useful than eight identical per-entity failures.
     */
    if (!plan.model.capabilities.imageGeneration) {
      return {
        generated: 0,
        failed: 0,
        skipped: 0,
        reason:
          `${plan.model.label} does not generate still images, so this video's ` +
          `continuity relies on textual constraints alone.`,
      };
    }

    const wanted = await referenceImagePlan({
      userId: input.userId,
      project: {
        projectId: input.projectId,
        channelId: project.channelId,
        generationMode: isGenerationMode(project.generationMode)
          ? project.generationMode
          : null,
        tier: input.tier,
      },
    });

    if (wanted.wanted.length === 0) {
      return {
        generated: 0,
        failed: 0,
        skipped: wanted.existing.length,
        reason: wanted.reason,
      };
    }

    /**
     * The still's resolution, resolved once against what the model offers for images.
     *
     * `assertImageQuality` with the project's *video* quality, not a fixed tier: a
     * project rendering at 720p does not need 2K character sheets, and one on 2K
     * should not have its references drawn at draft. When the model's image tiers do
     * not include the video one, `assertImageQuality` picks its nearest — which is
     * why the video quality is passed as a preference rather than asserted.
     */
    const quality = assertImageQuality(
      plan.model,
      plan.model.capabilities.imageQualities.includes(plan.quality)
        ? plan.quality
        : null,
    );

    /**
     * Landscape for every reference, whatever the video's frame is.
     *
     * A reference is a chart, not a shot: a full-body character sheet and an
     * establishing view of a location both want width, and cropping either into a
     * 9:16 frame is how the coat gets cut off in the picture the whole video is
     * supposed to match. Falls back to the model's first supported frame for a model
     * that somehow does not offer landscape.
     */
    const format = plan.model.formats.includes("landscape")
      ? "landscape"
      : (plan.model.formats[0] ?? plan.format);

    /**
     * Granted before the first still, for the reason the visuals stage grants: a
     * subscriber whose period has just rolled over has a stale zero balance, and
     * skipping their references for that would look like the feature was broken.
     *
     * No affordability *estimate* here, unlike the visuals stage. References are
     * optional by design — the video renders without them — so the honest behaviour
     * when the balance runs out mid-run is to keep the stills already paid for and stop,
     * which is what the loop below does. An up-front refusal would throw away
     * affordable references to avoid the unaffordable ones.
     */
    await ensureMonthlyGrant(input.userId, {});

    let generated = 0;
    let failed = 0;
    let unaffordable = 0;

    for (const [position, entry] of wanted.wanted.entries()) {
      await reportProgress(
        input.jobId,
        Math.round((position / wanted.wanted.length) * 95),
        `Drawing reference ${position + 1} of ${wanted.wanted.length}: ${entry.name}`,
      );

      const outcome = await generateReference({
        input,
        modelId: plan.model.id,
        format,
        quality,
        entry,
        index: position,
      });

      if (outcome === "stored") {
        generated += 1;
        continue;
      }

      if (outcome === "failed") {
        failed += 1;
        continue;
      }

      /**
       * Out of credits. Stop rather than ask seven more times.
       *
       * Every remaining entity costs the same and the balance only goes down, so the
       * refusals would be identical — and each one is a transaction and a log line for
       * an answer already known. The entities not attempted are reported as skipped,
       * because that is what happened to them.
       */
      unaffordable = wanted.wanted.length - position;
      break;
    }

    log.info("reference stills generated", {
      userId: input.userId,
      projectId: input.projectId,
      jobId: input.jobId,
      stage: "SCENE_PLAN",
      model: plan.model.id,
      generated,
      failed,
      unaffordable,
      skipped: wanted.existing.length,
    });

    return {
      generated,
      failed,
      skipped: wanted.existing.length + unaffordable,
      /**
       * Named plainly when credits ran out, and empty otherwise.
       *
       * `reason` is shown verbatim, and "there were not enough credits for the
       * remaining N" is something the user can act on — top up, or accept textual
       * continuity. Reporting the stills as merely "skipped" would be true and useless.
       */
      reason:
        unaffordable > 0
          ? `Generated ${generated} reference ${generated === 1 ? "image" : "images"}, ` +
            `then ran out of credits with ${unaffordable} still to draw. This video's ` +
            `remaining continuity relies on textual constraints. Top up to draw the rest.`
          : "",
    };
  });
}

/**
 * What happened to one entity's still.
 *
 * `unaffordable` is separated from `failed` because the caller does different things
 * with them: a failure is per entity and the run continues, while an empty balance is
 * true of every remaining entity and the run stops. Collapsing them into a boolean is
 * what would produce eight identical credit refusals.
 */
type ReferenceOutcome = "stored" | "failed" | "unaffordable";

/**
 * Generate and store one reference still. Reports the outcome instead of throwing.
 *
 * The boundary that makes "one entity failing costs that entity" true. It is the same
 * trade `compositeVariant` makes for thumbnails: failing the whole run to punish one
 * refused prompt throws away the references that did work.
 *
 * The purpose passed to the provider is the entity kind — `character`, `environment`
 * or `prop` — which is also what lands on `assets.meta.referenceKind`. `ImagePurpose`
 * and `ReferenceKind` share those three words deliberately, so there is no mapping
 * table between the prompt builder, the provider and the stored asset.
 */
async function generateReference(args: {
  input: StageInput;
  modelId: string;
  format: VideoFormat;
  quality: VideoQuality;
  entry: { kind: ReferenceKind; entityId: string; name: string; prompt: string };
  index: number;
}): Promise<ReferenceOutcome> {
  const { input, entry } = args;

  try {
    /**
     * Charged at the image rate, keyed by entity (§5, §12).
     *
     * `imageChargeKey` is keyed on the entity rather than on an ordinal because this
     * stage is explicitly re-runnable: `referenceImagePlan` already excludes entities
     * that have a stored still, and the key means a re-run that races that check still
     * cannot charge twice for the same character.
     *
     * A refusal for want of credits is caught by this function's own `catch` and costs
     * that entity its still rather than the run — the same treatment a refused prompt
     * gets, and correct for the same reason: seven references are better than none, and
     * a missing one degrades to the textual constraint the prompt already carries.
     */
    const image = await paidGeneration({
      userId: input.userId,
      projectId: input.projectId,
      operation: "image",
      modelId: args.modelId,
      quality: args.quality,
      idempotencyKey: imageChargeKey({
        projectId: input.projectId,
        purpose: entry.kind,
        entityId: entry.entityId,
      }),
      description: `Reference image — ${entry.name} (${args.quality})`,
      meta: { referenceKind: entry.kind, entityId: entry.entityId },
      generate: () =>
        generateImage(
          {
            prompt: entry.prompt,
            modelId: args.modelId,
            format: args.format,
            quality: args.quality,
            purpose: entry.kind,
            index: args.index,
          },
          {
            usage: {
              userId: input.userId,
              projectId: input.projectId,
              jobId: input.jobId,
              traceId: input.traceId ?? null,
              operation: "continuity.reference.image",
            },
          },
        ),
    });

    await storeAsset({
      userId: input.userId,
      projectId: input.projectId,
      folder: "reference",
      // The bytes are a still, so the kind says so. Recording a reference as
      // anything else would put it in the editor's clip picker.
      kind: "generated_image",
      bytes: image.bytes,
      mimeType: image.mimeType,
      extension: image.extension,
      width: image.width,
      height: image.height,
      // No duration: it is a picture. Null rather than 0, which would read as a
      // zero-length clip to the timeline.
      durationMs: null,
      provider: image.provider,
      providerAssetId: image.providerAssetId,
      sourceUrl: null,
      license: image.license,
      attribution: image.attribution,
      meta: referenceAssetMeta({
        kind: entry.kind,
        entityId: entry.entityId,
        entityName: entry.name,
        prompt: entry.prompt,
        modelId: image.modelId,
      }),
    });

    return "stored";
  } catch (error) {
    /**
     * An empty balance is reported, not logged as a failure.
     *
     * It is the one error here that says something about every *other* entity too, and
     * the caller stops on it. Logged at info because it is a customer's spending
     * decision rather than a defect — a warning per entity would make an ordinary state
     * look like eight broken generations.
     */
    if (error instanceof InsufficientCreditsError) {
      log.info("not enough credits for a continuity reference still", {
        userId: input.userId,
        projectId: input.projectId,
        jobId: input.jobId,
        stage: "SCENE_PLAN",
        referenceKind: entry.kind,
        entityId: entry.entityId,
      });
      return "unaffordable";
    }

    log.warn("could not generate a continuity reference still", {
      userId: input.userId,
      projectId: input.projectId,
      jobId: input.jobId,
      stage: "SCENE_PLAN",
      referenceKind: entry.kind,
      entityId: entry.entityId,
      error,
    });
    return "failed";
  }
}

/**
 * Queue the reference-still stage for a project.
 *
 * Guarded by `hasActiveJob` for the reason the guard exists everywhere else here, and
 * with more at stake than most: two concurrent runs would both read the same "nothing
 * stored yet" answer from `referenceImagePlan` and both pay for the whole cast.
 *
 * Takes its own input shape rather than `StageInput`, because the callers are a request
 * handler and (eventually) another stage, and only one of those has a `jobId`. The one
 * that matters — the id of the job being created — comes back from `enqueue`.
 *
 * Returns false when a run is already in flight, so the caller can say so.
 */
export async function enqueueReferenceImages(input: {
  userId: string;
  projectId: string;
  tier: PlanTier;
  traceId?: string | null;
}): Promise<boolean> {
  const project = await getProject(input.userId, input.projectId);
  const scope = project.channelId ? undefined : project.id;

  if (
    await hasActiveJob(
      input.userId,
      project.channelId ?? null,
      REFERENCE_IMAGES_JOB,
      scope,
    )
  ) {
    return false;
  }

  await enqueue({
    queue: "pipeline",
    name: REFERENCE_IMAGES_JOB,
    userId: input.userId,
    channelId: project.channelId,
    projectId: input.projectId,
    stage: "SCENE_PLAN",
    payload: { projectId: input.projectId, tier: input.tier },
    priority: queuePriorityFor(input.tier),
    traceId: input.traceId ?? project.traceId,
    statusMessage: "Queued",
  });

  return true;
}

/**
 * Queue the continuity check for a project.
 *
 * Guarded by `hasActiveJob` the same way `startVideoBuild` guards its seven jobs: a
 * render retried after a transient failure must not leave two checks queued, both
 * writing a `quality_checks` row for the same video.
 */
async function enqueueContinuityCheck(input: StageInput): Promise<void> {
  const project = await getProject(input.userId, input.projectId);
  const scope = project.channelId ? undefined : project.id;

  if (
    await hasActiveJob(
      input.userId,
      project.channelId ?? null,
      CONTINUITY_JOB,
      scope,
    )
  ) {
    return;
  }

  await enqueue({
    queue: "pipeline",
    name: CONTINUITY_JOB,
    userId: input.userId,
    channelId: project.channelId,
    projectId: input.projectId,
    stage: "QUALITY_CHECK",
    payload: { projectId: input.projectId, tier: input.tier },
    priority: queuePriorityFor(input.tier),
    traceId: input.traceId ?? project.traceId,
    statusMessage: "Queued",
  });
}

/**
 * Queue one scene's regeneration.
 *
 * The idempotency key is the scene, not the project: two scenes regenerating
 * concurrently is correct, the same scene twice is not. `hasActiveJob` locks the
 * whole project, so this uses `hasActiveSceneJob`, which adds the scene index from
 * the payload to the same predicate.
 */
async function enqueueSceneRegeneration(
  input: StageInput,
  sceneIndex: number,
): Promise<void> {
  const project = await getProject(input.userId, input.projectId);

  if (
    await hasActiveSceneJob(
      input.userId,
      input.projectId,
      SCENE_REGEN_JOB,
      sceneIndex,
    )
  ) {
    return;
  }

  await enqueue({
    queue: "pipeline",
    name: SCENE_REGEN_JOB,
    userId: input.userId,
    channelId: project.channelId,
    projectId: input.projectId,
    stage: "QUALITY_CHECK",
    payload: { projectId: input.projectId, tier: input.tier, sceneIndex },
    priority: queuePriorityFor(input.tier),
    traceId: input.traceId ?? project.traceId,
    statusMessage: `Queued — scene ${sceneIndex + 1}`,
  });
}

/** The continuity block each scene was generated with, by scene index. */
async function loadScenePrompts(
  userId: string,
  projectId: string,
): Promise<Map<number, string>> {
  const rows = await db
    .select({
      index: scenesTable.index,
      prompt: scenesTable.continuityPrompt,
    })
    .from(scenesTable)
    .where(
      and(eq(scenesTable.projectId, projectId), eq(scenesTable.userId, userId)),
    );

  const out = new Map<number, string>();
  for (const row of rows) {
    if (row.prompt) out.set(row.index, row.prompt);
  }
  return out;
}

/**
 * Poll a hosted render to completion.
 *
 * Every poll writes the provider's own percentage to `renders.progress`, which is
 * what the studio screen reads. Nothing here interpolates between polls.
 */
async function awaitRender(
  input: StageInput,
  renderId: string,
  providerRenderId: string,
): Promise<RenderOutput> {
  const deadline = Date.now() + RENDER_MAX_WAIT_MS;
  let previous = 0;

  for (;;) {
    await sleep(RENDER_POLL_MS);

    const state = await pollRender(providerRenderId, { previousProgress: previous });

    if (state.progress !== null && state.progress !== previous) {
      previous = state.progress;
      await recordRenderProgress(input, renderId, state.progress);
    }

    if (state.status === "succeeded") return state.output;

    if (state.status === "failed") {
      throw new RenderError(state.message, { retryable: state.retryable });
    }

    if (Date.now() > deadline) {
      throw new RenderError(
        `the provider did not finish within ${Math.round(RENDER_MAX_WAIT_MS / 60_000)} minutes`,
        { retryable: true },
      );
    }
  }
}

/**
 * Write render progress to all three places that display it.
 *
 * The render row, the job row and the project's overall figure. Three writes
 * because three different screens read three different rows, and a user watching
 * the dashboard should not see a different number from a user watching the studio.
 * The render's 0–100 is scaled into the render stage's 25-point share of the
 * project total.
 */
async function recordRenderProgress(
  input: StageInput,
  renderId: string,
  progress: number,
): Promise<void> {
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));

  await db
    .update(renders)
    .set({ progress: clamped })
    .where(and(eq(renders.id, renderId), eq(renders.userId, input.userId)))
    .catch(() => {});

  await reportProgress(input.jobId, clamped, `Rendering (${clamped}%)`);

  const base = deriveProgress(COMPLETED_AFTER[TIMELINE_JOB] ?? []);
  const renderWeight = 25;
  await setProgress(
    input.userId,
    input.projectId,
    base + Math.round((clamped / 100) * renderWeight),
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// Timeline assembly
// ---------------------------------------------------------------------------

/**
 * Build the timeline document from what is stored.
 *
 * Called by both the timeline stage and the render stage. Rebuilding rather than
 * reading a stored document means a render retried after a scene was re-acquired
 * uses the new clip — and it keeps the document derived from the rows rather than
 * a second, divergent copy of them.
 */
export async function assembleTimeline(
  userId: string,
  projectId: string,
): Promise<TimelineDocument> {
  const sceneRows = await loadScenes(userId, projectId);
  if (sceneRows.length === 0) {
    throw new AssetMissingError("a scene plan for this video");
  }

  const [project, narrationAssets, visualAssets, music, captionRow, brand] =
    await Promise.all([
      getProject(userId, projectId),
      loadNarrationAssets(userId, projectId),
      loadVisualAssets(userId, projectId),
      loadMusic(userId, projectId),
      loadCaptions(userId, projectId),
      loadBrandKit(userId, projectId),
    ]);

  const timelineScenes = sceneRows.map((scene) => {
    const visual = visualAssets.get(scene.index);
    if (!visual) {
      // Not retryable as a provider fault: the visuals stage must run again.
      throw new AssetMissingError(`a visual for scene ${scene.index + 1}`);
    }

    const narration = narrationAssets.get(scene.index);

    return {
      index: scene.index,
      label: scene.label,
      onScreenText: scene.onScreenText,
      transition: scene.transition,
      visualKey: visual.storageKey,
      visualKind: visual.kind,
      visualDurationMs: visual.durationMs,
      narrationKey: narration?.storageKey ?? null,
      narrationDurationMs: narration?.durationMs ?? 0,
    };
  });

  return buildTimeline({
    // The frame the project chose, or landscape when it chose none (§16). Read from
    // the project rather than from the clips: a portrait video whose stock provider
    // only had landscape footage is still a portrait video, and the renderer crops.
    // `formatSpec` is what turns the nullable column into a known format.
    format: formatSpec(project.videoFormat).format,
    scenes: timelineScenes,
    music,
    captionCues: captionRow?.cues ?? [],
    burnCaptions: captionRow?.burnedIn ?? true,
    captionStyle: brand?.captionStyle ?? null,
    brand: {
      primaryColor: brand?.primaryColor ?? null,
      secondaryColor: brand?.secondaryColor ?? null,
      fontPreference: brand?.fontPreference ?? null,
    },
  });
}

/**
 * Sign every asset the timeline references.
 *
 * Signed for the local encoder too, even though it reads from storage directly —
 * a uniform map means `submitRender` has one contract, and the unused URLs cost a
 * signature computation each.
 */
async function signTimelineAssets(
  timeline: TimelineDocument,
  edit?: CompiledEdit | null,
): Promise<Map<string, string>> {
  const keys = new Set<string>();
  for (const scene of timeline.scenes) {
    keys.add(scene.visualKey);
    if (scene.narrationKey) keys.add(scene.narrationKey);
  }
  if (timeline.music) keys.add(timeline.music.key);

  /**
   * Keys the cut references that the collapsed timeline does not.
   *
   * `TimelineScene` holds one visual and one narration per scene, so a stacked cutaway's
   * footage and narration that sits under no visual appear on the clip list only. They
   * are still in the export, so they still need signing — a hosted provider handed an
   * unsigned key fails with a message that says nothing useful.
   */
  for (const clip of edit?.clips ?? []) {
    if (clip.storageKey) keys.add(clip.storageKey);
  }

  const entries = await Promise.all(
    [...keys].map(
      async (key) =>
        [
          key,
          await signedReadUrl(key, { expiresInSeconds: RENDER_URL_TTL_SECONDS }),
        ] as const,
    ),
  );

  return new Map(entries);
}

// ---------------------------------------------------------------------------
// Stage plumbing
// ---------------------------------------------------------------------------

/**
 * Run a stage body, recording a failure on the project before rethrowing.
 *
 * Rethrowing is what lets the worker decide about a retry; recording first is
 * what stops the project sitting in ASSETS_GENERATING with no explanation. A
 * transition that is itself illegal (the project was cancelled mid-stage) is
 * logged rather than masking the original error.
 */
async function runStage<T>(
  input: StageInput,
  stage: PipelineStage,
  body: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();

  try {
    const result = await body();

    log.info("stage complete", {
      userId: input.userId,
      projectId: input.projectId,
      jobId: input.jobId,
      stage,
      status: "succeeded",
      durationMs: Date.now() - startedAt,
    });

    return result;
  } catch (error) {
    log.error("stage failed", {
      userId: input.userId,
      projectId: input.projectId,
      jobId: input.jobId,
      stage,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error,
    });

    // A retryable error leaves the project alone: the worker will try again, and
    // flashing FAILED between attempts would make a recoverable blip look like a
    // dead build (§37).
    if (!isAppError(error) || !error.retryable) {
      await transition(input.userId, input.projectId, "FAILED", {
        stage,
        error: {
          code: errorCodeOf(error),
          message: userMessageOf(error),
          stage,
        },
      }).catch((transitionError) => {
        log.error("could not record stage failure on project", {
          projectId: input.projectId,
          stage,
          error: transitionError,
        });
      });
    }

    throw error;
  }
}

/** Record this stage's completion on the project, then enqueue the next stage. */
async function chain(
  input: StageInput,
  nextJob: string,
  nextStage: PipelineStage,
  completedJob: string,
): Promise<void> {
  await setProgress(
    input.userId,
    input.projectId,
    deriveProgress(COMPLETED_AFTER[completedJob] ?? []),
  );

  await enqueueNext(input, nextJob, nextStage);
}

async function enqueueNext(
  input: StageInput,
  name: string,
  stage: PipelineStage,
): Promise<void> {
  const project = await getProject(input.userId, input.projectId);

  await enqueue({
    queue: "pipeline",
    name,
    userId: input.userId,
    channelId: project.channelId,
    projectId: input.projectId,
    stage,
    payload: { projectId: input.projectId, tier: input.tier },
    priority: queuePriorityFor(input.tier),
    traceId: input.traceId ?? project.traceId,
    statusMessage: "Queued",
  });
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

interface ApprovedScript {
  scriptId: string;
  versionId: string;
  draft: ScriptDraft;
}

/**
 * The approved script version, as a draft.
 *
 * Approval is checked here rather than trusted from the caller: this is the
 * function every stage reads the script through, so an unapproved script cannot
 * reach a paid provider by any path (§9).
 *
 * The version's prose lives in typed columns rather than a blob, so the draft is
 * reassembled from them. It is not re-validated against `ScriptDraftSchema`:
 * that schema is the *generator's* contract (minimum lengths a model must meet),
 * and applying it here would reject a user-edited version whose introduction the
 * author deliberately cut short. What matters for a build is asserted directly —
 * a hook and at least one section with narration in it.
 */
async function loadApprovedScript(
  userId: string,
  projectId: string,
): Promise<ApprovedScript> {
  const rows = await db
    .select({
      scriptId: scripts.id,
      approvedAt: scripts.approvedAt,
      versionId: scriptVersions.id,
      title: scriptVersions.title,
      titleIdeas: scriptVersions.titleIdeas,
      hook: scriptVersions.hook,
      introduction: scriptVersions.introduction,
      sections: scriptVersions.sections,
      conclusion: scriptVersions.conclusion,
      cta: scriptVersions.cta,
      storyStructure: scriptVersions.storyStructure,
      references: scriptVersions.references,
    })
    .from(scripts)
    .innerJoin(scriptVersions, eq(scriptVersions.id, scripts.activeVersionId))
    .where(and(eq(scripts.projectId, projectId), eq(scripts.userId, userId)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new NotFoundError(
      "An approved script is required before building a video.",
    );
  }

  if (!row.approvedAt) {
    throw new ConflictError(
      "Approve the script before building the video. Nothing is generated from an unapproved draft.",
    );
  }

  const sections = row.sections.filter((section) => section.body.trim());
  if (!row.hook.trim() || sections.length === 0) {
    throw new ConflictError(
      "The approved script has no narration to build from. Regenerate or edit it first.",
    );
  }

  const draft: ScriptDraft = {
    title: row.title,
    titleIdeas: row.titleIdeas,
    hook: row.hook,
    introduction: row.introduction ?? "",
    sections,
    conclusion: row.conclusion ?? "",
    cta: row.cta ?? "",
    storyStructure: row.storyStructure ?? "",
    references: row.references,
  };

  return { scriptId: row.scriptId, versionId: row.versionId, draft };
}

interface SceneRow {
  index: number;
  label: string | null;
  narration: string;
  visualPrompt: string | null;
  searchTerms: string[];
  onScreenText: string | null;
  transition: string | null;
  visualAssetId: string | null;
}

async function loadScenes(userId: string, projectId: string): Promise<SceneRow[]> {
  return db
    .select({
      index: scenesTable.index,
      label: scenesTable.label,
      narration: scenesTable.narration,
      visualPrompt: scenesTable.visualPrompt,
      searchTerms: scenesTable.searchTerms,
      onScreenText: scenesTable.onScreenText,
      transition: scenesTable.transition,
      visualAssetId: scenesTable.visualAssetId,
    })
    .from(scenesTable)
    .where(
      and(eq(scenesTable.projectId, projectId), eq(scenesTable.userId, userId)),
    )
    .orderBy(asc(scenesTable.index));
}

interface SettingsView {
  niche: string | null;
  videoStyle: string | null;
  voiceId: string | null;
  voiceStyle: string | null;
  voiceSpeed: number | null;
  language: string | null;
}

/**
 * Voice and style settings, when a channel has any.
 *
 * The all-null fallback below already existed for a channel whose settings were
 * never saved. Phase 11 (§4) adds a second way to reach it — a project with no
 * channel at all — and it resolves to the same defaults: the platform voice, the
 * default style. Nothing here needs a channel to produce a video.
 */
async function loadSettings(
  userId: string,
  projectId: string,
): Promise<SettingsView> {
  const project = await getProject(userId, projectId);
  const channelId = project.channelId;

  const rows = channelId
    ? await db
        .select({
          niche: channelSettings.niche,
          videoStyle: channelSettings.videoStyle,
          voiceId: channelSettings.voiceProviderVoiceId,
          voiceStyle: channelSettings.voiceStyle,
          voiceSpeed: channelSettings.voiceSpeed,
          language: channelSettings.contentLanguage,
        })
        .from(channelSettings)
        .where(
          and(
            eq(channelSettings.channelId, channelId),
            eq(channelSettings.userId, userId),
          ),
        )
        .limit(1)
    : [];

  return (
    rows[0] ?? {
      niche: null,
      videoStyle: null,
      voiceId: null,
      voiceStyle: null,
      voiceSpeed: null,
      language: null,
    }
  );
}

interface StoredAudio {
  storageKey: string;
  mimeType: string;
  durationMs: number;
}

/**
 * Narration audio by scene index.
 *
 * Keyed off `assets.meta.sceneIndex`, written by the voiceover stage. Read from
 * the assets rather than from `voiceovers.segments` because the storage key is
 * needed, and a row whose file is gone should not appear on a timeline.
 */
async function loadNarrationAssets(
  userId: string,
  projectId: string,
): Promise<Map<number, StoredAudio>> {
  const rows = await db
    .select({
      storageKey: assets.storageKey,
      mimeType: assets.mimeType,
      durationMs: assets.durationMs,
      meta: assets.meta,
      createdAt: assets.createdAt,
    })
    .from(assets)
    .where(
      and(
        eq(assets.projectId, projectId),
        eq(assets.userId, userId),
        eq(assets.kind, "voiceover"),
      ),
    )
    .orderBy(asc(assets.createdAt));

  const out = new Map<number, StoredAudio>();

  for (const row of rows) {
    const index = row.meta?.["sceneIndex"];
    if (typeof index !== "number" || !row.storageKey) continue;
    // Later rows win: a regenerated voiceover for one scene should replace the
    // previous take rather than sit behind it.
    out.set(index, {
      storageKey: row.storageKey,
      mimeType: row.mimeType ?? "audio/mpeg",
      durationMs: row.durationMs ?? 0,
    });
  }

  return out;
}

/** Measured narration length per scene, for stages that only need durations. */
async function loadNarrationDurations(
  userId: string,
  projectId: string,
): Promise<Map<number, number>> {
  const audio = await loadNarrationAssets(userId, projectId);
  return new Map([...audio].map(([index, a]) => [index, a.durationMs]));
}

interface StoredVisual {
  storageKey: string;
  kind: "stock_video" | "stock_image" | "generated_video" | "generated_image";
  durationMs: number | null;
}

async function loadVisualAssets(
  userId: string,
  projectId: string,
): Promise<Map<number, StoredVisual>> {
  const sceneRows = await loadScenes(userId, projectId);
  const ids = sceneRows
    .map((s) => s.visualAssetId)
    .filter((id): id is string => Boolean(id));

  if (ids.length === 0) return new Map();

  const rows = await db
    .select({
      id: assets.id,
      storageKey: assets.storageKey,
      kind: assets.kind,
      durationMs: assets.durationMs,
    })
    .from(assets)
    .where(and(eq(assets.userId, userId), inArray(assets.id, ids)));

  const byId = new Map(rows.map((row) => [row.id, row]));
  const out = new Map<number, StoredVisual>();

  for (const scene of sceneRows) {
    const asset = scene.visualAssetId ? byId.get(scene.visualAssetId) : undefined;
    if (!asset?.storageKey) continue;
    if (
      asset.kind !== "stock_video" &&
      asset.kind !== "stock_image" &&
      asset.kind !== "generated_video" &&
      asset.kind !== "generated_image"
    ) {
      continue;
    }
    out.set(scene.index, {
      storageKey: asset.storageKey,
      kind: asset.kind,
      durationMs: asset.durationMs,
    });
  }

  return out;
}

async function loadMusic(
  userId: string,
  projectId: string,
): Promise<TimelineDocument["music"]> {
  const rows = await db
    .select({
      volume: musicTracks.volume,
      duckUnderNarration: musicTracks.duckUnderNarration,
      startMs: musicTracks.startMs,
      durationMs: musicTracks.durationMs,
      storageKey: assets.storageKey,
    })
    .from(musicTracks)
    .innerJoin(assets, eq(assets.id, musicTracks.assetId))
    .where(
      and(
        eq(musicTracks.projectId, projectId),
        eq(musicTracks.userId, userId),
        eq(musicTracks.role, "background"),
      ),
    )
    .orderBy(desc(musicTracks.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row?.storageKey) return null;

  return {
    key: row.storageKey,
    volume: row.volume,
    duckUnderNarration: row.duckUnderNarration,
    startMs: row.startMs,
    durationMs: row.durationMs,
  };
}

async function loadCaptions(
  userId: string,
  projectId: string,
): Promise<{
  cues: Array<{ startMs: number; endMs: number; text: string }>;
  burnedIn: boolean;
} | null> {
  const rows = await db
    .select({ cues: captions.cues, burnedIn: captions.burnedIn })
    .from(captions)
    .where(and(eq(captions.projectId, projectId), eq(captions.userId, userId)))
    .orderBy(desc(captions.createdAt))
    .limit(1);

  return rows[0] ?? null;
}

async function loadBrandKit(
  userId: string,
  projectId: string,
): Promise<{
  captionStyle: Record<string, unknown> | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  fontPreference: string | null;
} | null> {
  const project = await getProject(userId, projectId);
  const channelId = project.channelId;
  // A brand kit belongs to a channel, so a channel-less project has none. Null is
  // already the "no kit" answer and the timeline falls back to its default caption
  // look, which is what an unbranded channel gets today (Phase 11 §4).
  if (!channelId) return null;

  const rows = await db
    .select({
      captionStyle: brandKits.captionStyle,
      primaryColor: brandKits.primaryColor,
      secondaryColor: brandKits.secondaryColor,
      fontPreference: brandKits.fontPreference,
    })
    .from(brandKits)
    .where(
      and(eq(brandKits.channelId, channelId), eq(brandKits.userId, userId)),
    )
    .limit(1);

  return rows[0] ?? null;
}

async function upsertMusicMood(input: StageInput, mood: string): Promise<void> {
  const existing = await db
    .select({ id: musicTracks.id })
    .from(musicTracks)
    .where(
      and(
        eq(musicTracks.projectId, input.projectId),
        eq(musicTracks.userId, input.userId),
      ),
    )
    .limit(1);

  const row = existing[0];
  if (row) {
    await db
      .update(musicTracks)
      .set({ mood: mood.slice(0, 64) })
      .where(and(eq(musicTracks.id, row.id), eq(musicTracks.userId, input.userId)));
    return;
  }

  await db.insert(musicTracks).values({
    projectId: input.projectId,
    userId: input.userId,
    mood: mood.slice(0, 64),
  });
}

// ---------------------------------------------------------------------------
// Asset storage
// ---------------------------------------------------------------------------

interface StoreAssetInput {
  userId: string;
  projectId: string;
  folder: "voiceover" | "visual" | "music" | "caption" | "video" | "reference";
  kind:
    | "stock_video"
    | "stock_image"
    | "generated_image"
    | "generated_video"
    | "voiceover"
    | "music"
    | "caption_file"
    | "render_output";
  bytes: Buffer;
  mimeType: string;
  extension: string;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  provider?: string | null;
  providerAssetId?: string | null;
  sourceUrl?: string | null;
  license?: string | null;
  attribution?: string | null;
  authorName?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Upload bytes and record the asset with its provenance.
 *
 * Storage first, then the row: an orphaned object costs pennies and is cleaned up
 * by a lifecycle rule, while a row pointing at an object that was never uploaded
 * breaks a render with a message about a missing file (§22, §29).
 */
async function storeAsset(input: StoreAssetInput): Promise<{ id: string }> {
  const key = storageKey({
    userId: input.userId,
    folder: input.folder,
    projectId: input.projectId,
    extension: input.extension,
  });

  const put = await putObject({
    key,
    body: input.bytes,
    contentType: input.mimeType,
  });

  const [row] = await db
    .insert(assets)
    .values({
      userId: input.userId,
      projectId: input.projectId,
      kind: input.kind,
      storageKey: put.key,
      mimeType: input.mimeType,
      bytes: put.bytes,
      width: input.width ?? null,
      height: input.height ?? null,
      durationMs: input.durationMs ?? null,
      checksumSha256: put.checksumSha256,
      provider: input.provider ?? null,
      providerAssetId: input.providerAssetId ?? null,
      sourceUrl: input.sourceUrl ?? null,
      license: input.license ?? null,
      attribution: input.attribution ?? null,
      authorName: input.authorName ?? null,
      meta: input.meta ?? null,
    })
    .returning({ id: assets.id });

  if (!row) throw new AssetMissingError("a stored asset record");
  return row;
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export interface VideoReadiness {
  ready: boolean;
  /** Capabilities that must be configured before a build can start. */
  blocked: string[];
}

/**
 * Whether a build can start, from the provider configuration alone.
 *
 * The studio screen computes its own `blocked` list from the capability registry;
 * this is the server-side equivalent, so a build cannot be started by a client
 * that ignored the banner (§34: never trust the frontend).
 */
export function videoReadiness(
  mode: GenerationMode = "STOCK",
): VideoReadiness {
  const blocked: string[] = [];
  if (!isVoiceConfigured()) blocked.push("voice");

  /**
   * Which visual capability has to be configured depends on the mode (Phase 11 §9).
   *
   * In `AI_VIDEO` the stock library is never called, so requiring `visuals` would
   * refuse a build that would have worked — and in `STOCK` the AI providers are
   * irrelevant, so requiring them would break every pre-Phase-11 deployment. Each
   * mode is checked against the capability it actually uses.
   */
  if (mode === "AI_VIDEO") {
    if (!isVideoGenConfigured()) blocked.push("video_gen");
  } else if (!isVisualsConfigured()) {
    blocked.push("visuals");
  }

  // Music and captions degrade rather than block; render is checked by the
  // provider itself at submission, and a missing encoder must not stop a user
  // from generating the assets they can.
  return { ready: blocked.length === 0, blocked };
}

function extensionOf(mimeType: string): string {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("m4a") || mimeType.includes("mp4")) return "m4a";
  return "mp3";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { ProjectRecord };

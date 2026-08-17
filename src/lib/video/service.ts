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
import "server-only";
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
  NotFoundError,
  RenderError,
  errorCodeOf,
  isAppError,
  userMessageOf,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
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
import { acquireVisual, isVisualsConfigured } from "@/lib/providers/visuals";
import { isVoiceConfigured, synthesize } from "@/lib/providers/voice";
import {
  deriveProgress,
  getProject,
  setProgress,
  transition,
  type ProjectRecord,
} from "@/lib/projects/service";
import { enqueue, hasActiveJob, reportProgress } from "@/lib/queue/jobs";
import type { ScriptDraft } from "@/lib/scripts/prompt";
import {
  getObjectBuffer,
  putObject,
  signedReadUrl,
  storageKey,
} from "@/lib/storage";
import type { PipelineStage } from "@/lib/stages";
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

  // One build per project at a time. A second would spend a second voiceover and
  // a second render to produce a duplicate of what the first is producing.
  for (const name of [
    SCENE_PLAN_JOB,
    VOICEOVER_JOB,
    VISUALS_JOB,
    MUSIC_JOB,
    CAPTIONS_JOB,
    TIMELINE_JOB,
    RENDER_JOB,
  ]) {
    if (await hasActiveJob(input.userId, project.channelId, name)) {
      throw new ConflictError(
        "A video is already being built for this channel. Wait for it to finish.",
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

    await reportProgress(input.jobId, 30, `Directing ${planned.length} scenes`);

    const directed = await directScenes({
      scenes: planned,
      title: script.draft.title,
      niche: settings.niche,
      videoStyle: settings.videoStyle,
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
 */
export async function executeVisuals(input: StageInput): Promise<{
  acquired: number;
}> {
  return runStage(input, "VISUALS", async () => {
    const sceneRows = await loadScenes(input.userId, input.projectId);
    const narration = await loadNarrationDurations(input.userId, input.projectId);

    const used = new Set<string>();
    let acquired = 0;

    for (const [position, scene] of sceneRows.entries()) {
      await reportProgress(
        input.jobId,
        Math.round((position / Math.max(1, sceneRows.length)) * 95),
        `Finding b-roll for scene ${position + 1} of ${sceneRows.length}`,
      );

      const visual = await acquireVisual(
        {
          sceneIndex: scene.index,
          visualPrompt: scene.visualPrompt,
          searchTerms: scene.searchTerms,
          durationMs: narration.get(scene.index) ?? 6_000,
          exclude: used,
        },
        {
          usage: {
            userId: input.userId,
            projectId: input.projectId,
            jobId: input.jobId,
            traceId: input.traceId ?? null,
          },
        },
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

      acquired += 1;
    }

    await chain(input, MUSIC_JOB, "MUSIC", VISUALS_JOB);

    return { acquired };
  });
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
    const timeline = await assembleTimeline(input.userId, input.projectId);

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
      const urls = await signTimelineAssets(timeline);

      await reportProgress(input.jobId, 5, "Submitting the render");

      const submission = await submitRender(
        timeline,
        { urls },
        {
          projectId: input.projectId,
          userId: input.userId,
          traceId: input.traceId ?? null,
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

  const [narrationAssets, visualAssets, music, captionRow, brand] =
    await Promise.all([
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
): Promise<Map<string, string>> {
  const keys = new Set<string>();
  for (const scene of timeline.scenes) {
    keys.add(scene.visualKey);
    if (scene.narrationKey) keys.add(scene.narrationKey);
  }
  if (timeline.music) keys.add(timeline.music.key);

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

async function loadSettings(
  userId: string,
  projectId: string,
): Promise<SettingsView> {
  const project = await getProject(userId, projectId);

  const rows = await db
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
        eq(channelSettings.channelId, project.channelId),
        eq(channelSettings.userId, userId),
      ),
    )
    .limit(1);

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

  const rows = await db
    .select({
      captionStyle: brandKits.captionStyle,
      primaryColor: brandKits.primaryColor,
      secondaryColor: brandKits.secondaryColor,
      fontPreference: brandKits.fontPreference,
    })
    .from(brandKits)
    .where(
      and(
        eq(brandKits.channelId, project.channelId),
        eq(brandKits.userId, userId),
      ),
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
  folder: "voiceover" | "visual" | "music" | "caption" | "video";
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
export function videoReadiness(): VideoReadiness {
  const blocked: string[] = [];
  if (!isVoiceConfigured()) blocked.push("voice");
  if (!isVisualsConfigured()) blocked.push("visuals");
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

/**
 * RenderProvider — the timeline becomes an MP4 (§15, §32, §37).
 *
 * Three implementations behind one interface:
 *
 *  - `shotstack` — hosted rendering. We submit an edit built from the timeline
 *    document, then poll. Fastest to configure: one API key, no infrastructure.
 *  - `ffmpeg` — a local encode with the bundled static binary. No account, no
 *    per-minute cost, and it is what makes a development render a **real video
 *    file** rather than a placeholder (§40, §42).
 *  - `remotion-lambda` — a render farm the operator owns. Highest ceiling,
 *    most setup.
 *
 * The submit/poll split is the shape every provider is bent into, because it is
 * the only shape that can report honest progress. `renders.progress` is
 * documented in the schema as *"Real provider-reported progress. Never
 * synthesised"*, so `poll()` returns whatever the provider says and returns the
 * previous value when the provider says nothing. A progress bar that advances on
 * a timer is exactly what §42 forbids, and the studio screen already handles the
 * honest case: it shows an indeterminate bar while a render sits at 0%.
 *
 * §48: an unconfigured provider throws `NotConfiguredError` naming its env vars.
 * There is no fake success path — a render either produces bytes or it fails.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { env, usingMockProviders } from "@/lib/env";
import { NotConfiguredError, RenderError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { assColour } from "@/lib/media/ass";
import { ffmpegBinary, secondsArg } from "@/lib/media/ffmpeg";
import { escapeFilterPath } from "@/lib/media/filter";
import { fetchRemoteAsset } from "@/lib/providers/fetch";
import { providerJson } from "@/lib/providers/http";
import {
  editFfmpegArgs,
  editOverlayScript,
  editRenderClips,
  isStillClip,
} from "@/lib/providers/render-edit";
import { getObjectBuffer } from "@/lib/storage";
import { isAudioTrack, type CompiledEdit } from "@/lib/video/edit-document";
import {
  MUSIC_FADE_MS,
  type TimelineDocument,
  type TimelineScene,
} from "@/lib/video/timeline";

const log = logger.child({ component: "render" });

/** A finished render can be large; 1080p at ten minutes is ~200MB. */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1_048_576;

/** Local encodes are slow. Ten minutes of 1080p on a laptop CPU is minutes. */
const FFMPEG_TIMEOUT_MS = 45 * 60_000;

export interface RenderSubmission {
  provider: string;
  /** Provider-side id for polling. */
  providerRenderId: string;
  /**
   * Bytes, when the provider finished synchronously.
   *
   * The local encoder does: by the time `submit()` returns there is a file. The
   * caller stores these and skips polling entirely.
   */
  output?: RenderOutput;
}

export interface RenderOutput {
  bytes: Buffer;
  mimeType: string;
  extension: string;
  durationMs: number | null;
}

export type RenderPollState =
  | { status: "running"; progress: number | null }
  | { status: "succeeded"; progress: 100; output: RenderOutput }
  | { status: "failed"; progress: number | null; message: string; retryable: boolean };

/**
 * Signed URLs for every asset the timeline references.
 *
 * A hosted provider cannot read our MinIO bucket, so each storage key is signed
 * before submission. Passed in rather than signed here so the caller controls the
 * TTL: a queued render can wait behind others, and a URL that expires mid-render
 * fails at the provider with a message that says nothing useful.
 */
export interface AssetUrls {
  /** storage key → signed https URL. */
  urls: ReadonlyMap<string, string>;
}

export interface SubmitOptions {
  projectId: string;
  userId: string;
  traceId?: string | null;
  /** Called with real percentages during a local encode. */
  onProgress?: (progress: number) => void | Promise<void>;
  /**
   * The project's compiled cut, when it has one (Phase B).
   *
   * Absent for a project that was never opened in the editor, and that absence is the
   * whole backwards-compatibility story: the local encoder falls back to the sequential
   * builder it has always used, so an unedited render is unchanged.
   *
   * When present it is the **source of truth** — it carries trims, absolute positions,
   * gaps, stacked tracks and per-clip gains that `TimelineDocument` has no fields for,
   * and its `timeline` is the same document derived in the same pass, so the two cannot
   * describe different videos.
   */
  edit?: CompiledEdit | null;
}

export function renderProviderName(): string {
  return usingMockProviders() ? "ffmpeg" : env().RENDER_PROVIDER;
}

export function isRenderConfigured(): boolean {
  const provider = renderProviderName();
  if (provider === "ffmpeg") return ffmpegBinary() !== null;
  if (provider === "shotstack") return Boolean(env().SHOTSTACK_API_KEY);
  if (provider === "remotion-lambda") {
    const e = env();
    return Boolean(e.REMOTION_LAMBDA_FUNCTION_NAME && e.REMOTION_SERVE_URL);
  }
  return false;
}

function requireConfigured(): void {
  if (isRenderConfigured()) return;

  const provider = renderProviderName();

  if (provider === "ffmpeg") {
    throw new NotConfiguredError(
      "ffmpeg",
      ["FFMPEG_PATH"],
      "The bundled ffmpeg-static binary was not found. Install it with " +
        "`npm install ffmpeg-static`, set FFMPEG_PATH to a system ffmpeg, or " +
        "set RENDER_PROVIDER=shotstack.",
    );
  }

  if (provider === "remotion-lambda") {
    throw new NotConfiguredError(
      "Remotion Lambda",
      ["REMOTION_LAMBDA_FUNCTION_NAME", "REMOTION_SERVE_URL"],
      "Deploy a Remotion Lambda function and site, then set both variables.",
    );
  }

  throw new NotConfiguredError(
    "Shotstack",
    ["SHOTSTACK_API_KEY"],
    "Create a key at https://dashboard.shotstack.io (start with the stage key).",
  );
}

/** Submit a timeline for rendering. */
export async function submitRender(
  timeline: TimelineDocument,
  assets: AssetUrls,
  options: SubmitOptions,
): Promise<RenderSubmission> {
  requireConfigured();

  if (timeline.scenes.length === 0) {
    throw new RenderError("the timeline has no scenes", { retryable: false });
  }

  const provider = renderProviderName();

  log.info("render submitted", {
    provider,
    projectId: options.projectId,
    scenes: timeline.scenes.length,
    durationMs: timeline.durationMs,
    edited: Boolean(options.edit),
    traceId: options.traceId ?? undefined,
  });

  // The hosted providers are submitted the timeline document, edited or not. That is not
  // a gap: the compiler collapses a cut onto exactly that document, so a hosted render
  // of an edited project honours the new order, positions and durations. What it cannot
  // express is a per-clip trim or two visuals stacked at one moment, because Shotstack's
  // and Remotion's schemas here take one visual per scene. Local ffmpeg is the renderer
  // that reads the cut in full, and it is Vidxir AI's default (§40).
  if (provider === "shotstack") return shotstackSubmit(timeline, assets);
  if (provider === "remotion-lambda") return remotionSubmit(timeline, assets);
  if (options.edit) return ffmpegRenderEdit(options.edit, options);
  return ffmpegRender(timeline, options);
}

/**
 * Ask a provider how a render is going.
 *
 * `previousProgress` is returned unchanged when the provider reports no
 * percentage, so the studio's bar holds rather than resetting to zero — and it is
 * never incremented here to make the UI feel busy.
 */
export async function pollRender(
  providerRenderId: string,
  options: { previousProgress?: number } = {},
): Promise<RenderPollState> {
  requireConfigured();

  const provider = renderProviderName();

  if (provider === "shotstack") {
    return shotstackPoll(providerRenderId, options.previousProgress ?? null);
  }
  if (provider === "remotion-lambda") {
    return remotionPoll(providerRenderId, options.previousProgress ?? null);
  }

  // The local encoder is synchronous — `submit()` already returned the bytes, so
  // nothing should ever poll it. Reaching here means a render row was written
  // without its output, which is a bug rather than a provider failure.
  throw new RenderError(
    "the local renderer completes synchronously and cannot be polled",
    { retryable: false },
  );
}

// ---------------------------------------------------------------------------
// Shotstack
// ---------------------------------------------------------------------------

function shotstackBase(): string {
  return `https://api.shotstack.io/edit/${env().SHOTSTACK_ENV}`;
}

interface ShotstackClip {
  asset: Record<string, unknown>;
  start: number;
  length: number;
  fit?: string;
  scale?: number;
  position?: string;
  effect?: string;
  transition?: { in?: string; out?: string };
  volume?: number;
}

interface ShotstackStatus {
  success?: boolean;
  response?: {
    status?: string;
    url?: string | null;
    error?: string | null;
    data?: { progress?: number } | null;
    /** Seconds. */
    duration?: number | null;
  } | null;
}

/**
 * Build a Shotstack edit from the timeline.
 *
 * Track order is z-order, topmost first, which is the opposite of intuition and
 * the single easiest thing to get wrong here: captions must precede visuals or
 * the b-roll paints over the text.
 */
function shotstackEdit(
  timeline: TimelineDocument,
  assets: AssetUrls,
): Record<string, unknown> {
  const seconds = (ms: number) => Math.round(ms) / 1000;

  const url = (key: string): string => {
    const signed = assets.urls.get(key);
    if (!signed) {
      throw new RenderError(`no signed URL was provided for asset ${key}`, {
        retryable: false,
      });
    }
    return signed;
  };

  const captionClips: ShotstackClip[] = (timeline.captions?.cues ?? []).map(
    (cue) => ({
      asset: {
        type: "title",
        text: cue.text,
        style: "minimal",
        size: "small",
        color: timeline.captions?.style.color ?? "#FFFFFF",
      },
      start: seconds(cue.startMs),
      length: Math.max(0.2, seconds(cue.endMs - cue.startMs)),
      // Shotstack positions titles by name, not by fraction.
      position: (timeline.captions?.style.verticalPosition ?? 0.82) > 0.6
        ? "bottom"
        : "top",
    }),
  );

  const textClips: ShotstackClip[] = timeline.scenes
    .filter((scene) => scene.onScreenText)
    .map((scene) => ({
      asset: {
        type: "title",
        text: scene.onScreenText ?? "",
        style: "future",
        size: "medium",
        color: timeline.brand.primaryColor ?? "#FFFFFF",
      },
      start: seconds(scene.startMs),
      // On-screen text is a beat, not a subtitle: it holds for a few seconds and
      // leaves, so it does not compete with the captions for the whole scene.
      length: Math.min(4, Math.max(1.5, seconds(scene.durationMs) - 0.5)),
      position: "top",
      transition: { in: "fade", out: "fade" },
    }));

  const visualClips: ShotstackClip[] = timeline.scenes.map((scene) => ({
    asset: isVideo(scene)
      ? {
          type: "video",
          src: url(scene.visualKey),
          // Stock clips carry ambient sound that fights the narration.
          volume: 0,
        }
      : { type: "image", src: url(scene.visualKey) },
    start: seconds(scene.startMs),
    length: seconds(scene.durationMs),
    // "cover" crops rather than letterboxes; a black bar looks like a mistake.
    fit: "cover",
    scale: 1,
    // A still gets a slow zoom so it does not read as a frozen frame.
    ...(isVideo(scene) ? {} : { effect: "zoomIn" }),
    ...(scene.transition === "none"
      ? {}
      : { transition: { in: "fade", out: "fade" } }),
  }));

  const narrationClips: ShotstackClip[] = timeline.scenes
    .filter((scene) => scene.narrationKey && scene.narrationDurationMs > 0)
    .map((scene) => ({
      asset: { type: "audio", src: url(scene.narrationKey as string), volume: 1 },
      start: seconds(scene.startMs),
      length: seconds(scene.narrationDurationMs),
    }));

  const musicClips: ShotstackClip[] = timeline.music
    ? [
        {
          asset: {
            type: "audio",
            src: url(timeline.music.key),
            volume: timeline.music.volume,
            effect: "fadeInFadeOut",
          },
          start: seconds(timeline.music.startMs),
          length: seconds(timeline.durationMs - timeline.music.startMs),
        },
      ]
    : [];

  const tracks = [
    ...(captionClips.length > 0 ? [{ clips: captionClips }] : []),
    ...(textClips.length > 0 ? [{ clips: textClips }] : []),
    { clips: visualClips },
    ...(narrationClips.length > 0 ? [{ clips: narrationClips }] : []),
    ...(musicClips.length > 0 ? [{ clips: musicClips }] : []),
  ];

  return {
    timeline: { background: "#000000", tracks },
    output: {
      format: "mp4",
      fps: timeline.fps,
      size: { width: timeline.width, height: timeline.height },
    },
  };
}

async function shotstackSubmit(
  timeline: TimelineDocument,
  assets: AssetUrls,
): Promise<RenderSubmission> {
  const body = await providerJson<{ response?: { id?: string } | null }>({
    provider: "Shotstack",
    url: `${shotstackBase()}/render`,
    method: "POST",
    headers: { "x-api-key": env().SHOTSTACK_API_KEY ?? "" },
    body: shotstackEdit(timeline, assets),
  });

  const id = body.response?.id;
  if (!id) {
    throw new RenderError("Shotstack accepted the edit but returned no render id");
  }

  return { provider: "shotstack", providerRenderId: id };
}

async function shotstackPoll(
  renderId: string,
  previousProgress: number | null,
): Promise<RenderPollState> {
  const body = await providerJson<ShotstackStatus>({
    provider: "Shotstack",
    url: `${shotstackBase()}/render/${encodeURIComponent(renderId)}`,
    headers: { "x-api-key": env().SHOTSTACK_API_KEY ?? "" },
  });

  const response = body.response;
  const status = (response?.status ?? "").toLowerCase();

  // Shotstack reports 0–1; the column is a percentage.
  const reported =
    typeof response?.data?.progress === "number"
      ? Math.round(Math.min(1, Math.max(0, response.data.progress)) * 100)
      : null;
  const progress = reported ?? previousProgress;

  if (status === "done") {
    const url = response?.url;
    if (!url) {
      throw new RenderError("Shotstack reported done with no output URL");
    }

    const asset = await fetchRemoteAsset(url, {
      provider: "Shotstack",
      maxBytes: MAX_OUTPUT_BYTES,
      // Shotstack serves output from regional S3 buckets; the two documented
      // hosts are allow-listed in fetch.ts, and an operator can add more.
      extraHosts: env().ASSET_FETCH_ALLOWED_HOSTS,
    });

    return {
      status: "succeeded",
      progress: 100,
      output: {
        bytes: asset.bytes,
        mimeType: "video/mp4",
        extension: "mp4",
        durationMs: response?.duration ? Math.round(response.duration * 1000) : null,
      },
    };
  }

  if (status === "failed") {
    return {
      status: "failed",
      progress,
      message: response?.error ?? "Shotstack reported the render failed",
      // Shotstack failures are usually a malformed edit or an asset it could not
      // fetch, and both fail identically on a retry.
      retryable: false,
    };
  }

  return { status: "running", progress };
}

// ---------------------------------------------------------------------------
// Remotion Lambda
// ---------------------------------------------------------------------------

/**
 * Remotion Lambda, invoked over its HTTP surface.
 *
 * The `@remotion/lambda` client is not a dependency: it pulls in a bundler and a
 * headless-Chrome toolchain that a worker container has no use for, since the
 * rendering happens inside the operator's already-deployed function. The two
 * calls used here — `start` and `status` — are the whole progress protocol.
 *
 * The operator's Remotion composition is expected to accept our timeline
 * document as its input props; the document is provider-neutral by design, which
 * is what makes that possible without a Vidxir AI-specific composition schema.
 */
async function remotionSubmit(
  timeline: TimelineDocument,
  assets: AssetUrls,
): Promise<RenderSubmission> {
  const e = env();

  const body = await providerJson<{
    type?: string;
    renderId?: string;
    bucketName?: string;
    message?: string;
  }>({
    provider: "Remotion Lambda",
    url: remotionUrl("start"),
    method: "POST",
    body: {
      type: "start",
      serveUrl: e.REMOTION_SERVE_URL,
      composition: "VidxirVideo",
      inputProps: { timeline: withSignedUrls(timeline, assets) },
      codec: "h264",
      imageFormat: "jpeg",
      crf: 23,
      privacy: "private",
      frameRange: null,
      logLevel: "info",
      // Renders are split across concurrent invocations by the function itself;
      // 1080p at ~30fps is comfortable at this frames-per-lambda.
      framesPerLambda: 120,
    },
  });

  if (!body.renderId) {
    throw new RenderError(
      `Remotion Lambda returned no render id${body.message ? `: ${body.message}` : ""}`,
    );
  }

  // The bucket is needed to poll, and there is nowhere else to keep it — the
  // column is a single string, so it is encoded into the id.
  return {
    provider: "remotion-lambda",
    providerRenderId: body.bucketName
      ? `${body.renderId}@${body.bucketName}`
      : body.renderId,
  };
}

async function remotionPoll(
  compositeId: string,
  previousProgress: number | null,
): Promise<RenderPollState> {
  const [renderId, bucketName] = compositeId.split("@");
  if (!renderId) {
    throw new RenderError("the Remotion render id is malformed", {
      retryable: false,
    });
  }

  const body = await providerJson<{
    done?: boolean;
    overallProgress?: number;
    outputFile?: string | null;
    errors?: Array<{ message?: string; stack?: string }> | null;
    fatalErrorEncountered?: boolean;
    timeToFinish?: number | null;
  }>({
    provider: "Remotion Lambda",
    url: remotionUrl("status"),
    method: "POST",
    body: {
      type: "status",
      renderId,
      bucketName: bucketName ?? null,
      version: null,
      logLevel: "info",
    },
  });

  const reported =
    typeof body.overallProgress === "number"
      ? Math.round(Math.min(1, Math.max(0, body.overallProgress)) * 100)
      : null;
  const progress = reported ?? previousProgress;

  if (body.fatalErrorEncountered) {
    return {
      status: "failed",
      progress,
      message:
        body.errors?.[0]?.message ??
        "Remotion Lambda reported a fatal error during rendering",
      retryable: false,
    };
  }

  if (body.done && body.outputFile) {
    const asset = await fetchRemoteAsset(body.outputFile, {
      provider: "Remotion Lambda",
      maxBytes: MAX_OUTPUT_BYTES,
      // The output bucket belongs to the operator, so only they can name it.
      extraHosts: env().ASSET_FETCH_ALLOWED_HOSTS,
    });

    return {
      status: "succeeded",
      progress: 100,
      output: {
        bytes: asset.bytes,
        mimeType: "video/mp4",
        extension: "mp4",
        durationMs: null,
      },
    };
  }

  return { status: "running", progress };
}

function remotionUrl(kind: "start" | "status"): string {
  const e = env();
  const name = e.REMOTION_LAMBDA_FUNCTION_NAME ?? "";
  // Lambda's function URL form. An operator fronting the function with API
  // Gateway sets REMOTION_LAMBDA_FUNCTION_NAME to that host instead.
  if (name.startsWith("https://")) return name.replace(/\/$/, "");
  return (
    `https://lambda.${e.REMOTION_AWS_REGION}.amazonaws.com/2015-03-31/functions/` +
    `${encodeURIComponent(name)}/invocations?Qualifier=${kind === "start" ? "start" : "status"}`
  );
}

/** Replace storage keys with signed URLs so a remote renderer can read them. */
function withSignedUrls(
  timeline: TimelineDocument,
  assets: AssetUrls,
): TimelineDocument {
  const url = (key: string): string => assets.urls.get(key) ?? key;

  return {
    ...timeline,
    scenes: timeline.scenes.map((scene) => ({
      ...scene,
      visualKey: url(scene.visualKey),
      narrationKey: scene.narrationKey ? url(scene.narrationKey) : null,
    })),
    music: timeline.music ? { ...timeline.music, key: url(timeline.music.key) } : null,
  };
}

// ---------------------------------------------------------------------------
// Local ffmpeg
// ---------------------------------------------------------------------------

/**
 * Encode the video locally.
 *
 * The filter graph, rather than a sequence of intermediate files, because a
 * single pass is both faster and the only way ffmpeg can report a continuous
 * progress percentage. What it does, per scene:
 *
 *   1. scale to fit 1920×1080 preserving aspect, pad the remainder black
 *   2. hold the last frame (stills) or loop (short clips) to fill the slot
 *   3. concatenate in scene order
 *
 * and for audio: each narration segment delayed to its measured offset, mixed
 * with the music bed at its stored volume.
 *
 * Captions are burned in from a generated SRT via the `subtitles` filter, which
 * is why cue text is escaped rather than interpolated.
 */
async function ffmpegRender(
  timeline: TimelineDocument,
  options: SubmitOptions,
): Promise<RenderSubmission> {
  const binary = ffmpegBinary();
  if (!binary) {
    throw new RenderError("no ffmpeg binary is available", { retryable: false });
  }

  const dir = await mkdtemp(join(tmpdir(), "vidxir-render-"));

  try {
    // Every input is pulled to disk first. ffmpeg can read HTTP, but a mid-encode
    // network stall on input 40 of 60 wastes the whole pass, and a local file is
    // seekable in a way a stream is not.
    const inputs: string[] = [];
    const sceneInputIndex = new Map<number, number>();
    const narrationInputIndex = new Map<number, number>();

    for (const scene of timeline.scenes) {
      const path = join(
        dir,
        `scene-${scene.index}.${isVideo(scene) ? "mp4" : "img"}`,
      );
      await writeFile(path, await getObjectBuffer(scene.visualKey));
      sceneInputIndex.set(scene.index, inputs.length);
      inputs.push(path);
    }

    for (const scene of timeline.scenes) {
      if (!scene.narrationKey || scene.narrationDurationMs <= 0) continue;
      const path = join(dir, `narration-${scene.index}.audio`);
      await writeFile(path, await getObjectBuffer(scene.narrationKey));
      narrationInputIndex.set(scene.index, inputs.length);
      inputs.push(path);
    }

    let musicIndex: number | null = null;
    if (timeline.music) {
      const path = join(dir, "music.audio");
      await writeFile(path, await getObjectBuffer(timeline.music.key));
      musicIndex = inputs.length;
      inputs.push(path);
    }

    const subtitlePath =
      timeline.captions && timeline.captions.burnedIn && timeline.captions.cues.length > 0
        ? join(dir, "captions.srt")
        : null;
    if (subtitlePath && timeline.captions) {
      await writeFile(subtitlePath, toSrt(timeline.captions.cues), "utf8");
    }

    const output = join(dir, "output.mp4");

    const args = ffmpegArgs({
      timeline,
      inputs,
      sceneInputIndex,
      narrationInputIndex,
      musicIndex,
      subtitlePath,
      output,
    });

    await runFfmpeg(binary, args, {
      durationMs: timeline.durationMs,
      onProgress: options.onProgress,
    });

    const bytes = await readFile(output);
    if (bytes.byteLength === 0) {
      throw new RenderError("ffmpeg produced an empty file");
    }

    log.info("local render complete", {
      projectId: options.projectId,
      bytes: bytes.byteLength,
      durationMs: timeline.durationMs,
    });

    return {
      provider: "ffmpeg",
      // No provider-side id exists, and inventing a UUID would suggest something
      // pollable. The row records that the encode was local and already finished.
      providerRenderId: `local:${options.projectId}`,
      output: {
        bytes,
        mimeType: "video/mp4",
        extension: "mp4",
        durationMs: timeline.durationMs,
      },
    };
  } finally {
    // Inputs and output together are gigabytes; a worker that leaks them fills
    // the disk within a day.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Encode an **edited** timeline locally (Phase B).
 *
 * The same shape as `ffmpegRender` — pull every input to disk, build a graph, run one
 * pass, return the bytes — and deliberately so: `runFfmpeg`, the progress reporting, the
 * output limits and the temp-directory cleanup are all the existing renderer's, and the
 * only thing that differs is which builder produced the arguments.
 *
 * Two differences worth naming:
 *
 *  - **only referenced media is downloaded.** `editRenderClips` decides what the graph
 *    will touch, so a hidden track's footage is never fetched. The original builder
 *    downloads one file per scene because in a pipeline timeline every scene is visible.
 *  - **the graph goes to a file.** A cut with a few hundred clips produces a
 *    `-filter_complex` value well past Windows' ~32KB command-line limit, and the
 *    failure mode is a truncated graph rather than a clean error.
 *    `-filter_complex_script` was verified to drive a byte-identical encode.
 */
async function ffmpegRenderEdit(
  edit: CompiledEdit,
  options: SubmitOptions,
): Promise<RenderSubmission> {
  const binary = ffmpegBinary();
  if (!binary) {
    throw new RenderError("no ffmpeg binary is available", { retryable: false });
  }

  const { visuals, audio } = editRenderClips(edit);

  if (visuals.length === 0) {
    throw new RenderError("the edit has no visible clips to render", {
      retryable: false,
    });
  }

  const dir = await mkdtemp(join(tmpdir(), "vidxir-render-"));

  try {
    const inputs: string[] = [];
    const clipInputIndex = new Map<string, number>();

    /**
     * One download per storage key, not per clip.
     *
     * A split produces two clips over one asset, and re-fetching the same object for
     * each half would double the transfer on the single most common edit there is.
     */
    const pathByKey = new Map<string, string>();

    for (const clip of [...visuals, ...audio]) {
      const key = clip.storageKey;
      if (!key) continue;

      let path = pathByKey.get(key);
      if (path === undefined) {
        // The extension is a hint for ffmpeg's probe, not a claim about the container;
        // it demuxes by content. `.img` matches what the sequential path writes.
        const extension = isAudioTrack(clip.trackKind)
          ? "audio"
          : isStillClip(clip)
            ? "img"
            : "mp4";
        path = join(dir, `clip-${pathByKey.size}.${extension}`);
        await writeFile(path, await getObjectBuffer(key));
        pathByKey.set(key, path);
      }

      // Each clip gets its **own** input even when two share a file: the two halves of
      // a split seek to different offsets, so they cannot share one decoder.
      clipInputIndex.set(clip.clipId, inputs.length);
      inputs.push(path);
    }

    const captions = edit.timeline.captions;
    const subtitlePath =
      captions && captions.burnedIn && captions.cues.length > 0
        ? join(dir, "captions.srt")
        : null;
    if (subtitlePath && captions) {
      await writeFile(subtitlePath, toSrt(captions.cues), "utf8");
    }

    const overlay = editOverlayScript(edit);
    const overlayPath = overlay ? join(dir, "overlay.ass") : null;
    if (overlayPath && overlay) {
      await writeFile(overlayPath, overlay, "utf8");
    }

    const output = join(dir, "output.mp4");

    const plan = editFfmpegArgs({
      edit,
      inputs,
      clipInputIndex,
      subtitlePath,
      overlayPath,
      output,
    });

    // The graph via a file rather than an argument, for the length reason above.
    const graphPath = join(dir, "graph.txt");
    await writeFile(graphPath, plan.filterGraph, "utf8");

    const args = plan.args.map((arg, index) =>
      plan.args[index - 1] === "-filter_complex" ? graphPath : arg,
    );
    const complexAt = args.indexOf("-filter_complex");
    if (complexAt >= 0) args[complexAt] = "-filter_complex_script";

    await runFfmpeg(binary, args, {
      durationMs: edit.durationMs,
      onProgress: options.onProgress,
    });

    const bytes = await readFile(output);
    if (bytes.byteLength === 0) {
      throw new RenderError("ffmpeg produced an empty file");
    }

    log.info("local edited render complete", {
      projectId: options.projectId,
      bytes: bytes.byteLength,
      durationMs: edit.durationMs,
      clips: visuals.length,
      audioClips: audio.length,
    });

    return {
      provider: "ffmpeg",
      providerRenderId: `local:${options.projectId}`,
      output: {
        bytes,
        mimeType: "video/mp4",
        extension: "mp4",
        durationMs: edit.durationMs,
      },
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

interface FfmpegArgsInput {
  timeline: TimelineDocument;
  inputs: readonly string[];
  sceneInputIndex: ReadonlyMap<number, number>;
  narrationInputIndex: ReadonlyMap<number, number>;
  musicIndex: number | null;
  subtitlePath: string | null;
  output: string;
}

/**
 * Build the argument list.
 *
 * Extracted and exported for tests: the filter graph is the most intricate part
 * of the local renderer, and asserting on the generated string is far cheaper
 * than encoding a video to find out that a label was misspelled.
 */
export function ffmpegArgs(input: FfmpegArgsInput): string[] {
  const { timeline } = input;
  /**
   * `-xerror` is load-bearing, not tidiness.
   *
   * A still is read with `-loop 1 -t <slot>`, and `-t` is measured in *output*
   * time. If the image never decodes — a truncated download, a provider serving
   * HTML with an image content-type, a corrupt deflate stream — no frame is ever
   * produced, output time never advances, `-t` never fires, and ffmpeg re-reads
   * the same unreadable file forever. Measured here: a 480x270 PNG with a damaged
   * IDAT payload spun until killed, emitting 18MB of `inflate returned error -3`
   * to stderr and writing nothing at all to `-progress`, so even the progress bar
   * would sit still while a worker burned a core for the full 45-minute ceiling.
   *
   * With `-xerror` the same input exits 1 immediately and the stderr tail names
   * the decode failure, which is what `runFfmpeg` reports. A healthy encode is
   * bit-identical either way.
   */
  const args: string[] = ["-y", "-nostdin", "-hide_banner", "-xerror"];

  for (const scene of timeline.scenes) {
    const index = input.sceneInputIndex.get(scene.index);
    if (index === undefined) continue;
    const path = input.inputs[index];
    if (!path) continue;

    if (isVideo(scene)) {
      // A clip shorter than its slot loops rather than cutting to black.
      args.push("-stream_loop", "-1", "-t", secondsArg(scene.durationMs), "-i", path);
    } else {
      // A still becomes a clip of exactly the slot length.
      args.push(
        "-loop",
        "1",
        "-framerate",
        String(timeline.fps),
        "-t",
        secondsArg(scene.durationMs),
        "-i",
        path,
      );
    }
  }

  for (const scene of timeline.scenes) {
    const index = input.narrationInputIndex.get(scene.index);
    if (index === undefined) continue;
    const path = input.inputs[index];
    if (path) args.push("-i", path);
  }

  if (input.musicIndex !== null) {
    const path = input.inputs[input.musicIndex];
    // The bed loops for the whole video; `-t` on the output trims the tail.
    if (path) args.push("-stream_loop", "-1", "-i", path);
  }

  const filters: string[] = [];
  const videoLabels: string[] = [];

  timeline.scenes.forEach((scene, position) => {
    const index = input.sceneInputIndex.get(scene.index);
    if (index === undefined) return;

    const label = `v${position}`;
    filters.push(
      `[${index}:v]` +
        // Even dimensions: H.264's 4:2:0 chroma subsampling cannot encode an odd
        // width, and ffmpeg fails at the very end of the pass if one slips in.
        `scale=${timeline.width}:${timeline.height}:force_original_aspect_ratio=decrease,` +
        `pad=${timeline.width}:${timeline.height}:-1:-1:color=black,` +
        `setsar=1,fps=${timeline.fps},format=yuv420p,` +
        `trim=duration=${secondsArg(scene.durationMs)},setpts=PTS-STARTPTS` +
        `[${label}]`,
    );
    videoLabels.push(label);
  });

  if (videoLabels.length === 0) {
    throw new RenderError("no scene produced a video stream", { retryable: false });
  }

  if (videoLabels.length === 1) {
    // `concat` with a single input is legal but pointless; `null` renames the
    // label so everything downstream can assume [vconcat] exists.
    filters.push(`[${videoLabels[0] as string}]null[vconcat]`);
  } else {
    filters.push(
      `${videoLabels.map((l) => `[${l}]`).join("")}concat=n=${videoLabels.length}:v=1:a=0[vconcat]`,
    );
  }
  let videoOut = "vconcat";

  // The tail: hold the last frame for the padding rather than cutting to black,
  // which is what `tpad` does at the end of the concatenated stream.
  const tailMs = timeline.durationMs - lastSceneEnd(timeline.scenes);
  if (tailMs > 0) {
    filters.push(
      `[${videoOut}]tpad=stop_mode=clone:stop_duration=${secondsArg(tailMs)}[vpad]`,
    );
    videoOut = "vpad";
  }

  if (input.subtitlePath) {
    const style = timeline.captions?.style;
    // ASS overrides: the SRT carries no styling, so the look comes from here.
    const styleArg =
      `FontName=${(style?.fontFamily ?? "Inter").replace(/[,:'\\]/g, "")},` +
      `FontSize=${Math.round((style?.fontSizePx ?? 48) * 0.55)},` +
      `PrimaryColour=${assColour(style?.color ?? "#FFFFFF")},` +
      `BorderStyle=${style?.backgroundColor ? 4 : 1},` +
      `BackColour=${assColour(style?.backgroundColor ?? "#000000A6")},` +
      `Outline=2,Shadow=0,Alignment=2,MarginV=60`;

    filters.push(
      `[${videoOut}]subtitles=${escapeFilterPath(input.subtitlePath)}:` +
        `force_style='${styleArg}'[vout]`,
    );
    videoOut = "vout";
  }

  // Audio: each narration segment delayed to its measured offset.
  const audioLabels: string[] = [];

  timeline.scenes.forEach((scene, position) => {
    const index = input.narrationInputIndex.get(scene.index);
    if (index === undefined) return;

    const label = `a${position}`;
    filters.push(
      `[${index}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `adelay=${Math.round(scene.startMs)}|${Math.round(scene.startMs)}[${label}]`,
    );
    audioLabels.push(label);
  });

  if (input.musicIndex !== null && timeline.music) {
    const fade = Math.min(MUSIC_FADE_MS, Math.floor(timeline.durationMs / 4)) / 1000;
    const totalSeconds = timeline.durationMs / 1000;
    filters.push(
      `[${input.musicIndex}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `atrim=duration=${secondsArg(timeline.durationMs)},` +
        `volume=${clampVolume(timeline.music.volume)},` +
        `afade=t=in:st=0:d=${fade.toFixed(2)},` +
        `afade=t=out:st=${Math.max(0, totalSeconds - fade).toFixed(2)}:d=${fade.toFixed(2)}` +
        `[music]`,
    );
    audioLabels.push("music");
  }

  let audioOut: string | null = null;
  if (audioLabels.length === 1) {
    audioOut = audioLabels[0] as string;
  } else if (audioLabels.length > 1) {
    filters.push(
      `${audioLabels.map((l) => `[${l}]`).join("")}` +
        // `dropout_transition=0` and `normalize=0` matter: without them amix
        // raises the music every time the narration pauses, which sounds like a
        // mistake rather than like a mix.
        `amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0[amix]`,
    );
    audioOut = "amix";
  }

  args.push("-filter_complex", filters.join(";"));
  args.push("-map", `[${videoOut}]`);
  if (audioOut) args.push("-map", `[${audioOut}]`);

  args.push(
    "-t",
    secondsArg(timeline.durationMs),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "22",
    "-pix_fmt",
    "yuv420p",
    // Every 2 seconds: YouTube's recommended keyframe interval, and it makes
    // seeking in the studio preview responsive.
    "-g",
    String(timeline.fps * 2),
    // The single flag that makes an MP4 playable before it is fully downloaded.
    "-movflags",
    "+faststart",
  );

  if (audioOut) {
    args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
  } else {
    // A video with no audio track at all confuses some players; silence is
    // safer, and there is genuinely no narration to encode.
    args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-shortest");
  }

  args.push("-progress", "pipe:1", "-loglevel", "error", input.output);

  return args;
}

function lastSceneEnd(scenes: readonly TimelineScene[]): number {
  return scenes.reduce((end, s) => Math.max(end, s.startMs + s.durationMs), 0);
}

function clampVolume(volume: number): string {
  const value = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0.14;
  return value.toFixed(3);
}

/**
 * Run ffmpeg, translating `-progress` output into percentages.
 *
 * This is where real progress comes from: ffmpeg writes `out_time_ms` as it
 * encodes, and dividing by the known duration is a measurement of work done, not
 * an animation. §42 is satisfied because if ffmpeg stalls, so does the bar.
 */
function runFfmpeg(
  binary: string,
  args: readonly string[],
  options: {
    durationMs: number;
    onProgress?: (progress: number) => void | Promise<void>;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    let lastReported = -1;
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(
        new RenderError(
          `the local encode exceeded ${Math.round(FFMPEG_TIMEOUT_MS / 60_000)} minutes`,
          { retryable: false },
        ),
      );
    }, FFMPEG_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        const match = /^out_time_ms=(\d+)/.exec(line.trim());
        if (!match?.[1]) continue;

        // ffmpeg's `out_time_ms` is microseconds despite the name.
        const encodedMs = Number(match[1]) / 1000;
        if (!Number.isFinite(encodedMs) || options.durationMs <= 0) continue;

        const progress = Math.min(
          99,
          Math.round((encodedMs / options.durationMs) * 100),
        );
        // Only forward increases, and only whole-percent changes: the callback
        // writes to the database, and ffmpeg emits progress several times a
        // second.
        if (progress > lastReported) {
          lastReported = progress;
          void options.onProgress?.(progress);
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      // Bounded: a failing filter graph can emit megabytes, and the tail is the
      // part that names the problem.
      stderr = (stderr + chunk.toString("utf8")).slice(-4_000);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new RenderError("ffmpeg could not be started", { retryable: false, cause: error }));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new RenderError(
          `ffmpeg exited with code ${code}${stderr ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`,
          // A non-zero exit is a bad filter graph or a corrupt input; both fail
          // the same way on a second attempt.
          { retryable: false },
        ),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

/**
 * SRT from cues.
 *
 * Also the format the publish stage uploads to YouTube as a caption track, so it
 * lives here rather than inside the ffmpeg path.
 */
export function toSrt(
  cues: ReadonlyArray<{ startMs: number; endMs: number; text: string }>,
): string {
  return (
    cues
      .map((cue, index) =>
        [
          String(index + 1),
          `${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}`,
          // A literal blank line inside a cue would end it early.
          cue.text.replace(/\r?\n{2,}/g, "\n").trim(),
          "",
        ].join("\n"),
      )
      .join("\n") + "\n"
  );
}

function srtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return (
    `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`
  );
}

/** WebVTT, which is what YouTube's caption endpoint prefers. */
export function toVtt(
  cues: ReadonlyArray<{ startMs: number; endMs: number; text: string }>,
): string {
  return (
    "WEBVTT\n\n" +
    cues
      .map(
        (cue) =>
          `${srtTime(cue.startMs).replace(",", ".")} --> ` +
          `${srtTime(cue.endMs).replace(",", ".")}\n${cue.text.trim()}\n`,
      )
      .join("\n")
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isVideo(scene: TimelineScene): boolean {
  return scene.visualKind === "stock_video" || scene.visualKind === "generated_video";
}

/** Unused elsewhere, kept for the storage streaming path in service code. */
export async function writeBufferToFile(path: string, bytes: Buffer): Promise<void> {
  await streamPipeline(Readable.from(bytes), createWriteStream(path));
}

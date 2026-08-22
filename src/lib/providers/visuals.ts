/**
 * VisualProvider — b-roll for each scene (§12, §29, §32).
 *
 * `acquireVisual()` takes one scene's visual direction and returns the bytes of a
 * clip or still, together with everything §29 requires us to keep: the provider,
 * its asset id, the source URL, the licence and the author. That provenance is not
 * optional metadata — it is the record that proves Tally assembled licensed stock
 * rather than reposting someone's video, and it is written on the `assets` row
 * before the file is ever put in a timeline.
 *
 * Sources are tried in the order `VISUAL_PROVIDERS` lists them, and the list is
 * a priority order rather than a set:
 *
 *  - `pexels` — licensed stock. A video first (motion holds attention), falling
 *    back to a still for terms with no clip, which is common for abstract beats
 *    like "the realisation".
 *  - `runway` — generated video, for scenes where no stock exists. Two calls and
 *    real money per scene, so it sits behind stock rather than in front of it.
 *  - `mock` — a real PNG at the right dimensions, development only (§40).
 *
 * A source that fails is logged and the next is tried; only when every source has
 * failed does the stage fail. That is deliberate: one unlucky search term must not
 * cost a whole render, and a scene with no visual cannot be rendered at all.
 */
import { env, usingMockProviders } from "@/lib/env";
import { AssetMissingError, NotConfiguredError, ProviderError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { solidPng } from "@/lib/media/synthetic";
import { fetchRemoteAsset, isOversizeAsset } from "@/lib/providers/fetch";
import { providerJson } from "@/lib/providers/http";
import { withUsage, type UsageContext } from "@/lib/providers/usage";

const log = logger.child({ component: "visuals" });

const PEXELS_API = "https://api.pexels.com";

const RUNWAY_API = "https://api.dev.runwayml.com/v1";

/**
 * Runway pins its API behaviour to a date header rather than a URL version. If
 * Runway ships a breaking change this is the single line to move.
 */
const RUNWAY_VERSION = "2024-11-06";

/** 1080p output, so a portrait clip would letterbox badly. */
const TARGET_WIDTH = 1920;
const TARGET_HEIGHT = 1080;

/** A single b-roll clip. Anything larger is a 4K master we do not need. */
const MAX_CLIP_BYTES = 120 * 1_048_576;

const MAX_IMAGE_BYTES = 25 * 1_048_576;

/** Search results considered per term before moving on. */
const CANDIDATES_PER_TERM = 15;

/** Generated-clip poll ceiling. Runway's Gen-4 turbo is ~30-90s for 5s of video. */
const RUNWAY_POLL_MS = 5_000;
const RUNWAY_MAX_WAIT_MS = 5 * 60_000;

export type VisualKind =
  | "stock_video"
  | "stock_image"
  | "generated_video"
  | "generated_image";

export interface VisualRequest {
  sceneIndex: number;
  /** Free-text direction, used as the generation prompt. */
  visualPrompt: string | null;
  /** Stock search terms, best first. */
  searchTerms: readonly string[];
  /** How long the scene runs, so a clip long enough can be preferred. */
  durationMs: number;
  /**
   * Provider asset ids already used in this video. A repeated clip is the single
   * most obvious tell of an automated edit, so used ids are excluded rather than
   * deduplicated afterwards.
   */
  exclude?: ReadonlySet<string>;
}

export interface AcquiredVisual {
  provider: string;
  kind: VisualKind;
  bytes: Buffer;
  mimeType: string;
  extension: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  providerAssetId: string | null;
  sourceUrl: string | null;
  license: string | null;
  attribution: string | null;
  authorName: string | null;
  /** The term or prompt that produced this, kept on `assets.meta` for debugging. */
  matchedOn: string;
}

export interface AcquireOptions {
  usage: Omit<UsageContext, "provider" | "operation"> & { operation?: string };
}

/** Sources in priority order, or `["mock"]` in development. */
export function visualSources(): string[] {
  if (usingMockProviders()) return ["mock"];
  const list = env().VISUAL_PROVIDERS.map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 ? list : [];
}

export function visualsProviderName(): string {
  const sources = visualSources();
  return sources.length > 0 ? sources.join("+") : "mock";
}

export function isVisualsConfigured(): boolean {
  const sources = visualSources();
  if (sources.length === 0) return false;
  return sources.some((source) => {
    if (source === "mock") return true;
    if (source === "pexels") return Boolean(env().PEXELS_API_KEY);
    if (source === "runway") return Boolean(env().RUNWAY_API_KEY);
    return false;
  });
}

function requireConfigured(): void {
  if (isVisualsConfigured()) return;

  const sources = visualSources();
  const missing: string[] = [];
  if (sources.length === 0) missing.push("VISUAL_PROVIDERS");
  if (sources.includes("pexels") && !env().PEXELS_API_KEY) missing.push("PEXELS_API_KEY");
  if (sources.includes("runway") && !env().RUNWAY_API_KEY) missing.push("RUNWAY_API_KEY");

  throw new NotConfiguredError(
    "Visual library",
    missing.length > 0 ? missing : ["VISUAL_PROVIDERS", "PEXELS_API_KEY"],
    "Set VISUAL_PROVIDERS=pexels and add PEXELS_API_KEY from https://www.pexels.com/api/new/.",
  );
}

/**
 * Find and download one visual for a scene.
 *
 * Downloading here rather than returning a URL is deliberate: a stock CDN link
 * expires, and a timeline that references an expired URL renders a black frame
 * hours later with nothing in the logs. Owning the bytes makes the render
 * reproducible.
 */
export async function acquireVisual(
  request: VisualRequest,
  options: AcquireOptions,
): Promise<AcquiredVisual> {
  requireConfigured();

  const errors: unknown[] = [];

  for (const source of visualSources()) {
    try {
      const result = await withUsage(
        {
          provider: source,
          operation: options.usage.operation ?? "visuals.acquire",
          userId: options.usage.userId ?? null,
          projectId: options.usage.projectId ?? null,
          jobId: options.usage.jobId ?? null,
          traceId: options.usage.traceId ?? null,
        },
        () => fromSource(source, request),
        // Null when this source had no match, which is a real outcome worth
        // recording — a search that returned nothing still cost an API call.
        (r) => ({ quantity: r?.bytes.byteLength ?? 0, unit: "bytes" }),
      );

      if (result) return result;
    } catch (error) {
      // A missing credential for one source is not a reason to abandon the
      // others; the registry has already reported the configuration state.
      log.warn("visual source failed", {
        provider: source,
        sceneIndex: request.sceneIndex,
        error,
      });
      errors.push(error);
    }
  }

  // Nothing found anywhere. Not retryable as a provider fault — the search terms
  // are the problem, and the scene planner produced them, so a retry re-runs the
  // same query. `AssetMissingError` says exactly which scene has no visual.
  const first = errors[0];
  if (first instanceof ProviderError && first.retryable) throw first;

  throw new AssetMissingError(
    `a visual for scene ${request.sceneIndex + 1} (searched: ${
      request.searchTerms.slice(0, 4).join(", ") || "no terms"
    })`,
  );
}

async function fromSource(
  source: string,
  request: VisualRequest,
): Promise<AcquiredVisual | null> {
  switch (source) {
    case "pexels":
      return pexelsVisual(request);
    case "runway":
      return runwayVisual(request);
    case "mock":
      return mockVisual(request);
    default:
      log.warn("unknown visual source in VISUAL_PROVIDERS", { provider: source });
      return null;
  }
}

// ---------------------------------------------------------------------------
// Pexels
// ---------------------------------------------------------------------------

interface PexelsVideoFile {
  id: number;
  quality: string | null;
  file_type: string | null;
  width: number | null;
  height: number | null;
  link: string;
}

interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  /** Seconds. */
  duration: number;
  url: string;
  user?: { name?: string | null; url?: string | null } | null;
  video_files?: PexelsVideoFile[] | null;
}

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer?: string | null;
  photographer_url?: string | null;
  src?: Record<string, string> | null;
}

const PEXELS_LICENSE = "Pexels License (free to use, no attribution required)";

async function pexelsVisual(
  request: VisualRequest,
): Promise<AcquiredVisual | null> {
  const key = env().PEXELS_API_KEY;
  if (!key) return null;

  for (const term of searchTermsFor(request)) {
    const video = await pexelsVideo(term, key, request);
    if (video) return video;
  }

  // No motion for any term. A still is a legitimate b-roll choice — the renderer
  // gives it a slow push so it does not read as a frozen frame.
  for (const term of searchTermsFor(request)) {
    const photo = await pexelsPhoto(term, key, request);
    if (photo) return photo;
  }

  return null;
}

async function pexelsVideo(
  term: string,
  key: string,
  request: VisualRequest,
): Promise<AcquiredVisual | null> {
  const url =
    `${PEXELS_API}/videos/search?query=${encodeURIComponent(term)}` +
    `&per_page=${CANDIDATES_PER_TERM}&orientation=landscape&size=medium`;

  const body = await providerJson<{ videos?: PexelsVideo[] | null }>({
    provider: "Pexels",
    url,
    headers: { authorization: key },
  });

  const videos = (body.videos ?? []).filter(
    (v) => !request.exclude?.has(pexelsId("video", v.id)),
  );

  for (const video of videos) {
    for (const file of rankedVideoFiles(video.video_files ?? [])) {
      let asset;
      try {
        asset = await fetchRemoteAsset(file.link, {
          provider: "Pexels",
          maxBytes: MAX_CLIP_BYTES,
        });
      } catch (error) {
        /**
         * An over-size or unreachable rendition is not a failed search — there
         * are usually three more encodes of the same clip and fourteen more
         * clips behind it. Only oversize is stepped over; anything else (a
         * refused host, a DNS answer inside the network) is a fault worth
         * surfacing rather than papering over with a different download.
         */
        if (isOversizeAsset(error)) {
          log.debug("skipped oversize rendition", {
            provider: "pexels",
            sceneIndex: request.sceneIndex,
            width: file.width,
          });
          continue;
        }
        throw error;
      }

      return {
        provider: "pexels",
        kind: "stock_video",
        bytes: asset.bytes,
        mimeType: asset.contentType.startsWith("video/")
          ? asset.contentType
          : "video/mp4",
        extension: "mp4",
        width: file.width ?? video.width,
        height: file.height ?? video.height,
        durationMs: Math.round((video.duration || 0) * 1000) || null,
        providerAssetId: pexelsId("video", video.id),
        sourceUrl: video.url,
        license: PEXELS_LICENSE,
        attribution: video.user?.name
          ? `Video by ${video.user.name} on Pexels`
          : "Video from Pexels",
        authorName: video.user?.name ?? null,
        matchedOn: term,
      };
    }
  }

  return null;
}

async function pexelsPhoto(
  term: string,
  key: string,
  request: VisualRequest,
): Promise<AcquiredVisual | null> {
  const url =
    `${PEXELS_API}/v1/search?query=${encodeURIComponent(term)}` +
    `&per_page=${CANDIDATES_PER_TERM}&orientation=landscape`;

  const body = await providerJson<{ photos?: PexelsPhoto[] | null }>({
    provider: "Pexels",
    url,
    headers: { authorization: key },
  });

  const photos = (body.photos ?? []).filter(
    (p) => !request.exclude?.has(pexelsId("photo", p.id)),
  );

  for (const photo of photos) {
    // `large2x` is 1880px wide — enough for a 1080p frame with room to pan, and a
    // fraction of `original`, which can be 40 megapixels.
    const link = photo.src?.["large2x"] ?? photo.src?.["large"] ?? photo.src?.["original"];
    if (!link) continue;

    const asset = await fetchRemoteAsset(link, {
      provider: "Pexels",
      maxBytes: MAX_IMAGE_BYTES,
    });

    return {
      provider: "pexels",
      kind: "stock_image",
      bytes: asset.bytes,
      mimeType: asset.contentType.startsWith("image/")
        ? asset.contentType
        : "image/jpeg",
      extension: asset.contentType.includes("png") ? "png" : "jpg",
      width: photo.width,
      height: photo.height,
      durationMs: null,
      providerAssetId: pexelsId("photo", photo.id),
      sourceUrl: photo.url,
      license: PEXELS_LICENSE,
      attribution: photo.photographer
        ? `Photo by ${photo.photographer} on Pexels`
        : "Photo from Pexels",
      authorName: photo.photographer ?? null,
      matchedOn: term,
    };
  }

  return null;
}

function pexelsId(kind: "video" | "photo", id: number): string {
  return `pexels:${kind}:${id}`;
}

/**
 * Rank the downloads, best first.
 *
 * Prefers the largest MP4 that is still at or under 1080p. Going above wastes
 * bandwidth and render time for a frame nobody sees; HLS is skipped because it is
 * a playlist, not a file, and a render provider handed an `.m3u8` fails late.
 *
 * The whole ranked list is returned rather than only the winner because
 * resolution does not predict file size: Pexels serves some 1080p clips at well
 * over `MAX_CLIP_BYTES` (a long, high-bitrate encode), and the byte ceiling is
 * only discovered on download. With one candidate the caller had nothing to fall
 * back to and the scene failed; a lower rendition of the same clip is a far
 * better answer than no visual at all.
 */
function rankedVideoFiles(
  files: readonly PexelsVideoFile[],
): PexelsVideoFile[] {
  return files
    .filter(
      (f) =>
        f.link &&
        f.file_type !== "video/hls" &&
        f.quality !== "hls" &&
        (f.width ?? 0) > 0 &&
        (f.width ?? 0) <= TARGET_WIDTH + 200,
    )
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
}

/** Search terms, longest-first, with the visual prompt as a last resort. */
function searchTermsFor(request: VisualRequest): string[] {
  const terms = request.searchTerms
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .slice(0, 5);

  if (terms.length === 0 && request.visualPrompt) {
    // Stock search does badly with a sentence; the first few content words are a
    // better query than the whole direction.
    terms.push(request.visualPrompt.split(/\s+/).slice(0, 4).join(" "));
  }

  return terms;
}

// ---------------------------------------------------------------------------
// Runway (generated video)
// ---------------------------------------------------------------------------

interface RunwayTask {
  id: string;
  status: "PENDING" | "THROTTLED" | "RUNNING" | "SUCCEEDED" | "FAILED" | string;
  output?: string[] | null;
  failure?: string | null;
  failureCode?: string | null;
}

/**
 * Generate a clip for a scene no stock library covers.
 *
 * Two calls: a still from the prompt, then that still animated. Runway's video
 * models take an image as the first frame rather than text alone, so the still is
 * a required input rather than an extra flourish.
 */
async function runwayVisual(
  request: VisualRequest,
): Promise<AcquiredVisual | null> {
  const key = env().RUNWAY_API_KEY;
  if (!key) return null;

  const prompt = (request.visualPrompt ?? request.searchTerms.join(", ")).trim();
  if (prompt.length < 8) return null;

  const headers = {
    authorization: `Bearer ${key}`,
    "x-runway-version": RUNWAY_VERSION,
  };

  const imageTask = await providerJson<RunwayTask>({
    provider: "Runway",
    url: `${RUNWAY_API}/text_to_image`,
    method: "POST",
    headers,
    body: {
      model: "gen4_image",
      promptText: prompt.slice(0, 900),
      ratio: `${TARGET_WIDTH}:${TARGET_HEIGHT}`,
    },
  });

  const imageUrl = await awaitRunwayTask(imageTask.id, headers);

  // Runway bills per second and only accepts a fixed set of durations; 5s covers
  // a single scene beat, and a longer scene loops or holds in the timeline rather
  // than paying for footage the cut would not use.
  const videoTask = await providerJson<RunwayTask>({
    provider: "Runway",
    url: `${RUNWAY_API}/image_to_video`,
    method: "POST",
    headers,
    body: {
      model: "gen4_turbo",
      promptImage: imageUrl,
      promptText: prompt.slice(0, 900),
      ratio: `${TARGET_WIDTH}:${TARGET_HEIGHT}`,
      duration: 5,
    },
  });

  const videoUrl = await awaitRunwayTask(videoTask.id, headers);

  const asset = await fetchRemoteAsset(videoUrl, {
    provider: "Runway",
    maxBytes: MAX_CLIP_BYTES,
    // Runway serves output from a signed CDN host that is not documented as
    // stable, so the operator allow-lists it once rather than us guessing.
    extraHosts: env().ASSET_FETCH_ALLOWED_HOSTS,
  });

  return {
    provider: "runway",
    kind: "generated_video",
    bytes: asset.bytes,
    mimeType: "video/mp4",
    extension: "mp4",
    width: TARGET_WIDTH,
    height: TARGET_HEIGHT,
    durationMs: 5_000,
    providerAssetId: `runway:${videoTask.id}`,
    sourceUrl: null,
    license: "Generated by Runway under the Tally account's Runway licence",
    attribution: "Generated with Runway",
    authorName: null,
    matchedOn: prompt.slice(0, 120),
  };
}

/** Poll a Runway task to completion and return its single output URL. */
async function awaitRunwayTask(
  taskId: string,
  headers: Record<string, string>,
): Promise<string> {
  const deadline = Date.now() + RUNWAY_MAX_WAIT_MS;

  for (;;) {
    const task = await providerJson<RunwayTask>({
      provider: "Runway",
      url: `${RUNWAY_API}/tasks/${encodeURIComponent(taskId)}`,
      headers,
    });

    if (task.status === "SUCCEEDED") {
      const output = task.output?.[0];
      if (!output) {
        throw new ProviderError("Runway", "reported success with no output", {
          retryable: false,
          details: { taskId },
        });
      }
      return output;
    }

    if (task.status === "FAILED") {
      throw new ProviderError(
        "Runway",
        `generation failed: ${task.failure ?? task.failureCode ?? "unknown reason"}`,
        // A content-policy refusal will refuse identically next time; anything
        // else is worth one more attempt.
        { retryable: !/safety|moderation|policy/i.test(task.failure ?? ""), details: { taskId } },
      );
    }

    if (Date.now() > deadline) {
      throw new ProviderError(
        "Runway",
        `generation did not finish within ${RUNWAY_MAX_WAIT_MS / 1000}s`,
        { retryable: true, details: { taskId, status: task.status } },
      );
    }

    await sleep(RUNWAY_POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Mock (§40)
// ---------------------------------------------------------------------------

/**
 * A real 1080p PNG, one distinct colour per scene.
 *
 * Distinct colours matter: a mock render whose scenes are all the same grey
 * cannot show you that the timeline ordered them correctly, and ordering is the
 * thing most likely to be wrong.
 */
async function mockVisual(request: VisualRequest): Promise<AcquiredVisual> {
  const seed = `${request.sceneIndex}:${request.searchTerms.join(",")}`;
  // A quarter-size frame: the renderer scales it, and a full 1920×1080 PNG per
  // scene is megabytes of storage for a development artefact.
  const bytes = solidPng({ width: TARGET_WIDTH / 4, height: TARGET_HEIGHT / 4, seed });

  return {
    provider: "mock",
    kind: "generated_image",
    bytes,
    mimeType: "image/png",
    extension: "png",
    width: TARGET_WIDTH / 4,
    height: TARGET_HEIGHT / 4,
    durationMs: null,
    providerAssetId: `mock:${request.sceneIndex}`,
    sourceUrl: null,
    license: "Development placeholder — not for publication",
    attribution: null,
    authorName: null,
    matchedOn: request.searchTerms[0] ?? "mock",
  };
}

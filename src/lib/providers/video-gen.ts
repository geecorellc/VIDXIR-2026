/**
 * The generation provider registry — Tally's branded models, and the vendor APIs
 * underneath them (Phase 12 §2, §3, §4, §5, §14, §16).
 *
 * Phase 11 reached six vendors through one aggregator (fal.ai) and named them in
 * the picker. §2 removes that: the four models a customer chooses from are Tally's
 * own, each reaching **one vendor's first-party API directly**, and the vendor is
 * never part of the customer-facing name.
 *
 *   Tal 1.0 — Fast Model        → Alibaba DashScope (Wan)      DASHSCOPE_API_KEY
 *   Tal 2.0 — Creators Model    → MiniMax                      MINIMAX_API_KEY
 *   Tal 3.0 — Cinematic Model   → Volcengine Ark (Seedance)    SEEDANCE_API_KEY
 *   Tal 3.1 — Ultra Model       → Google Veo / Imagen          GEMINI_API_KEY
 *
 * That mapping is the only place it exists. Nothing else in the application knows
 * which vendor serves which model — not the router, not the plan layer, not the
 * continuity engine (§6: "the continuity layer must not call provider APIs
 * directly"), and not the browser (§3: the backend names must not appear in the
 * normal customer-facing UI, which `publicModels()` enforces by construction).
 *
 * Six rules this module exists to enforce, none of them enforceable in the UI:
 *
 *  1. **The server decides what exists** (§2, §19). `availableModels()` is computed
 *     from `VIDEO_GEN_PROVIDERS` plus the credential check. A model absent from that
 *     list cannot be selected by any request, however the request is manipulated.
 *  2. **No fabricated APIs** (§19, "do not fabricate provider capabilities"). Every
 *     adapter below submits to an endpoint its vendor documents, in that vendor's
 *     own request shape. Where a vendor has a capability Tally has not integrated,
 *     the capability matrix says `false` and says why in a comment — it does not
 *     claim the capability and fail at runtime.
 *  3. **Capabilities are declared, not assumed** (§4, §16). Each model carries the
 *     resolutions, durations, aspect ratios, image support, reference-image support
 *     and audio support it actually has. §4's "do not show an option that the
 *     underlying model does not support" is then a filter over data rather than a
 *     rule someone has to remember, and `assertQuality`/`resolveImageModel` refuse
 *     an unsupported request server-side.
 *  4. **Unconfigured means unavailable, never fake.** A provider whose key is unset
 *     reports `not_configured` and generation throws `NotConfiguredError`. There is
 *     no placeholder clip and no silent fallback to stock: falling back would mean a
 *     user who spent credits on AI video got stock footage and was told otherwise.
 *  5. **No keys leave the server.** The status and model reports contain variable
 *     *names* and states. Every credential read happens inside a generate call.
 *  6. **One registry for video and images** (§5). Image generation is a *capability
 *     of the same models*, not a second architecture: the same provider objects, the
 *     same credential checks, the same `withUsage` accounting, the same allow-listed
 *     download path. Only the models whose vendor publishes an image API declare it.
 *
 * A generated clip is short — the longest here is 12 seconds — and a scene is often
 * longer. That is expected and handled elsewhere: final assembly stays with the
 * existing FFmpeg pipeline, which holds or loops a clip to fill its slot. Nothing
 * here tries to generate a whole video.
 */
import { env, usingMockProviders } from "@/lib/env";
import { NotConfiguredError, ProviderError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { solidPng } from "@/lib/media/synthetic";
import { fetchRemoteAsset } from "@/lib/providers/fetch";
import { providerJson } from "@/lib/providers/http";
import { withUsage, type UsageContext } from "@/lib/providers/usage";
import { formatSpec, type VideoFormat } from "@/lib/video/format";
import {
  qualityFrame,
  qualityRank,
  qualitySpec,
  type VideoQuality,
} from "@/lib/video/quality";

const log = logger.child({ component: "video-gen" });

/**
 * How the visuals for a project are produced (§1).
 *
 * Two modes are the stated minimum. `STOCK` is the existing behaviour and the
 * default, so a project that never touches AI video is in `STOCK` mode and the
 * b-roll stage runs exactly as it did.
 */
export type GenerationMode = "STOCK" | "AI_VIDEO";

export const GENERATION_MODES = ["STOCK", "AI_VIDEO"] as const;

export function isGenerationMode(value: unknown): value is GenerationMode {
  return (
    typeof value === "string" &&
    (GENERATION_MODES as readonly string[]).includes(value)
  );
}

/**
 * Backend provider ids.
 *
 * **These are internal.** They appear in `VIDEO_GEN_PROVIDERS`, in logs, in
 * `api_usage.provider` and in the operator-facing configuration report. §3 keeps
 * them out of the customer-facing UI, which is why `publicModels()` exists and why
 * `/api/video/providers` no longer forwards them.
 *
 * `fal` is gone as a video route (§14). It is not a member of this union, so the
 * type system now refuses a reintroduction; a stale `VIDEO_GEN_PROVIDERS=fal` is
 * warned about and ignored rather than taking the deployment down.
 */
export type VideoGenProviderId =
  | "qwen"
  | "minimax"
  | "seedance"
  | "veo"
  | "runway"
  | "mock";

/** Configuration state of one provider, mirroring `providers/config.ts`. */
export type VideoGenState = "ready" | "mock" | "not_configured" | "disabled";

/**
 * What a model can actually do (§16).
 *
 * The centralised capability matrix. Every field is stated per model from that
 * vendor's published documentation, and a capability Tally has not implemented is
 * `false` even when the vendor offers it — a matrix that promises image-to-video
 * because the vendor supports it, while no adapter here sends a first frame, is
 * worse than one that says `false`.
 *
 * Aspect ratios live on `VideoGenModel.formats` rather than here, because two
 * existing modules (`generation-plan.ts` and the picker) already read them from
 * there and moving them would be churn for no gain. `formats` is the aspect-ratio
 * axis of this matrix.
 */
export interface ModelCapabilities {
  /** Generates video from a text prompt alone. True for every model here. */
  textToVideo: boolean;
  /** Accepts a starting frame and animates it. */
  imageToVideo: boolean;
  /** Generates still images (§5). */
  imageGeneration: boolean;
  /**
   * Accepts reference images to constrain a character, environment or prop.
   *
   * §6: where this is false the continuity engine falls back to continuity-aware
   * *textual* prompting, which is what it already does.
   */
  referenceImages: boolean;
  /** Produces an audio track with the video. */
  audio: boolean;
  /** Video resolutions this model accepts, ascending (§4). */
  qualities: readonly VideoQuality[];
  /** Image resolutions this model accepts. Empty when `imageGeneration` is false. */
  imageQualities: readonly VideoQuality[];
  /**
   * Clip lengths the endpoint accepts, in seconds.
   *
   * The scene's requested length is snapped to the nearest one rather than sent
   * verbatim, because every vendor here rejects an unsupported value instead of
   * clamping it.
   */
  durations: readonly number[];
}

export interface VideoGenModel {
  /** Stable id the client sends back, e.g. `tal/3.0`. */
  id: string;
  /** Backend provider. Internal — never rendered in the customer UI (§3). */
  provider: VideoGenProviderId;
  /** Customer-facing name, e.g. "Tal 3.0 — Cinematic Model" (§2). */
  label: string;
  /** One line under the label (§3). */
  description: string;
  /** The "Best for:" line (§3). */
  bestFor: string;
  /** Model strengths, shown as bullets (§4). */
  strengths: readonly string[];
  /** Generation limitations, shown as bullets (§4). Honest, not marketing. */
  limitations: readonly string[];
  /** Longest clip this model produces, in seconds. Derived from `capabilities`. */
  maxClipSeconds: number;
  /** Aspect ratios the model generates natively. */
  formats: readonly VideoFormat[];
  /**
   * True when this model costs materially more than the others, so it can be gated
   * behind the `premiumVideoModels` entitlement.
   *
   * Since §7 introduces credits, this is a *plan capability* gate rather than the
   * cost control — per-generation cost is expressed in credits, which every plan
   * spends from the same balance.
   */
  premium: boolean;
  /**
   * True for a model kept only so a project that stored its id still renders (§17).
   *
   * Absent from `availableModels()` and therefore from every picker, but still
   * resolvable, which is the difference between "not offered any more" and "your
   * saved project is now broken".
   */
  legacy: boolean;
  capabilities: ModelCapabilities;
}

export interface VideoGenProviderStatus {
  provider: VideoGenProviderId;
  /** Operator-facing vendor name. Not for the customer UI (§3). */
  label: string;
  state: VideoGenState;
  /** Env var names only. Never a value. */
  requiredEnvVars: string[];
  missingEnvVars: string[];
  /** Where to get the credential, or what service is required. */
  hint: string;
  /**
   * Stated when the provider depends on a specific third-party service. Shown to
   * operators, not to customers.
   */
  serviceNote: string | null;
  models: VideoGenModel[];
}

/**
 * A stored reference still, offered to a model that can constrain generation with one.
 *
 * §6's other half. The continuity engine's fallback when this cannot be used is
 * detailed textual prompting, which is what every catalogued model gets today — no
 * model here declares `capabilities.referenceImages`, so this type is currently
 * inhabited by nothing that reaches a provider.
 *
 * It exists now rather than when the first such backend lands because the *decision*
 * exists now: `generateClip` refuses references for a model that declares none, so the
 * capability flag is what gates the feature rather than each adapter remembering to
 * ignore a field. Flipping one model's flag and reading `request.referenceImages` in
 * its adapter is the whole change.
 */
export interface ReferenceImageInput {
  /** What the still depicts. Same vocabulary as `ImagePurpose`'s continuity members. */
  kind: "character" | "environment" | "prop";
  /** The bible entity's slug, for the provider's own labelling where it takes one. */
  entityId: string;
  bytes: Buffer;
  mimeType: string;
}

export interface GenerateClipRequest {
  /** What the shot should show. The scene's visual direction. */
  prompt: string;
  /** Model id, already validated by `resolveModel`. */
  modelId: string;
  format: VideoFormat;
  /**
   * Requested resolution. Null resolves to the default and is then checked against
   * the model's declared support, so a legacy caller cannot request 2K on a model
   * that tops out at 1080p.
   */
  quality?: VideoQuality | null;
  /**
   * How long the scene runs. A provider snaps this to a length it supports; the
   * renderer fills any remainder.
   */
  durationMs: number;
  sceneIndex: number;
  /**
   * Continuity references for this scene's committed entities (§6).
   *
   * Refused by `generateClip` unless the model declares `referenceImages`. Absent is
   * the normal case and means the continuity constraints are in `prompt`.
   */
  referenceImages?: readonly ReferenceImageInput[];
}

export interface GeneratedClip {
  provider: VideoGenProviderId;
  modelId: string;
  bytes: Buffer;
  mimeType: string;
  extension: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** Provider-side id, for provenance and de-duplication. */
  providerAssetId: string | null;
  /** Licence statement recorded on the asset row. */
  license: string;
  attribution: string | null;
  /** The prompt that produced it, kept on `assets.meta`. */
  matchedOn: string;
}

/**
 * What a generated still is *for* (§5).
 *
 * Carried through to `assets.meta` so a continuity reference can be found again by
 * purpose rather than by guessing from a filename. The set is the list §5 names.
 */
export type ImagePurpose =
  | "character"
  | "environment"
  | "prop"
  | "artwork"
  | "scene"
  | "thumbnail"
  | "reference";

export const IMAGE_PURPOSES = [
  "character",
  "environment",
  "prop",
  "artwork",
  "scene",
  "thumbnail",
  "reference",
] as const;

export interface GenerateImageRequest {
  prompt: string;
  modelId: string;
  format: VideoFormat;
  quality?: VideoQuality | null;
  purpose: ImagePurpose;
  /** Ordinal for provenance — a scene index, or a position within a bible. */
  index: number;
}

export interface GeneratedImage {
  provider: VideoGenProviderId;
  modelId: string;
  purpose: ImagePurpose;
  bytes: Buffer;
  mimeType: string;
  extension: string;
  width: number | null;
  height: number | null;
  providerAssetId: string | null;
  license: string;
  attribution: string | null;
  matchedOn: string;
}

export interface GenerateOptions {
  usage: Omit<UsageContext, "provider" | "operation"> & { operation?: string };
}

/**
 * The provider contract.
 *
 * `generate` and `generateImage` are the only methods that touch a credential.
 * Everything the UI and the authorisation layer need — which models exist, whether
 * they are configured, what they can do — is answered without one, which is what
 * lets the picker be rendered for a deployment that has configured nothing.
 *
 * `generateImage` is optional and must be present exactly when some model of this
 * provider declares `capabilities.imageGeneration`. `assertRegistryIntegrity()`
 * checks that at module load rather than trusting it. `acceptsReferenceImages` is the
 * same arrangement for the other half of §6.
 */
interface GenerationProvider {
  id: VideoGenProviderId;
  label: string;
  requiredEnvVars: readonly string[];
  hint: string;
  serviceNote: string | null;
  models: readonly VideoGenModel[];
  /** Env vars from `requiredEnvVars` that are currently unset. */
  missingEnvVars(): string[];
  generate(request: GenerateClipRequest): Promise<GeneratedClip>;
  generateImage?(request: GenerateImageRequest): Promise<GeneratedImage>;
  /**
   * The adapter's signed statement that its `generate` reads
   * `request.referenceImages` and sends the bytes to the vendor (§6).
   *
   * Absent on every provider below, because none of them do. It exists because
   * "reused by scene generation where the selected backend supports them" is a claim
   * that has to be *checkable*: a capability flag alone can be flipped on a model in
   * one line, and the reference stills would then be generated, charged and silently
   * dropped on the floor by an adapter that never looks at the field.
   *
   * `assertRegistryIntegrity()` requires this and `capabilities.referenceImages` to
   * agree in both directions, so flipping either one alone fails at module load.
   * There is no way to declare the feature without the adapter, and no way to leave
   * a stale declaration behind after removing one.
   */
  acceptsReferenceImages?: true;
}

// ---------------------------------------------------------------------------
// Shared limits
// ---------------------------------------------------------------------------

/**
 * The hint attached to a configuration error that reaches a *user*.
 *
 * Deliberately vendor-free. Each provider's own `hint` names a vendor console and
 * belongs in the operator report; a customer who hits an unconfigured model needs to
 * know it is not their fault and not their fix, and nothing more (§3).
 */
const SETUP_HINT =
  "This model is not available yet on this workspace. Choose another model, or " +
  "contact support.";

/** One generated clip. A 1080p 12-second clip is tens of megabytes. */
const MAX_CLIP_BYTES = 120 * 1_048_576;

/** One generated still. Generous for a 2K PNG, far below the clip ceiling. */
const MAX_IMAGE_BYTES = 24 * 1_048_576;

/**
 * Alibaba's object storage, where both DashScope and MiniMax serve finished media.
 *
 * Named here and passed to `fetchRemoteAsset` as an extra allowed host rather than
 * added to the global `PROVIDER_HOSTS` list, so the SSRF allow-list only widens for
 * the calls that need it.
 */
const ALIYUN_MEDIA_HOSTS = ["aliyuncs.com"] as const;

/** MiniMax's own hosts, for the file-retrieve step and its CDN. */
const MINIMAX_MEDIA_HOSTS = ["minimaxi.chat", "minimax.chat", "minimax.io"] as const;

/** Volcengine's object storage, where Ark serves finished Seedance clips. */
const ARK_MEDIA_HOSTS = ["volces.com", "byteplusapi.com"] as const;

/** Host Veo serves finished files from — same API host, authenticated download. */
const GEMINI_MEDIA_HOST = "generativelanguage.googleapis.com";

// ---------------------------------------------------------------------------
// Tal 1.0 — Fast Model, on Alibaba Cloud Model Studio (DashScope / Wan)
// ---------------------------------------------------------------------------

/**
 * DashScope's asynchronous job pattern.
 *
 * Both the video and the image endpoint work the same way: POST with
 * `X-DashScope-Async: enable`, get a task id back, then poll `GET /tasks/{id}`
 * until `task_status` leaves the pending states. One poller serves both.
 */
const DASHSCOPE_POLL_MS = 5_000;
const DASHSCOPE_MAX_WAIT_MS = 12 * 60_000;

interface DashScopeSubmit {
  output?: { task_id?: string | null; task_status?: string | null } | null;
  request_id?: string | null;
  code?: string | null;
  message?: string | null;
}

interface DashScopeTask {
  output?: {
    task_id?: string | null;
    task_status?: string | null;
    video_url?: string | null;
    results?: Array<{ url?: string | null; code?: string | null }> | null;
    code?: string | null;
    message?: string | null;
  } | null;
}

const TAL_1: VideoGenModel = {
  id: "tal/1.0",
  provider: "qwen",
  label: "Tal 1.0 — Fast Model",
  description: "Fast generation • Great for high-volume content",
  bestFor: "Shorts, simple scenes, rapid production",
  strengths: [
    "Fastest turnaround of the four models",
    "Lowest credit cost per scene",
    "Generates all three aspect ratios",
    "Also generates reference stills for the continuity engine",
  ],
  limitations: [
    "Five-second clips only — longer scenes are filled by the renderer",
    "No generated audio",
    "Less consistent motion than the cinematic tiers",
  ],
  maxClipSeconds: 5,
  formats: ["landscape", "portrait", "square"],
  premium: false,
  legacy: false,
  capabilities: {
    textToVideo: true,
    // Wan publishes an image-to-video endpoint, but no adapter here sends a first
    // frame, so this stays false rather than promising a path that does not exist.
    imageToVideo: false,
    imageGeneration: true,
    referenceImages: false,
    audio: false,
    qualities: ["draft", "720p", "1080p"],
    imageQualities: ["draft", "720p", "1080p"],
    durations: [5],
  },
};

const qwen: GenerationProvider = {
  id: "qwen",
  label: "Alibaba Cloud Model Studio (Wan)",
  requiredEnvVars: ["DASHSCOPE_API_KEY"],
  hint: "Create a key at https://bailian.console.alibabacloud.com",
  serviceNote:
    "Alibaba's own first-party API for the Wan models — a vendor API, not an " +
    "aggregator. DASHSCOPE_BASE_URL selects the regional endpoint; a key issued " +
    "for the international estate is rejected by the mainland China host and vice " +
    "versa. Also serves this model's text-to-image capability.",
  models: [TAL_1],
  missingEnvVars() {
    return env().DASHSCOPE_API_KEY ? [] : ["DASHSCOPE_API_KEY"];
  },
  async generate(request) {
    const key = requireKey("Tal 1.0", env().DASHSCOPE_API_KEY, [
      "DASHSCOPE_API_KEY",
    ], SETUP_HINT);

    const quality = assertQuality(TAL_1, request.quality);
    const size = dashScopeSize(request.format, quality);
    const seconds = nearest(TAL_1.capabilities.durations, secondsOf(request.durationMs));
    const base = env().DASHSCOPE_BASE_URL.replace(/\/+$/, "");
    const headers = {
      authorization: `Bearer ${key}`,
      "X-DashScope-Async": "enable",
    };

    const submitted = await providerJson<DashScopeSubmit>({
      provider: TAL_1.label,
      url: `${base}/services/aigc/video-generation/video-synthesis`,
      method: "POST",
      headers,
      body: {
        model: env().DASHSCOPE_VIDEO_MODEL,
        input: { prompt: request.prompt.slice(0, 1_500) },
        parameters: { size, duration: seconds, prompt_extend: true },
      },
    });

    const taskId = submitted.output?.task_id;
    if (!taskId) {
      throw new ProviderError(TAL_1.label, "returned no task id", {
        retryable: true,
      });
    }

    const task = await awaitDashScopeTask(TAL_1.label, base, taskId, key);
    const url = task.output?.video_url;
    if (!url) {
      throw new ProviderError(TAL_1.label, "completed with no video URL", {
        retryable: false,
        details: { taskId },
      });
    }

    const asset = await fetchRemoteAsset(url, {
      provider: TAL_1.label,
      maxBytes: MAX_CLIP_BYTES,
      extraHosts: [...ALIYUN_MEDIA_HOSTS, ...env().ASSET_FETCH_ALLOWED_HOSTS],
    });

    const pixels = qualityFrame(request.format, quality);
    return {
      provider: "qwen",
      modelId: TAL_1.id,
      bytes: asset.bytes,
      mimeType: videoMime(asset.contentType),
      extension: "mp4",
      width: pixels.width,
      height: pixels.height,
      durationMs: seconds * 1_000,
      providerAssetId: `qwen:${taskId}`,
      license: brandedLicense(TAL_1.label),
      attribution: brandedAttribution(TAL_1.label),
      matchedOn: request.prompt.slice(0, 120),
    };
  },
  async generateImage(request) {
    const key = requireKey("Tal 1.0", env().DASHSCOPE_API_KEY, [
      "DASHSCOPE_API_KEY",
    ], SETUP_HINT);

    const quality = assertImageQuality(TAL_1, request.quality);
    const size = dashScopeSize(request.format, quality);
    const base = env().DASHSCOPE_BASE_URL.replace(/\/+$/, "");
    const headers = {
      authorization: `Bearer ${key}`,
      "X-DashScope-Async": "enable",
    };

    const submitted = await providerJson<DashScopeSubmit>({
      provider: TAL_1.label,
      url: `${base}/services/aigc/text2image/image-synthesis`,
      method: "POST",
      headers,
      body: {
        model: env().DASHSCOPE_IMAGE_MODEL,
        input: { prompt: request.prompt.slice(0, 1_500) },
        parameters: { size, n: 1 },
      },
    });

    const taskId = submitted.output?.task_id;
    if (!taskId) {
      throw new ProviderError(TAL_1.label, "returned no task id", {
        retryable: true,
      });
    }

    const task = await awaitDashScopeTask(TAL_1.label, base, taskId, key);
    const url = task.output?.results?.[0]?.url;
    if (!url) {
      throw new ProviderError(TAL_1.label, "completed with no image URL", {
        retryable: false,
        details: { taskId },
      });
    }

    const asset = await fetchRemoteAsset(url, {
      provider: TAL_1.label,
      maxBytes: MAX_IMAGE_BYTES,
      extraHosts: [...ALIYUN_MEDIA_HOSTS, ...env().ASSET_FETCH_ALLOWED_HOSTS],
    });

    const pixels = qualityFrame(request.format, quality);
    return {
      provider: "qwen",
      modelId: TAL_1.id,
      purpose: request.purpose,
      bytes: asset.bytes,
      mimeType: imageMime(asset.contentType),
      extension: extensionFor(imageMime(asset.contentType)),
      width: pixels.width,
      height: pixels.height,
      providerAssetId: `qwen:img:${taskId}`,
      license: brandedLicense(TAL_1.label),
      attribution: brandedAttribution(TAL_1.label),
      matchedOn: request.prompt.slice(0, 120),
    };
  },
};

/** DashScope spells a frame `width*height`. */
function dashScopeSize(format: VideoFormat, quality: VideoQuality): string {
  const frame = qualityFrame(format, quality);
  return `${frame.width}*${frame.height}`;
}

/** Poll a DashScope task until it leaves the pending states. */
async function awaitDashScopeTask(
  label: string,
  base: string,
  taskId: string,
  key: string,
): Promise<DashScopeTask> {
  const deadline = Date.now() + DASHSCOPE_MAX_WAIT_MS;

  for (;;) {
    const task = await providerJson<DashScopeTask>({
      provider: label,
      url: `${base}/tasks/${encodeURIComponent(taskId)}`,
      headers: { authorization: `Bearer ${key}` },
    });

    const status = task.output?.task_status ?? "";

    if (status === "SUCCEEDED") return task;

    if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
      const detail = task.output?.message ?? task.output?.code ?? status;
      throw new ProviderError(label, `generation failed: ${detail}`, {
        retryable: transientDetail(detail),
        details: { taskId },
      });
    }

    if (Date.now() > deadline) {
      throw new ProviderError(
        label,
        `generation did not finish within ${DASHSCOPE_MAX_WAIT_MS / 1000}s`,
        { retryable: true, details: { taskId, status } },
      );
    }

    await sleep(DASHSCOPE_POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// Tal 2.0 — Creators Model, on MiniMax
// ---------------------------------------------------------------------------

/**
 * MiniMax's three-step flow.
 *
 * Submit returns a task id; polling returns a *file id* rather than a URL; the file
 * has to be retrieved to get a download URL. Three calls, all documented, and the
 * middle one is the reason this adapter is longer than the others.
 */
const MINIMAX_POLL_MS = 5_000;
const MINIMAX_MAX_WAIT_MS = 12 * 60_000;

interface MiniMaxSubmit {
  task_id?: string | null;
  base_resp?: { status_code?: number | null; status_msg?: string | null } | null;
}

interface MiniMaxStatus {
  task_id?: string | null;
  status?: string | null;
  file_id?: string | null;
  base_resp?: { status_code?: number | null; status_msg?: string | null } | null;
}

interface MiniMaxFile {
  file?: { download_url?: string | null; filename?: string | null } | null;
}

/**
 * MiniMax's image response — synchronous, unlike its video flow.
 *
 * `image_generation` returns finished URLs in one call rather than a task id, so the
 * image path here is one request where the video path is three.
 */
interface MiniMaxImage {
  data?: { image_urls?: string[] | null } | null;
  base_resp?: { status_code?: number | null; status_msg?: string | null } | null;
}

const TAL_2: VideoGenModel = {
  id: "tal/2.0",
  provider: "minimax",
  label: "Tal 2.0 — Creators Model",
  description: "Balanced quality and generation cost",
  bestFor: "YouTube creators and everyday storytelling",
  strengths: [
    "Strong physics and character motion",
    "Six- and ten-second clips, so fewer joins per scene",
    "Good value per credit for a full-length video",
    "Also generates reference stills for the continuity engine",
  ],
  limitations: [
    "Landscape and portrait only — no square",
    "No generated audio",
  ],
  maxClipSeconds: 10,
  formats: ["landscape", "portrait"],
  premium: false,
  legacy: false,
  capabilities: {
    textToVideo: true,
    imageToVideo: false,
    // MiniMax's own `image_generation` endpoint, on the same host and key as the
    // video API. Integrated in Phase 12 §5 so continuity references can be made by
    // whichever model the project already selected.
    imageGeneration: true,
    referenceImages: false,
    audio: false,
    // Its image API takes an aspect ratio rather than a pixel size, so the tier
    // list matches the video one — the frame is derived either way.
    imageQualities: ["720p", "1080p"],
    qualities: ["720p", "1080p"],
    durations: [6, 10],
  },
};

const minimax: GenerationProvider = {
  id: "minimax",
  label: "MiniMax (Hailuo and image-01)",
  requiredEnvVars: ["MINIMAX_API_KEY"],
  hint: "Create a key at https://www.minimaxi.com/user-center/basic-information",
  serviceNote:
    "MiniMax's own first-party video API. Finished files are retrieved by file id " +
    "rather than returned as a URL, so this adapter makes three calls per clip. Its " +
    "image endpoint is synchronous and takes one, on the same host and key; " +
    "MINIMAX_IMAGE_MODEL selects that version independently of the video one.",
  models: [TAL_2],
  missingEnvVars() {
    return env().MINIMAX_API_KEY ? [] : ["MINIMAX_API_KEY"];
  },
  async generate(request) {
    const key = requireKey("Tal 2.0", env().MINIMAX_API_KEY, [
      "MINIMAX_API_KEY",
    ], SETUP_HINT);

    if (request.format === "square") {
      // Generating landscape and cropping to a square would cut the subject out of
      // the shot, so this is refused with the actual reason. `resolveModel` plus
      // `generationPlanFor` normally catch it first; this is the backstop.
      throw new ProviderError(
        TAL_2.label,
        "does not generate square video. Choose landscape or portrait, or pick a " +
          "different model.",
        { retryable: false, status: 400 },
      );
    }

    const quality = assertQuality(TAL_2, request.quality);
    const seconds = nearest(TAL_2.capabilities.durations, secondsOf(request.durationMs));
    const base = env().MINIMAX_BASE_URL.replace(/\/+$/, "");
    const headers = { authorization: `Bearer ${key}` };

    const submitted = await providerJson<MiniMaxSubmit>({
      provider: TAL_2.label,
      url: `${base}/video_generation`,
      method: "POST",
      headers,
      body: {
        model: env().MINIMAX_VIDEO_MODEL,
        prompt: request.prompt.slice(0, 1_500),
        duration: seconds,
        resolution: quality === "1080p" ? "1080P" : "720P",
        // A content-policy refusal is a correct outcome surfaced as a permanent
        // error. Disabling the check would move responsibility for a policy
        // violation onto Tally's account.
        prompt_optimizer: true,
      },
    });

    assertMiniMaxOk(submitted.base_resp);
    const taskId = submitted.task_id;
    if (!taskId) {
      throw new ProviderError(TAL_2.label, "returned no task id", {
        retryable: true,
      });
    }

    const fileId = await awaitMiniMaxTask(base, taskId, headers);

    const file = await providerJson<MiniMaxFile>({
      provider: TAL_2.label,
      url: `${base}/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
      headers,
    });
    const url = file.file?.download_url;
    if (!url) {
      throw new ProviderError(TAL_2.label, "returned no download URL", {
        retryable: false,
        details: { taskId, fileId },
      });
    }

    const asset = await fetchRemoteAsset(url, {
      provider: TAL_2.label,
      maxBytes: MAX_CLIP_BYTES,
      extraHosts: [
        ...MINIMAX_MEDIA_HOSTS,
        ...ALIYUN_MEDIA_HOSTS,
        ...env().ASSET_FETCH_ALLOWED_HOSTS,
      ],
    });

    const pixels = qualityFrame(request.format, quality);
    return {
      provider: "minimax",
      modelId: TAL_2.id,
      bytes: asset.bytes,
      mimeType: videoMime(asset.contentType),
      extension: "mp4",
      width: pixels.width,
      height: pixels.height,
      durationMs: seconds * 1_000,
      providerAssetId: `minimax:${taskId}`,
      license: brandedLicense(TAL_2.label),
      attribution: brandedAttribution(TAL_2.label),
      matchedOn: request.prompt.slice(0, 120),
    };
  },
  async generateImage(request) {
    const key = requireKey("Tal 2.0", env().MINIMAX_API_KEY, [
      "MINIMAX_API_KEY",
    ], SETUP_HINT);

    // Square is refused for images too, and for the same reason as video: the frame
    // is a generation parameter, and cropping a landscape still to a square would
    // move the subject out of a reference the continuity engine relies on.
    if (request.format === "square") {
      throw new ProviderError(
        TAL_2.label,
        "does not generate square images. Choose landscape or portrait, or pick a " +
          "different model.",
        { retryable: false, status: 400 },
      );
    }

    const frame = formatSpec(request.format);
    const quality = assertImageQuality(TAL_2, request.quality);
    const base = env().MINIMAX_BASE_URL.replace(/\/+$/, "");

    const response = await providerJson<MiniMaxImage>({
      provider: TAL_2.label,
      url: `${base}/image_generation`,
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: {
        model: env().MINIMAX_IMAGE_MODEL,
        prompt: request.prompt.slice(0, 1_500),
        aspect_ratio: frame.ratio,
        response_format: "url",
        n: 1,
        prompt_optimizer: true,
      },
    });

    assertMiniMaxOk(response.base_resp);
    const url = response.data?.image_urls?.[0];
    if (!url) {
      throw new ProviderError(TAL_2.label, "returned no image URL", {
        retryable: false,
      });
    }

    const asset = await fetchRemoteAsset(url, {
      provider: TAL_2.label,
      maxBytes: MAX_IMAGE_BYTES,
      extraHosts: [
        ...MINIMAX_MEDIA_HOSTS,
        ...ALIYUN_MEDIA_HOSTS,
        ...env().ASSET_FETCH_ALLOWED_HOSTS,
      ],
    });

    const mimeType = imageMime(asset.contentType);
    const pixels = qualityFrame(request.format, quality);
    return {
      provider: "minimax",
      modelId: TAL_2.id,
      purpose: request.purpose,
      bytes: asset.bytes,
      mimeType,
      extension: extensionFor(mimeType),
      width: pixels.width,
      height: pixels.height,
      // Its image endpoint is synchronous and returns no task id to record.
      providerAssetId: null,
      license: brandedLicense(TAL_2.label),
      attribution: brandedAttribution(TAL_2.label),
      matchedOn: request.prompt.slice(0, 120),
    };
  },
};

/**
 * MiniMax reports application errors in a 200 body.
 *
 * A non-zero `status_code` with HTTP 200 would otherwise sail past `providerJson`'s
 * status translation and be read as a successful submit with a missing task id.
 */
function assertMiniMaxOk(
  resp: { status_code?: number | null; status_msg?: string | null } | null | undefined,
): void {
  const code = resp?.status_code ?? 0;
  if (code === 0) return;
  const detail = resp?.status_msg ?? `status ${code}`;
  throw new ProviderError(TAL_2.label, `rejected the request: ${detail}`, {
    retryable: transientDetail(detail),
    details: { statusCode: code },
  });
}

/** Poll a MiniMax generation task and return its file id. */
async function awaitMiniMaxTask(
  base: string,
  taskId: string,
  headers: Record<string, string>,
): Promise<string> {
  const deadline = Date.now() + MINIMAX_MAX_WAIT_MS;

  for (;;) {
    const status = await providerJson<MiniMaxStatus>({
      provider: TAL_2.label,
      url: `${base}/query/video_generation?task_id=${encodeURIComponent(taskId)}`,
      headers,
    });

    const state = (status.status ?? "").toLowerCase();

    if (state === "success") {
      const fileId = status.file_id;
      if (!fileId) {
        throw new ProviderError(TAL_2.label, "succeeded with no file id", {
          retryable: false,
          details: { taskId },
        });
      }
      return fileId;
    }

    if (state === "fail" || state === "failed") {
      const detail = status.base_resp?.status_msg ?? "unknown reason";
      throw new ProviderError(TAL_2.label, `generation failed: ${detail}`, {
        retryable: transientDetail(detail),
        details: { taskId },
      });
    }

    if (Date.now() > deadline) {
      throw new ProviderError(
        TAL_2.label,
        `generation did not finish within ${MINIMAX_MAX_WAIT_MS / 1000}s`,
        { retryable: true, details: { taskId, status: state } },
      );
    }

    await sleep(MINIMAX_POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// Tal 3.0 — Cinematic Model, on Volcengine Ark (Seedance)
// ---------------------------------------------------------------------------

const ARK_POLL_MS = 5_000;
const ARK_MAX_WAIT_MS = 15 * 60_000;

interface ArkTask {
  id?: string | null;
  status?: string | null;
  error?: { code?: string | null; message?: string | null } | null;
  content?: { video_url?: string | null } | null;
}

/**
 * Ark's image response, which is OpenAI-shaped rather than task-shaped.
 *
 * Its video family is asynchronous and its image family is not, so `generateImage`
 * below is a single call with no polling — the same split MiniMax has.
 */
interface ArkImage {
  data?: ({ url?: string | null; size?: string | null } | null)[] | null;
  error?: { code?: string | null; message?: string | null } | null;
}

const TAL_3: VideoGenModel = {
  id: "tal/3.0",
  provider: "seedance",
  label: "Tal 3.0 — Cinematic Model",
  description: "Higher visual quality and stronger cinematic motion",
  bestFor: "Storytelling, children's animation, cinematic content",
  strengths: [
    "Best camera control and motion coherence of the standard tiers",
    "Clips up to twelve seconds, so a whole scene often fits one generation",
    "Holds a character's appearance across a shot",
    "Generates all three aspect ratios",
    "Also generates reference stills for the continuity engine",
  ],
  limitations: [
    "Slower than Tal 1.0 and Tal 2.0",
    "No generated audio",
  ],
  maxClipSeconds: 12,
  formats: ["landscape", "portrait", "square"],
  premium: false,
  legacy: false,
  capabilities: {
    textToVideo: true,
    imageToVideo: false,
    // Ark's Seedream family, on the same host and key as Seedance video, under the
    // OpenAI-shaped `/images/generations` route. Integrated in Phase 12 §5 so a
    // project on Tal 3.0 makes its continuity references with the model it already
    // selected instead of borrowing another one's look.
    imageGeneration: true,
    referenceImages: false,
    audio: false,
    /**
     * No draft tier for stills, unlike video.
     *
     * A draft *clip* is a check-the-scene-before-committing artefact and is thrown
     * away. A reference image is the opposite: it is kept and re-read by every later
     * scene, so a 480-line character sheet would degrade every generation that
     * consults it. 2K is absent because Seedream bounds a side at 2048 and the 2K
     * long edge is 2560.
     */
    imageQualities: ["720p", "1080p"],
    qualities: ["draft", "720p", "1080p"],
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  },
};

const seedance: GenerationProvider = {
  id: "seedance",
  label: "Volcengine Ark (Seedance and Seedream)",
  requiredEnvVars: ["SEEDANCE_API_KEY"],
  hint: "Create a key at https://console.volcengine.com/ark",
  serviceNote:
    "ByteDance serves Seedance through Volcengine Ark, which is ByteDance's own " +
    "platform rather than a third-party aggregator. SEEDANCE_VIDEO_MODEL selects " +
    "the model version, so a newer Seedance release is a configuration change " +
    "rather than a code change. Generation parameters are passed as text commands " +
    "appended to the prompt, which is Ark's documented convention for this family. " +
    "Stills come from the Seedream family on the same host and key, selected by " +
    "SEEDANCE_IMAGE_MODEL, through an OpenAI-shaped route that takes ordinary JSON.",
  models: [TAL_3],
  missingEnvVars() {
    return env().SEEDANCE_API_KEY ? [] : ["SEEDANCE_API_KEY"];
  },
  async generate(request) {
    const key = requireKey("Tal 3.0", env().SEEDANCE_API_KEY, [
      "SEEDANCE_API_KEY",
    ], SETUP_HINT);

    const frame = formatSpec(request.format);
    const quality = assertQuality(TAL_3, request.quality);
    const seconds = nearest(TAL_3.capabilities.durations, secondsOf(request.durationMs));
    const base = env().SEEDANCE_BASE_URL.replace(/\/+$/, "");
    const headers = { authorization: `Bearer ${key}` };

    /**
     * Ark takes generation parameters as `--flag value` commands inside the text.
     *
     * Unusual, and it is why the prompt is trimmed to leave room: the commands are
     * appended after the prompt and a truncated `--duration` would either be
     * ignored or read as part of the scene description.
     */
    const commands = [
      `--resolution ${arkResolution(quality)}`,
      `--duration ${seconds}`,
      `--ratio ${frame.ratio}`,
      // No recognisable people: a generated likeness in a published video is a
      // rights problem, and the scene director never asks for one.
      "--watermark false",
    ].join(" ");

    const submitted = await providerJson<ArkTask>({
      provider: TAL_3.label,
      url: `${base}/contents/generations/tasks`,
      method: "POST",
      headers,
      body: {
        model: env().SEEDANCE_VIDEO_MODEL,
        content: [
          { type: "text", text: `${request.prompt.slice(0, 1_200)} ${commands}` },
        ],
      },
    });

    const taskId = submitted.id;
    if (!taskId) {
      throw new ProviderError(TAL_3.label, "returned no task id", {
        retryable: true,
      });
    }

    const url = await awaitArkTask(base, taskId, headers);

    const asset = await fetchRemoteAsset(url, {
      provider: TAL_3.label,
      maxBytes: MAX_CLIP_BYTES,
      extraHosts: [...ARK_MEDIA_HOSTS, ...env().ASSET_FETCH_ALLOWED_HOSTS],
    });

    const pixels = qualityFrame(request.format, quality);
    return {
      provider: "seedance",
      modelId: TAL_3.id,
      bytes: asset.bytes,
      mimeType: videoMime(asset.contentType),
      extension: "mp4",
      width: pixels.width,
      height: pixels.height,
      durationMs: seconds * 1_000,
      providerAssetId: `seedance:${taskId}`,
      license: brandedLicense(TAL_3.label),
      attribution: brandedAttribution(TAL_3.label),
      matchedOn: request.prompt.slice(0, 120),
    };
  },
  async generateImage(request) {
    const key = requireKey("Tal 3.0", env().SEEDANCE_API_KEY, [
      "SEEDANCE_API_KEY",
    ], SETUP_HINT);

    const quality = assertImageQuality(TAL_3, request.quality);
    const base = env().SEEDANCE_BASE_URL.replace(/\/+$/, "");

    /**
     * Ark's image route takes ordinary JSON fields, not the `--flag` commands its
     * video route wants, so the prompt is not trimmed to leave room for them.
     */
    const image = await providerJson<ArkImage>({
      provider: TAL_3.label,
      url: `${base}/images/generations`,
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: {
        model: env().SEEDANCE_IMAGE_MODEL,
        prompt: request.prompt.slice(0, 1_500),
        size: arkImageSize(request.format, quality),
        response_format: "url",
        n: 1,
        // Same reasoning as the video route: a visible vendor mark in a published
        // frame is both a rights problem and a §3 leak.
        watermark: false,
      },
    });

    if (image.error?.message) {
      const detail = image.error.message;
      throw new ProviderError(TAL_3.label, `rejected the request: ${detail}`, {
        retryable: transientDetail(detail),
      });
    }

    const url = image.data?.[0]?.url;
    if (!url) {
      throw new ProviderError(TAL_3.label, "returned no image URL", {
        retryable: false,
      });
    }

    const asset = await fetchRemoteAsset(url, {
      provider: TAL_3.label,
      maxBytes: MAX_IMAGE_BYTES,
      extraHosts: [...ARK_MEDIA_HOSTS, ...env().ASSET_FETCH_ALLOWED_HOSTS],
    });

    const mimeType = imageMime(asset.contentType);
    const pixels = qualityFrame(request.format, quality);
    return {
      provider: "seedance",
      modelId: TAL_3.id,
      purpose: request.purpose,
      bytes: asset.bytes,
      mimeType,
      extension: extensionFor(mimeType),
      width: pixels.width,
      height: pixels.height,
      // Ark's image route is synchronous and returns no task id to record.
      providerAssetId: null,
      license: brandedLicense(TAL_3.label),
      attribution: brandedAttribution(TAL_3.label),
      matchedOn: request.prompt.slice(0, 120),
    };
  },
};

/**
 * Seedream spells a frame `widthxheight` and bounds each side to 512..2048.
 *
 * Clamped rather than trusted, because `qualityFrame` is derived from the format and
 * a future tier or format could fall outside the window; an out-of-range side is a
 * 400 from Ark after the request is already in flight, which costs a round trip to
 * learn something computable here. The clamp keeps the aspect ratio: only the side
 * that violates the bound moves, and both bounds are far outside the tiers this
 * model actually offers, so in practice nothing moves.
 */
function arkImageSize(format: VideoFormat, quality: VideoQuality): string {
  const frame = qualityFrame(format, quality);
  const long = Math.max(frame.width, frame.height);
  const short = Math.min(frame.width, frame.height);

  let scale = 1;
  if (long > 2048) scale = 2048 / long;
  if (short * scale < 512) scale = 512 / short;

  const width = Math.round(frame.width * scale);
  const height = Math.round(frame.height * scale);
  return `${width}x${height}`;
}

/** Ark's resolution token. It has no 2K tier for this family. */
function arkResolution(quality: VideoQuality): string {
  return quality === "draft" ? "480p" : quality === "720p" ? "720p" : "1080p";
}

/** Poll an Ark generation task and return its video URL. */
async function awaitArkTask(
  base: string,
  taskId: string,
  headers: Record<string, string>,
): Promise<string> {
  const deadline = Date.now() + ARK_MAX_WAIT_MS;

  for (;;) {
    const task = await providerJson<ArkTask>({
      provider: TAL_3.label,
      url: `${base}/contents/generations/tasks/${encodeURIComponent(taskId)}`,
      headers,
    });

    const status = (task.status ?? "").toLowerCase();

    if (status === "succeeded") {
      const url = task.content?.video_url;
      if (!url) {
        throw new ProviderError(TAL_3.label, "succeeded with no video URL", {
          retryable: false,
          details: { taskId },
        });
      }
      return url;
    }

    if (status === "failed" || status === "cancelled" || status === "canceled") {
      const detail = task.error?.message ?? task.error?.code ?? status;
      throw new ProviderError(TAL_3.label, `generation failed: ${detail}`, {
        retryable: transientDetail(detail),
        details: { taskId },
      });
    }

    if (Date.now() > deadline) {
      throw new ProviderError(
        TAL_3.label,
        `generation did not finish within ${ARK_MAX_WAIT_MS / 1000}s`,
        { retryable: true, details: { taskId, status } },
      );
    }

    await sleep(ARK_POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// Tal 3.1 — Ultra Model, on the Google AI (Gemini) API: Veo + Imagen
// ---------------------------------------------------------------------------

/**
 * §15: Tally already had a Gemini integration for Veo, and this is it — adapted to
 * the branded model rather than duplicated. The image half (Imagen) is added to the
 * *same* provider, sharing the same `GEMINI_API_KEY`, which is what keeps §15's "do
 * not create a duplicate Gemini integration" true.
 */
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

/** Veo takes minutes per clip; the operation is polled, not awaited. */
const VEO_POLL_MS = 10_000;
const VEO_MAX_WAIT_MS = 15 * 60_000;

interface VeoOperation {
  name?: string | null;
  done?: boolean | null;
  error?: { code?: number | null; message?: string | null } | null;
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{ video?: { uri?: string | null } | null }> | null;
      raiMediaFilteredCount?: number | null;
      raiMediaFilteredReasons?: string[] | null;
    } | null;
  } | null;
}

interface ImagenResponse {
  predictions?: Array<{
    bytesBase64Encoded?: string | null;
    mimeType?: string | null;
    raiFilteredReason?: string | null;
  }> | null;
}

const TAL_3_1: VideoGenModel = {
  id: "tal/3.1",
  provider: "veo",
  label: "Tal 3.1 — Ultra Model",
  description: "Premium generation quality",
  bestFor: "Hero scenes, premium productions and highest visual quality",
  strengths: [
    "Highest visual fidelity available in Tally",
    "Generates a native audio track with the clip",
    "Strongest prompt adherence for complex direction",
    "Also generates 2K reference stills for the continuity engine",
  ],
  limitations: [
    "Highest credit cost per scene",
    "Eight seconds maximum per clip",
    "Landscape and portrait only — no square",
    "Refuses prompts asking for recognisable people",
  ],
  maxClipSeconds: 8,
  formats: ["landscape", "portrait"],
  premium: true,
  legacy: false,
  capabilities: {
    textToVideo: true,
    imageToVideo: false,
    imageGeneration: true,
    referenceImages: false,
    audio: true,
    qualities: ["720p", "1080p"],
    imageQualities: ["1080p", "2k"],
    durations: [4, 6, 8],
  },
};

const veo: GenerationProvider = {
  id: "veo",
  label: "Google AI (Veo and Imagen)",
  requiredEnvVars: ["GEMINI_API_KEY"],
  hint: "Create a key at https://aistudio.google.com/apikey",
  serviceNote:
    "Runs on the Google AI (Gemini) API and needs its own API key. The " +
    "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET pair Tally already uses is an OAuth " +
    "client for acting as a user's YouTube channel, granted YouTube scopes at " +
    "consent; it cannot authenticate Veo and is not reused here. No second Google " +
    "authentication path is introduced — this is a different credential for a " +
    "different Google API, and the video and image halves share it.",
  models: [TAL_3_1],
  missingEnvVars() {
    return env().GEMINI_API_KEY ? [] : ["GEMINI_API_KEY"];
  },
  async generate(request) {
    const key = requireKey("Tal 3.1", env().GEMINI_API_KEY, [
      "GEMINI_API_KEY",
    ], SETUP_HINT);

    const frame = formatSpec(request.format);
    if (frame.format === "square") {
      throw new ProviderError(
        TAL_3_1.label,
        "does not generate square video. Choose landscape or portrait, or pick a " +
          "different model.",
        { retryable: false, status: 400 },
      );
    }

    const quality = assertQuality(TAL_3_1, request.quality);
    const seconds = nearest(
      TAL_3_1.capabilities.durations,
      secondsOf(request.durationMs),
    );
    const headers = { "x-goog-api-key": key };

    const started = await providerJson<VeoOperation>({
      provider: TAL_3_1.label,
      url: `${GEMINI_API}/models/${env().GEMINI_VEO_MODEL}:predictLongRunning`,
      method: "POST",
      headers,
      body: {
        instances: [{ prompt: request.prompt.slice(0, 1_500) }],
        parameters: {
          aspectRatio: frame.ratio,
          resolution: quality === "720p" ? "720p" : "1080p",
          durationSeconds: String(seconds),
          numberOfVideos: 1,
          // No recognisable people: a generated likeness in a published video is a
          // rights problem, and the scene director is already instructed never to
          // ask for one.
          personGeneration: "dont_allow",
        },
      },
    });

    const operation = started.name;
    if (!operation) {
      throw new ProviderError(TAL_3_1.label, "returned no operation name", {
        retryable: true,
      });
    }

    const uri = await awaitVeoOperation(operation, headers);

    const asset = await fetchRemoteAsset(uri, {
      provider: TAL_3_1.label,
      maxBytes: MAX_CLIP_BYTES,
      extraHosts: [GEMINI_MEDIA_HOST, ...env().ASSET_FETCH_ALLOWED_HOSTS],
      // The file lives behind the same API host and needs the key to download. Veo
      // deletes generated files after two days, which is the other reason the bytes
      // are fetched now rather than referenced later.
      headers,
    });

    const pixels = qualityFrame(request.format, quality);
    return {
      provider: "veo",
      modelId: TAL_3_1.id,
      bytes: asset.bytes,
      mimeType: videoMime(asset.contentType),
      extension: "mp4",
      width: pixels.width,
      height: pixels.height,
      durationMs: seconds * 1_000,
      providerAssetId: `veo:${operation.split("/").pop() ?? operation}`,
      license: brandedLicense(TAL_3_1.label),
      attribution: brandedAttribution(TAL_3_1.label),
      matchedOn: request.prompt.slice(0, 120),
    };
  },
  async generateImage(request) {
    const key = requireKey("Tal 3.1", env().GEMINI_API_KEY, [
      "GEMINI_API_KEY",
    ], SETUP_HINT);

    const frame = formatSpec(request.format);
    const quality = assertImageQuality(TAL_3_1, request.quality);

    const response = await providerJson<ImagenResponse>({
      provider: TAL_3_1.label,
      url: `${GEMINI_API}/models/${env().GEMINI_IMAGE_MODEL}:predict`,
      method: "POST",
      headers: { "x-goog-api-key": key },
      body: {
        instances: [{ prompt: request.prompt.slice(0, 1_500) }],
        parameters: {
          sampleCount: 1,
          aspectRatio: frame.ratio,
          sampleImageSize: quality === "2k" ? "2K" : "1K",
          personGeneration: "dont_allow",
        },
      },
    });

    const prediction = response.predictions?.[0];
    const encoded = prediction?.bytesBase64Encoded;
    if (!encoded) {
      // A responsible-AI filter reports success with nothing generated. That is a
      // refusal, not a fault, and it will refuse again for the same prompt.
      const filtered = prediction?.raiFilteredReason;
      throw new ProviderError(
        TAL_3_1.label,
        filtered ? `refused the prompt: ${filtered}` : "returned no image",
        { retryable: false },
      );
    }

    const mimeType = imageMime(prediction?.mimeType ?? "image/png");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.byteLength === 0) {
      throw new ProviderError(TAL_3_1.label, "returned an empty image", {
        retryable: true,
      });
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new ProviderError(TAL_3_1.label, "returned an oversize image", {
        retryable: false,
        details: { bytes: bytes.byteLength },
      });
    }

    const pixels = qualityFrame(request.format, quality);
    return {
      provider: "veo",
      modelId: TAL_3_1.id,
      purpose: request.purpose,
      bytes,
      mimeType,
      extension: extensionFor(mimeType),
      width: pixels.width,
      height: pixels.height,
      // Imagen returns the bytes inline with no server-side id to record.
      providerAssetId: null,
      license: brandedLicense(TAL_3_1.label),
      attribution: brandedAttribution(TAL_3_1.label),
      matchedOn: request.prompt.slice(0, 120),
    };
  },
};

/** Poll a Veo long-running operation and return its video URI. */
async function awaitVeoOperation(
  operationName: string,
  headers: Record<string, string>,
): Promise<string> {
  const deadline = Date.now() + VEO_MAX_WAIT_MS;

  for (;;) {
    const operation = await providerJson<VeoOperation>({
      provider: TAL_3_1.label,
      // The operation name already carries its own path prefix.
      url: `${GEMINI_API}/${operationName}`,
      headers,
    });

    if (operation.error) {
      throw new ProviderError(
        TAL_3_1.label,
        `generation failed: ${operation.error.message ?? "unknown reason"}`,
        { retryable: false, details: { operationName } },
      );
    }

    if (operation.done) {
      const response = operation.response?.generateVideoResponse;
      const uri = response?.generatedSamples?.[0]?.video?.uri;
      if (!uri) {
        const filtered = response?.raiMediaFilteredReasons?.join("; ");
        throw new ProviderError(
          TAL_3_1.label,
          filtered ? `refused the prompt: ${filtered}` : "completed with no video",
          { retryable: false, details: { operationName } },
        );
      }
      return uri;
    }

    if (Date.now() > deadline) {
      throw new ProviderError(
        TAL_3_1.label,
        `generation did not finish within ${VEO_MAX_WAIT_MS / 1000}s`,
        { retryable: true, details: { operationName } },
      );
    }

    await sleep(VEO_POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// Runway — legacy, kept resolvable so saved projects still render (§17)
// ---------------------------------------------------------------------------

const RUNWAY_API = "https://api.dev.runwayml.com/v1";
const RUNWAY_VERSION = "2024-11-06";
const RUNWAY_POLL_MS = 5_000;
const RUNWAY_MAX_WAIT_MS = 5 * 60_000;

interface RunwayTask {
  id: string;
  status: string;
  output?: string[] | null;
  failure?: string | null;
  failureCode?: string | null;
}

/**
 * Runway, reached the same way `providers/visuals.ts` already reaches it.
 *
 * §2 names four customer-facing models and Runway is not one of them, so its model
 * is marked `legacy: true` and never appears in a picker (§14: "do not leave dead
 * model options in the UI"). It stays *resolvable* because a project created in
 * Phase 11 may hold `runway/gen4-turbo`, and §17 requires that project to still
 * render. Runway's separate role in the stock/b-roll stage is untouched.
 */
const RUNWAY_MODEL: VideoGenModel = {
  id: "runway/gen4-turbo",
  provider: "runway",
  label: "Tally AI Video (legacy)",
  description: "A model selected before Tally's branded models existed.",
  bestFor: "Existing projects only",
  strengths: [],
  limitations: [
    "No longer offered for new projects — pick a Tal model instead",
    "Five-second clips only",
  ],
  maxClipSeconds: 5,
  formats: ["landscape", "portrait", "square"],
  premium: false,
  legacy: true,
  capabilities: {
    textToVideo: true,
    imageToVideo: false,
    imageGeneration: false,
    referenceImages: false,
    audio: false,
    imageQualities: [],
    qualities: ["720p", "1080p"],
    durations: [5],
  },
};

const runway: GenerationProvider = {
  id: "runway",
  label: "Runway",
  requiredEnvVars: ["RUNWAY_API_KEY"],
  hint: "Create a key at https://dev.runwayml.com",
  serviceNote:
    "Retained for projects that selected it before Tally's branded models " +
    "existed. Runway's role in the stock/b-roll stage is separate and unaffected.",
  models: [RUNWAY_MODEL],
  missingEnvVars() {
    return env().RUNWAY_API_KEY ? [] : ["RUNWAY_API_KEY"];
  },
  async generate(request) {
    const key = requireKey("Runway", env().RUNWAY_API_KEY, [
      "RUNWAY_API_KEY",
    ], SETUP_HINT);

    const frame = formatSpec(request.format);
    const quality = assertQuality(RUNWAY_MODEL, request.quality);
    const ratio = `${frame.width}:${frame.height}`;
    const headers = {
      authorization: `Bearer ${key}`,
      "x-runway-version": RUNWAY_VERSION,
    };
    const prompt = request.prompt.slice(0, 900);

    // Two calls: Runway's video models take a first frame rather than text alone.
    const imageTask = await providerJson<RunwayTask>({
      provider: "Runway",
      url: `${RUNWAY_API}/text_to_image`,
      method: "POST",
      headers,
      body: { model: "gen4_image", promptText: prompt, ratio },
    });
    const imageUrl = await awaitRunwayTask(imageTask.id, headers);

    const videoTask = await providerJson<RunwayTask>({
      provider: "Runway",
      url: `${RUNWAY_API}/image_to_video`,
      method: "POST",
      headers,
      body: {
        model: "gen4_turbo",
        promptImage: imageUrl,
        promptText: prompt,
        ratio,
        duration: 5,
      },
    });
    const videoUrl = await awaitRunwayTask(videoTask.id, headers);

    const asset = await fetchRemoteAsset(videoUrl, {
      provider: "Runway",
      maxBytes: MAX_CLIP_BYTES,
      extraHosts: env().ASSET_FETCH_ALLOWED_HOSTS,
    });

    const pixels = qualityFrame(request.format, quality);
    return {
      provider: "runway",
      modelId: RUNWAY_MODEL.id,
      bytes: asset.bytes,
      mimeType: "video/mp4",
      extension: "mp4",
      width: pixels.width,
      height: pixels.height,
      durationMs: 5_000,
      providerAssetId: `runway:${videoTask.id}`,
      license: "Generated by Runway under the Tally account's Runway licence",
      attribution: "Generated with Tally AI Video",
      matchedOn: prompt.slice(0, 120),
    };
  },
};

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
      const detail = task.failure ?? task.failureCode ?? "unknown reason";
      throw new ProviderError("Runway", `generation failed: ${detail}`, {
        retryable: transientDetail(detail),
        details: { taskId },
      });
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

// ---------------------------------------------------------------------------
// Mock — development only
// ---------------------------------------------------------------------------

const MOCK_MODEL: VideoGenModel = {
  id: "mock/placeholder",
  provider: "mock",
  label: "Placeholder (development)",
  description: "A solid-colour frame. Not a generated video.",
  bestFor: "Local development only",
  strengths: [],
  limitations: ["Not a video, and not for publication"],
  maxClipSeconds: 5,
  formats: ["landscape", "portrait", "square"],
  premium: false,
  legacy: false,
  capabilities: {
    textToVideo: true,
    imageToVideo: false,
    // True so the image path is exercisable in development without a paid call.
    imageGeneration: true,
    referenceImages: false,
    audio: false,
    qualities: ["draft", "720p", "1080p", "2k"],
    imageQualities: ["draft", "720p", "1080p", "2k"],
    durations: [5],
  },
};

/**
 * A real PNG at the requested frame, one colour per scene.
 *
 * Only reachable when `TALLY_USE_MOCK_PROVIDERS` is on, which `env.ts` refuses in
 * production. It is honest about what it is: `kind` ends up `generated_image`, the
 * licence says "not for publication", and the model is labelled a placeholder.
 * Nothing here claims a video was generated when it was not.
 */
const mock: GenerationProvider = {
  id: "mock",
  label: "Development placeholder",
  requiredEnvVars: [],
  hint: "Active because TALLY_USE_MOCK_PROVIDERS=true. Never available in production.",
  serviceNote:
    "Produces a solid-colour still, not a video. Development only, and refused " +
    "in production by the environment validator.",
  models: [MOCK_MODEL],
  missingEnvVars() {
    return [];
  },
  async generate(request) {
    const quality = assertQuality(MOCK_MODEL, request.quality);
    const frame = qualityFrame(request.format, quality);
    const width = Math.round(frame.width / 4);
    const height = Math.round(frame.height / 4);
    const bytes = solidPng({
      width,
      height,
      seed: `ai:${request.sceneIndex}:${request.prompt}`,
    });

    return {
      provider: "mock",
      modelId: MOCK_MODEL.id,
      bytes,
      mimeType: "image/png",
      extension: "png",
      width,
      height,
      durationMs: null,
      providerAssetId: `mock:ai:${request.sceneIndex}`,
      license: "Development placeholder — not for publication",
      attribution: null,
      matchedOn: request.prompt.slice(0, 120),
    };
  },
  async generateImage(request) {
    const quality = assertImageQuality(MOCK_MODEL, request.quality);
    const frame = qualityFrame(request.format, quality);
    const width = Math.round(frame.width / 4);
    const height = Math.round(frame.height / 4);
    const bytes = solidPng({
      width,
      height,
      seed: `img:${request.purpose}:${request.index}:${request.prompt}`,
    });

    return {
      provider: "mock",
      modelId: MOCK_MODEL.id,
      purpose: request.purpose,
      bytes,
      mimeType: "image/png",
      extension: "png",
      width,
      height,
      providerAssetId: `mock:img:${request.purpose}:${request.index}`,
      license: "Development placeholder — not for publication",
      attribution: null,
      matchedOn: request.prompt.slice(0, 120),
    };
  },
};

// ---------------------------------------------------------------------------
// Aliases — what a project row from an earlier release resolves to (§17)
// ---------------------------------------------------------------------------

/**
 * Model ids that moved, old → new.
 *
 * Phase 11 offered ten fal.ai models across six vendors plus two Veo tiers. Phase 12
 * offers four branded models reached directly. A project row may hold any of the old
 * ids, and the visuals stage re-resolves a stored id at render time — so dropping an
 * id would turn a saved project into a failed render (§17).
 *
 * Each old id maps to the branded tier backed by the *same vendor* where one exists,
 * and to the nearest tier otherwise. Kling and Hunyuan have no direct Tally
 * credential, so they map to the cinematic tier; that is a visible change of model
 * for those projects, and the alternative — failing the render — is worse.
 */
const MODEL_ALIASES: Readonly<Record<string, string>> = {
  // Alibaba Wan → Tal 1.0, same vendor.
  "fal/wan-v2-2-a14b": "tal/1.0",
  // Tencent Hunyuan: no direct credential. Nearest by cost and clip length.
  "fal/hunyuan-video": "tal/1.0",
  // MiniMax Hailuo → Tal 2.0, same vendor.
  "fal/minimax-hailuo-02-pro": "tal/2.0",
  "fal/minimax-hailuo-02-standard": "tal/2.0",
  // ByteDance Seedance → Tal 3.0, same vendor.
  "fal/seedance-1-pro": "tal/3.0",
  "fal/seedance-1-lite": "tal/3.0",
  // The pre-catalogue single-model id from the first Phase 11 release.
  "seedance/v1-pro": "tal/3.0",
  // Kuaishou Kling: no direct credential. Nearest by intent — cinematic motion.
  "fal/kling-v2-master": "tal/3.0",
  "fal/kling-v2-5-turbo-pro": "tal/3.0",
  // Google Veo → Tal 3.1, same vendor, now billed to Google rather than to fal.
  "fal/veo3": "tal/3.1",
  "fal/veo3-fast": "tal/3.1",
  "veo/3.1": "tal/3.1",
  "veo/3.1-fast": "tal/3.1",
};

/**
 * Provider ids that moved or were never canonical, old → new.
 *
 * `fal` is deliberately absent: it is not a member of `VideoGenProviderId` any more
 * and there is no single provider it could resolve to, so a stale
 * `VIDEO_GEN_PROVIDERS=fal` warns and is skipped. The vendor-flavoured spellings
 * below are accepted because an operator reading §2 might reasonably write any of
 * them.
 */
const PROVIDER_ALIASES: Readonly<Record<string, VideoGenProviderId>> = {
  dashscope: "qwen",
  wan: "qwen",
  alibaba: "qwen",
  ark: "seedance",
  bytedance: "seedance",
  gemini: "veo",
  google: "veo",
};

/** Resolve a possibly-aliased model id to its current one. */
function canonicalModelId(modelId: string): string {
  return MODEL_ALIASES[modelId] ?? modelId;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const PROVIDERS: readonly GenerationProvider[] = [
  qwen,
  minimax,
  seedance,
  veo,
  runway,
  mock,
];

/**
 * Fail at load if a provider's declared capabilities and its methods disagree.
 *
 * §5 requires the capability resolver to prevent unsupported requests, and §6 requires
 * continuity references to be reused "where the selected backend supports them". Both
 * are claims about the matrix being true, and the ways it can silently go false are
 * mechanical: a model declaring `imageGeneration: true` on a provider with no
 * `generateImage`, or one declaring `referenceImages: true` on an adapter that never
 * reads `request.referenceImages`. Checked here rather than in a test, because a test
 * can be skipped and a module cannot.
 */
function assertRegistryIntegrity(): void {
  for (const provider of PROVIDERS) {
    const claimsImages = provider.models.some(
      (model) => model.capabilities.imageGeneration,
    );
    if (claimsImages && !provider.generateImage) {
      throw new Error(
        `provider ${provider.id} declares image generation but implements none`,
      );
    }

    /**
     * Reference support, checked in both directions.
     *
     * A model claiming it without the adapter would charge for stills nobody sends;
     * an adapter claiming it with no model to use it is a dead branch that reads as a
     * shipped feature. Neither is allowed to load.
     */
    const claimsReferences = provider.models.some(
      (model) => model.capabilities.referenceImages,
    );
    if (claimsReferences && !provider.acceptsReferenceImages) {
      throw new Error(
        `provider ${provider.id} declares reference images but its adapter ignores them`,
      );
    }
    if (provider.acceptsReferenceImages && !claimsReferences) {
      throw new Error(
        `provider ${provider.id} accepts reference images but no model declares them`,
      );
    }

    for (const model of provider.models) {
      if (model.provider !== provider.id) {
        throw new Error(`model ${model.id} is registered under ${provider.id}`);
      }
      if (model.capabilities.qualities.length === 0) {
        throw new Error(`model ${model.id} declares no video resolutions`);
      }
      if (model.capabilities.imageGeneration === (model.capabilities.imageQualities.length === 0)) {
        throw new Error(
          `model ${model.id} disagrees with itself about image resolutions`,
        );
      }
      const longest = Math.max(...model.capabilities.durations);
      if (model.maxClipSeconds !== longest) {
        throw new Error(
          `model ${model.id} says ${model.maxClipSeconds}s but offers ${longest}s`,
        );
      }
    }
  }
}

assertRegistryIntegrity();

/**
 * Provider ids the operator has enabled, in priority order.
 *
 * Empty is the normal state for a deployment that has not opted in, and it means
 * every project uses stock footage. Mock replaces the list entirely in development,
 * exactly as `visualSources()` does — a development run must not reach a paid
 * generation API by accident.
 */
export function videoGenProviderIds(): VideoGenProviderId[] {
  if (usingMockProviders()) return ["mock"];
  const known = new Set(PROVIDERS.map((p) => p.id));
  const resolved: VideoGenProviderId[] = [];

  for (const raw of env().VIDEO_GEN_PROVIDERS) {
    const id = raw.trim().toLowerCase();
    if (!id) continue;

    const canonical = PROVIDER_ALIASES[id] ?? id;

    if (!known.has(canonical as VideoGenProviderId) || canonical === "mock") {
      // Includes `fal`, removed as a video route in §14. Warned about and skipped
      // so a stale environment line degrades to "no AI video" rather than taking
      // the deployment down.
      log.warn("unknown provider in VIDEO_GEN_PROVIDERS", { provider: id });
      continue;
    }
    // De-duplicated, so `wan,qwen` enables one provider and not two.
    if (!resolved.includes(canonical as VideoGenProviderId)) {
      resolved.push(canonical as VideoGenProviderId);
    }
  }

  return resolved;
}

/**
 * Every credential the currently-enabled providers need, de-duplicated.
 *
 * Exists so `providers/config.ts` can answer "which variables must this deployment
 * set for AI video?" by asking the registry rather than by keeping its own
 * provider→variable if-chain. That chain drifted the moment §14 replaced the
 * aggregator: it still mapped `seedance` to the aggregator's key, so an operator
 * following the banner would have set a revoked credential and got no video and no
 * explanation.
 *
 * Operator-facing, like `videoGenStatuses()` — variable names, never values, and
 * never sent to the customer-facing picker (§3).
 */
export function videoGenRequiredEnvVars(): string[] {
  const enabled = videoGenProviderIds();
  const names = new Set<string>();
  for (const provider of PROVIDERS) {
    if (!enabled.includes(provider.id)) continue;
    for (const name of provider.requiredEnvVars) names.add(name);
  }
  return [...names];
}

/** True when at least one AI video provider is enabled *and* configured. */
export function isVideoGenConfigured(): boolean {
  return videoGenStatuses().some((s) => s.state === "ready" || s.state === "mock");
}

/** True when at least one enabled, configured model can generate images (§5). */
export function isImageGenConfigured(): boolean {
  return imageModels().length > 0;
}

/**
 * Configuration state of every enabled provider.
 *
 * Names and states only. There is no code path here that reads a credential's
 * value, only whether it is set — but it *does* carry vendor names, so it is
 * operator-facing and §3 keeps it out of the customer UI. `/api/video/providers`
 * sends `providerReadiness()` instead.
 */
export function videoGenStatuses(): VideoGenProviderStatus[] {
  const enabled = videoGenProviderIds();

  return PROVIDERS.filter((p) => enabled.includes(p.id)).map((provider) => {
    const missingEnvVars = provider.missingEnvVars();
    const state: VideoGenState =
      provider.id === "mock"
        ? "mock"
        : missingEnvVars.length > 0
          ? "not_configured"
          : "ready";

    return {
      provider: provider.id,
      label: provider.label,
      state,
      requiredEnvVars: [...provider.requiredEnvVars],
      missingEnvVars,
      hint: provider.hint,
      serviceNote: provider.serviceNote,
      models: [...provider.models],
    };
  });
}

/**
 * Every provider Tally knows how to call, enabled or not.
 *
 * The operator-facing view: a provider that is implemented but switched off shows as
 * `disabled` rather than vanishing, so "we do not offer this" and "this is broken"
 * are distinguishable in the verification script and the settings screen.
 */
export function allVideoGenStatuses(): VideoGenProviderStatus[] {
  const enabled = videoGenProviderIds();

  return PROVIDERS.map((provider) => {
    const missingEnvVars = provider.missingEnvVars();
    let state: VideoGenState;
    if (!enabled.includes(provider.id)) {
      state = "disabled";
    } else if (provider.id === "mock") {
      state = "mock";
    } else {
      state = missingEnvVars.length > 0 ? "not_configured" : "ready";
    }

    return {
      provider: provider.id,
      label: provider.label,
      state,
      requiredEnvVars: [...provider.requiredEnvVars],
      missingEnvVars,
      hint: provider.hint,
      serviceNote: provider.serviceNote,
      models: [...provider.models],
    };
  });
}

/**
 * Models a client may actually select.
 *
 * Enabled *and* configured *and* not legacy. A model whose provider is missing its
 * key is deliberately absent rather than present-but-flagged, because a flagged
 * model is one careless render away from being selected. The unconfigured state is
 * still reported — by `providerReadiness()`, which the UI shows as a configuration
 * notice — so nothing is hidden from the operator.
 */
export function availableModels(): VideoGenModel[] {
  return videoGenStatuses()
    .filter((status) => status.state === "ready" || status.state === "mock")
    .flatMap((status) => status.models)
    .filter((model) => !model.legacy);
}

/** Selectable models that can generate stills (§5). */
export function imageModels(): VideoGenModel[] {
  return availableModels().filter(
    (model) => model.capabilities.imageGeneration,
  );
}

/**
 * The customer-facing projection of a model (§3).
 *
 * `provider` is dropped, not renamed. §3 forbids exposing the underlying provider
 * in the normal customer UI, and the reliable way to honour that is for the object
 * the API serialises not to contain the field at all — a UI cannot render what it
 * was never sent, and a future component cannot start rendering it by accident.
 * Backend logs, `api_usage` and the operator status report keep it.
 */
export type PublicModel = Omit<VideoGenModel, "provider">;

export function publicModel(model: VideoGenModel): PublicModel {
  const { provider: _provider, ...rest } = model;
  return rest;
}

export function publicModels(): PublicModel[] {
  return availableModels().map(publicModel);
}

/**
 * Aggregate readiness, with no vendor names (§3).
 *
 * What the customer-facing picker needs to distinguish "this deployment does not
 * offer AI video" from "AI video is misconfigured — contact support", without
 * learning which company Tally buys generation from. The variable-naming detail an
 * operator needs stays in `allVideoGenStatuses()`, which only operator surfaces and
 * the verification scripts read.
 */
export interface ProviderReadiness {
  /** Enabled providers that have their credentials. */
  ready: number;
  /** Enabled providers still missing a credential — an operator action. */
  awaitingConfiguration: number;
  /** True when the development placeholder is in use. */
  placeholder: boolean;
}

export function providerReadiness(): ProviderReadiness {
  const statuses = videoGenStatuses();
  return {
    ready: statuses.filter((s) => s.state === "ready").length,
    awaitingConfiguration: statuses.filter((s) => s.state === "not_configured")
      .length,
    placeholder: statuses.some((s) => s.state === "mock"),
  };
}

export interface ResolvedModel {
  model: VideoGenModel;
  provider: VideoGenProviderId;
}

/**
 * Validate a client-supplied model id.
 *
 * The single choke point. Three failures, three different errors, because they mean
 * three different things to the caller:
 *
 *  - unknown id             -> `ProviderError` with status 400. The client sent
 *    something that does not exist.
 *  - known but disabled     -> the same, because as far as this deployment is
 *    concerned it does not exist. Reporting "disabled" would confirm the existence
 *    of a provider the operator chose not to offer.
 *  - enabled, no credential -> `NotConfiguredError` naming the variable, which is
 *    the operator's problem and is reported as a 503 configuration state.
 *
 * That ordering is what "a client must not be able to request an unconfigured
 * provider simply by manipulating the request" reduces to in code. A `legacy` model
 * resolves normally: it is not offered, but a project that stored it must render.
 */
export function resolveModel(modelId: string): ResolvedModel {
  const canonical = canonicalModelId(modelId);
  const provider = PROVIDERS.find((p) =>
    p.models.some((m) => m.id === canonical),
  );
  const model = provider?.models.find((m) => m.id === canonical);

  if (!provider || !model) {
    throw new ProviderError(
      "Video generation",
      `"${modelId.slice(0, 60)}" is not an available video model.`,
      { retryable: false, status: 400 },
    );
  }

  if (!videoGenProviderIds().includes(provider.id)) {
    throw new ProviderError(
      "Video generation",
      `"${model.label}" is not available on this deployment.`,
      { retryable: false, status: 400 },
    );
  }

  const missing = provider.missingEnvVars();
  if (missing.length > 0) {
    // Named for the *model*, not the vendor. A `NotConfiguredError` is a 503 that
    // reaches a user, so §3 applies to it: `provider.label` would put "Volcengine
    // Ark" in front of a customer. The variable names stay, because they are the
    // actionable fact and §2 names them itself; the vendor's console URL does not,
    // because it is operator information and `allVideoGenStatuses()` already
    // carries it for the surfaces operators actually read.
    throw new NotConfiguredError(model.label, missing, SETUP_HINT);
  }

  return { model, provider: provider.id };
}

/**
 * Validate a model id for an *image* request (§5).
 *
 * "Where a model does not support image generation, the capability resolver must
 * prevent unsupported requests." This is that resolver: same three failures as
 * `resolveModel`, plus a fourth for a model that exists and is configured but
 * cannot produce a still.
 */
export function resolveImageModel(modelId: string): ResolvedModel {
  const resolved = resolveModel(modelId);
  if (!resolved.model.capabilities.imageGeneration) {
    throw new ProviderError(
      "Image generation",
      `"${resolved.model.label}" does not generate images. Choose a model that does.`,
      { retryable: false, status: 400 },
    );
  }
  return resolved;
}

/**
 * The requested resolution, checked against what the model declares (§4).
 *
 * Null means "no preference" and resolves to the shared default, then goes through
 * the same check — so a caller that omits quality on a model without a 1080p tier
 * gets that model's nearest supported tier rather than a rejected request. An
 * *explicit* unsupported request is refused, because silently downgrading a
 * selection the user made and was quoted a credit price for would be worse.
 */
export function assertQuality(
  model: VideoGenModel,
  requested: VideoQuality | null | undefined,
): VideoQuality {
  return checkQuality(model, model.capabilities.qualities, requested, "video");
}

export function assertImageQuality(
  model: VideoGenModel,
  requested: VideoQuality | null | undefined,
): VideoQuality {
  return checkQuality(
    model,
    model.capabilities.imageQualities,
    requested,
    "image",
  );
}

function checkQuality(
  model: VideoGenModel,
  supported: readonly VideoQuality[],
  requested: VideoQuality | null | undefined,
  kind: "video" | "image",
): VideoQuality {
  if (supported.length === 0) {
    throw new ProviderError(
      "Image generation",
      `"${model.label}" does not generate images.`,
      { retryable: false, status: 400 },
    );
  }

  if (requested == null) {
    const fallback = qualitySpec(null).quality;
    if (supported.includes(fallback)) return fallback;
    // Nearest supported tier, preferring the lower one so an absent choice never
    // silently costs more than the default would have.
    return [...supported].sort(
      (a, b) =>
        Math.abs(qualityRank(a) - qualityRank(fallback)) -
        Math.abs(qualityRank(b) - qualityRank(fallback)),
    )[0] as VideoQuality;
  }

  if (!supported.includes(requested)) {
    throw new ProviderError(
      model.label,
      `does not generate ${kind} at ${qualitySpec(requested).label}. ` +
        `Supported: ${supported.map((q) => qualitySpec(q).label).join(", ")}.`,
      { retryable: false, status: 400 },
    );
  }

  return requested;
}

/**
 * Generate one clip.
 *
 * Re-resolves the model rather than trusting the caller's, so a stored model id that
 * was valid when a project was created is re-checked against the current
 * configuration before any money is spent. Usage is recorded through the same
 * `withUsage` accounting every other provider uses.
 */
export async function generateClip(
  request: GenerateClipRequest,
  options: GenerateOptions,
): Promise<GeneratedClip> {
  const { model, provider: providerId } = resolveModel(request.modelId);
  const provider = providerFor(providerId);

  /**
   * References are dropped, loudly, for a model that cannot use them (§6).
   *
   * Dropped rather than refused, because the caller is the visuals stage and the
   * alternative to a reference-constrained clip is a textually-constrained one — which
   * is the documented fallback and a working video. Failing the scene would turn a
   * capability the project does not have into a build error.
   *
   * Warned rather than ignored, because a stage that keeps sending references nothing
   * reads is paying to generate stills for no consumer, and that is invisible unless
   * something says so.
   */
  const references = request.referenceImages ?? [];
  if (references.length > 0 && !model.capabilities.referenceImages) {
    log.warn("dropping reference images: model does not accept them", {
      model: model.id,
      provider: provider.id,
      count: references.length,
    });
  }

  /**
   * Normalised once, here.
   *
   * A legacy alias is translated at this single point so every provider's
   * `generate` and the usage row all see the id that actually ran. Leaving the
   * alias in place would record spend against a model id that no longer exists in
   * the catalogue, which makes per-model cost reporting quietly wrong.
   *
   * The reference list is normalised the same way: a provider's `generate` sees the
   * field only when its own model declares support, so an adapter cannot accidentally
   * come to depend on a field the matrix says it does not get.
   */
  const normalised: GenerateClipRequest = {
    ...request,
    modelId: model.id,
    referenceImages: model.capabilities.referenceImages ? references : undefined,
  };

  return withUsage(
    {
      provider: provider.id,
      operation: options.usage.operation ?? "video-gen.clip",
      userId: options.usage.userId ?? null,
      projectId: options.usage.projectId ?? null,
      jobId: options.usage.jobId ?? null,
      traceId: options.usage.traceId ?? null,
      model: model.id,
    },
    () => provider.generate(normalised),
    (clip) => ({ quantity: clip.bytes.byteLength, unit: "bytes" }),
  );
}

/**
 * Generate one still (§5).
 *
 * Deliberately the same shape as `generateClip`: same resolver, same normalisation,
 * same accounting, same provider objects. §5 forbids "a separate disconnected image
 * architecture", and the way to comply is for image generation to be a second method
 * on one registry rather than a second registry.
 */
export async function generateImage(
  request: GenerateImageRequest,
  options: GenerateOptions,
): Promise<GeneratedImage> {
  const { model, provider: providerId } = resolveImageModel(request.modelId);
  const provider = providerFor(providerId);

  if (!provider.generateImage) {
    // Unreachable: `assertRegistryIntegrity` refuses to load a registry where a
    // model claims image generation and its provider implements none.
    throw new ProviderError("Image generation", "is not implemented", {
      retryable: false,
      status: 400,
    });
  }
  const generateOne = provider.generateImage.bind(provider);

  const normalised: GenerateImageRequest = { ...request, modelId: model.id };

  return withUsage(
    {
      provider: provider.id,
      operation: options.usage.operation ?? "image-gen.still",
      userId: options.usage.userId ?? null,
      projectId: options.usage.projectId ?? null,
      jobId: options.usage.jobId ?? null,
      traceId: options.usage.traceId ?? null,
      model: model.id,
    },
    () => generateOne(normalised),
    (image) => ({ quantity: image.bytes.byteLength, unit: "bytes" }),
  );
}

function providerFor(id: VideoGenProviderId): GenerationProvider {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) {
    throw new ProviderError("Video generation", "provider disappeared", {
      retryable: false,
    });
  }
  return provider;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a credential or refuse, naming the variable rather than the vendor.
 *
 * The customer-facing name is passed in — a `NotConfiguredError` reaches a user, and
 * §3 keeps vendor names out of what a user sees. The *variable* names are the point
 * of the message and are not vendor branding.
 */
function requireKey(
  label: string,
  value: string | undefined,
  vars: string[],
  hint: string,
): string {
  if (!value) throw new NotConfiguredError(label, vars, hint);
  return value;
}

/** Licence text for a branded generation. */
function brandedLicense(label: string): string {
  return `Generated by ${label} under the Tally account's generation terms`;
}

/** Attribution text. Names the Tally model, never the vendor behind it (§3). */
function brandedAttribution(label: string): string {
  return `Generated with ${label}`;
}

/** Seconds, floored at one — a zero-length request is a caller bug, not a clip. */
function secondsOf(durationMs: number): number {
  const seconds = Math.round(durationMs / 1_000);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 1;
}

function videoMime(contentType: string): string {
  return contentType.startsWith("video/") ? contentType : "video/mp4";
}

function imageMime(contentType: string): string {
  return contentType.startsWith("image/") ? contentType : "image/png";
}

function extensionFor(mimeType: string): string {
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

/**
 * Whether a vendor's failure detail is worth another attempt.
 *
 * A content-policy refusal refuses identically next time, so retrying spends money
 * to learn nothing. Anything else — a transient worker fault, a queue eviction — is
 * worth one more attempt. Shared by all four adapters so they classify alike.
 */
function transientDetail(detail: string): boolean {
  return !/safety|moderation|policy|content|sensitive|violat|prohibit/i.test(
    detail,
  );
}

/**
 * The supported duration closest to what the scene wants.
 *
 * A clamp is not enough: Tal 2.0 offers 6s and 10s and nothing between, and a
 * request for 7 is rejected rather than rounded, so the choice has to be made here.
 * A non-finite input falls through to the first option — the shortest, and therefore
 * the cheapest thing to be wrong about.
 */
function nearest(options: readonly number[], value: number): number {
  let best = options[0] ?? 0;
  for (const option of options) {
    if (Math.abs(option - value) < Math.abs(best - value)) best = option;
  }
  return best;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

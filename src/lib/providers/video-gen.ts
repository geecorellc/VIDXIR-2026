/**
 * VideoGenerationProvider — one interface, several ways to get a clip
 * (Phase 11 §9-§14).
 *
 * A scene needs a moving image. Before Phase 11 there was exactly one answer:
 * search a stock library, and if that fails ask Runway. §9 makes the answer a
 * user choice — stock footage, or an AI model that generates the shot — and §14
 * requires that adding a fourth or fifth model later does not mean rewriting the
 * workflow. So the shape here is:
 *
 *   mode STOCK    -> the existing `acquireVisual()` path, unchanged
 *   mode AI_VIDEO -> one of the providers in this registry, chosen by model id
 *
 * Four rules this module exists to enforce, all of them from the spec and none of
 * them enforceable in the UI:
 *
 *  1. **The server decides what exists** (§10). `availableModels()` is computed
 *     from `VIDEO_GEN_PROVIDERS` plus the credential check. A model absent from
 *     that list cannot be selected by any request, however the request is
 *     manipulated — `resolveModel()` throws for anything it does not recognise.
 *  2. **No fabricated APIs** (§11, §12). Seedance is reached through fal.ai's
 *     documented queue API; Veo through Google's documented
 *     `predictLongRunning` + operation-polling endpoints. Where a service
 *     requirement exists rather than a direct public API — ByteDance publishes no
 *     first-party Seedance API Tally can integrate against — that is recorded in
 *     the provider's own `serviceNote` rather than papered over.
 *  3. **Unconfigured means unavailable, never fake** (§42). A provider whose key
 *     is unset reports `not_configured` and generation throws
 *     `NotConfiguredError`. There is no placeholder clip and no silent fallback to
 *     stock: falling back would mean a user who paid for AI video got stock
 *     footage and was told it was AI video.
 *  4. **No keys leave the server.** `availableModels()` returns names, labels and
 *     states. Every credential read happens inside a generate call.
 *
 * A generated clip is short — Seedance tops out at 12 seconds, Veo at 8 — and a
 * scene is often longer. That is expected and handled elsewhere: §17 leaves final
 * assembly to the existing FFmpeg pipeline, which holds or loops a clip to fill
 * its slot. Nothing here tries to generate a whole video.
 */
import { env, usingMockProviders } from "@/lib/env";
import { NotConfiguredError, ProviderError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { solidPng } from "@/lib/media/synthetic";
import { fetchRemoteAsset } from "@/lib/providers/fetch";
import { providerJson } from "@/lib/providers/http";
import { withUsage, type UsageContext } from "@/lib/providers/usage";
import { formatSpec, type VideoFormat } from "@/lib/video/format";

const log = logger.child({ component: "video-gen" });

/**
 * How the visuals for a project are produced (§9).
 *
 * Two modes are the stated minimum. `STOCK` is the existing behaviour and the
 * default, so a project that never touches Phase 11 is in `STOCK` mode and the
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
 * Provider ids that can serve `AI_VIDEO`.
 *
 * `fal` is one provider hosting many models — Seedance, Kling, MiniMax, Hunyuan,
 * Wan and Google's own Veo among them — because that is what it actually is: a
 * single queue API and a single credential, distinguished only by the model slug
 * in the URL. Giving each model its own provider id would mean four copies of the
 * same submit-poll-fetch code and four identical credential checks (§14).
 *
 * `seedance` is retained as a deprecated alias of `fal` so an existing deployment
 * with `VIDEO_GEN_PROVIDERS=seedance` and a project holding `seedance/v1-pro`
 * keeps working. See `PROVIDER_ALIASES` and `MODEL_ALIASES`.
 */
export type VideoGenProviderId = "fal" | "veo" | "runway" | "mock";

/** Configuration state of one provider, mirroring `providers/config.ts`. */
export type VideoGenState = "ready" | "mock" | "not_configured" | "disabled";

export interface VideoGenModel {
  /** Stable id the client sends back. Namespaced by provider. */
  id: string;
  provider: VideoGenProviderId;
  label: string;
  /** One line the picker shows under the label. */
  description: string;
  /** Longest clip this model produces, in seconds. */
  maxClipSeconds: number;
  /** Formats the model can generate natively. */
  formats: readonly VideoFormat[];
  /**
   * True when this model costs materially more than the others, so it can be
   * gated behind the `premiumVideoModels` entitlement (§19).
   */
  premium: boolean;
}

export interface VideoGenProviderStatus {
  provider: VideoGenProviderId;
  label: string;
  state: VideoGenState;
  /** Env var names only. Never a value (§20). */
  requiredEnvVars: string[];
  missingEnvVars: string[];
  /** Where to get the credential, or what service is required. */
  hint: string;
  /**
   * Stated when the provider depends on a specific third-party service rather
   * than a first-party API (§11). Shown to operators, not hidden in a comment.
   */
  serviceNote: string | null;
  models: VideoGenModel[];
}

export interface GenerateClipRequest {
  /** What the shot should show. The scene's visual direction. */
  prompt: string;
  /** Model id, already validated by `resolveModel`. */
  modelId: string;
  format: VideoFormat;
  /**
   * How long the scene runs. A provider clamps this to what it supports; the
   * renderer fills any remainder (§17).
   */
  durationMs: number;
  sceneIndex: number;
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
  /** Licence statement recorded on the asset row (§29). */
  license: string;
  attribution: string | null;
  /** The prompt that produced it, kept on `assets.meta`. */
  matchedOn: string;
}

export interface GenerateOptions {
  usage: Omit<UsageContext, "provider" | "operation"> & { operation?: string };
}

/**
 * The provider contract (§9).
 *
 * `generate` is the only method that touches a credential. Everything the UI and
 * the authorisation layer need — which models exist, whether they are configured
 * — is answered without one, which is what lets the picker be rendered for a user
 * whose deployment has configured nothing.
 */
interface VideoGenerationProvider {
  id: VideoGenProviderId;
  label: string;
  requiredEnvVars: readonly string[];
  hint: string;
  serviceNote: string | null;
  models: readonly VideoGenModel[];
  /** Env vars from `requiredEnvVars` that are currently unset. */
  missingEnvVars(): string[];
  generate(request: GenerateClipRequest): Promise<GeneratedClip>;
}

// ---------------------------------------------------------------------------
// fal.ai (§11, §14) — one queue API, many models
// ---------------------------------------------------------------------------

const FAL_QUEUE = "https://queue.fal.run";

/** Models generate in seconds; a queue can hold a request for minutes. */
const FAL_POLL_MS = 5_000;
const FAL_MAX_WAIT_MS = 10 * 60_000;

/** One generated clip. A 1080p 12-second clip is tens of megabytes. */
const MAX_CLIP_BYTES = 120 * 1_048_576;

/**
 * fal.ai's media CDN.
 *
 * Named here and passed to `fetchRemoteAsset` as an extra allowed host rather
 * than added to the global `PROVIDER_HOSTS` list, so the SSRF allow-list only
 * widens for the one call that needs it. Both hosts are in use: `fal.media` is
 * the current CDN and `v3.fal.media` the versioned one older endpoints return.
 */
const FAL_MEDIA_HOSTS = ["fal.media", "v3.fal.media"] as const;

interface FalQueueSubmit {
  request_id: string;
  status?: string | null;
  queue_position?: number | null;
}

interface FalQueueStatus {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | string;
  queue_position?: number | null;
  error?: string | null;
  error_type?: string | null;
}

interface FalVideoResult {
  video?: {
    url?: string | null;
    content_type?: string | null;
    file_size?: number | null;
  } | null;
  seed?: number | null;
}

/**
 * One fal.ai-hosted video model.
 *
 * The catalogue below is data, not code, which is the whole point (§5, §14):
 * adding a model fal.ai has published is one entry here, and nothing else in the
 * application changes — not the router, not the plan layer, not the picker.
 *
 * `endpoint` is the fal.ai model slug that goes into the queue URL. `durations`
 * are the clip lengths the endpoint accepts; the scene's requested length is
 * snapped to the nearest one rather than being sent verbatim, because fal.ai
 * rejects an unsupported value instead of clamping it.
 */
interface FalModelSpec extends VideoGenModel {
  /** fal.ai model slug, e.g. `fal-ai/kling-video/v2/master/text-to-video`. */
  endpoint: string;
  /** Clip lengths the endpoint accepts, in seconds. */
  durations: readonly number[];
  /**
   * How this endpoint spells the frame.
   *
   *  - `aspect_ratio` — the reduced ratio, e.g. "16:9". What most take.
   *  - `resolution_only` — no aspect field; the frame follows `resolution`.
   *
   * Stated per model because getting it wrong means either a rejected request or,
   * worse, a silently letterboxed clip.
   */
  frameParam: "aspect_ratio" | "resolution_only";
  /** Sent as `resolution` when the endpoint takes one. */
  resolution: "1080p" | "720p" | "580p" | null;
  /** Sent as `duration`: a string for most endpoints, a number for a few. */
  durationParam: "string" | "number" | "none";
}

/**
 * The fal.ai video catalogue.
 *
 * Every entry is a text-to-video endpoint fal.ai publishes. Ordered roughly by
 * how much they cost, which is also the order the picker shows them in.
 *
 * `premium` marks the models that cost materially more per second and are gated
 * behind the `premiumVideoModels` entitlement (§19). The cheap-and-fast tiers are
 * deliberately non-premium so a Studio-plan user has real choices rather than one.
 *
 * Formats are declared from each model's documented aspect-ratio support. Where a
 * model does not offer 1:1 it is absent from `formats`, so `generationPlanFor`
 * refuses the pairing up front instead of generating a 16:9 clip and cropping the
 * subject out of the shot (§16).
 */
const FAL_MODELS: readonly FalModelSpec[] = [
  {
    id: "fal/seedance-1-pro",
    provider: "fal",
    label: "Seedance 1 Pro",
    description:
      "ByteDance's flagship. Strong camera control and motion coherence, up to 12s.",
    maxClipSeconds: 12,
    formats: ["landscape", "portrait", "square"],
    premium: true,
    endpoint: "fal-ai/bytedance/seedance/v1/pro/text-to-video",
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    frameParam: "aspect_ratio",
    resolution: "1080p",
    durationParam: "string",
  },
  {
    id: "fal/seedance-1-lite",
    provider: "fal",
    label: "Seedance 1 Lite",
    description: "Cheaper, faster Seedance tier. Up to 12s at 720p.",
    maxClipSeconds: 12,
    formats: ["landscape", "portrait", "square"],
    premium: false,
    endpoint: "fal-ai/bytedance/seedance/v1/lite/text-to-video",
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    frameParam: "aspect_ratio",
    resolution: "720p",
    durationParam: "string",
  },
  {
    id: "fal/kling-v2-master",
    provider: "fal",
    label: "Kling 2.1 Master",
    description:
      "Kuaishou's top tier. Cinematic motion and prompt adherence, 5s or 10s.",
    maxClipSeconds: 10,
    formats: ["landscape", "portrait", "square"],
    premium: true,
    endpoint: "fal-ai/kling-video/v2/master/text-to-video",
    durations: [5, 10],
    frameParam: "aspect_ratio",
    resolution: null,
    durationParam: "string",
  },
  {
    id: "fal/kling-v2-5-turbo-pro",
    provider: "fal",
    label: "Kling 2.5 Turbo Pro",
    description: "Newer Kling tier, faster and cheaper than Master. 5s or 10s.",
    maxClipSeconds: 10,
    formats: ["landscape", "portrait", "square"],
    premium: false,
    endpoint: "fal-ai/kling-video/v2.5-turbo/pro/text-to-video",
    durations: [5, 10],
    frameParam: "aspect_ratio",
    resolution: null,
    durationParam: "string",
  },
  {
    id: "fal/minimax-hailuo-02-pro",
    provider: "fal",
    label: "Hailuo 02 Pro (MiniMax)",
    description:
      "MiniMax Hailuo 02. Excellent physics and character motion, 6s at 1080p.",
    maxClipSeconds: 6,
    formats: ["landscape", "portrait"],
    premium: true,
    endpoint: "fal-ai/minimax/hailuo-02/pro/text-to-video",
    durations: [6],
    frameParam: "resolution_only",
    resolution: "1080p",
    durationParam: "none",
  },
  {
    id: "fal/minimax-hailuo-02-standard",
    provider: "fal",
    label: "Hailuo 02 Standard (MiniMax)",
    description: "Standard Hailuo 02 tier. 6s or 10s at 720p.",
    maxClipSeconds: 10,
    formats: ["landscape", "portrait"],
    premium: false,
    endpoint: "fal-ai/minimax/hailuo-02/standard/text-to-video",
    durations: [6, 10],
    frameParam: "resolution_only",
    resolution: "720p",
    durationParam: "string",
  },
  {
    id: "fal/wan-v2-2-a14b",
    provider: "fal",
    label: "Wan 2.2 A14B",
    description:
      "Alibaba's open Wan 2.2. Good motion at low cost, 5s.",
    maxClipSeconds: 5,
    formats: ["landscape", "portrait", "square"],
    premium: false,
    endpoint: "fal-ai/wan/v2.2-a14b/text-to-video",
    durations: [5],
    frameParam: "aspect_ratio",
    resolution: "720p",
    durationParam: "none",
  },
  {
    id: "fal/hunyuan-video",
    provider: "fal",
    label: "Hunyuan Video",
    description:
      "Tencent's open Hunyuan. Distinctive cinematic look, ~5s clips.",
    maxClipSeconds: 5,
    formats: ["landscape", "portrait"],
    premium: false,
    endpoint: "fal-ai/hunyuan-video",
    durations: [5],
    frameParam: "aspect_ratio",
    resolution: "720p",
    durationParam: "none",
  },
  {
    id: "fal/veo3",
    provider: "fal",
    label: "Veo 3 (via fal.ai)",
    description:
      "Google Veo 3 on fal.ai, billed through fal. Native audio, 4-8s.",
    maxClipSeconds: 8,
    formats: ["landscape", "portrait"],
    premium: true,
    endpoint: "fal-ai/veo3",
    durations: [4, 6, 8],
    frameParam: "aspect_ratio",
    resolution: "1080p",
    durationParam: "string",
  },
  {
    id: "fal/veo3-fast",
    provider: "fal",
    label: "Veo 3 Fast (via fal.ai)",
    description: "Faster, cheaper Veo 3 tier on fal.ai. 4-8s.",
    maxClipSeconds: 8,
    formats: ["landscape", "portrait"],
    premium: false,
    endpoint: "fal-ai/veo3/fast",
    durations: [4, 6, 8],
    frameParam: "aspect_ratio",
    resolution: "1080p",
    durationParam: "string",
  },
];

/**
 * Model ids that moved, old → new.
 *
 * Phase 11 shipped a single-model `seedance` provider whose one id was
 * `seedance/v1-pro`. A project row may already hold that string, and §10 has the
 * visuals stage re-resolve a stored id at render time — so dropping the id would
 * turn a saved project into a failed render. Mapped rather than kept as a
 * duplicate catalogue entry, so the picker shows one Seedance Pro, not two.
 */
const MODEL_ALIASES: Readonly<Record<string, string>> = {
  "seedance/v1-pro": "fal/seedance-1-pro",
};

/**
 * Provider ids that moved, old → new.
 *
 * Same reasoning applied to `VIDEO_GEN_PROVIDERS`: an operator who wrote
 * `seedance` in their environment gets the fal provider rather than a warning and
 * a silently empty model list.
 */
const PROVIDER_ALIASES: Readonly<Record<string, VideoGenProviderId>> = {
  seedance: "fal",
};

/** Resolve a possibly-aliased model id to its current one. */
function canonicalModelId(modelId: string): string {
  return MODEL_ALIASES[modelId] ?? modelId;
}

/**
 * fal.ai — one provider, the whole catalogue above.
 *
 * A single credential and a single code path. `generate` looks the model up, reads
 * its `endpoint` and parameter spelling from the catalogue, and submits; adding a
 * model does not touch this function.
 */
const fal: VideoGenerationProvider = {
  id: "fal",
  label: "fal.ai",
  requiredEnvVars: ["FAL_KEY"],
  hint: "Create a key at https://fal.ai/dashboard/keys",
  serviceNote:
    "fal.ai hosts video models from several vendors — ByteDance (Seedance), " +
    "Kuaishou (Kling), MiniMax (Hailuo), Tencent (Hunyuan), Alibaba (Wan) and " +
    "Google (Veo 3) — behind one queue API and one key. Most of those vendors " +
    "publish no first-party public API that Tally could integrate against, so " +
    "fal.ai is a service requirement for those models rather than an alternative " +
    "to one. Everything is billed to the Tally account's fal.ai balance.",
  models: FAL_MODELS,
  missingEnvVars() {
    return env().FAL_KEY ? [] : ["FAL_KEY"];
  },
  async generate(request) {
    const key = env().FAL_KEY;
    if (!key) {
      throw new NotConfiguredError("fal.ai", ["FAL_KEY"], this.hint);
    }

    const spec = falModel(request.modelId);
    const frame = formatSpec(request.format);
    const seconds = nearest(
      spec.durations,
      Math.round(request.durationMs / 1000),
    );
    const headers = { authorization: `Key ${key}` };
    const label = spec.label;

    /**
     * The request body, assembled from the model's declared spelling.
     *
     * Only fields the endpoint documents are sent: fal.ai rejects unknown input
     * keys on some models rather than ignoring them, so a body built by spreading
     * every possible field would fail on exactly the models it was meant to help.
     */
    const body: Record<string, unknown> = {
      prompt: request.prompt.slice(0, 1_500),
      // A content-policy refusal is a correct outcome surfaced as a permanent
      // error. Disabling the check would move responsibility for a policy
      // violation onto Tally's account.
      enable_safety_checker: true,
    };
    if (spec.frameParam === "aspect_ratio") body["aspect_ratio"] = frame.ratio;
    if (spec.resolution) body["resolution"] = spec.resolution;
    if (spec.durationParam === "string") body["duration"] = String(seconds);
    if (spec.durationParam === "number") body["duration"] = seconds;

    const submitted = await providerJson<FalQueueSubmit>({
      provider: label,
      url: `${FAL_QUEUE}/${spec.endpoint}`,
      method: "POST",
      headers,
      body,
    });

    const requestId = submitted.request_id;
    if (!requestId) {
      throw new ProviderError(label, "queue returned no request id", {
        retryable: true,
      });
    }

    await awaitFalQueue(spec, requestId, headers);

    const result = await providerJson<FalVideoResult>({
      provider: label,
      url: `${FAL_QUEUE}/${spec.endpoint}/requests/${encodeURIComponent(requestId)}`,
      headers,
    });

    const url = result.video?.url;
    if (!url) {
      throw new ProviderError(label, "completed with no video URL", {
        retryable: false,
        details: { requestId },
      });
    }

    const asset = await fetchRemoteAsset(url, {
      provider: label,
      maxBytes: MAX_CLIP_BYTES,
      extraHosts: [...FAL_MEDIA_HOSTS, ...env().ASSET_FETCH_ALLOWED_HOSTS],
    });

    return {
      provider: "fal",
      // The canonical id, so an asset generated from a legacy alias records what
      // actually ran rather than the string the project happened to store.
      modelId: spec.id,
      bytes: asset.bytes,
      mimeType: asset.contentType.startsWith("video/")
        ? asset.contentType
        : "video/mp4",
      extension: "mp4",
      width: frame.width,
      height: frame.height,
      durationMs: seconds * 1000,
      providerAssetId: `fal:${requestId}`,
      license: `Generated by ${label} via fal.ai under the Tally account's fal.ai terms`,
      attribution: `Generated with ${label}`,
      matchedOn: request.prompt.slice(0, 120),
    };
  },
};

/** Look up a fal model by id, accepting a legacy alias. */
function falModel(modelId: string): FalModelSpec {
  const canonical = canonicalModelId(modelId);
  const spec = FAL_MODELS.find((m) => m.id === canonical);
  if (!spec) {
    // Unreachable through `generateClip`, which resolves the model first. Thrown
    // rather than defaulted so a future caller that skips resolution fails loudly
    // instead of silently generating on whichever model happens to be first.
    throw new ProviderError(
      "fal.ai",
      `"${modelId.slice(0, 60)}" is not a known fal.ai model.`,
      { retryable: false, status: 400 },
    );
  }
  return spec;
}

/** Poll a fal.ai queue entry until it completes. */
async function awaitFalQueue(
  spec: FalModelSpec,
  requestId: string,
  headers: Record<string, string>,
): Promise<void> {
  const deadline = Date.now() + FAL_MAX_WAIT_MS;

  for (;;) {
    const status = await providerJson<FalQueueStatus>({
      provider: spec.label,
      url: `${FAL_QUEUE}/${spec.endpoint}/requests/${encodeURIComponent(requestId)}/status`,
      headers,
    });

    if (status.status === "COMPLETED") return;

    if (status.error || status.error_type) {
      const detail = status.error ?? status.error_type ?? "unknown reason";
      throw new ProviderError(spec.label, `generation failed: ${detail}`, {
        // A content-policy refusal refuses identically next time. Anything else
        // — a transient worker fault — is worth one more attempt.
        retryable: !/safety|moderation|policy|content/i.test(detail),
        details: { requestId },
      });
    }

    if (Date.now() > deadline) {
      throw new ProviderError(
        spec.label,
        `generation did not finish within ${FAL_MAX_WAIT_MS / 1000}s`,
        { retryable: true, details: { requestId, status: status.status } },
      );
    }

    await sleep(FAL_POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// Veo 3, via the Google AI (Gemini) API (§12)
// ---------------------------------------------------------------------------

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

/** Veo takes minutes per clip; the operation is polled, not awaited. */
const VEO_POLL_MS = 10_000;
const VEO_MAX_WAIT_MS = 15 * 60_000;

/** Host Veo serves finished files from — same API host, authenticated download. */
const GEMINI_MEDIA_HOST = "generativelanguage.googleapis.com";

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

/** Veo's supported clip lengths, as documented. */
const VEO_DURATIONS = [4, 6, 8] as const;

const veo: VideoGenerationProvider = {
  id: "veo",
  label: "Veo 3.1",
  requiredEnvVars: ["GEMINI_API_KEY"],
  hint: "Create a key at https://aistudio.google.com/apikey",
  serviceNote:
    "Veo runs on the Google AI (Gemini) API and needs its own API key. The " +
    "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET pair Tally already uses is an OAuth " +
    "client for acting as a user's YouTube channel, granted YouTube scopes at " +
    "consent; it cannot authenticate Veo and is not reused here. No second " +
    "Google authentication path is introduced — this is a different credential " +
    "for a different Google API.",
  models: [
    {
      id: "veo/3.1",
      provider: "veo",
      label: "Veo 3.1",
      description:
        "Google's highest-fidelity text-to-video, up to 8s with native audio.",
      maxClipSeconds: 8,
      formats: ["landscape", "portrait"],
      premium: true,
    },
    {
      id: "veo/3.1-fast",
      provider: "veo",
      label: "Veo 3.1 Fast",
      description: "Faster, cheaper Veo tier. Up to 8s, lower fidelity.",
      maxClipSeconds: 8,
      formats: ["landscape", "portrait"],
      premium: false,
    },
  ],
  missingEnvVars() {
    return env().GEMINI_API_KEY ? [] : ["GEMINI_API_KEY"];
  },
  async generate(request) {
    const key = env().GEMINI_API_KEY;
    if (!key) {
      throw new NotConfiguredError("Veo", ["GEMINI_API_KEY"], this.hint);
    }

    const frame = formatSpec(request.format);
    if (frame.format === "square") {
      // Veo generates 16:9 and 9:16 only. Generating landscape and cropping to a
      // square would cut the subject out of the shot, so this is refused with the
      // actual reason rather than silently producing the wrong frame.
      throw new ProviderError(
        "Veo",
        "does not generate square video. Choose landscape or portrait, or use " +
          "stock footage for a square render.",
        { retryable: false, status: 400 },
      );
    }

    const model = modelIdFor(request.modelId);
    const seconds = nearest(VEO_DURATIONS, Math.round(request.durationMs / 1000));
    const headers = { "x-goog-api-key": key };

    const started = await providerJson<VeoOperation>({
      provider: "Veo",
      url: `${GEMINI_API}/models/${model}:predictLongRunning`,
      method: "POST",
      headers,
      body: {
        instances: [{ prompt: request.prompt.slice(0, 1_500) }],
        parameters: {
          aspectRatio: frame.ratio,
          resolution: "1080p",
          durationSeconds: String(seconds),
          numberOfVideos: 1,
          // No recognisable people: a generated likeness in a published video is
          // a rights problem, and the scene director is already instructed never
          // to ask for one.
          personGeneration: "dont_allow",
        },
      },
    });

    const operation = started.name;
    if (!operation) {
      throw new ProviderError("Veo", "returned no operation name", {
        retryable: true,
      });
    }

    const uri = await awaitVeoOperation(operation, headers);

    const asset = await fetchRemoteAsset(uri, {
      provider: "Veo",
      maxBytes: MAX_CLIP_BYTES,
      extraHosts: [GEMINI_MEDIA_HOST, ...env().ASSET_FETCH_ALLOWED_HOSTS],
      // The file lives behind the same API host and needs the key to download.
      // Veo deletes generated files after two days, which is the other reason
      // the bytes are fetched now rather than referenced later.
      headers,
    });

    return {
      provider: "veo",
      modelId: request.modelId,
      bytes: asset.bytes,
      mimeType: asset.contentType.startsWith("video/")
        ? asset.contentType
        : "video/mp4",
      extension: "mp4",
      width: frame.width,
      height: frame.height,
      durationMs: seconds * 1000,
      providerAssetId: `veo:${operation.split("/").pop() ?? operation}`,
      license:
        "Generated by Google Veo under the Tally account's Google AI API terms",
      attribution: "Generated with Veo",
      matchedOn: request.prompt.slice(0, 120),
    };
  },
};

/** Which Veo model id a Tally model id maps to. */
function modelIdFor(tallyModelId: string): string {
  if (tallyModelId === "veo/3.1-fast") return "veo-3.1-fast-generate-preview";
  // The configured default, so a preview rename is a config change rather than a
  // code change.
  return env().GEMINI_VEO_MODEL;
}

/** Poll a Veo long-running operation and return its video URI. */
async function awaitVeoOperation(
  operationName: string,
  headers: Record<string, string>,
): Promise<string> {
  const deadline = Date.now() + VEO_MAX_WAIT_MS;

  for (;;) {
    const operation = await providerJson<VeoOperation>({
      provider: "Veo",
      // The operation name already carries its own path prefix.
      url: `${GEMINI_API}/${operationName}`,
      headers,
    });

    if (operation.error) {
      throw new ProviderError(
        "Veo",
        `generation failed: ${operation.error.message ?? "unknown reason"}`,
        { retryable: false, details: { operationName } },
      );
    }

    if (operation.done) {
      const response = operation.response?.generateVideoResponse;
      const uri = response?.generatedSamples?.[0]?.video?.uri;
      if (!uri) {
        // A responsible-AI filter reports success with nothing generated. That is
        // a refusal, not a fault, and it will refuse again for the same prompt.
        const filtered = response?.raiMediaFilteredReasons?.join("; ");
        throw new ProviderError(
          "Veo",
          filtered
            ? `refused the prompt: ${filtered}`
            : "completed with no video",
          { retryable: false, details: { operationName } },
        );
      }
      return uri;
    }

    if (Date.now() > deadline) {
      throw new ProviderError(
        "Veo",
        `generation did not finish within ${VEO_MAX_WAIT_MS / 1000}s`,
        { retryable: true, details: { operationName } },
      );
    }

    await sleep(VEO_POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// Runway (§13, §14) — already integrated, exposed as a selectable AI model
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
 * Present because §14 asks for extensibility and Runway is the provider that is
 * already configured in this project — including it proves the abstraction is not
 * shaped around one vendor. The two calls (still, then animate) are Runway's own
 * requirement: its video models take a first frame rather than text alone.
 */
const runway: VideoGenerationProvider = {
  id: "runway",
  label: "Runway Gen-4",
  requiredEnvVars: ["RUNWAY_API_KEY"],
  hint: "Create a key at https://dev.runwayml.com",
  serviceNote: null,
  models: [
    {
      id: "runway/gen4-turbo",
      provider: "runway",
      label: "Runway Gen-4 Turbo",
      description: "5s generated clips. Already used by the b-roll stage.",
      maxClipSeconds: 5,
      formats: ["landscape", "portrait", "square"],
      premium: false,
    },
  ],
  missingEnvVars() {
    return env().RUNWAY_API_KEY ? [] : ["RUNWAY_API_KEY"];
  },
  async generate(request) {
    const key = env().RUNWAY_API_KEY;
    if (!key) {
      throw new NotConfiguredError("Runway", ["RUNWAY_API_KEY"], this.hint);
    }

    const frame = formatSpec(request.format);
    const ratio = `${frame.width}:${frame.height}`;
    const headers = {
      authorization: `Bearer ${key}`,
      "x-runway-version": RUNWAY_VERSION,
    };
    const prompt = request.prompt.slice(0, 900);

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

    return {
      provider: "runway",
      modelId: request.modelId,
      bytes: asset.bytes,
      mimeType: "video/mp4",
      extension: "mp4",
      width: frame.width,
      height: frame.height,
      durationMs: 5_000,
      providerAssetId: `runway:${videoTask.id}`,
      license: "Generated by Runway under the Tally account's Runway licence",
      attribution: "Generated with Runway",
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
        retryable: !/safety|moderation|policy/i.test(detail),
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
// Mock (§40) — development only
// ---------------------------------------------------------------------------

/**
 * A real PNG at the requested frame, one colour per scene.
 *
 * Only reachable when `TALLY_USE_MOCK_PROVIDERS` is on, which `env.ts` refuses in
 * production. It is honest about what it is: `kind` ends up `generated_image`, the
 * licence says "not for publication", and the model is labelled a placeholder in
 * the picker. §42 forbids claiming a video was generated when it was not, and
 * this claims nothing.
 */
const mock: VideoGenerationProvider = {
  id: "mock",
  label: "Development placeholder",
  requiredEnvVars: [],
  hint: "Active because TALLY_USE_MOCK_PROVIDERS=true. Never available in production.",
  serviceNote:
    "Produces a solid-colour still, not a video. Development only, and refused " +
    "in production by the environment validator.",
  models: [
    {
      id: "mock/placeholder",
      provider: "mock",
      label: "Placeholder (development)",
      description: "A solid-colour frame. Not a generated video.",
      maxClipSeconds: 5,
      formats: ["landscape", "portrait", "square"],
      premium: false,
    },
  ],
  missingEnvVars() {
    return [];
  },
  async generate(request) {
    const frame = formatSpec(request.format);
    const width = Math.round(frame.width / 4);
    const height = Math.round(frame.height / 4);
    const bytes = solidPng({
      width,
      height,
      seed: `ai:${request.sceneIndex}:${request.prompt}`,
    });

    return {
      provider: "mock",
      modelId: request.modelId,
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
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const PROVIDERS: readonly VideoGenerationProvider[] = [fal, veo, runway, mock];

/**
 * Provider ids the operator has enabled, in priority order.
 *
 * Empty is the normal state for a deployment that has not opted in, and it means
 * link mode offers stock footage only. Mock replaces the list entirely in
 * development, exactly as `visualSources()` does — a development run must not
 * reach a paid generation API by accident.
 */
export function videoGenProviderIds(): VideoGenProviderId[] {
  if (usingMockProviders()) return ["mock"];
  const known = new Set(PROVIDERS.map((p) => p.id));
  const resolved: VideoGenProviderId[] = [];

  for (const raw of env().VIDEO_GEN_PROVIDERS) {
    const id = raw.trim().toLowerCase();
    if (!id) continue;

    // A deprecated name resolves to its replacement rather than warning: an
    // operator who wrote `seedance` before the fal catalogue existed should get
    // the fal provider, not an empty picker.
    const canonical = PROVIDER_ALIASES[id] ?? id;

    if (!known.has(canonical as VideoGenProviderId) || canonical === "mock") {
      log.warn("unknown provider in VIDEO_GEN_PROVIDERS", { provider: id });
      continue;
    }
    // De-duplicated, so `seedance,fal` enables one provider and not two.
    if (!resolved.includes(canonical as VideoGenProviderId)) {
      resolved.push(canonical as VideoGenProviderId);
    }
  }

  return resolved;
}

/** True when at least one AI video provider is enabled *and* configured. */
export function isVideoGenConfigured(): boolean {
  return videoGenStatuses().some((s) => s.state === "ready" || s.state === "mock");
}

/**
 * Configuration state of every enabled provider (§20).
 *
 * Names and states only. Safe to return from an API route: there is no code path
 * here that reads a credential's value, only whether it is set.
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
 * Every provider Tally knows how to call, enabled or not (§20).
 *
 * The operator-facing view: a provider that is implemented but switched off shows
 * as `disabled` rather than vanishing, so "we do not offer this" and "this is
 * broken" are distinguishable in the verification script and the settings screen.
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
 * Models a client may actually select (§10).
 *
 * Enabled *and* configured. A model whose provider is missing its key is
 * deliberately absent from this list rather than present-but-flagged, because a
 * flagged model is one careless render away from being selected. The unconfigured
 * state is still reported — by `providerStatuses()`, which the UI shows as a
 * configuration notice — so nothing is hidden from the operator.
 */
export function availableModels(): VideoGenModel[] {
  return videoGenStatuses()
    .filter((status) => status.state === "ready" || status.state === "mock")
    .flatMap((status) => status.models);
}

export interface ResolvedModel {
  model: VideoGenModel;
  provider: VideoGenProviderId;
}

/**
 * Validate a client-supplied model id (§10, §21).
 *
 * The single choke point. Three failures, three different errors, because they
 * mean three different things to the caller:
 *
 *  - unknown id            -> `ValidationError`-shaped 400 via `ProviderError`
 *    with status 400. The client sent something that does not exist.
 *  - known but disabled    -> the same, because as far as this deployment is
 *    concerned it does not exist. Reporting "disabled" would confirm the
 *    existence of a provider the operator chose not to offer.
 *  - enabled, no credential -> `NotConfiguredError` naming the variable, which is
 *    the operator's problem and is reported as a 503 configuration state.
 *
 * That ordering is what §10's "a client must not be able to request an
 * unconfigured provider simply by manipulating the request" reduces to in code.
 */
export function resolveModel(modelId: string): ResolvedModel {
  // A stored id from an earlier release maps to its current model first, so a
  // project saved against `seedance/v1-pro` resolves instead of failing its render
  // (§10 re-resolves at render time, which is what makes this matter).
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
    throw new NotConfiguredError(provider.label, missing, provider.hint);
  }

  return { model, provider: provider.id };
}

/**
 * Generate one clip.
 *
 * Re-resolves the model rather than trusting the caller's, so a stored model id
 * that was valid when a project was created is re-checked against the current
 * configuration before any money is spent. Usage is recorded through the same
 * `withUsage` accounting every other provider uses.
 */
export async function generateClip(
  request: GenerateClipRequest,
  options: GenerateOptions,
): Promise<GeneratedClip> {
  const { model, provider: providerId } = resolveModel(request.modelId);
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) {
    throw new ProviderError("Video generation", "provider disappeared", {
      retryable: false,
    });
  }

  /**
   * Normalised once, here.
   *
   * A legacy alias is translated at this single point so every provider's
   * `generate` and the usage row all see the id that actually ran. Leaving the
   * alias in place would record spend against a model id that no longer exists in
   * the catalogue, which makes per-model cost reporting quietly wrong.
   */
  const normalised: GenerateClipRequest = { ...request, modelId: model.id };

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The supported duration closest to what the scene wants.
 *
 * A clamp is not enough for the fal.ai catalogue: Kling offers 5s and 10s and
 * nothing between, and a request for 7 is rejected rather than rounded, so the
 * choice has to be made here. A non-finite input falls through to the first
 * option — the shortest, and therefore the cheapest thing to be wrong about.
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

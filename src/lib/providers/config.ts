/**
 * Provider configuration registry (§32, §42, §48).
 *
 * Single source of truth for "is this capability actually available?". Each
 * capability declares the env vars its selected implementation requires. The
 * API exposes the resulting status at GET /api/config/providers, and the UI
 * renders an explicit configuration banner instead of a broken feature.
 *
 * This is what makes §42 structural: code cannot reach a provider without going
 * through a factory that throws NotConfiguredError when credentials are absent,
 * so there is nowhere for a silent fake to hide.
 */
import { bedrockRegion, env, usingMockProviders } from "@/lib/env";
import { hasFfmpeg } from "@/lib/media/ffmpeg";
import { FONT_HINT, hasThumbnailFont } from "@/lib/media/fonts";
import {
  videoGenProviderIds,
  videoGenRequiredEnvVars,
} from "@/lib/providers/video-gen";

export type Capability =
  | "ai"
  | "youtube"
  | "voice"
  | "visuals"
  | "video_gen"
  | "music"
  | "transcription"
  | "render"
  | "thumbnail"
  | "storage"
  | "billing"
  | "email";

export type ConfigState =
  /** Real provider, credentials present. */
  | "ready"
  /** Mock implementation active — development only, never production (§40). */
  | "mock"
  /** Selected implementation is missing credentials. Feature is unavailable. */
  | "not_configured";

export interface CapabilityStatus {
  capability: Capability;
  /** Implementation the configuration selects, e.g. "elevenlabs". */
  provider: string;
  state: ConfigState;
  /** Env vars that must be set for `provider` to work. */
  requiredEnvVars: string[];
  /** Subset of the above that is currently unset. */
  missingEnvVars: string[];
  /** Short label shown in the UI. */
  label: string;
  /** Operator-facing note: where to get the credential. */
  hint?: string;
  /** True when the app can still function usefully without this. */
  optional: boolean;
}

function present(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function missing(names: string[]): string[] {
  return names.filter((n) => !present(n));
}

interface Spec {
  capability: Capability;
  label: string;
  optional: boolean;
  /** Which implementation is selected by configuration. */
  provider: () => string;
  /** Env vars required by the selected implementation. */
  required: (provider: string) => string[];
  /**
   * Non-credential readiness check, for a provider whose requirement is not an
   * env var. The local renderer needs an executable on disk, and reporting
   * "ready" because no variable is missing would be a lie of exactly the kind
   * §42 forbids.
   */
  available?: (provider: string) => boolean;
  /** Shown when `available` returns false. */
  unavailableHint?: string;
  hint?: string | (() => string);
}

const SPECS: Spec[] = [
  {
    capability: "ai",
    label: "AI generation",
    optional: false,
    // Two transports to the same models (§32). Which one is selected decides
    // which credentials are missing, so the banner and the 503 must follow it
    // rather than always naming the first-party key (§48).
    provider: () => (usingMockProviders() ? "mock" : env().AI_PROVIDER),
    required: (p) => {
      if (p === "mock") return [];
      // Region only. AWS credentials resolve asynchronously through the standard
      // chain — an instance role, an SSO cache, a profile — none of which is an
      // env var this registry could check for, and reporting "ready" or
      // "missing" on a guess is what §42 forbids. A credential that is actually
      // absent surfaces as a ProviderAuthError naming the chain.
      if (p === "bedrock") return ["BEDROCK_REGION"];
      return ["ANTHROPIC_API_KEY"];
    },
    // `AWS_REGION` / `AWS_DEFAULT_REGION` satisfy Bedrock without BEDROCK_REGION
    // being set, so the presence check above is not the whole truth on its own.
    available: (p) => (p === "bedrock" ? Boolean(bedrockRegion()) : true),
    unavailableHint:
      "Set BEDROCK_REGION (or AWS_REGION) to a region where your account has " +
      "access to the Claude model in BEDROCK_MODEL.",
    hint: () =>
      env().AI_PROVIDER === "bedrock"
        ? "Bedrock uses the standard AWS credential chain — no key is stored in " +
          "Vidxir AI's configuration. Enable Claude model access in the AWS console."
        : "Create a key at https://console.anthropic.com/settings/keys",
  },
  {
    capability: "youtube",
    label: "YouTube",
    optional: false,
    // YouTube is never mocked for reads/writes against a real channel; the mock
    // switch only affects whether publishing is permitted (see realPublishBlocked).
    provider: () => "google",
    required: () => ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    hint:
      "Google Cloud console -> Credentials -> OAuth 2.0 Client ID (Web). " +
      "Enable YouTube Data API v3 and YouTube Analytics API.",
  },
  {
    capability: "voice",
    label: "Voiceover",
    optional: true,
    provider: () => (usingMockProviders() ? "mock" : env().VOICE_PROVIDER),
    required: (p) => (p === "elevenlabs" ? ["ELEVENLABS_API_KEY"] : []),
    hint: "Create a key at https://elevenlabs.io/app/settings/api-keys",
  },
  {
    capability: "visuals",
    label: "B-roll & visuals",
    optional: true,
    provider: () => {
      if (usingMockProviders()) return "mock";
      const list = env().VISUAL_PROVIDERS;
      return list.length > 0 ? list.join("+") : "mock";
    },
    required: (p) => {
      const names: string[] = [];
      if (p.includes("pexels")) names.push("PEXELS_API_KEY");
      if (p.includes("runway")) names.push("RUNWAY_API_KEY");
      return names;
    },
    hint: "Pexels: https://www.pexels.com/api/new/ · Runway: https://dev.runwayml.com",
  },
  {
    capability: "video_gen",
    label: "AI video generation",
    // Optional, and genuinely so: with no AI provider enabled, link mode and the
    // whole pipeline still work on stock footage, which is what every deployment
    // before Phase 11 did. This capability being unconfigured removes a choice,
    // not a feature (§13).
    optional: true,
    // Registered here rather than in a second registry of its own (§10). The
    // capability answers "can this deployment generate AI video at all?"; which
    // *models* are on offer is `video-gen.ts`'s `availableModels()`, since a
    // per-model catalogue does not fit the one-provider-per-capability shape the
    // rest of this table has.
    provider: () => {
      if (usingMockProviders()) return "mock";
      // The *resolved* ids, not the raw environment line: an alias is reported
      // under the name it resolves to, and an id §14 retired is absent rather than
      // being listed as though this deployment offered it.
      const list = videoGenProviderIds();
      // "stock" is not a provider in the AI sense — it is the absence of one, and
      // saying so is more honest than reporting `not_configured` for a deployment
      // that deliberately offers stock footage only.
      return list.length > 0 ? list.join("+") : "stock";
    },
    /**
     * Asked of the registry rather than matched against the provider string.
     *
     * The previous if-chain mapped `seedance` to `FAL_KEY`, which was true while
     * every model came through the aggregator and became wrong the moment §14
     * replaced it — an operator following this banner would have set a revoked key,
     * got no video, and had nothing to read. Each provider already declares its own
     * `requiredEnvVars`, so deriving the list means the banner cannot drift from
     * what the generation path actually reads.
     */
    required: () => videoGenRequiredEnvVars(),
    hint:
      "Set VIDEO_GEN_PROVIDERS to any of qwen,minimax,seedance,veo,runway — the " +
      "four backends behind Vidxir AI's own video models, plus Runway. Each needs one " +
      "key: DASHSCOPE_API_KEY (https://bailian.console.aliyun.com), " +
      "MINIMAX_API_KEY (https://platform.minimaxi.chat), SEEDANCE_API_KEY " +
      "(https://console.volcengine.com/ark), GEMINI_API_KEY " +
      "(https://aistudio.google.com/apikey — a Google AI key, separate from the " +
      "YouTube OAuth client), RUNWAY_API_KEY. `fal` was retired in Phase 12 and " +
      "enables nothing.",
  },
  {
    capability: "music",
    label: "Music & SFX",
    optional: true,
    provider: () => (usingMockProviders() ? "mock" : env().MUSIC_PROVIDER),
    required: (p) => (p === "freesound" ? ["FREESOUND_API_KEY"] : []),
    hint: "Freesound: https://freesound.org/apiv2/apply/",
  },
  {
    capability: "transcription",
    label: "Captions",
    optional: true,
    provider: () => (usingMockProviders() ? "mock" : env().TRANSCRIPTION_PROVIDER),
    required: (p) => {
      if (p === "openai-whisper") return ["OPENAI_API_KEY"];
      if (p === "deepgram") return ["DEEPGRAM_API_KEY"];
      return [];
    },
  },
  {
    capability: "render",
    label: "Video rendering",
    optional: true,
    // Not mocked, even in development: `ffmpeg` is a real encoder producing a
    // real MP4, so there is no state in which Vidxir AI claims to have rendered a
    // video it did not render (§42).
    provider: () => env().RENDER_PROVIDER,
    required: (p) => {
      if (p === "shotstack") return ["SHOTSTACK_API_KEY"];
      if (p === "remotion-lambda") {
        return ["REMOTION_LAMBDA_FUNCTION_NAME", "REMOTION_SERVE_URL"];
      }
      // `ffmpeg` needs a binary rather than a credential; see `available` below.
      return [];
    },
    // The bundled binary is the default, so the usual reason this is unavailable
    // is an install that skipped postinstall scripts.
    available: (p) => (p === "ffmpeg" ? (env().RENDER_EXECUTION === "cloudflare" || hasFfmpeg()) : true),
    unavailableHint:
      "ffmpeg was not found. Run `npm install ffmpeg-static`, set FFMPEG_PATH " +
      "to a system ffmpeg, or set RENDER_PROVIDER=shotstack.",
    hint: "Local ffmpeg needs no account · Shotstack: https://dashboard.shotstack.io",
  },
  {
    capability: "thumbnail",
    label: "Thumbnail text",
    // Optional in the sense that the rest of the product works without it: a
    // video renders, uploads and publishes with no thumbnail. Only the Thumbnail
    // tab is blocked.
    optional: true,
    // Never mocked. `drawtext` burns real type onto a real frame, so there is no
    // state where Vidxir AI shows a thumbnail it did not composite (§42).
    provider: () => "ffmpeg-drawtext",
    // The requirement is a file on disk, not a credential — the env var is how an
    // operator points at one, but a system font satisfies it without any var set.
    required: () => [],
    available: () => env().RENDER_EXECUTION === "cloudflare" || (hasFfmpeg() && hasThumbnailFont()),
    unavailableHint:
      "Thumbnail headlines are drawn by ffmpeg and need a font file. " + FONT_HINT,
    hint:
      "A system font is used when found. THUMBNAIL_FONT_FILE overrides it — set " +
      "it to match the channel's brand face.",
  },
  {
    capability: "storage",
    label: "Object storage",
    optional: false,
    provider: () => "r2",
    required: () => [],
    hint: "Private media is stored in the Cloudflare R2 MEDIA binding.",
  },
  {
    capability: "billing",
    label: "Billing",
    optional: true,
    provider: () => (usingMockProviders() ? "mock" : env().BILLING_PROVIDER),
    required: (p) =>
      p === "stripe" ? ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] : [],
    hint: "Stripe: https://dashboard.stripe.com/apikeys",
  },
  {
    capability: "email",
    label: "Transactional email",
    optional: false,
    provider: () => env().EMAIL_PROVIDER,
    required: (p) => (p === "resend" ? ["RESEND_API_KEY"] : []),
    hint: "EMAIL_PROVIDER=console prints emails to the server log in development.",
  },
];

function evaluate(spec: Spec): CapabilityStatus {
  const provider = spec.provider();
  const requiredEnvVars = spec.required(provider);
  const missingEnvVars = missing(requiredEnvVars);

  const available = spec.available?.(provider) ?? true;

  let state: ConfigState;
  if (provider === "mock" || provider === "console") {
    state = "mock";
  } else if (missingEnvVars.length > 0 || !available) {
    state = "not_configured";
  } else {
    state = "ready";
  }

  return {
    capability: spec.capability,
    provider,
    state,
    requiredEnvVars,
    missingEnvVars,
    label: spec.label,
    // The unavailability hint is the actionable one when it applies: telling an
    // operator where to get a Shotstack key does not help when the problem is a
    // missing binary.
    hint: !available && spec.unavailableHint ? spec.unavailableHint : typeof spec.hint === "function" ? spec.hint() : spec.hint,
    optional: spec.optional,
  };
}

/** Status of every capability. Safe to send to the client — names only. */
export function providerStatuses(): CapabilityStatus[] {
  return SPECS.map(evaluate);
}

export function capabilityStatus(capability: Capability): CapabilityStatus {
  const spec = SPECS.find((s) => s.capability === capability);
  if (!spec) throw new Error(`Unknown capability: ${capability}`);
  return evaluate(spec);
}

/** True when the capability can actually do work (real or mock). */
export function isCapabilityAvailable(capability: Capability): boolean {
  return capabilityStatus(capability).state !== "not_configured";
}

/** Capabilities that block the core MVP flow when unconfigured. */
export function blockingMisconfigurations(): CapabilityStatus[] {
  return providerStatuses().filter(
    (s) => !s.optional && s.state === "not_configured",
  );
}

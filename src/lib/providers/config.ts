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
import "server-only";
import { env, usingMockProviders } from "@/lib/env";

export type Capability =
  | "ai"
  | "youtube"
  | "voice"
  | "visuals"
  | "music"
  | "transcription"
  | "render"
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
  hint?: string;
}

const SPECS: Spec[] = [
  {
    capability: "ai",
    label: "AI generation",
    optional: false,
    provider: () => (usingMockProviders() ? "mock" : "anthropic"),
    required: (p) => (p === "mock" ? [] : ["ANTHROPIC_API_KEY"]),
    hint: "Create a key at https://console.anthropic.com/settings/keys",
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
    provider: () => (usingMockProviders() ? "mock" : env().RENDER_PROVIDER),
    required: (p) => {
      if (p === "shotstack") return ["SHOTSTACK_API_KEY"];
      if (p === "remotion-lambda") {
        return ["REMOTION_LAMBDA_FUNCTION_NAME", "REMOTION_SERVE_URL"];
      }
      return [];
    },
    hint: "Shotstack: https://dashboard.shotstack.io (use the stage key first)",
  },
  {
    capability: "storage",
    label: "Object storage",
    optional: false,
    provider: () => "s3",
    required: () => ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"],
    hint: "`npm run infra:up` starts MinIO with the .env.example defaults.",
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

  let state: ConfigState;
  if (provider === "mock" || provider === "console") {
    state = "mock";
  } else if (missingEnvVars.length > 0) {
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
    hint: spec.hint,
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

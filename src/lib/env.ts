/**
 * Typed, validated environment configuration.
 *
 * Rules enforced here:
 *  - Core infrastructure (DB, Redis, storage, secrets) is REQUIRED. The process
 *    refuses to boot without it — a half-configured backend silently degrades
 *    into exactly the fake behaviour §42 forbids.
 *  - Provider credentials are OPTIONAL and resolved lazily. A missing key is a
 *    *configuration state*, surfaced to the UI, never a fallback to fakery.
 *  - Mock providers are only permitted outside production (§40).
 *
 * This module is server-only. It must never be imported from a client
 * component — `server-only` makes that a build error rather than a leak (§34).
 */
import "server-only";
import { z } from "zod";

const hex32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters (32 bytes)");

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .transform((v) => v === "true" || v === "1");

const csv = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  TALLY_USE_MOCK_PROVIDERS: bool.default("false"),
  TALLY_BLOCK_REAL_PUBLISH: bool.default("false"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  QUEUE_PREFIX: z.string().default("tally"),

  ENCRYPTION_KEY: hex32,
  SESSION_SECRET: hex32,

  EMAIL_PROVIDER: z.enum(["console", "resend"]).default("console"),
  EMAIL_FROM: z.string().default("Tally <no-reply@tally.app>"),
  RESEND_API_KEY: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5"),
  ANTHROPIC_EFFORT: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .default("high"),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),

  VOICE_PROVIDER: z.enum(["elevenlabs", "mock"]).default("mock"),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_MODEL_ID: z.string().default("eleven_multilingual_v2"),

  VISUAL_PROVIDERS: csv,
  PEXELS_API_KEY: z.string().optional(),
  RUNWAY_API_KEY: z.string().optional(),

  MUSIC_PROVIDER: z.enum(["freesound", "mock"]).default("mock"),
  FREESOUND_API_KEY: z.string().optional(),

  TRANSCRIPTION_PROVIDER: z
    .enum(["openai-whisper", "deepgram", "mock"])
    .default("mock"),
  OPENAI_API_KEY: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),

  RENDER_PROVIDER: z
    .enum(["shotstack", "remotion-lambda", "mock"])
    .default("mock"),
  SHOTSTACK_API_KEY: z.string().optional(),
  SHOTSTACK_ENV: z.enum(["stage", "v1"]).default("stage"),
  REMOTION_AWS_REGION: z.string().default("us-east-1"),
  REMOTION_LAMBDA_FUNCTION_NAME: z.string().optional(),
  REMOTION_SERVE_URL: z.string().optional(),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().min(1, "S3_BUCKET is required"),
  S3_ACCESS_KEY_ID: z.string().min(1, "S3_ACCESS_KEY_ID is required"),
  S3_SECRET_ACCESS_KEY: z.string().min(1, "S3_SECRET_ACCESS_KEY is required"),
  S3_FORCE_PATH_STYLE: bool.default("false"),
  S3_SIGNED_URL_TTL: z.coerce.number().int().positive().default(3600),

  BILLING_PROVIDER: z.enum(["stripe", "mock"]).default("mock"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_STUDIO: z.string().optional(),
  STRIPE_PRICE_SCALE: z.string().optional(),

  MAX_REMOTE_ASSET_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(524_288_000),
  ASSET_FETCH_ALLOWED_HOSTS: csv,
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_GENERATION_PER_MINUTE: z.coerce
    .number()
    .int()
    .positive()
    .default(20),

  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error"])
    .default("info"),
  LOG_FORMAT: z.enum(["pretty", "json"]).default("json"),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        `Copy .env.example to .env and fill in the required values.`,
    );
  }

  const env = parsed.data;

  // §40: mock providers and the publish guard exist for development only.
  // Allowing them in production would let Tally report success for work it
  // never did — the exact failure mode §42 prohibits.
  if (env.NODE_ENV === "production") {
    if (env.TALLY_USE_MOCK_PROVIDERS) {
      throw new Error(
        "TALLY_USE_MOCK_PROVIDERS must be false in production. " +
          "Production must use real providers.",
      );
    }
    if (env.EMAIL_PROVIDER === "console") {
      throw new Error(
        "EMAIL_PROVIDER=console only prints emails to stdout. " +
          "Configure a real email provider in production.",
      );
    }
  }

  return env;
}

let cached: Env | undefined;

/** Validated environment. Throws on first access if configuration is invalid. */
export function env(): Env {
  cached ??= load();
  return cached;
}

/**
 * Drop the cached environment so the next `env()` re-reads `process.env`.
 *
 * Test-only. The cache is what makes configuration a one-time cost in
 * production; a test that needs to assert the *absence* of a credential has no
 * other way to get there, and asserting on the not-configured path is precisely
 * what §48 requires coverage of.
 */
export function resetEnvCache(): void {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("resetEnvCache() is a test-only helper.");
  }
  cached = undefined;
}

/** True when mock providers are active (development/test only). */
export function usingMockProviders(): boolean {
  const e = env();
  return e.NODE_ENV !== "production" && e.TALLY_USE_MOCK_PROVIDERS;
}

/** True when any real YouTube publish/upload call must be refused (§40). */
export function realPublishBlocked(): boolean {
  const e = env();
  return e.NODE_ENV !== "production" && e.TALLY_BLOCK_REAL_PUBLISH;
}

export function isProduction(): boolean {
  return env().NODE_ENV === "production";
}

/** OAuth redirect target. Must match the Google console entry exactly (§6). */
export function youtubeRedirectUri(): string {
  return `${env().APP_URL.replace(/\/$/, "")}/api/channels/callback`;
}

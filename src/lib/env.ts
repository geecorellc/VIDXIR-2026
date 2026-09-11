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
 * This module must never be imported from a client component: it reads secrets,
 * and anything a client component imports ends up in the browser bundle (§34).
 *
 * That boundary is enforced by the `no-restricted-imports` rule in
 * `eslint.config.mjs`, not by the `server-only` marker package. The marker is a
 * bundler directive with no runnable Node semantics — its `default` export throws
 * unconditionally — so a module carrying it cannot be imported by the standalone
 * BullMQ worker, which is a real Node process rather than an RSC runtime. Since
 * the worker legitimately needs this module (it holds every credential), the
 * check has to live somewhere both runtimes share.
 */
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
  /**
   * The continuity layer (story bible, continuity-aware prompts, continuity QC).
   *
   * Off by default, and off means *inert*: no bible is planned, no prompt is
   * modified, no continuity check is written, and every project generates exactly
   * what it generated before the layer existed. Unlike the two flags above this one
   * is allowed in production — it gates a feature rather than a test double.
   */
  TALLY_CONTINUITY_ENGINE_ENABLED: bool.default("false"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** Server-side per-statement ceiling, in milliseconds. See `lib/db`. */
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15_000),
  /** Ceiling on an idle open transaction, in milliseconds. See `lib/db`. */
  DATABASE_IDLE_TX_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000),

  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  QUEUE_PREFIX: z.string().default("tally"),

  ENCRYPTION_KEY: hex32,
  SESSION_SECRET: hex32,

  EMAIL_PROVIDER: z.enum(["console", "resend"]).default("console"),
  EMAIL_FROM: z.string().default("Tally <no-reply@tally.app>"),
  RESEND_API_KEY: z.string().optional(),

  /**
   * Which surface Claude is reached through (§32).
   *
   * `anthropic` is the first-party API and the default, so an existing
   * deployment is unaffected by this variable existing. `bedrock` routes the
   * same calls through AWS Bedrock, for an account that buys inference through
   * AWS. Both run the same models; nothing else in the app changes.
   *
   * Not `mock`: there is no fake AI transport (§42). Mock selection stays with
   * TALLY_USE_MOCK_PROVIDERS, which the capability registry reads.
   */
  AI_PROVIDER: z.enum(["anthropic", "bedrock"]).default("anthropic"),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5"),
  /** Reasoning effort. Sent on both transports; Bedrock accepts it unchanged. */
  ANTHROPIC_EFFORT: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .default("high"),

  /**
   * AWS region for Bedrock, e.g. `us-east-1`.
   *
   * Optional here, and required only when `AI_PROVIDER=bedrock` — enforced by
   * the provider factory, which throws `NotConfiguredError` naming this variable
   * rather than letting the SDK constructor throw an unclassified error. Falls
   * back to the standard `AWS_REGION` / `AWS_DEFAULT_REGION` when unset, so a
   * deployment that already sets those does not have to repeat itself.
   *
   * There is deliberately no `BEDROCK_ACCESS_KEY_ID` or secret here.
   * Credentials come from the standard AWS provider chain, so they can live in
   * an instance role, a container role or an SSO cache and never enter Tally's
   * configuration (§33). Note this is distinct from `S3_*` and
   * `REMOTION_AWS_REGION`: those are storage and render, and an operator may
   * legitimately run them in a different account or region from inference.
   */
  BEDROCK_REGION: z.string().optional(),
  /**
   * Bedrock model id. Bedrock namespaces them — `anthropic.claude-opus-5`, not
   * the bare `claude-opus-5`, which Bedrock answers with a 404. The `anthropic.`
   * prefix is added when absent, so either form works.
   */
  BEDROCK_MODEL: z.string().default("anthropic.claude-opus-5"),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),

  VOICE_PROVIDER: z.enum(["elevenlabs", "mock"]).default("mock"),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_MODEL_ID: z.string().default("eleven_multilingual_v2"),

  VISUAL_PROVIDERS: csv,
  PEXELS_API_KEY: z.string().optional(),
  RUNWAY_API_KEY: z.string().optional(),

  /**
   * AI video-generation providers an operator has enabled (Phase 11 §10).
   *
   * A comma-separated allow-list of provider ids. Since Phase 12 the ids are the
   * four direct vendor APIs behind Tally's branded models — `qwen`, `minimax`,
   * `seedance`, `veo` — plus the pre-existing `runway`. Empty is the default and
   * means AI video is unavailable and every project uses stock footage, which is
   * the pre-Phase-11 behaviour.
   *
   * `fal` was removed as a video route in Phase 12 (§14). It is still accepted
   * here and resolves to nothing with a warning rather than a boot failure, so a
   * stale `VIDEO_GEN_PROVIDERS=fal` line degrades to "no AI video" instead of
   * taking the deployment down. See `PROVIDER_ALIASES` in `providers/video-gen.ts`.
   *
   * This is the *server's* list, and it is what makes §10's rule enforceable: a
   * client sends a model id and the server answers from this variable plus the
   * credential check. A provider absent here is unavailable however the request
   * is manipulated, and a provider present here but missing its key reports
   * `not_configured` rather than being quietly skipped (§11, §12).
   *
   * Deliberately separate from `VISUAL_PROVIDERS`: that list decides how the
   * existing b-roll stage finds stock footage, and turning on AI video generation
   * for one project must not change how every other project acquires visuals.
   */
  VIDEO_GEN_PROVIDERS: csv,

  /**
   * Alibaba Cloud Model Studio (DashScope) key — the backend for Tal 1.0 (§2).
   *
   * DashScope is Alibaba's own first-party API and hosts the Wan video models
   * directly, so this is a vendor API rather than an aggregator. Unset means
   * Tal 1.0 reports NOT_CONFIGURED and cannot be selected, never faked (§42).
   */
  DASHSCOPE_API_KEY: z.string().optional(),
  /**
   * DashScope region host. Alibaba runs separate endpoints for mainland China and
   * the international estate, and a key issued for one is rejected by the other.
   */
  DASHSCOPE_BASE_URL: z
    .string()
    .default("https://dashscope-intl.aliyuncs.com/api/v1"),
  /** Wan text-to-video model id. Versioned by Alibaba, so configurable. */
  DASHSCOPE_VIDEO_MODEL: z.string().default("wan2.2-t2v-plus"),
  /** Wan text-to-image model id, used for continuity reference stills (§5). */
  DASHSCOPE_IMAGE_MODEL: z.string().default("wan2.2-t2i-plus"),

  /**
   * MiniMax platform key — the backend for Tal 2.0 (§2).
   *
   * MiniMax publishes its own video API, so Hailuo is reached first-party here
   * rather than through an aggregator as it was in Phase 11.
   */
  MINIMAX_API_KEY: z.string().optional(),
  /** MiniMax API host. The `.chat` domain serves the international estate. */
  MINIMAX_BASE_URL: z.string().default("https://api.minimaxi.chat/v1"),
  /** MiniMax video model id. */
  MINIMAX_VIDEO_MODEL: z.string().default("MiniMax-Hailuo-02"),
  /**
   * MiniMax text-to-image model id, used for continuity reference stills (§5).
   *
   * The same key and host as the video API — MiniMax serves images from its own
   * `image_generation` endpoint, so Tal 2.0 generating references costs no second
   * credential and introduces no second integration.
   */
  MINIMAX_IMAGE_MODEL: z.string().default("image-01"),

  /**
   * Seedance key — the backend for Tal 3.0 (§2).
   *
   * ByteDance serves Seedance through Volcengine Ark. The variable is named for
   * the model rather than the platform because §2 names it that way and because
   * an operator setting it is thinking about Seedance, not about Ark.
   */
  SEEDANCE_API_KEY: z.string().optional(),
  /** Ark API host. */
  SEEDANCE_BASE_URL: z.string().default("https://ark.ap-southeast.volces.com/api/v3"),
  /**
   * Seedance model id. Ark versions these, so it is configurable.
   *
   * The Dreamina Seedance 2.0 fast model, which is the version that accepts continuity
   * reference images (§6) — the 1.0 family this defaulted to previously documents only
   * first/last-frame image input, so a deployment pinned back to it keeps working and
   * silently falls back to textual continuity. The 2.0 fast tier also caps at 720p and
   * takes 4–15 second clips, which is what `TAL_3.capabilities` declares.
   */
  SEEDANCE_VIDEO_MODEL: z.string().default("dreamina-seedance-2-0-fast-260128"),
  /**
   * Ark text-to-image model id, used for continuity reference stills (§5).
   *
   * Ark serves images through the Seedream family on the same host and key as
   * Seedance video, under the OpenAI-shaped `/images/generations` route. Separate
   * variable because the model families version independently.
   */
  SEEDANCE_IMAGE_MODEL: z.string().default("doubao-seedream-3-0-t2i-250415"),

  /**
   * fal.ai API key.
   *
   * Superseded as a video route in Phase 12 (§14): the four branded models now
   * reach their vendors directly, so nothing reads this. Retained rather than
   * deleted because `env.ts` parses strictly and removing a key an existing
   * deployment sets would turn a harmless stale line into a boot failure.
   *
   * @deprecated Video generation goes direct to the vendor APIs above.
   */
  FAL_KEY: z.string().optional(),
  /**
   * Superseded, and kept only so setting it is not an error. Nothing reads it.
   *
   * @deprecated Model ids come from the branded model catalogue, not config.
   */
  FAL_SEEDANCE_MODEL: z
    .string()
    .default("fal-ai/bytedance/seedance/v1/pro/text-to-video"),
  /**
   * Google AI (Gemini) API key — the backend for Tal 3.1 (§2, §12, §15).
   *
   * Distinct from `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and not derivable
   * from them. Those are an OAuth client for acting *as a user's YouTube
   * channel*, granted YouTube scopes at consent; Veo is a first-party Google AI
   * API authenticated with a project API key. Reusing the OAuth client here is
   * not possible, so no duplicate Google auth infrastructure is created —
   * `GEMINI_API_KEY` is simply a different credential for a different API.
   *
   * §15: this is the *existing* Gemini integration, adapted to the branded model
   * layer rather than duplicated.
   */
  GEMINI_API_KEY: z.string().optional(),
  /** Veo model id. Overridable because Google versions these behind previews. */
  GEMINI_VEO_MODEL: z.string().default("veo-3.1-generate-preview"),
  /**
   * Gemini image model, used for continuity reference stills on Tal 3.1 (§5).
   *
   * The same credential as Veo — one Google AI key covers both APIs, which is
   * why no second Gemini integration is introduced (§15).
   */
  GEMINI_IMAGE_MODEL: z.string().default("imagen-4.0-generate-001"),

  MUSIC_PROVIDER: z.enum(["freesound", "mock"]).default("mock"),
  FREESOUND_API_KEY: z.string().optional(),

  TRANSCRIPTION_PROVIDER: z
    .enum(["openai-whisper", "deepgram", "mock"])
    .default("mock"),
  OPENAI_API_KEY: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),

  /**
   * There is deliberately no `mock` renderer. `ffmpeg` encodes locally with the
   * bundled static binary, so a development build produces a genuine MP4 rather
   * than a placeholder — §42 applies to the render stage above all others. A
   * legacy `RENDER_PROVIDER=mock` is accepted and read as `ffmpeg`.
   */
  RENDER_PROVIDER: z
    .preprocess(
      (value) => (value === "mock" ? "ffmpeg" : value),
      z.enum(["shotstack", "remotion-lambda", "ffmpeg"]),
    )
    .default("ffmpeg"),
  /** Overrides the bundled ffmpeg-static binary with a system install. */
  FFMPEG_PATH: z.string().optional(),
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

  /**
   * Stripe price ids for the one-off credit packs (§11).
   *
   * One variable per pack, resolved server-side by `priceIdForPack` exactly as the
   * subscription prices are: the request body names a *pack*, never a price id, so
   * a client cannot select what it will be charged. A pack whose variable is unset
   * is simply not offered — there is no fallback price and no default amount.
   *
   * These are `mode: "payment"` prices rather than recurring ones, which is what
   * makes the webhook able to tell a top-up from a subscription (§11).
   */
  STRIPE_PRICE_CREDITS_100: z.string().optional(),
  STRIPE_PRICE_CREDITS_500: z.string().optional(),
  STRIPE_PRICE_CREDITS_1000: z.string().optional(),
  STRIPE_PRICE_CREDITS_2500: z.string().optional(),

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

  /**
   * Number of proxy hops in front of this instance, for `clientIp()`.
   *
   * `X-Forwarded-For` is client-appendable: a request can arrive carrying a
   * fabricated header, and the platform proxy *appends* the real peer rather than
   * replacing the list. So the trustworthy entry is the Nth from the right, where
   * N is the number of proxies that are actually in the path. Default 0 means
   * "no proxy" and the header is ignored entirely, which is the safe default for
   * a direct-to-Node deployment; behind one load balancer, set 1.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(0),

  /**
   * Optional shared token gating the *detail* in the readiness response (§16).
   *
   * The readiness verdict is always public — an orchestrator probe cannot log in,
   * and a probe that cannot get an answer is useless. The per-dependency breakdown
   * is operational detail, so in production it is shown only to a caller
   * presenting this token. Unset in development, where the breakdown is what makes
   * the endpoint worth calling.
   */
  HEALTH_PROBE_TOKEN: z.string().optional(),

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

    /**
     * §17: Stripe live configuration must be explicit, never inferred.
     *
     * `BILLING_PROVIDER=stripe` with a missing key would boot fine and fail at the
     * first checkout — and, worse, a missing webhook secret means signature
     * verification has nothing to verify against, so subscription state would
     * silently stop tracking reality. Both are startup errors instead.
     */
    if (env.BILLING_PROVIDER === "stripe") {
      const missing = (
        [
          ["STRIPE_SECRET_KEY", env.STRIPE_SECRET_KEY],
          ["STRIPE_WEBHOOK_SECRET", env.STRIPE_WEBHOOK_SECRET],
        ] as const
      )
        .filter(([, value]) => !value)
        .map(([name]) => name);
      if (missing.length > 0) {
        throw new Error(
          `BILLING_PROVIDER=stripe requires ${missing.join(" and ")}. ` +
            `Stripe live configuration must be explicit, not inferred.`,
        );
      }
    }

    /**
     * Cookies are issued with `secure: true` in production (see `auth/session`),
     * and a browser will not return a Secure cookie over http — so an http
     * APP_URL in production produces a login flow that appears to work and never
     * establishes a session. It also means OAuth state and session tokens would
     * cross the network in clear text.
     */
    if (env.APP_URL.startsWith("http://")) {
      throw new Error(
        "APP_URL must use https in production. Session and OAuth cookies are " +
          "issued as Secure and will not be sent over http.",
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

/**
 * The AWS region Bedrock should be called in, or undefined.
 *
 * `BEDROCK_REGION` is Tally's own knob and wins. `AWS_REGION` /
 * `AWS_DEFAULT_REGION` are the standard AWS variables the credential chain
 * already honours, and a deployment that sets them should not have to repeat
 * itself. Those two are read from `process.env` rather than the typed schema
 * because they are the ambient AWS environment, not Tally configuration.
 *
 * Lives here rather than in `providers/ai` so the capability registry can resolve
 * a region without importing the Bedrock SDK.
 */
export function bedrockRegion(): string | undefined {
  const candidates = [
    env().BEDROCK_REGION,
    process.env["AWS_REGION"],
    process.env["AWS_DEFAULT_REGION"],
  ];
  return candidates.find((v) => typeof v === "string" && v.trim().length > 0)?.trim();
}

/** True when mock providers are active (development/test only). */
export function usingMockProviders(): boolean {
  const e = env();
  return e.NODE_ENV !== "production" && e.TALLY_USE_MOCK_PROVIDERS;
}

/**
 * True when the continuity layer is active.
 *
 * No `NODE_ENV` condition, unlike the mock and publish-block flags: those exist to
 * make development safe and would be a lie in production, while this one is a
 * product feature an operator may legitimately want on.
 */
export function continuityEnabled(): boolean {
  return env().TALLY_CONTINUITY_ENGINE_ENABLED;
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

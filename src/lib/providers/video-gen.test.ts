/**
 * AI video providers (Phase 11 §9–§14, §20, §21, §23 cases 11–15, 19–20).
 *
 * `generation-plan.test.ts` covers which model a *request* may select.  This file
 * covers the adapters underneath: what each provider actually sends, how it reads
 * a queue, and what it does when the queue says no.  Both halves are needed —
 * selection being right does not make a request body right, and §11/§12 ask
 * specifically for tests "with mocks/fakes" and for **no live API calls**.
 *
 * `providers/http` and `providers/fetch` are replaced entirely, so no socket is
 * opened.  Every URL, header and body the providers would have sent is recorded
 * instead and asserted, which is the strongest claim a test can make about a paid
 * API without spending money on it.  Whether a real key works is
 * `verify:providers`' question and cannot be answered here honestly.
 *
 * What the cases below hold the adapters to:
 *
 *  - **Reported configuration is the truth** (§20, §23 case 15).  A provider that
 *    is enabled without its key reports `not_configured` and names the variable;
 *    one the operator has not enabled reports `disabled` rather than vanishing;
 *    and neither state can produce a clip.
 *  - **A credential is never in the report** (§21).  The status objects and the
 *    generated clip are serialised and searched for the key that was set.
 *  - **The frame reaches the provider** (§16).  A fal.ai model is sent the aspect
 *    ratio of the selected format, spelled the way its own endpoint documents it;
 *    Veo refuses square rather than cropping the subject out of the shot.
 *  - **The chosen model decides the endpoint** (§14).  Every entry in the fal.ai
 *    catalogue is submitted to its own URL, so selecting Kling cannot quietly
 *    generate on Seedance.
 *  - **Provider failures are classified, not flattened** (§23 cases 19–20).  A
 *    content-policy refusal is permanent; a transient queue fault and a timeout
 *    are retryable; a missing key is a configuration state.
 *  - **§22 holds at the provider boundary too.** Nothing here downloads from
 *    YouTube.  Generation prompts are Tally's own scene direction, and a clip's
 *    provenance is recorded on the asset.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { NotConfiguredError, ProviderError } from "@/lib/errors";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** One recorded outbound call the provider *would* have made. */
interface Call {
  provider: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const net = vi.hoisted(() => ({
  calls: [] as Array<{
    provider: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }>,
  /** Queued JSON replies, matched in order. A missing reply is a test bug. */
  replies: [] as unknown[],
  /** Bytes `fetchRemoteAsset` returns, and the URLs it was asked for. */
  fetched: [] as string[],
  assetBytes: Buffer.alloc(0),
  assetType: "video/mp4",
}));

vi.mock("@/lib/providers/http", () => ({
  providerJson: (request: {
    provider: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  }) => {
    net.calls.push({
      provider: request.provider,
      url: request.url,
      method: request.method ?? "GET",
      headers: request.headers ?? {},
      body: request.body ?? null,
    });
    if (net.replies.length === 0) {
      return Promise.reject(
        new Error(`no queued reply for ${request.method ?? "GET"} ${request.url}`),
      );
    }
    const next = net.replies.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  },
  providerBytes: () => Promise.reject(new Error("not used")),
}));

vi.mock("@/lib/providers/fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/fetch")>();
  return {
    ...actual,
    fetchRemoteAsset: (url: string) => {
      net.fetched.push(url);
      return Promise.resolve({
        bytes: net.assetBytes,
        contentType: net.assetType,
        finalUrl: url,
      });
    },
  };
});

vi.mock("@/lib/providers/usage", () => ({
  // Pass-through. `api_usage` accounting has its own tests, and a database is not
  // available in a unit run.
  withUsage: (_ctx: unknown, run: () => Promise<unknown>) => run(),
}));

const {
  allVideoGenStatuses,
  availableModels,
  generateClip,
  isGenerationMode,
  isVideoGenConfigured,
  resolveModel,
  videoGenProviderIds,
  videoGenStatuses,
} = await import("@/lib/providers/video-gen");

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** What `lib/env` needs before it will parse. Local placeholders only (§25). */
const BASE = {
  DATABASE_URL: "postgresql://tally:tally@localhost:5432/tally_unit",
  REDIS_URL: "redis://127.0.0.1:6379",
  S3_BUCKET: "tally-unit",
  S3_ACCESS_KEY_ID: "unit",
  S3_SECRET_ACCESS_KEY: "unit",
  ENCRYPTION_KEY: "a".repeat(64),
  SESSION_SECRET: "b".repeat(64),
} as const;

const MANAGED = [
  "NODE_ENV",
  "TALLY_USE_MOCK_PROVIDERS",
  "VIDEO_GEN_PROVIDERS",
  "FAL_KEY",
  "FAL_SEEDANCE_MODEL",
  "GEMINI_API_KEY",
  "GEMINI_VEO_MODEL",
  "RUNWAY_API_KEY",
  ...Object.keys(BASE),
] as const;

const original = new Map<string, string | undefined>(
  MANAGED.map((key) => [key, process.env[key]]),
);

function setEnv(key: string, value: string): void {
  // Next declares NODE_ENV readonly in its ambient types; written through the
  // index signature, confined to this helper.
  (process.env as Record<string, string>)[key] = value;
}

/**
 * A distinctive placeholder per provider.
 *
 * Distinctive so a leak assertion can search for it and mean something; obviously
 * a placeholder so §25's secret scan has nothing to flag.
 */
const FAKE_FAL_KEY = "fal-unit-placeholder-not-a-real-key";
const FAKE_GEMINI_KEY = "gemini-unit-placeholder-not-a-real-key";

function configure(vars: Record<string, string | undefined>): void {
  setEnv("NODE_ENV", "test");
  resetEnvCache();
  for (const key of MANAGED) delete process.env[key];
  const merged = { ...BASE, TALLY_USE_MOCK_PROVIDERS: "false", ...vars };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete process.env[key];
    else setEnv(key, value);
  }
  resetEnvCache();
}

beforeEach(() => {
  net.calls = [];
  net.replies = [];
  net.fetched = [];
  // Small but non-empty: the byte count is what usage accounting records.
  net.assetBytes = Buffer.alloc(4_096, 7);
  net.assetType = "video/mp4";
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  setEnv("NODE_ENV", "test");
  resetEnvCache();
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else setEnv(key, value);
  }
  resetEnvCache();
});

/** The single scene request every generation case starts from. */
function request(over: Partial<Parameters<typeof generateClip>[0]> = {}) {
  return {
    prompt: "Wide shot of a kitchen worktop, morning light, no people",
    modelId: "fal/seedance-1-pro",
    format: "landscape" as const,
    durationMs: 6_000,
    sceneIndex: 2,
    ...over,
  };
}

const USAGE = {
  usage: {
    userId: null,
    projectId: null,
    jobId: null,
    traceId: "unit",
  },
} as const;

// ---------------------------------------------------------------------------
// §23 case 15 / §20 — configuration reporting
// ---------------------------------------------------------------------------

describe("configuration reporting (§20, §23 case 15)", () => {
  it("reports nothing enabled as no models, without failing", () => {
    configure({ VIDEO_GEN_PROVIDERS: "" });
    // The default posture: link mode offers stock footage only, and that is a
    // configuration state rather than a defect.
    expect(videoGenProviderIds()).toEqual([]);
    expect(videoGenStatuses()).toEqual([]);
    expect(availableModels()).toEqual([]);
    expect(isVideoGenConfigured()).toBe(false);
  });

  it("reports an enabled provider with no key as not_configured, naming the variable", () => {
    configure({ VIDEO_GEN_PROVIDERS: "fal", FAL_KEY: undefined });

    const status = videoGenStatuses().find((s) => s.provider === "fal");
    expect(status?.state).toBe("not_configured");
    expect(status?.requiredEnvVars).toEqual(["FAL_KEY"]);
    expect(status?.missingEnvVars).toEqual(["FAL_KEY"]);
    // §11: a provider that needs a specific third-party service says so, in the
    // operator-facing report rather than in a code comment.
    expect(status?.serviceNote).toMatch(/fal\.ai/i);
    // Its models are visible to an operator but not selectable by a client.
    expect(status?.models.length).toBeGreaterThan(0);
    expect(availableModels()).toEqual([]);
    expect(isVideoGenConfigured()).toBe(false);
  });

  it("reports an implemented but unenabled provider as disabled, not absent", () => {
    configure({ VIDEO_GEN_PROVIDERS: "fal", FAL_KEY: FAKE_FAL_KEY });

    const all = allVideoGenStatuses();
    // "We do not offer this" and "this is broken" have to be distinguishable.
    expect(all.find((s) => s.provider === "fal")?.state).toBe("ready");
    expect(all.find((s) => s.provider === "veo")?.state).toBe("disabled");
    expect(all.find((s) => s.provider === "runway")?.state).toBe("disabled");
    // The narrower list a client sees carries only what it may select.
    expect(videoGenStatuses().map((s) => s.provider)).toEqual(["fal"]);
  });

  it("ignores an unknown provider name in the enabled list", () => {
    // A typo in an environment variable must not enable something, and must not
    // crash the picker either.
    configure({
      VIDEO_GEN_PROVIDERS: "fal,sora,pika",
      FAL_KEY: FAKE_FAL_KEY,
    });
    expect(videoGenProviderIds()).toEqual(["fal"]);
  });

  it("still accepts the pre-catalogue provider name (`seedance`)", () => {
    // An operator's environment was written before fal.ai carried a catalogue.
    // Silently offering nothing would be the worst of the three options here —
    // worse than warning, and worse than resolving it as the fal provider.
    configure({ VIDEO_GEN_PROVIDERS: "seedance", FAL_KEY: FAKE_FAL_KEY });
    expect(videoGenProviderIds()).toEqual(["fal"]);
    expect(videoGenStatuses()[0]?.provider).toBe("fal");
    expect(availableModels().length).toBeGreaterThan(0);
  });

  it("counts the old and new provider names as one provider, not two", () => {
    configure({ VIDEO_GEN_PROVIDERS: "seedance,fal", FAL_KEY: FAKE_FAL_KEY });
    // Duplicated ids would duplicate every model in the picker.
    expect(videoGenProviderIds()).toEqual(["fal"]);
    const ids = availableModels().map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("cannot be talked into enabling the development placeholder in a real run", () => {
    // `mock` is reachable only through TALLY_USE_MOCK_PROVIDERS, which `env.ts`
    // refuses in production. Naming it directly does nothing.
    configure({ VIDEO_GEN_PROVIDERS: "mock" });
    expect(videoGenProviderIds()).toEqual([]);

    configure({ TALLY_USE_MOCK_PROVIDERS: "true", VIDEO_GEN_PROVIDERS: "seedance" });
    // With mocks on, the placeholder *replaces* the list — a development run must
    // not reach a paid generation API by accident.
    expect(videoGenProviderIds()).toEqual(["mock"]);
    expect(videoGenStatuses()[0]?.state).toBe("mock");
  });

  it("never puts a credential in a status report (§21)", () => {
    configure({
      VIDEO_GEN_PROVIDERS: "fal,veo",
      FAL_KEY: FAKE_FAL_KEY,
      GEMINI_API_KEY: FAKE_GEMINI_KEY,
    });

    // This is the object `/api/video/providers` serialises to the browser.
    const serialised = JSON.stringify(allVideoGenStatuses());
    expect(serialised).not.toContain(FAKE_FAL_KEY);
    expect(serialised).not.toContain(FAKE_GEMINI_KEY);
    // Variable *names* are the point of the report, so they must be present.
    expect(serialised).toContain("FAL_KEY");
    expect(serialised).toContain("GEMINI_API_KEY");
  });

  it("recognises the two generation modes and nothing else", () => {
    expect(isGenerationMode("STOCK")).toBe(true);
    expect(isGenerationMode("AI_VIDEO")).toBe(true);
    for (const bad of ["stock", "ai_video", "AI", "", null, 7, {}]) {
      expect(isGenerationMode(bad)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// §23 cases 11–14 — model resolution
// ---------------------------------------------------------------------------

describe("resolveModel (§10, §23 cases 11–14)", () => {
  it("resolves a configured model to its provider", () => {
    configure({ VIDEO_GEN_PROVIDERS: "fal", FAL_KEY: FAKE_FAL_KEY });
    const resolved = resolveModel("fal/seedance-1-pro");
    expect(resolved.provider).toBe("fal");
    expect(resolved.model.premium).toBe(true);
    expect(resolved.model.formats).toContain("square");
  });

  it("resolves a model id stored before the catalogue existed", () => {
    // §10 has the visuals stage re-resolve a *stored* id at render time, so an id
    // that stops resolving turns a saved project into a failed render rather than
    // a stale label. The alias is what prevents that.
    configure({ VIDEO_GEN_PROVIDERS: "fal", FAL_KEY: FAKE_FAL_KEY });
    const resolved = resolveModel("seedance/v1-pro");
    expect(resolved.provider).toBe("fal");
    expect(resolved.model.id).toBe("fal/seedance-1-pro");
  });

  it("refuses a model name no provider declares (§23 case 14)", () => {
    configure({ VIDEO_GEN_PROVIDERS: "fal", FAL_KEY: FAKE_FAL_KEY });
    // A model id in a request body is a string, not a capability.
    for (const bogus of [
      "sora/v2",
      "fal/seedance-9-ultra",
      "seedance/v9-ultra",
      "../../etc/passwd",
      "",
      "fal/seedance-1-pro ",
    ]) {
      let thrown: unknown;
      try {
        resolveModel(bogus);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProviderError);
      expect((thrown as ProviderError).status).toBe(400);
      expect((thrown as ProviderError).retryable).toBe(false);
    }
  });

  it("refuses a real model whose provider this deployment has not enabled", () => {
    configure({ VIDEO_GEN_PROVIDERS: "fal", FAL_KEY: FAKE_FAL_KEY });
    // Reported identically to an unknown id: saying "disabled" would confirm the
    // existence of a provider the operator chose not to offer.
    expect(() => resolveModel("veo/3.1")).toThrow(ProviderError);
    expect(() => resolveModel("runway/gen4-turbo")).toThrow(ProviderError);
  });

  it("refuses an enabled provider with no credential as a configuration state (§23 case 15)", () => {
    configure({ VIDEO_GEN_PROVIDERS: "veo", GEMINI_API_KEY: undefined });

    let thrown: unknown;
    try {
      resolveModel("veo/3.1");
    } catch (error) {
      thrown = error;
    }
    // §10: "a client must not be able to request an unconfigured provider simply
    // by manipulating the request." It gets a 503 naming the variable instead.
    expect(thrown).toBeInstanceOf(NotConfiguredError);
    const error = thrown as NotConfiguredError;
    expect(error.status).toBe(503);
    expect(error.code).toBe("provider_not_configured");
    expect(JSON.stringify(error.toResponseBody())).toContain("GEMINI_API_KEY");
  });

  it("declares Veo as landscape and portrait only (§16)", () => {
    configure({ VIDEO_GEN_PROVIDERS: "veo", GEMINI_API_KEY: FAKE_GEMINI_KEY });
    for (const model of availableModels()) {
      expect(model.formats).toEqual(["landscape", "portrait"]);
    }
    // And offers one premium tier and one standard, so `premiumVideoModels`
    // gating has something to distinguish (§19).
    const premium = availableModels().map((m) => m.premium);
    expect(premium).toContain(true);
    expect(premium).toContain(false);
  });
});

// ---------------------------------------------------------------------------
// §23 cases 12–13 — what each provider sends
// ---------------------------------------------------------------------------

describe("fal.ai (§11, §14, §23 case 12)", () => {
  beforeEach(() => {
    configure({ VIDEO_GEN_PROVIDERS: "fal", FAL_KEY: FAKE_FAL_KEY });
  });

  it("submits, polls to completion, reads the result and returns the clip", async () => {
    net.replies = [
      { request_id: "req-123" },
      { status: "COMPLETED" },
      { video: { url: "https://v3.fal.media/files/clip.mp4", content_type: "video/mp4" } },
    ];

    const clip = await generateClip(request(), USAGE);

    expect(clip.provider).toBe("fal");
    expect(clip.modelId).toBe("fal/seedance-1-pro");
    expect(clip.bytes.byteLength).toBe(4_096);
    expect(clip.mimeType).toBe("video/mp4");
    expect(clip.extension).toBe("mp4");
    // Landscape at 1080p, from the shared format system rather than a literal
    // hardcoded in the adapter (§16).
    expect(clip.width).toBe(1_920);
    expect(clip.height).toBe(1_080);
    expect(clip.durationMs).toBe(6_000);
    // Provenance for the asset row (§29): which provider, which request.
    expect(clip.providerAssetId).toBe("fal:req-123");
    expect(clip.license).toMatch(/fal\.ai/i);
    expect(clip.attribution).toBe("Generated with Seedance 1 Pro");
    expect(net.fetched).toEqual(["https://v3.fal.media/files/clip.mp4"]);
  });

  it("routes each model to its own fal.ai endpoint (§14)", async () => {
    // The point of the catalogue: the model id chosen in the UI decides the URL,
    // and nothing else in the request pipeline knows which vendor is involved.
    const expected: Array<[string, string]> = [
      ["fal/seedance-1-pro", "fal-ai/bytedance/seedance/v1/pro/text-to-video"],
      ["fal/seedance-1-lite", "fal-ai/bytedance/seedance/v1/lite/text-to-video"],
      ["fal/kling-v2-master", "fal-ai/kling-video/v2/master/text-to-video"],
      ["fal/kling-v2-5-turbo-pro", "fal-ai/kling-video/v2.5-turbo/pro/text-to-video"],
      ["fal/minimax-hailuo-02-pro", "fal-ai/minimax/hailuo-02/pro/text-to-video"],
      ["fal/minimax-hailuo-02-standard", "fal-ai/minimax/hailuo-02/standard/text-to-video"],
      ["fal/wan-v2-2-a14b", "fal-ai/wan/v2.2-a14b/text-to-video"],
      ["fal/hunyuan-video", "fal-ai/hunyuan-video"],
      ["fal/veo3", "fal-ai/veo3"],
      ["fal/veo3-fast", "fal-ai/veo3/fast"],
    ];

    for (const [modelId, endpoint] of expected) {
      net.calls = [];
      net.replies = [
        { request_id: `req-${modelId}` },
        { status: "COMPLETED" },
        { video: { url: "https://fal.media/files/c.mp4" } },
      ];

      const clip = await generateClip(request({ modelId }), USAGE);

      expect((net.calls[0] as Call).url).toBe(`https://queue.fal.run/${endpoint}`);
      // Status and result polling address the same endpoint, so a model whose
      // slug is wrong fails at submit rather than hanging on a poll loop.
      for (const call of net.calls) expect(call.url).toContain(endpoint);
      expect(clip.modelId).toBe(modelId);
    }

    // Every catalogue entry was covered — a new model added without a routing
    // case here fails this assertion rather than shipping untested.
    const configured = availableModels().filter((m) => m.provider === "fal");
    expect(configured.map((m) => m.id).sort()).toEqual(
      expected.map(([id]) => id).sort(),
    );
  });

  it("sends the frame's aspect ratio and keeps the safety checker on", async () => {
    net.replies = [
      { request_id: "req-portrait" },
      { status: "COMPLETED" },
      { video: { url: "https://v3.fal.media/files/p.mp4" } },
    ];

    await generateClip(request({ format: "portrait", durationMs: 9_000 }), USAGE);

    const submit = net.calls[0] as Call;
    expect(submit.method).toBe("POST");
    expect(submit.url).toContain("queue.fal.run");
    const body = submit.body as Record<string, unknown>;
    expect(body["aspect_ratio"]).toBe("9:16");
    expect(body["duration"]).toBe("9");
    // Disabling the check would put responsibility for a policy violation on
    // Tally's account; a refusal is surfaced as a permanent error instead.
    expect(body["enable_safety_checker"]).toBe(true);
  });

  it("spells each model's parameters the way its endpoint documents them", async () => {
    // Hailuo takes no aspect ratio — the frame follows `resolution` — and its Pro
    // tier takes no duration at all. Sending an unknown key is not harmless: some
    // fal endpoints reject the request rather than ignoring the field.
    net.replies = [
      { request_id: "req-hailuo" },
      { status: "COMPLETED" },
      { video: { url: "https://fal.media/files/h.mp4" } },
    ];
    await generateClip(
      request({ modelId: "fal/minimax-hailuo-02-pro", durationMs: 6_000 }),
      USAGE,
    );
    const hailuo = (net.calls[0] as Call).body as Record<string, unknown>;
    expect(hailuo["aspect_ratio"]).toBeUndefined();
    expect(hailuo["duration"]).toBeUndefined();
    expect(hailuo["resolution"]).toBe("1080p");

    // Kling takes an aspect ratio and a string duration, but no resolution.
    net.calls = [];
    net.replies = [
      { request_id: "req-kling" },
      { status: "COMPLETED" },
      { video: { url: "https://fal.media/files/k.mp4" } },
    ];
    await generateClip(
      request({ modelId: "fal/kling-v2-master", durationMs: 9_000 }),
      USAGE,
    );
    const kling = (net.calls[0] as Call).body as Record<string, unknown>;
    expect(kling["aspect_ratio"]).toBe("16:9");
    expect(kling["resolution"]).toBeUndefined();
    // 9s is not offered; 10 is the nearest of [5, 10].
    expect(kling["duration"]).toBe("10");
  });

  it("snaps a scene to a length the chosen model actually offers (§17)", async () => {
    net.replies = [
      { request_id: "req-long" },
      { status: "COMPLETED" },
      { video: { url: "https://v3.fal.media/files/l.mp4" } },
    ];

    // A 40-second scene: the clip is capped at the model's longest and the
    // renderer fills the remainder — §17 makes final assembly the worker's job.
    const clip = await generateClip(request({ durationMs: 40_000 }), USAGE);
    expect((net.calls[0] as Call).body).toMatchObject({ duration: "12" });
    expect(clip.durationMs).toBe(12_000);

    // Kling offers only 5s and 10s, so the same scene snaps to 10 rather than
    // being sent a 12 the endpoint would reject.
    net.calls = [];
    net.replies = [
      { request_id: "req-long-kling" },
      { status: "COMPLETED" },
      { video: { url: "https://fal.media/files/lk.mp4" } },
    ];
    const kling = await generateClip(
      request({ modelId: "fal/kling-v2-master", durationMs: 40_000 }),
      USAGE,
    );
    expect(kling.durationMs).toBe(10_000);
  });

  it("generates on the current model when a project stored a legacy id", async () => {
    net.replies = [
      { request_id: "req-alias" },
      { status: "COMPLETED" },
      { video: { url: "https://fal.media/files/a.mp4" } },
    ];

    const clip = await generateClip(request({ modelId: "seedance/v1-pro" }), USAGE);

    expect((net.calls[0] as Call).url).toContain(
      "fal-ai/bytedance/seedance/v1/pro/text-to-video",
    );
    // Records what actually ran, not the alias the project happened to hold —
    // otherwise per-model spend reporting attributes cost to a dead id.
    expect(clip.modelId).toBe("fal/seedance-1-pro");
  });

  it("treats a content-policy refusal as permanent and a queue fault as retryable (§23 case 20)", async () => {
    net.replies = [
      { request_id: "req-refused" },
      { status: "ERROR", error: "flagged by the safety checker" },
    ];
    await expect(generateClip(request(), USAGE)).rejects.toMatchObject({
      code: "provider_failed",
      // The same prompt refuses identically next time; retrying spends money to
      // learn nothing.
      retryable: false,
    });

    net.calls = [];
    net.replies = [
      { request_id: "req-blip" },
      { status: "ERROR", error: "worker crashed" },
    ];
    await expect(generateClip(request(), USAGE)).rejects.toMatchObject({
      code: "provider_failed",
      retryable: true,
    });
  });

  it("treats a completed request with no video URL as permanent", async () => {
    net.replies = [
      { request_id: "req-empty" },
      { status: "COMPLETED" },
      { video: null },
    ];
    await expect(generateClip(request(), USAGE)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it("treats a queue that returns no request id as retryable", async () => {
    net.replies = [{ status: "IN_QUEUE" }];
    await expect(generateClip(request(), USAGE)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("refuses to generate once the key is removed (§10 applied to time)", async () => {
    // Days can pass between selecting a model and rendering with it, and a
    // credential can be rotated away in between.
    configure({ VIDEO_GEN_PROVIDERS: "fal", FAL_KEY: undefined });
    await expect(generateClip(request(), USAGE)).rejects.toBeInstanceOf(
      NotConfiguredError,
    );
    // Nothing was sent: the refusal is before the first call, not after it.
    expect(net.calls).toEqual([]);
  });

  it("puts the key in a header and never in the returned clip (§21)", async () => {
    net.replies = [
      { request_id: "req-key" },
      { status: "COMPLETED" },
      { video: { url: "https://v3.fal.media/files/k.mp4" } },
    ];
    const clip = await generateClip(request(), USAGE);

    // Authorisation travels as a header, not in a query string that would be
    // logged by every proxy in between.
    expect((net.calls[0] as Call).headers["authorization"]).toContain(FAKE_FAL_KEY);
    for (const call of net.calls) expect(call.url).not.toContain(FAKE_FAL_KEY);
    // The clip is persisted and its meta is rendered; neither may carry the key.
    const { bytes, ...rest } = clip;
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(JSON.stringify(rest)).not.toContain(FAKE_FAL_KEY);
  });
});

describe("Veo via the Gemini API (§12, §23 case 13)", () => {
  beforeEach(() => {
    configure({ VIDEO_GEN_PROVIDERS: "veo", GEMINI_API_KEY: FAKE_GEMINI_KEY });
  });

  it("starts a long-running operation, polls it and downloads the sample", async () => {
    net.replies = [
      { name: "models/veo/operations/op-9" },
      {
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [
              { video: { uri: "https://generativelanguage.googleapis.com/v1beta/files/x" } },
            ],
          },
        },
      },
    ];

    const clip = await generateClip(request({ modelId: "veo/3.1" }), USAGE);

    expect(clip.provider).toBe("veo");
    expect(clip.providerAssetId).toBe("veo:op-9");
    expect(clip.license).toMatch(/Google Veo/i);
    // 6s is not one of Veo's supported lengths (4/6/8); 6 is, so it is unchanged.
    expect(clip.durationMs).toBe(6_000);
    expect((net.calls[0] as Call).url).toContain(":predictLongRunning");
    expect((net.calls[0] as Call).headers["x-goog-api-key"]).toBe(FAKE_GEMINI_KEY);
  });

  it("asks for no recognisable people", async () => {
    net.replies = [
      { name: "op-2" },
      {
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [{ video: { uri: "https://generativelanguage.googleapis.com/f" } }],
          },
        },
      },
    ];
    await generateClip(request({ modelId: "veo/3.1-fast" }), USAGE);

    const params = ((net.calls[0] as Call).body as { parameters: Record<string, unknown> })
      .parameters;
    // A generated likeness in a published video is a rights problem.
    expect(params["personGeneration"]).toBe("dont_allow");
    expect(params["aspectRatio"]).toBe("16:9");
    // The fast tier maps to its own documented model id rather than the default.
    expect((net.calls[0] as Call).url).toContain("veo-3.1-fast-generate-preview");
  });

  it("snaps a scene to the nearest supported clip length", async () => {
    net.replies = [
      { name: "op-3" },
      {
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [{ video: { uri: "https://generativelanguage.googleapis.com/f" } }],
          },
        },
      },
    ];
    // 11s is closest to 8, the longest Veo produces.
    const clip = await generateClip(
      request({ modelId: "veo/3.1", durationMs: 11_000 }),
      USAGE,
    );
    expect(clip.durationMs).toBe(8_000);
  });

  it("refuses square with the actual reason instead of cropping (§16)", async () => {
    let thrown: unknown;
    try {
      await generateClip(request({ modelId: "veo/3.1", format: "square" }), USAGE);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).status).toBe(400);
    expect((thrown as ProviderError).retryable).toBe(false);
    expect((thrown as ProviderError).message).toMatch(/square/i);
    // Refused before anything was sent, so no quota was spent learning this.
    expect(net.calls).toEqual([]);
  });

  it("treats a responsible-AI filter as a permanent refusal, not a fault", async () => {
    net.replies = [
      { name: "op-filtered" },
      {
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [],
            raiMediaFilteredCount: 1,
            raiMediaFilteredReasons: ["Policy: person generation"],
          },
        },
      },
    ];
    await expect(
      generateClip(request({ modelId: "veo/3.1" }), USAGE),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("treats an operation error as permanent and a missing name as retryable", async () => {
    net.replies = [{ name: "op-err" }, { error: { code: 13, message: "internal" } }];
    await expect(
      generateClip(request({ modelId: "veo/3.1" }), USAGE),
    ).rejects.toMatchObject({ retryable: false });

    net.replies = [{ done: false }];
    await expect(
      generateClip(request({ modelId: "veo/3.1" }), USAGE),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("does not reuse the YouTube OAuth client (§12)", () => {
    // §12 forbids duplicating Google authentication. Veo needs a *different*
    // credential for a different Google API, and the report says so rather than
    // leaving an operator to discover it.
    const status = videoGenStatuses().find((s) => s.provider === "veo");
    expect(status?.requiredEnvVars).toEqual(["GEMINI_API_KEY"]);
    expect(status?.serviceNote).toMatch(/GOOGLE_CLIENT_ID/);
    expect(status?.serviceNote).toMatch(/cannot authenticate Veo/i);
  });
});

describe("the development placeholder", () => {
  it("is honest about not being a video (§42)", async () => {
    configure({ TALLY_USE_MOCK_PROVIDERS: "true" });

    const clip = await generateClip(request({ modelId: "mock/placeholder" }), USAGE);
    // A still, declared as a still, licensed as unpublishable. §42 forbids
    // claiming a video was generated when it was not, and this claims nothing.
    expect(clip.mimeType).toBe("image/png");
    expect(clip.extension).toBe("png");
    expect(clip.durationMs).toBeNull();
    expect(clip.license).toMatch(/not for publication/i);
    // And it reached no network: no queued reply was consumed.
    expect(net.calls).toEqual([]);
    expect(net.fetched).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §23 — no live calls
// ---------------------------------------------------------------------------

describe("test-suite discipline (§23, §24)", () => {
  it("reaches a provider only through the two seams this file replaces", () => {
    // §23 forbids real video-generation requests. Rather than trusting that, this
    // reads the module and asserts it has no other way out: every outbound call in
    // `video-gen.ts` goes through `providerJson` or `fetchRemoteAsset`, both of
    // which are mocked above, so a future adapter that called `fetch` directly
    // would fail here instead of quietly spending money in CI.
    const source = readFileSync(
      new URL("../providers/video-gen.ts", import.meta.url),
      "utf8",
    );
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of ["fetch(", "https.request", "http.request", "axios"]) {
      expect(stripped).not.toContain(forbidden);
    }
    expect(stripped).toContain("providerJson");
    expect(stripped).toContain("fetchRemoteAsset");
  });
});

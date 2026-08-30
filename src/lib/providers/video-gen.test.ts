/**
 * The generation registry — Tally's branded models and the vendors under them
 * (Phase 12 §2–§5, §14–§16, §18 cases 1–7, 20–21, §19, §21).
 *
 * `generation-plan.test.ts` covers which model a *request* may select. This file
 * covers the adapters underneath: what each vendor is actually sent, how a queue is
 * read, what happens when the queue says no — and, new in Phase 12, that the vendor
 * never reaches the customer.
 *
 * `providers/http` and `providers/fetch` are replaced entirely, so no socket is
 * opened. Every URL, header and body the providers would have sent is recorded
 * instead and asserted, which is the strongest claim a test can make about a paid
 * API without spending money on it. Whether a real key works is
 * `verify:video-providers`' question and cannot be answered here honestly.
 *
 * What the cases below hold the registry to:
 *
 *  - **The branded name is the only name a customer sees** (§3, §14, acceptance
 *    criterion 20). `publicModels()` is serialised and searched for all six vendor
 *    names, and `publicModel` is asserted not to *have* a provider field — a UI
 *    cannot render what it was never sent.
 *  - **Each branded model reaches its own vendor** (§2, §18 case 2). Tal 1.0 must
 *    submit to DashScope, Tal 2.0 to MiniMax, Tal 3.0 to Ark, Tal 3.1 to the Gemini
 *    API. A mapping error would mean a customer paying cinematic credits for a fast
 *    generation.
 *  - **Capabilities are honoured, not decorative** (§4, §5, §18 cases 4–7). An
 *    unsupported resolution is refused server-side; a model that declares no image
 *    support cannot be talked into an image request.
 *  - **Reported configuration is the truth** (§18 case 12 and its Phase 11
 *    ancestor). Enabled without a key reports `not_configured` and names the
 *    variable; not enabled reports `disabled` rather than vanishing; neither can
 *    produce a clip.
 *  - **A credential is never in a report** (§21). Status objects and returned
 *    assets are serialised and searched for every key that was set.
 *  - **Saved projects still render** (§17). Every retired Phase 11 model id still
 *    resolves, to a branded model backed by the same vendor wherever one exists.
 *  - **Failures are classified, not flattened** (§13). A content-policy refusal is
 *    permanent; a transient fault and a deadline are retryable; a missing key is a
 *    configuration state.
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
  /** Extra hosts each fetch was allowed to reach, for the SSRF assertions. */
  allowed: [] as string[][],
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
    fetchRemoteAsset: (
      url: string,
      options: { extraHosts?: readonly string[] },
    ) => {
      net.fetched.push(url);
      net.allowed.push([...(options.extraHosts ?? [])]);
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
  assertImageQuality,
  assertQuality,
  generateClip,
  generateImage,
  imageModels,
  isGenerationMode,
  isImageGenConfigured,
  isVideoGenConfigured,
  providerReadiness,
  publicModel,
  publicModels,
  resolveImageModel,
  resolveModel,
  videoGenProviderIds,
  videoGenStatuses,
} = await import("@/lib/providers/video-gen");

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** What `lib/env` needs before it will parse. Local placeholders only. */
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
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_BASE_URL",
  "DASHSCOPE_VIDEO_MODEL",
  "DASHSCOPE_IMAGE_MODEL",
  "MINIMAX_API_KEY",
  "MINIMAX_BASE_URL",
  "MINIMAX_VIDEO_MODEL",
  "MINIMAX_IMAGE_MODEL",
  "SEEDANCE_API_KEY",
  "SEEDANCE_BASE_URL",
  "SEEDANCE_VIDEO_MODEL",
  "SEEDANCE_IMAGE_MODEL",
  "GEMINI_API_KEY",
  "GEMINI_VEO_MODEL",
  "GEMINI_IMAGE_MODEL",
  "RUNWAY_API_KEY",
  // Retained in `env.ts` as deprecated (§14). Managed here so a developer's own
  // shell cannot influence a case.
  "FAL_KEY",
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
 * A distinctive placeholder per vendor.
 *
 * Distinctive so a leak assertion can search for it and mean something; obviously
 * a placeholder so the repository's secret scan has nothing to flag.
 */
const FAKE_DASHSCOPE_KEY = "dashscope-unit-placeholder-not-a-real-key";
const FAKE_MINIMAX_KEY = "minimax-unit-placeholder-not-a-real-key";
const FAKE_SEEDANCE_KEY = "seedance-unit-placeholder-not-a-real-key";
const FAKE_GEMINI_KEY = "gemini-unit-placeholder-not-a-real-key";
const FAKE_RUNWAY_KEY = "runway-unit-placeholder-not-a-real-key";

/** Every vendor credential set at once, for the cross-provider cases. */
const ALL_KEYS = {
  VIDEO_GEN_PROVIDERS: "qwen,minimax,seedance,veo",
  DASHSCOPE_API_KEY: FAKE_DASHSCOPE_KEY,
  MINIMAX_API_KEY: FAKE_MINIMAX_KEY,
  SEEDANCE_API_KEY: FAKE_SEEDANCE_KEY,
  GEMINI_API_KEY: FAKE_GEMINI_KEY,
} as const;

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
  net.allowed = [];
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
    modelId: "tal/3.0",
    format: "landscape" as const,
    durationMs: 6_000,
    sceneIndex: 2,
    ...over,
  };
}

/** The single still request every image case starts from. */
function imageRequest(over: Partial<Parameters<typeof generateImage>[0]> = {}) {
  return {
    prompt: "Character reference: a small boy in a yellow raincoat, full body",
    modelId: "tal/1.0",
    format: "landscape" as const,
    purpose: "character" as const,
    index: 0,
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

/**
 * Every backend name §3 forbids in a customer-facing field.
 *
 * Word-anchored rather than substring, because "fal" appears inside ordinary
 * English ("filled", "final") and a substring match would either fail on innocent
 * copy or be quietly relaxed until it stopped testing anything.
 */
const FORBIDDEN_NAMES: readonly RegExp[] = [
  /\bfal\b/i,
  /fal\.ai/i,
  /\bseedance\b/i,
  /\bminimax\b/i,
  /\bhailuo\b/i,
  /\bkling\b/i,
  /\bwan\b/i,
  /\bveo\b/i,
  /\bgemini\b/i,
  /\bimagen\b/i,
  /\bdashscope\b/i,
  /\balibaba\b/i,
  /\bbytedance\b/i,
  /\bvolcengine\b/i,
  /\bark\b/i,
  /\brunway\b/i,
  /\bqwen\b/i,
];

// ---------------------------------------------------------------------------
// §3, §14, acceptance criterion 20 — the customer never sees a vendor
// ---------------------------------------------------------------------------

describe("branded model names (§2, §3, §14)", () => {
  beforeEach(() => {
    configure(ALL_KEYS);
  });

  it("offers exactly the four models §2 names, in order", () => {
    expect(availableModels().map((m) => m.id)).toEqual([
      "tal/1.0",
      "tal/2.0",
      "tal/3.0",
      "tal/3.1",
    ]);
    expect(availableModels().map((m) => m.label)).toEqual([
      "Tal 1.0 — Fast Model",
      "Tal 2.0 — Creators Model",
      "Tal 3.0 — Cinematic Model",
      "Tal 3.1 — Ultra Model",
    ]);
  });

  it("carries the §3 description and Best-for copy for each model", () => {
    const copy = new Map(
      availableModels().map((m) => [m.id, `${m.description} / ${m.bestFor}`]),
    );
    expect(copy.get("tal/1.0")).toBe(
      "Fast generation • Great for high-volume content / " +
        "Shorts, simple scenes, rapid production",
    );
    expect(copy.get("tal/2.0")).toBe(
      "Balanced quality and generation cost / " +
        "YouTube creators and everyday storytelling",
    );
    expect(copy.get("tal/3.0")).toBe(
      "Higher visual quality and stronger cinematic motion / " +
        "Storytelling, children's animation, cinematic content",
    );
    expect(copy.get("tal/3.1")).toBe(
      "Premium generation quality / " +
        "Hero scenes, premium productions and highest visual quality",
    );
  });

  it("names no vendor anywhere in the customer-facing model list (§3, criterion 20)", () => {
    // This is the object the picker renders. Serialised whole, so a vendor name in
    // a strength, a limitation or a description fails here too — not just one in
    // the label.
    const serialised = JSON.stringify(publicModels());
    for (const name of FORBIDDEN_NAMES) {
      expect(serialised).not.toMatch(name);
    }
  });

  it("drops the provider field rather than renaming it (§3)", () => {
    // Renaming would leave the vendor one `JSON.stringify` away from a browser.
    // Absence is the enforceable version of "do not expose".
    for (const model of publicModels()) {
      expect(model).not.toHaveProperty("provider");
    }
    const internal = availableModels()[0];
    expect(internal?.provider).toBe("qwen");
    expect(publicModel(internal!)).not.toHaveProperty("provider");
  });

  it("reports readiness as counts, with no vendor names (§3)", () => {
    expect(providerReadiness()).toEqual({
      ready: 4,
      awaitingConfiguration: 0,
      placeholder: false,
    });

    configure({ ...ALL_KEYS, SEEDANCE_API_KEY: undefined });
    const readiness = providerReadiness();
    // An operator's problem is still visible to the UI as a count, so it can say
    // "AI video is misconfigured" without saying which company is involved.
    expect(readiness).toEqual({
      ready: 3,
      awaitingConfiguration: 1,
      placeholder: false,
    });
    expect(JSON.stringify(readiness)).not.toMatch(/seedance/i);
  });

  it("keeps the vendor in the operator report, which is a different surface", () => {
    // §3 permits provider information in "backend logs/admin/debug views". The
    // operator has to know which variable to set, so this list is the one place a
    // vendor name is correct — and it is not what `/api/video/providers` sends.
    const operator = JSON.stringify(allVideoGenStatuses());
    expect(operator).toMatch(/DASHSCOPE_API_KEY/);
    expect(operator).toMatch(/MINIMAX_API_KEY/);
    expect(operator).toMatch(/SEEDANCE_API_KEY/);
    expect(operator).toMatch(/GEMINI_API_KEY/);
  });

  it("does not offer the retired route under any name (§14)", () => {
    // §14: "do not leave the old Fal video route accidentally selectable."
    configure({ ...ALL_KEYS, VIDEO_GEN_PROVIDERS: "fal", FAL_KEY: "ignored" });
    // A stale environment line degrades to "no AI video" rather than taking the
    // deployment down, and enables nothing.
    expect(videoGenProviderIds()).toEqual([]);
    expect(availableModels()).toEqual([]);
    expect(isVideoGenConfigured()).toBe(false);
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
// §18 case 12 / §20 — configuration reporting
// ---------------------------------------------------------------------------

describe("configuration reporting", () => {
  it("reports nothing enabled as no models, without failing", () => {
    configure({ VIDEO_GEN_PROVIDERS: "" });
    // The default posture: stock footage only, and that is a configuration state
    // rather than a defect.
    expect(videoGenProviderIds()).toEqual([]);
    expect(videoGenStatuses()).toEqual([]);
    expect(availableModels()).toEqual([]);
    expect(isVideoGenConfigured()).toBe(false);
    expect(isImageGenConfigured()).toBe(false);
  });

  it("reports an enabled provider with no key as not_configured, naming the variable", () => {
    configure({ VIDEO_GEN_PROVIDERS: "qwen", DASHSCOPE_API_KEY: undefined });

    const status = videoGenStatuses().find((s) => s.provider === "qwen");
    expect(status?.state).toBe("not_configured");
    expect(status?.requiredEnvVars).toEqual(["DASHSCOPE_API_KEY"]);
    expect(status?.missingEnvVars).toEqual(["DASHSCOPE_API_KEY"]);
    // A provider that depends on a specific service says so, in the operator-facing
    // report rather than in a code comment.
    expect(status?.serviceNote).toMatch(/DASHSCOPE_BASE_URL/);
    // Its models are visible to an operator but not selectable by a client.
    expect(status?.models.length).toBeGreaterThan(0);
    expect(availableModels()).toEqual([]);
    expect(isVideoGenConfigured()).toBe(false);
  });

  it("reports an implemented but unenabled provider as disabled, not absent", () => {
    configure({ VIDEO_GEN_PROVIDERS: "qwen", DASHSCOPE_API_KEY: FAKE_DASHSCOPE_KEY });

    const all = allVideoGenStatuses();
    // "We do not offer this" and "this is broken" have to be distinguishable.
    expect(all.find((s) => s.provider === "qwen")?.state).toBe("ready");
    expect(all.find((s) => s.provider === "minimax")?.state).toBe("disabled");
    expect(all.find((s) => s.provider === "seedance")?.state).toBe("disabled");
    expect(all.find((s) => s.provider === "veo")?.state).toBe("disabled");
    expect(all.find((s) => s.provider === "runway")?.state).toBe("disabled");
    // The narrower list a client sees carries only what it may select.
    expect(videoGenStatuses().map((s) => s.provider)).toEqual(["qwen"]);
  });

  it("ignores an unknown provider name in the enabled list", () => {
    // A typo in an environment variable must not enable something, and must not
    // crash the picker either.
    configure({
      VIDEO_GEN_PROVIDERS: "qwen,sora,pika,fal",
      DASHSCOPE_API_KEY: FAKE_DASHSCOPE_KEY,
    });
    expect(videoGenProviderIds()).toEqual(["qwen"]);
  });

  it("accepts the vendor-flavoured spellings an operator might write", () => {
    // §2 names the backends "Wan 3.0 Video → QwenCloud/Alibaba", "Seedance 2.5",
    // "Google Veo". An operator reading that could reasonably write any of these,
    // and silently offering nothing would be the worst outcome of the three.
    for (const [written, resolved] of [
      ["dashscope", "qwen"],
      ["wan", "qwen"],
      ["alibaba", "qwen"],
      ["ark", "seedance"],
      ["bytedance", "seedance"],
      ["gemini", "veo"],
      ["google", "veo"],
    ] as const) {
      configure({ ...ALL_KEYS, VIDEO_GEN_PROVIDERS: written });
      expect(videoGenProviderIds()).toEqual([resolved]);
    }
  });

  it("counts an alias and its canonical name as one provider, not two", () => {
    configure({ ...ALL_KEYS, VIDEO_GEN_PROVIDERS: "wan,qwen,dashscope" });
    // Duplicated ids would duplicate every model in the picker.
    expect(videoGenProviderIds()).toEqual(["qwen"]);
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
    expect(providerReadiness().placeholder).toBe(true);
  });

  it("never puts a credential in a status report (§21)", () => {
    configure({ ...ALL_KEYS, VIDEO_GEN_PROVIDERS: "qwen,minimax,seedance,veo,runway", RUNWAY_API_KEY: FAKE_RUNWAY_KEY });

    const serialised = JSON.stringify(allVideoGenStatuses());
    for (const key of [
      FAKE_DASHSCOPE_KEY,
      FAKE_MINIMAX_KEY,
      FAKE_SEEDANCE_KEY,
      FAKE_GEMINI_KEY,
      FAKE_RUNWAY_KEY,
    ]) {
      expect(serialised).not.toContain(key);
    }
    // Variable *names* are the point of the report, so they must be present.
    expect(serialised).toContain("DASHSCOPE_API_KEY");
    expect(serialised).toContain("GEMINI_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// §18 cases 1–3 — model resolution and vendor mapping
// ---------------------------------------------------------------------------

describe("resolveModel (§18 cases 1–3)", () => {
  beforeEach(() => {
    configure(ALL_KEYS);
  });

  it("maps each branded model to the vendor §2 assigns it (§18 case 2)", () => {
    expect(resolveModel("tal/1.0").provider).toBe("qwen");
    expect(resolveModel("tal/2.0").provider).toBe("minimax");
    expect(resolveModel("tal/3.0").provider).toBe("seedance");
    expect(resolveModel("tal/3.1").provider).toBe("veo");
  });

  it("marks only the Ultra tier premium, so plan gating has something to gate", () => {
    const premium = new Map(availableModels().map((m) => [m.id, m.premium]));
    expect(premium.get("tal/1.0")).toBe(false);
    expect(premium.get("tal/2.0")).toBe(false);
    expect(premium.get("tal/3.0")).toBe(false);
    expect(premium.get("tal/3.1")).toBe(true);
  });

  it("refuses a model name no provider declares (§18 case 1)", () => {
    // A model id in a request body is a string, not a capability.
    for (const bogus of [
      "sora/v2",
      "tal/9.9",
      "tal/3.0 ",
      "../../etc/passwd",
      "",
      "fal/does-not-exist",
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
    configure({ VIDEO_GEN_PROVIDERS: "qwen", DASHSCOPE_API_KEY: FAKE_DASHSCOPE_KEY });
    // Reported identically to an unknown id: saying "disabled" would confirm the
    // existence of a provider the operator chose not to offer.
    expect(() => resolveModel("tal/3.1")).toThrow(ProviderError);
    expect(() => resolveModel("runway/gen4-turbo")).toThrow(ProviderError);
    expect(resolveModel("tal/1.0").model.id).toBe("tal/1.0");
  });

  it("refuses an enabled provider with no credential as a configuration state", () => {
    configure({ VIDEO_GEN_PROVIDERS: "veo", GEMINI_API_KEY: undefined });

    let thrown: unknown;
    try {
      resolveModel("tal/3.1");
    } catch (error) {
      thrown = error;
    }
    // "A client must not be able to request an unconfigured provider simply by
    // manipulating the request." It gets a 503 naming the variable instead.
    expect(thrown).toBeInstanceOf(NotConfiguredError);
    const error = thrown as NotConfiguredError;
    expect(error.status).toBe(503);
    expect(error.code).toBe("provider_not_configured");
    expect(JSON.stringify(error.toResponseBody())).toContain("GEMINI_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// §17 — a project created before Phase 12 still renders
// ---------------------------------------------------------------------------

describe("legacy model ids (§17)", () => {
  beforeEach(() => {
    configure(ALL_KEYS);
  });

  it("resolves every retired Phase 11 id to a branded model", () => {
    // The visuals stage re-resolves a *stored* id at render time, so an id that
    // stops resolving turns a saved project into a failed render. Same-vendor
    // wherever one exists, which is what makes the substitution defensible.
    const expected: Array<[string, string, string]> = [
      ["fal/wan-v2-2-a14b", "tal/1.0", "qwen"],
      ["fal/hunyuan-video", "tal/1.0", "qwen"],
      ["fal/minimax-hailuo-02-pro", "tal/2.0", "minimax"],
      ["fal/minimax-hailuo-02-standard", "tal/2.0", "minimax"],
      ["fal/seedance-1-pro", "tal/3.0", "seedance"],
      ["fal/seedance-1-lite", "tal/3.0", "seedance"],
      ["seedance/v1-pro", "tal/3.0", "seedance"],
      ["fal/kling-v2-master", "tal/3.0", "seedance"],
      ["fal/kling-v2-5-turbo-pro", "tal/3.0", "seedance"],
      ["fal/veo3", "tal/3.1", "veo"],
      ["fal/veo3-fast", "tal/3.1", "veo"],
      ["veo/3.1", "tal/3.1", "veo"],
      ["veo/3.1-fast", "tal/3.1", "veo"],
    ];

    for (const [stored, modelId, provider] of expected) {
      const resolved = resolveModel(stored);
      expect(resolved.model.id, stored).toBe(modelId);
      expect(resolved.provider, stored).toBe(provider);
    }
  });

  it("keeps the retired Runway model resolvable but never offers it", () => {
    configure({ ...ALL_KEYS, VIDEO_GEN_PROVIDERS: "veo,runway", RUNWAY_API_KEY: FAKE_RUNWAY_KEY });
    // Resolvable, because a Phase 11 project may hold this id.
    const resolved = resolveModel("runway/gen4-turbo");
    expect(resolved.provider).toBe("runway");
    expect(resolved.model.legacy).toBe(true);
    // Absent from every picker: §14 forbids dead model options in the UI.
    expect(availableModels().map((m) => m.id)).not.toContain("runway/gen4-turbo");
    expect(publicModels().map((m) => m.id)).not.toContain("runway/gen4-turbo");
  });

  it("records what actually ran, not the alias the project happened to hold", () => {
    net.replies = [
      { output: { task_id: "task-alias" } },
      { output: { task_status: "SUCCEEDED", video_url: "https://oss.aliyuncs.com/a.mp4" } },
    ];

    // Otherwise per-model spend reporting attributes cost to a dead id, and §9's
    // per-model credit pricing has nothing reliable to reconcile against.
    return generateClip(request({ modelId: "fal/wan-v2-2-a14b" }), USAGE).then(
      (clip) => {
        expect(clip.modelId).toBe("tal/1.0");
        expect(clip.provider).toBe("qwen");
      },
    );
  });
});

// ---------------------------------------------------------------------------
// §4, §16 — declared capabilities are enforced
// ---------------------------------------------------------------------------

describe("capability matrix (§4, §16, §18 cases 4–7)", () => {
  beforeEach(() => {
    configure(ALL_KEYS);
  });

  it("declares aspect ratios per model, and only what the vendor generates", () => {
    const formats = new Map(availableModels().map((m) => [m.id, m.formats]));
    expect(formats.get("tal/1.0")).toEqual(["landscape", "portrait", "square"]);
    expect(formats.get("tal/2.0")).toEqual(["landscape", "portrait"]);
    expect(formats.get("tal/3.0")).toEqual(["landscape", "portrait", "square"]);
    expect(formats.get("tal/3.1")).toEqual(["landscape", "portrait"]);
  });

  it("declares resolutions per model rather than a shared list (§4)", () => {
    const qualities = new Map(
      availableModels().map((m) => [m.id, m.capabilities.qualities]),
    );
    expect(qualities.get("tal/1.0")).toEqual(["draft", "720p", "1080p"]);
    expect(qualities.get("tal/2.0")).toEqual(["720p", "1080p"]);
    expect(qualities.get("tal/3.0")).toEqual(["draft", "720p", "1080p"]);
    expect(qualities.get("tal/3.1")).toEqual(["720p", "1080p"]);
    // Nothing claims 2K video: §19 forbids fabricating a capability, and no vendor
    // integrated here serves 2K on these model families.
    for (const list of qualities.values()) expect(list).not.toContain("2k");
  });

  it("refuses an unsupported resolution server-side (§18 case 7)", () => {
    const ultra = resolveModel("tal/3.1").model;
    let thrown: unknown;
    try {
      assertQuality(ultra, "draft");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).status).toBe(400);
    expect((thrown as ProviderError).retryable).toBe(false);
    // The message lists what *is* supported, so the client can correct itself.
    expect((thrown as ProviderError).message).toMatch(/720p, 1080p/);
  });

  it("refuses an unsupported resolution at the generation boundary too", async () => {
    // The UI is generated from capabilities, but the UI is not the control.
    await expect(
      generateClip(request({ modelId: "tal/3.1", quality: "draft" }), USAGE),
    ).rejects.toMatchObject({ status: 400, retryable: false });
    expect(net.calls).toEqual([]);
  });

  it("resolves an absent resolution to the default without failing", () => {
    // Null means "no preference" and arrives from a project row written before the
    // column existed. Downgrading an *explicit* choice would be worse, but an
    // absent one has nothing to preserve.
    for (const model of availableModels()) {
      expect(model.capabilities.qualities).toContain(assertQuality(model, null));
    }
  });

  it("keeps maxClipSeconds and the duration list in agreement", () => {
    // Two representations of one fact, so the registry checks them against each
    // other at load. Asserted here as well because the picker reads the first and
    // the adapters read the second.
    for (const model of availableModels()) {
      expect(model.maxClipSeconds).toBe(
        Math.max(...model.capabilities.durations),
      );
    }
  });

  it("declares text-to-video everywhere and claims no capability it lacks", () => {
    for (const model of availableModels()) {
      expect(model.capabilities.textToVideo).toBe(true);
      // No adapter here sends a first frame or a reference image, so §19's "do not
      // fabricate provider capabilities" makes both of these false until one does.
      expect(model.capabilities.imageToVideo).toBe(false);
      expect(model.capabilities.referenceImages).toBe(false);
    }
    // Audio is declared only where the vendor actually produces it.
    const audio = new Map(
      availableModels().map((m) => [m.id, m.capabilities.audio]),
    );
    expect(audio.get("tal/3.1")).toBe(true);
    expect(audio.get("tal/1.0")).toBe(false);
  });

  it("states strengths and honest limitations for each model (§4)", () => {
    for (const model of availableModels()) {
      expect(model.strengths.length).toBeGreaterThan(0);
      expect(model.limitations.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// §5 — image generation is a capability of the same models
// ---------------------------------------------------------------------------

describe("image generation (§5, §18 cases 5–6)", () => {
  beforeEach(() => {
    configure(ALL_KEYS);
  });

  it("offers stills on every branded model, first-class rather than as a side system", () => {
    // All four, not a subset: a project makes its continuity references with the
    // model it already selected instead of borrowing another model's look.
    expect(imageModels().map((m) => m.id)).toEqual([
      "tal/1.0",
      "tal/2.0",
      "tal/3.0",
      "tal/3.1",
    ]);
    expect(isImageGenConfigured()).toBe(true);
    expect(imageModels().map((m) => m.provider)).toEqual([
      "qwen",
      "minimax",
      "seedance",
      "veo",
    ]);
  });

  it("prevents an image request on a model that does not generate images (§5)", () => {
    // "Where a model does not support image generation, the capability resolver
    // must prevent unsupported requests." This is that resolver. Every *branded*
    // model now generates stills, so the case that exercises it is the legacy
    // Runway model — which is still resolvable for a Phase 11 project (§17) and
    // must not become an image surface because of it.
    configure({
      ...ALL_KEYS,
      VIDEO_GEN_PROVIDERS: "qwen,minimax,seedance,veo,runway",
      RUNWAY_API_KEY: FAKE_RUNWAY_KEY,
    });

    let thrown: unknown;
    try {
      resolveImageModel("runway/gen4-turbo");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).status).toBe(400);
    expect((thrown as ProviderError).message).toMatch(/does not generate images/);

    for (const modelId of ["tal/1.0", "tal/2.0", "tal/3.0", "tal/3.1"]) {
      expect(resolveImageModel(modelId).model.id, modelId).toBe(modelId);
    }
  });

  it("refuses an unsupported image resolution, which differs from the video list", () => {
    const ultra = resolveModel("tal/3.1").model;
    // The Ultra tier is the only 2K surface in Tally, and it is stills-only.
    expect(ultra.capabilities.imageQualities).toEqual(["1080p", "2k"]);
    expect(assertImageQuality(ultra, "2k")).toBe("2k");
    expect(() => assertImageQuality(ultra, "720p")).toThrow(ProviderError);

    const fast = resolveModel("tal/1.0").model;
    expect(fast.capabilities.imageQualities).toEqual(["draft", "720p", "1080p"]);
    expect(() => assertImageQuality(fast, "2k")).toThrow(ProviderError);
  });

  it("reports no image resolutions for a model that generates none", () => {
    for (const model of availableModels()) {
      expect(
        model.capabilities.imageQualities.length > 0,
        model.id,
      ).toBe(model.capabilities.imageGeneration);
    }
  });

  it("refuses an image request at the generation boundary too", async () => {
    configure({
      ...ALL_KEYS,
      VIDEO_GEN_PROVIDERS: "qwen,minimax,seedance,veo,runway",
      RUNWAY_API_KEY: FAKE_RUNWAY_KEY,
    });
    // The boundary check is separate from the resolver's: a caller that reached
    // `generateImage` with a video-only model must be refused before a request is
    // built, not after one is sent and billed.
    await expect(
      generateImage(imageRequest({ modelId: "runway/gen4-turbo" }), USAGE),
    ).rejects.toMatchObject({ status: 400, retryable: false });
    expect(net.calls).toEqual([]);
  });

  it("carries the continuity purpose through to the returned asset (§5)", async () => {
    net.assetType = "image/png";
    net.replies = [
      { output: { task_id: "img-1" } },
      {
        output: {
          task_status: "SUCCEEDED",
          results: [{ url: "https://oss.aliyuncs.com/ref.png" }],
        },
      },
    ];

    const image = await generateImage(
      imageRequest({ purpose: "environment", index: 3 }),
      USAGE,
    );

    // The purpose is what lets a continuity reference be found again by what it is
    // for, rather than guessed from a filename.
    expect(image.purpose).toBe("environment");
    expect(image.modelId).toBe("tal/1.0");
    expect(image.provider).toBe("qwen");
    expect(image.mimeType).toBe("image/png");
    expect(image.extension).toBe("png");
    expect(image.providerAssetId).toBe("qwen:img:img-1");
    expect(image.bytes.byteLength).toBe(4_096);
  });
});

// ---------------------------------------------------------------------------
// §18 case 2 — what each vendor is actually sent
// ---------------------------------------------------------------------------

describe("Tal 1.0 on its vendor API", () => {
  beforeEach(() => {
    configure(ALL_KEYS);
  });

  it("submits asynchronously, polls the task and downloads the clip", async () => {
    net.replies = [
      { output: { task_id: "task-1" } },
      {
        output: {
          task_status: "SUCCEEDED",
          video_url: "https://oss-cn.aliyuncs.com/clip.mp4",
        },
      },
    ];

    const clip = await generateClip(request({ modelId: "tal/1.0" }), USAGE);

    const submit = net.calls[0] as Call;
    expect(submit.method).toBe("POST");
    expect(submit.url).toBe(
      "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
    );
    // The asynchronous header is what makes the endpoint return a task rather than
    // blocking for minutes behind an HTTP timeout.
    expect(submit.headers["X-DashScope-Async"]).toBe("enable");
    expect(submit.headers["authorization"]).toContain(FAKE_DASHSCOPE_KEY);
    const body = submit.body as { parameters: Record<string, unknown> };
    // Frame spelled the way this vendor documents it, derived from the shared
    // format/quality modules rather than hardcoded in the adapter (§16).
    expect(body.parameters["size"]).toBe("1920*1080");
    expect(body.parameters["duration"]).toBe(5);

    // Polling addresses the task, on the same base URL.
    expect((net.calls[1] as Call).url).toBe(
      "https://dashscope-intl.aliyuncs.com/api/v1/tasks/task-1",
    );

    expect(clip.provider).toBe("qwen");
    expect(clip.modelId).toBe("tal/1.0");
    expect(clip.width).toBe(1_920);
    expect(clip.height).toBe(1_080);
    // 6s was asked for; this model offers 5 and nothing else, and the renderer
    // fills the remainder.
    expect(clip.durationMs).toBe(5_000);
    expect(clip.providerAssetId).toBe("qwen:task-1");
    // Licence and attribution name the Tally model, never the vendor (§3).
    expect(clip.license).toContain("Tal 1.0 — Fast Model");
    expect(clip.attribution).toBe("Generated with Tal 1.0 — Fast Model");
    for (const name of FORBIDDEN_NAMES) {
      expect(`${clip.license} ${clip.attribution}`).not.toMatch(name);
    }
    expect(net.fetched).toEqual(["https://oss-cn.aliyuncs.com/clip.mp4"]);
  });

  it(
    "keeps polling while the task is pending rather than reading it as a failure",
    async () => {
      // The states that mean "not yet" are as important as the ones that mean
      // "done": treating an unrecognised status as a failure would abandon a
      // generation the customer has already been charged for. This case costs the
      // suite one real poll interval, which is why it is the only one that pays it.
      net.replies = [
        { output: { task_id: "task-slow" } },
        { output: { task_status: "PENDING" } },
        { output: { task_status: "RUNNING" } },
        {
          output: {
            task_status: "SUCCEEDED",
            video_url: "https://oss.aliyuncs.com/slow.mp4",
          },
        },
      ];

      const clip = await generateClip(request({ modelId: "tal/1.0" }), USAGE);
      expect(clip.providerAssetId).toBe("qwen:task-slow");
      // Submit plus three polls: nothing was skipped and nothing looped twice.
      expect(net.calls).toHaveLength(4);
    },
    20_000,
  );

  it("honours a regional base URL rather than assuming one estate", async () => {
    configure({
      ...ALL_KEYS,
      DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/api/v1/",
    });
    net.replies = [
      { output: { task_id: "task-cn" } },
      { output: { task_status: "SUCCEEDED", video_url: "https://oss.aliyuncs.com/c.mp4" } },
    ];

    await generateClip(request({ modelId: "tal/1.0" }), USAGE);
    // Trailing slash trimmed, so a configured value with one does not produce a
    // double-slashed path the vendor may or may not accept.
    expect((net.calls[0] as Call).url).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
    );
  });

  it("sends the requested resolution, not always the default", async () => {
    net.replies = [
      { output: { task_id: "task-draft" } },
      { output: { task_status: "SUCCEEDED", video_url: "https://oss.aliyuncs.com/d.mp4" } },
    ];

    const clip = await generateClip(
      request({ modelId: "tal/1.0", format: "portrait", quality: "draft" }),
      USAGE,
    );

    const body = (net.calls[0] as Call).body as { parameters: Record<string, unknown> };
    // Draft portrait: 480 on the short edge, and the long edge derived from the
    // format rather than tabulated per combination.
    expect(body.parameters["size"]).toBe("480*854");
    expect(clip.width).toBe(480);
    expect(clip.height).toBe(854);
  });

  it("submits a still to the image endpoint, not the video one (§5)", async () => {
    net.assetType = "image/png";
    net.replies = [
      { output: { task_id: "img-2" } },
      {
        output: {
          task_status: "SUCCEEDED",
          results: [{ url: "https://oss.aliyuncs.com/still.png" }],
        },
      },
    ];

    await generateImage(imageRequest({ modelId: "tal/1.0" }), USAGE);

    expect((net.calls[0] as Call).url).toBe(
      "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis",
    );
    const body = (net.calls[0] as Call).body as { parameters: Record<string, unknown> };
    expect(body.parameters["n"]).toBe(1);
    // Same task poller as video: one asynchronous pattern, two endpoints.
    expect((net.calls[1] as Call).url).toContain("/tasks/img-2");
  });

  it("classifies a policy refusal as permanent and a fault as retryable (§13)", async () => {
    net.replies = [
      { output: { task_id: "task-refused" } },
      {
        output: {
          task_status: "FAILED",
          message: "Input data may contain inappropriate content, policy violation",
        },
      },
    ];
    await expect(
      generateClip(request({ modelId: "tal/1.0" }), USAGE),
    ).rejects.toMatchObject({ code: "provider_failed", retryable: false });

    net.replies = [
      { output: { task_id: "task-blip" } },
      { output: { task_status: "FAILED", message: "internal worker error" } },
    ];
    await expect(
      generateClip(request({ modelId: "tal/1.0" }), USAGE),
    ).rejects.toMatchObject({ code: "provider_failed", retryable: true });
  });

  it("treats a submit with no task id as retryable and a done task with no URL as not", async () => {
    net.replies = [{ output: { task_status: "PENDING" } }];
    await expect(
      generateClip(request({ modelId: "tal/1.0" }), USAGE),
    ).rejects.toMatchObject({ retryable: true });

    net.replies = [
      { output: { task_id: "task-empty" } },
      { output: { task_status: "SUCCEEDED", video_url: null } },
    ];
    await expect(
      generateClip(request({ modelId: "tal/1.0" }), USAGE),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("allow-lists only the hosts this vendor serves media from", async () => {
    net.replies = [
      { output: { task_id: "task-host" } },
      { output: { task_status: "SUCCEEDED", video_url: "https://oss.aliyuncs.com/h.mp4" } },
    ];
    await generateClip(request({ modelId: "tal/1.0" }), USAGE);
    // Widened per call rather than added to the global allow-list, so the SSRF
    // control stays as narrow as each download needs.
    expect(net.allowed[0]).toContain("aliyuncs.com");
    expect(net.allowed[0]).not.toContain("volces.com");
  });
});

describe("Tal 2.0 on its vendor API", () => {
  beforeEach(() => {
    configure(ALL_KEYS);
  });

  it("submits, polls for a file id, then retrieves the download URL", async () => {
    net.replies = [
      { task_id: "mm-1", base_resp: { status_code: 0 } },
      { status: "Success", file_id: "file-77" },
      { file: { download_url: "https://cdn.minimaxi.chat/v/clip.mp4" } },
    ];

    const clip = await generateClip(request({ modelId: "tal/2.0" }), USAGE);

    const submit = net.calls[0] as Call;
    expect(submit.method).toBe("POST");
    expect(submit.url).toBe("https://api.minimaxi.chat/v1/video_generation");
    expect(submit.headers["authorization"]).toContain(FAKE_MINIMAX_KEY);
    const body = submit.body as Record<string, unknown>;
    // This vendor spells the resolution in capitals and takes duration as a number.
    expect(body["resolution"]).toBe("1080P");
    expect(body["duration"]).toBe(6);
    // A refusal is surfaced as a permanent error rather than avoided by disabling
    // the vendor's own optimiser.
    expect(body["prompt_optimizer"]).toBe(true);

    expect((net.calls[1] as Call).url).toContain("query/video_generation?task_id=mm-1");
    // The extra retrieve step is why this adapter makes three calls per clip.
    expect((net.calls[2] as Call).url).toContain("files/retrieve?file_id=file-77");

    expect(clip.provider).toBe("minimax");
    expect(clip.modelId).toBe("tal/2.0");
    expect(clip.durationMs).toBe(6_000);
    expect(clip.providerAssetId).toBe("minimax:mm-1");
    expect(clip.license).toContain("Tal 2.0 — Creators Model");
  });

  it("snaps a scene to a length this model actually offers", async () => {
    net.replies = [
      { task_id: "mm-long", base_resp: { status_code: 0 } },
      { status: "Success", file_id: "f" },
      { file: { download_url: "https://cdn.minimaxi.chat/v/l.mp4" } },
    ];
    // 9s is not offered; 10 is the nearer of [6, 10], and sending 9 would be
    // rejected rather than rounded by the endpoint.
    const clip = await generateClip(
      request({ modelId: "tal/2.0", durationMs: 9_000 }),
      USAGE,
    );
    expect((net.calls[0] as Call).body).toMatchObject({ duration: 10 });
    expect(clip.durationMs).toBe(10_000);

    // An exact tie keeps the shorter option, which is the cheaper thing to be
    // wrong about — 8s is equidistant from 6 and 10.
    net.calls = [];
    net.replies = [
      { task_id: "mm-tie", base_resp: { status_code: 0 } },
      { status: "Success", file_id: "f" },
      { file: { download_url: "https://cdn.minimaxi.chat/v/t.mp4" } },
    ];
    const tied = await generateClip(
      request({ modelId: "tal/2.0", durationMs: 8_000 }),
      USAGE,
    );
    expect(tied.durationMs).toBe(6_000);
  });

  it("refuses square with the actual reason instead of cropping (§4)", async () => {
    let thrown: unknown;
    try {
      await generateClip(request({ modelId: "tal/2.0", format: "square" }), USAGE);
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

  it("does not read an error in a 200 body as a success", async () => {
    // This vendor reports application errors inside a 200, which would otherwise
    // sail past the shared status translation and be read as a missing task id.
    net.replies = [
      { base_resp: { status_code: 1_008, status_msg: "insufficient balance" } },
    ];
    await expect(
      generateClip(request({ modelId: "tal/2.0" }), USAGE),
    ).rejects.toMatchObject({ code: "provider_failed", retryable: true });

    net.replies = [
      { base_resp: { status_code: 1_027, status_msg: "content policy violation" } },
    ];
    await expect(
      generateClip(request({ modelId: "tal/2.0" }), USAGE),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("treats a success with no file id as permanent", async () => {
    net.replies = [
      { task_id: "mm-empty", base_resp: { status_code: 0 } },
      { status: "Success", file_id: null },
    ];
    await expect(
      generateClip(request({ modelId: "tal/2.0" }), USAGE),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("takes one call for a still where the clip takes three (§5)", async () => {
    net.assetType = "image/jpeg";
    net.replies = [
      {
        base_resp: { status_code: 0 },
        data: { image_urls: ["https://cdn.minimaxi.chat/i/ref.jpg"] },
      },
    ];

    const image = await generateImage(
      imageRequest({ modelId: "tal/2.0", purpose: "prop", format: "portrait" }),
      USAGE,
    );

    // One call, no polling: this vendor's image family is synchronous even though
    // its video family is not.
    expect(net.calls).toHaveLength(1);
    const submit = net.calls[0] as Call;
    expect(submit.method).toBe("POST");
    expect(submit.url).toBe("https://api.minimaxi.chat/v1/image_generation");
    expect(submit.headers["authorization"]).toContain(FAKE_MINIMAX_KEY);
    const body = submit.body as Record<string, unknown>;
    expect(body["model"]).toBe("image-01");
    // An aspect ratio, not a pixel size — the frame is derived from the ratio here
    // and from a `width*height` token on Tal 1.0. Both come from the shared modules.
    expect(body["aspect_ratio"]).toBe("9:16");
    expect(body["n"]).toBe(1);

    expect(image.provider).toBe("minimax");
    expect(image.modelId).toBe("tal/2.0");
    expect(image.purpose).toBe("prop");
    expect(image.mimeType).toBe("image/jpeg");
    expect(image.extension).toBe("jpg");
    // 1080p portrait: the resolution the frame is recorded at, not the ratio string.
    expect(image.width).toBe(1_080);
    expect(image.height).toBe(1_920);
    expect(image.providerAssetId).toBeNull();
    expect(image.license).toContain("Tal 2.0 — Creators Model");
  });

  it("refuses a square still and an unsupported still resolution", async () => {
    await expect(
      generateImage(imageRequest({ modelId: "tal/2.0", format: "square" }), USAGE),
    ).rejects.toMatchObject({ status: 400, retryable: false });
    await expect(
      generateImage(imageRequest({ modelId: "tal/2.0", quality: "2k" }), USAGE),
    ).rejects.toMatchObject({ status: 400, retryable: false });
    // Neither refusal spent a request to learn what the matrix already declares.
    expect(net.calls).toEqual([]);
  });

  it("reads an error in a 200 body on the image route too", async () => {
    net.replies = [
      { base_resp: { status_code: 1_027, status_msg: "content policy violation" } },
    ];
    await expect(
      generateImage(imageRequest({ modelId: "tal/2.0" }), USAGE),
    ).rejects.toMatchObject({ retryable: false });

    net.replies = [{ base_resp: { status_code: 0 }, data: { image_urls: [] } }];
    await expect(
      generateImage(imageRequest({ modelId: "tal/2.0" }), USAGE),
    ).rejects.toMatchObject({ retryable: false });
  });
});

describe("Tal 3.0 on its vendor API", () => {
  beforeEach(() => {
    configure(ALL_KEYS);
  });

  it("submits with parameters as text commands, polls and downloads", async () => {
    net.replies = [
      { id: "ark-1" },
      { status: "succeeded", content: { video_url: "https://tos.volces.com/c.mp4" } },
    ];

    const clip = await generateClip(request({ modelId: "tal/3.0" }), USAGE);

    const submit = net.calls[0] as Call;
    expect(submit.method).toBe("POST");
    expect(submit.url).toBe(
      "https://ark.ap-southeast.volces.com/api/v3/contents/generations/tasks",
    );
    expect(submit.headers["authorization"]).toContain(FAKE_SEEDANCE_KEY);
    const content = (submit.body as { content: Array<{ text: string }> }).content;
    // This vendor's documented convention: `--flag value` inside the prompt text.
    // Unusual enough that a regression would be silent without this assertion.
    expect(content[0]?.text).toContain("--resolution 1080p");
    expect(content[0]?.text).toContain("--duration 6");
    expect(content[0]?.text).toContain("--ratio 16:9");
    expect(content[0]?.text).toContain("Wide shot of a kitchen worktop");

    expect((net.calls[1] as Call).url).toContain("/contents/generations/tasks/ark-1");

    expect(clip.provider).toBe("seedance");
    expect(clip.modelId).toBe("tal/3.0");
    expect(clip.durationMs).toBe(6_000);
    expect(clip.providerAssetId).toBe("seedance:ark-1");
    expect(clip.license).toContain("Tal 3.0 — Cinematic Model");
    expect(net.allowed[0]).toContain("volces.com");
  });

  it("generates all three aspect ratios, including square", async () => {
    for (const [format, ratio] of [
      ["landscape", "16:9"],
      ["portrait", "9:16"],
      ["square", "1:1"],
    ] as const) {
      net.calls = [];
      net.replies = [
        { id: `ark-${format}` },
        { status: "succeeded", content: { video_url: "https://tos.volces.com/f.mp4" } },
      ];
      await generateClip(request({ modelId: "tal/3.0", format }), USAGE);
      const content = ((net.calls[0] as Call).body as { content: Array<{ text: string }> })
        .content;
      expect(content[0]?.text).toContain(`--ratio ${ratio}`);
    }
  });

  it("caps a long scene at the model's longest clip", async () => {
    net.replies = [
      { id: "ark-long" },
      { status: "succeeded", content: { video_url: "https://tos.volces.com/l.mp4" } },
    ];
    // A 40-second scene: capped at 12s and the renderer fills the remainder — final
    // assembly stays the worker's job.
    const clip = await generateClip(
      request({ modelId: "tal/3.0", durationMs: 40_000 }),
      USAGE,
    );
    expect(((net.calls[0] as Call).body as { content: Array<{ text: string }> }).content[0]?.text)
      .toContain("--duration 12");
    expect(clip.durationMs).toBe(12_000);
  });

  it("uses the vendor's own resolution token for a draft", async () => {
    net.replies = [
      { id: "ark-draft" },
      { status: "succeeded", content: { video_url: "https://tos.volces.com/d.mp4" } },
    ];
    await generateClip(request({ modelId: "tal/3.0", quality: "draft" }), USAGE);
    // 480p, not "draft" — the vocabulary is Tally's and the token is the vendor's.
    expect(((net.calls[0] as Call).body as { content: Array<{ text: string }> }).content[0]?.text)
      .toContain("--resolution 480p");
  });

  it("classifies a moderation failure as permanent", async () => {
    net.replies = [
      { id: "ark-refused" },
      {
        status: "failed",
        error: { code: "SensitiveContentDetected", message: "moderation rejected" },
      },
    ];
    await expect(
      generateClip(request({ modelId: "tal/3.0" }), USAGE),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("sends a still as ordinary JSON, not as text commands (§5)", async () => {
    net.assetType = "image/png";
    net.replies = [{ data: [{ url: "https://tos.volces.com/i/ref.png" }] }];

    const image = await generateImage(
      imageRequest({ modelId: "tal/3.0", purpose: "environment" }),
      USAGE,
    );

    // One call and a different route shape from the video family: the `--flag`
    // convention applies to the video endpoint only, so a still that carried the
    // commands in its prompt would ask for a picture of the words.
    expect(net.calls).toHaveLength(1);
    const submit = net.calls[0] as Call;
    expect(submit.method).toBe("POST");
    expect(submit.url).toBe(
      "https://ark.ap-southeast.volces.com/api/v3/images/generations",
    );
    expect(submit.headers["authorization"]).toContain(FAKE_SEEDANCE_KEY);
    const body = submit.body as Record<string, unknown>;
    expect(body["model"]).toBe("doubao-seedream-3-0-t2i-250415");
    expect(body["size"]).toBe("1920x1080");
    expect(body["watermark"]).toBe(false);
    expect(String(body["prompt"])).not.toContain("--");

    expect(image.provider).toBe("seedance");
    expect(image.modelId).toBe("tal/3.0");
    expect(image.purpose).toBe("environment");
    expect(image.width).toBe(1_920);
    expect(image.height).toBe(1_080);
    expect(image.providerAssetId).toBeNull();
    expect(image.license).toContain("Tal 3.0 — Cinematic Model");
    expect(net.allowed[0]).toContain("volces.com");
  });

  it("keeps every still side inside the vendor's 512..2048 window", async () => {
    for (const [format, quality, size] of [
      ["landscape", "720p", "1280x720"],
      ["portrait", "720p", "720x1280"],
      ["square", "1080p", "1080x1080"],
    ] as const) {
      net.calls = [];
      net.assetType = "image/png";
      net.replies = [{ data: [{ url: "https://tos.volces.com/i/s.png" }] }];
      await generateImage(
        imageRequest({ modelId: "tal/3.0", format, quality }),
        USAGE,
      );
      expect((net.calls[0] as Call).body).toMatchObject({ size });
    }
  });

  it("offers no draft still, because a reference image is kept and re-read", async () => {
    // A draft clip is thrown away after a look; a draft character sheet would
    // degrade every scene that later consults it.
    await expect(
      generateImage(imageRequest({ modelId: "tal/3.0", quality: "draft" }), USAGE),
    ).rejects.toMatchObject({ status: 400, retryable: false });
    // The same tier is fine for a clip on this model, so the two lists differ on
    // purpose rather than by omission.
    expect(resolveModel("tal/3.0").model.capabilities.qualities).toContain("draft");
    expect(net.calls).toEqual([]);
  });

  it("surfaces an image-route error carried in a 200 body", async () => {
    net.replies = [
      { error: { code: "OutputImageSensitiveContentDetected", message: "policy" } },
    ];
    await expect(
      generateImage(imageRequest({ modelId: "tal/3.0" }), USAGE),
    ).rejects.toMatchObject({ retryable: false });

    net.replies = [{ data: [] }];
    await expect(
      generateImage(imageRequest({ modelId: "tal/3.0" }), USAGE),
    ).rejects.toMatchObject({ retryable: false });
  });
});

describe("Tal 3.1 on its vendor API (§15)", () => {
  beforeEach(() => {
    configure(ALL_KEYS);
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

    const clip = await generateClip(request({ modelId: "tal/3.1" }), USAGE);

    expect(clip.provider).toBe("veo");
    expect(clip.modelId).toBe("tal/3.1");
    expect(clip.providerAssetId).toBe("veo:op-9");
    expect(clip.license).toContain("Tal 3.1 — Ultra Model");
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
    await generateClip(request({ modelId: "tal/3.1", format: "portrait" }), USAGE);

    const params = ((net.calls[0] as Call).body as { parameters: Record<string, unknown> })
      .parameters;
    // A generated likeness in a published video is a rights problem.
    expect(params["personGeneration"]).toBe("dont_allow");
    expect(params["aspectRatio"]).toBe("9:16");
    expect(params["resolution"]).toBe("1080p");
    expect(params["durationSeconds"]).toBe("6");
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
    // 11s is closest to 8, the longest this model produces.
    const clip = await generateClip(
      request({ modelId: "tal/3.1", durationMs: 11_000 }),
      USAGE,
    );
    expect(clip.durationMs).toBe(8_000);
  });

  it("refuses square with the actual reason instead of cropping (§4)", async () => {
    await expect(
      generateClip(request({ modelId: "tal/3.1", format: "square" }), USAGE),
    ).rejects.toMatchObject({ status: 400, retryable: false });
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
      generateClip(request({ modelId: "tal/3.1" }), USAGE),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("treats an operation error as permanent and a missing name as retryable", async () => {
    net.replies = [{ name: "op-err" }, { error: { code: 13, message: "internal" } }];
    await expect(
      generateClip(request({ modelId: "tal/3.1" }), USAGE),
    ).rejects.toMatchObject({ retryable: false });

    net.replies = [{ done: false }];
    await expect(
      generateClip(request({ modelId: "tal/3.1" }), USAGE),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("generates a 2K still on the same credential as the video (§15)", async () => {
    // §15 forbids a duplicate Gemini integration. The image half is a second method
    // on the same provider, reading the same key — asserted by generating a still
    // with no additional configuration beyond what the video path needed.
    net.replies = [
      {
        predictions: [
          { bytesBase64Encoded: Buffer.from("not-a-real-png").toString("base64"), mimeType: "image/png" },
        ],
      },
    ];

    const image = await generateImage(
      imageRequest({ modelId: "tal/3.1", purpose: "thumbnail", quality: "2k" }),
      USAGE,
    );

    const submit = net.calls[0] as Call;
    expect(submit.url).toContain(":predict");
    expect(submit.url).not.toContain(":predictLongRunning");
    expect(submit.headers["x-goog-api-key"]).toBe(FAKE_GEMINI_KEY);
    const params = (submit.body as { parameters: Record<string, unknown> }).parameters;
    expect(params["sampleImageSize"]).toBe("2K");
    expect(params["personGeneration"]).toBe("dont_allow");

    expect(image.provider).toBe("veo");
    expect(image.purpose).toBe("thumbnail");
    expect(image.width).toBe(2_560);
    expect(image.height).toBe(1_440);
    // Bytes arrive inline, so nothing was downloaded and there is no vendor-side id.
    expect(net.fetched).toEqual([]);
    expect(image.providerAssetId).toBeNull();
    expect(image.bytes.toString()).toBe("not-a-real-png");
  });

  it("treats an image filtered by policy as a permanent refusal", async () => {
    net.replies = [
      { predictions: [{ raiFilteredReason: "Policy: person generation" }] },
    ];
    await expect(
      generateImage(imageRequest({ modelId: "tal/3.1" }), USAGE),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("does not reuse the YouTube OAuth client (§15)", () => {
    // §15 forbids duplicating Google authentication. This needs a *different*
    // credential for a different Google API, and the operator report says so rather
    // than leaving someone to discover it.
    const status = videoGenStatuses().find((s) => s.provider === "veo");
    expect(status?.requiredEnvVars).toEqual(["GEMINI_API_KEY"]);
    expect(status?.serviceNote).toMatch(/GOOGLE_CLIENT_ID/);
    expect(status?.serviceNote).toMatch(/cannot authenticate Veo/i);
  });
});

// ---------------------------------------------------------------------------
// §21 — credentials, and the placeholder
// ---------------------------------------------------------------------------

describe("credential handling (§21)", () => {
  it("refuses to generate once a key is removed", async () => {
    // Days can pass between selecting a model and rendering with it, and a
    // credential can be rotated away in between.
    configure({ VIDEO_GEN_PROVIDERS: "seedance", SEEDANCE_API_KEY: undefined });
    await expect(
      generateClip(request({ modelId: "tal/3.0" }), USAGE),
    ).rejects.toBeInstanceOf(NotConfiguredError);
    // Nothing was sent: the refusal is before the first call, not after it.
    expect(net.calls).toEqual([]);
  });

  it("names the branded model in a configuration error, not the vendor (§3)", async () => {
    configure({ VIDEO_GEN_PROVIDERS: "seedance", SEEDANCE_API_KEY: undefined });
    let thrown: unknown;
    try {
      await generateClip(request({ modelId: "tal/3.0" }), USAGE);
    } catch (error) {
      thrown = error;
    }
    // A NotConfiguredError reaches a user, so the *provider* field is the branded
    // name. The variable names are the point of the message and are not branding.
    const body = JSON.stringify(
      (thrown as NotConfiguredError).toResponseBody(),
    );
    expect(body).toContain("SEEDANCE_API_KEY");
    expect(body).not.toMatch(/volcengine/i);
  });

  it("puts every key in a header and never in a URL or a returned asset", async () => {
    configure(ALL_KEYS);

    const runs: Array<[string, unknown[], string]> = [
      [
        "tal/1.0",
        [
          { output: { task_id: "k1" } },
          { output: { task_status: "SUCCEEDED", video_url: "https://oss.aliyuncs.com/k.mp4" } },
        ],
        FAKE_DASHSCOPE_KEY,
      ],
      [
        "tal/2.0",
        [
          { task_id: "k2", base_resp: { status_code: 0 } },
          { status: "Success", file_id: "f2" },
          { file: { download_url: "https://cdn.minimaxi.chat/k.mp4" } },
        ],
        FAKE_MINIMAX_KEY,
      ],
      [
        "tal/3.0",
        [
          { id: "k3" },
          { status: "succeeded", content: { video_url: "https://tos.volces.com/k.mp4" } },
        ],
        FAKE_SEEDANCE_KEY,
      ],
      [
        "tal/3.1",
        [
          { name: "op-k4" },
          {
            done: true,
            response: {
              generateVideoResponse: {
                generatedSamples: [
                  { video: { uri: "https://generativelanguage.googleapis.com/k" } },
                ],
              },
            },
          },
        ],
        FAKE_GEMINI_KEY,
      ],
    ];

    for (const [modelId, replies, key] of runs) {
      net.calls = [];
      net.replies = [...replies];
      const clip = await generateClip(request({ modelId }), USAGE);

      // Authorisation travels as a header, not in a query string that would be
      // logged by every proxy in between.
      const headers = JSON.stringify((net.calls[0] as Call).headers);
      expect(headers, modelId).toContain(key);
      for (const call of net.calls) expect(call.url, modelId).not.toContain(key);
      // The clip is persisted and its meta is rendered; neither may carry the key.
      const { bytes, ...rest } = clip;
      expect(bytes.byteLength).toBeGreaterThan(0);
      expect(JSON.stringify(rest), modelId).not.toContain(key);
    }
  });
});

describe("the development placeholder", () => {
  beforeEach(() => {
    configure({ TALLY_USE_MOCK_PROVIDERS: "true" });
  });

  it("is honest about not being a video", async () => {
    const clip = await generateClip(request({ modelId: "mock/placeholder" }), USAGE);
    // A still, declared as a still, licensed as unpublishable. Nothing here claims
    // a video was generated when it was not.
    expect(clip.mimeType).toBe("image/png");
    expect(clip.extension).toBe("png");
    expect(clip.durationMs).toBeNull();
    expect(clip.license).toMatch(/not for publication/i);
    // And it reached no network: no queued reply was consumed.
    expect(net.calls).toEqual([]);
    expect(net.fetched).toEqual([]);
  });

  it("exercises the image path without a paid call (§5)", async () => {
    const image = await generateImage(
      imageRequest({ modelId: "mock/placeholder", purpose: "prop", index: 4 }),
      USAGE,
    );
    expect(image.purpose).toBe("prop");
    expect(image.mimeType).toBe("image/png");
    expect(image.bytes.byteLength).toBeGreaterThan(0);
    expect(image.license).toMatch(/not for publication/i);
    expect(net.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §18 — no live calls
// ---------------------------------------------------------------------------

describe("test-suite discipline (§18, §19)", () => {
  it("reaches a provider only through the two seams this file replaces", () => {
    // §18 forbids real video-generation requests. Rather than trusting that, this
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

  it("keeps the retired aggregator out of the module entirely (§14)", () => {
    const source = readFileSync(
      new URL("../providers/video-gen.ts", import.meta.url),
      "utf8",
    );
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // §14: the old video route is removed, not merely unreferenced. The only
    // surviving mentions are the alias keys that keep saved projects rendering,
    // which are string literals under `MODEL_ALIASES` and reach no endpoint.
    expect(stripped).not.toContain("queue.fal.run");
    expect(stripped).not.toContain("FAL_KEY");
    expect(stripped).not.toContain("fal.media");
  });
});

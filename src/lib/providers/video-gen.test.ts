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
 *  - **A declared reference-image capability is a claim about a request body** (§6,
 *    §19). Where a model says it accepts continuity stills, the recorded body is
 *    searched for the actual bytes; where it says it does not, the body is searched to
 *    prove they were stripped before the adapter saw them.
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
    // Tal 3.0 keeps 1080p across the 1.0 → 2.0 move. `SEEDANCE_VIDEO_MODEL` defaults to
    // the Seedance 2.0 *standard* tier, which serves it; the cheaper `-fast-` tier caps
    // at 720p and pinning it is a deployment choosing to lose a resolution.
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
      // No adapter sends a first frame, so §19's "do not fabricate provider
      // capabilities" keeps this false everywhere until one does. Image-to-video is a
      // separate feature from reference images and is not implemented on any model.
      expect(model.capabilities.imageToVideo).toBe(false);
    }
    // Audio is declared only where the vendor actually produces it.
    const audio = new Map(
      availableModels().map((m) => [m.id, m.capabilities.audio]),
    );
    expect(audio.get("tal/3.1")).toBe(true);
    expect(audio.get("tal/1.0")).toBe(false);
  });

  it("declares reference images only where an adapter actually sends them (§6, §19)", () => {
    const references = new Map(
      availableModels().map((m) => [m.id, m.capabilities.referenceImages]),
    );

    // Both of these vendors document a reference-image input on the endpoint and model
    // each adapter actually calls, and both adapters send the bytes. The cases further
    // down prove that rather than trusting these flags.
    expect(references.get("tal/3.1")).toBe(true);
    // Omni reference-to-video, on the Dreamina Seedance 2.0 series: a `reference_image`
    // role on an `image_url` item of the multimodal content array, 1–9 images.
    expect(references.get("tal/3.0")).toBe(true);

    // The other two vendors do offer *something* in this area, and none of it is
    // reachable from the endpoint and model each adapter uses:
    //  - Tal 1.0's Wan route takes `first_frame`/`last_frame` image-to-video inputs,
    //    at most one of each, on an i2v model — not the configured t2v one — and its
    //    documentation states there is no multi-subject reference support.
    //  - Tal 2.0's reference images are a v2-API feature on MiniMax-H3, and this
    //    adapter is on v1 with Hailuo-02; claiming it would need an endpoint *and* a
    //    model migration, not a flag.
    expect(references.get("tal/1.0")).toBe(false);
    expect(references.get("tal/2.0")).toBe(false);
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

  /** The recorded submit body, typed for the fields these cases read. */
  function arkBody(): {
    model: string;
    content: Array<Record<string, unknown>>;
    resolution: string;
    duration: number;
    ratio: string;
    watermark: boolean;
    generate_audio: boolean;
  } {
    return (net.calls[0] as Call).body as ReturnType<typeof arkBody>;
  }

  it("submits parameters in the body, polls and downloads", async () => {
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

    /**
     * Typed body fields, not `--flag` commands inside the prompt.
     *
     * The vendor accepts both forms and they are not equivalent: the body is documented
     * as strictly validated, a flag in the text is "ignored or causes an error", and the
     * 2.0 series renamed the flags (`--rs`, `--rt`, `--dur`) so the long-form commands
     * this adapter once sent would now be dropped in silence. A regression back to text
     * commands would still produce a video — at the wrong resolution and duration.
     */
    const body = arkBody();
    expect(body.model).toBe("dreamina-seedance-2-0-260128");
    // `request()` names no quality, so `assertQuality` resolves the global 1080p default,
    // which this model supports on the standard tier it is configured with.
    expect(body.resolution).toBe("1080p");
    expect(body.duration).toBe(6);
    expect(body.ratio).toBe("16:9");
    expect(body.watermark).toBe(false);
    expect(body.content[0]?.["text"]).toContain("Wide shot of a kitchen worktop");
    expect(JSON.stringify(body)).not.toContain("--");

    /**
     * Audio off explicitly, because the vendor's default is on.
     *
     * Tally lays its own narration over the clip. A vendor soundtrack baked into the
     * video cannot be separated again, so omitting this field would silently ship
     * double audio — and `capabilities.audio` tells the pipeline the clip is silent.
     */
    expect(body.generate_audio).toBe(false);
    expect(resolveModel("tal/3.0").model.capabilities.audio).toBe(false);

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
      expect(arkBody().ratio, format).toBe(ratio);
    }
  });

  it("caps a long scene at the model's longest clip", async () => {
    net.replies = [
      { id: "ark-long" },
      { status: "succeeded", content: { video_url: "https://tos.volces.com/l.mp4" } },
    ];
    // A 40-second scene: capped at 15s — the documented maximum for this family — and
    // the renderer fills the remainder. Final assembly stays the worker's job.
    const clip = await generateClip(
      request({ modelId: "tal/3.0", durationMs: 40_000 }),
      USAGE,
    );
    expect(arkBody().duration).toBe(15);
    expect(clip.durationMs).toBe(15_000);
  });

  it("raises a scene below the vendor's four-second floor", async () => {
    net.replies = [
      { id: "ark-short" },
      { status: "succeeded", content: { video_url: "https://tos.volces.com/s.mp4" } },
    ];
    // The documented range starts at four. A three-second scene rounds up rather than
    // being sent as a duration the vendor rejects.
    const clip = await generateClip(
      request({ modelId: "tal/3.0", durationMs: 3_000 }),
      USAGE,
    );
    expect(arkBody().duration).toBe(4);
    expect(clip.durationMs).toBe(4_000);
  });

  it("uses the vendor's own resolution token for a draft", async () => {
    net.replies = [
      { id: "ark-draft" },
      { status: "succeeded", content: { video_url: "https://tos.volces.com/d.mp4" } },
    ];
    await generateClip(request({ modelId: "tal/3.0", quality: "draft" }), USAGE);
    // 480p, not "draft" — the vocabulary is Tally's and the token is the vendor's.
    expect(arkBody().resolution).toBe("480p");
  });

  it("sends 1080p through, which the default standard tier serves", async () => {
    net.replies = [
      { id: "ark-hd" },
      { status: "succeeded", content: { video_url: "https://tos.volces.com/h.mp4" } },
    ];
    // The tier Tal 3.0 has advertised since it was catalogued. `SEEDANCE_VIDEO_MODEL`
    // defaults to the standard Seedance 2.0 model rather than `-fast-` precisely so this
    // holds: enabling reference-image continuity must not quietly cost a resolution.
    await generateClip(request({ modelId: "tal/3.0", quality: "1080p" }), USAGE);
    expect(arkBody().resolution).toBe("1080p");
  });

  it("refuses 2K rather than generating at a tier no Ark model has", async () => {
    // Refused before a request is made, so the failure is an honest message naming the
    // supported tiers instead of a vendor rejection after credits are committed.
    await expect(
      generateClip(request({ modelId: "tal/3.0", quality: "2k" }), USAGE),
    ).rejects.toMatchObject({ retryable: false, status: 400 });
    expect(net.calls).toHaveLength(0);
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
// §6 — continuity reference stills reaching a vendor
// ---------------------------------------------------------------------------

/**
 * The reuse half of §6, asserted at the only layer where it can be proved.
 *
 * "The model accepts reference images" is a claim about an outbound HTTP body, and the
 * failure it guards against is silent by construction: an adapter that declares support
 * and drops the field produces a *working video*, just one that ignores the stills the
 * workspace paid to generate. Nothing downstream can tell the difference. So these cases
 * read the recorded request body and assert the bytes are in it.
 *
 * Every case is offline. `providers/http` is replaced at the top of this file, so the
 * only thing being asserted is what Tally *would* have sent — which is the strongest
 * honest claim available without spending money, and the only one available at all here
 * since `GEMINI_API_KEY` is a placeholder. Whether the real vendor accepts this body is
 * `verify:video-providers`' question and is not answered anywhere in this file.
 */
describe("continuity reference stills (§6)", () => {
  beforeEach(() => {
    configure(ALL_KEYS);
  });

  /** A finished Veo operation. Two replies: the submit, then one poll. */
  function veoReplies(): unknown[] {
    return [
      { name: "models/veo/operations/op-ref" },
      {
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [
              { video: { uri: "https://generativelanguage.googleapis.com/v1beta/files/r" } },
            ],
          },
        },
      },
    ];
  }

  /** One stored still, with recognisable bytes so the base64 can be identified. */
  function reference(over: Partial<{
    kind: "character" | "environment" | "prop";
    entityId: string;
    bytes: Buffer;
    mimeType: string;
  }> = {}) {
    return {
      kind: "character" as const,
      entityId: "maya",
      bytes: Buffer.from("still-bytes-for-maya"),
      mimeType: "image/png",
      ...over,
    };
  }

  /** The `instances[0]` object of the recorded submit. */
  function instance(): Record<string, unknown> {
    const body = (net.calls[0] as Call).body as {
      instances: Array<Record<string, unknown>>;
    };
    return body.instances[0] as Record<string, unknown>;
  }

  it("sends the still's bytes inline, inside the instance (§6)", async () => {
    net.replies = veoReplies();

    await generateClip(
      request({ modelId: "tal/3.1", referenceImages: [reference()] }),
      USAGE,
    );

    const sent = instance()["referenceImages"] as Array<{
      image: { inlineData: { mimeType: string; data: string } };
      referenceType: string;
    }>;

    expect(sent).toHaveLength(1);
    // The actual bytes, not a URL and not a filename. Decoded rather than compared as
    // base64, so the assertion is about the image the vendor receives.
    expect(Buffer.from(sent[0]!.image.inlineData.data, "base64").toString()).toBe(
      "still-bytes-for-maya",
    );
    expect(sent[0]!.image.inlineData.mimeType).toBe("image/png");
    // The only documented reference type: preserve this subject's appearance.
    expect(sent[0]!.referenceType).toBe("asset");

    // Inside the instance beside the prompt — this vendor does not read them from
    // `parameters`, and putting them there would be accepted-and-ignored.
    expect(instance()["prompt"]).toContain("Wide shot of a kitchen worktop");
    const params = ((net.calls[0] as Call).body as {
      parameters: Record<string, unknown>;
    }).parameters;
    expect(params["referenceImages"]).toBeUndefined();
  });

  it("never sends a private storage URL in place of the bytes (§21)", async () => {
    net.replies = veoReplies();

    await generateClip(
      request({ modelId: "tal/3.1", referenceImages: [reference()] }),
      USAGE,
    );

    // Tally's stills live in a private bucket. The alternative to inlining would be
    // handing the vendor a signed URL to object storage, which is a credential in a
    // request body by another name.
    const serialised = JSON.stringify((net.calls[0] as Call).body);
    expect(serialised).not.toContain("http://");
    expect(serialised).not.toContain("X-Amz-Signature");
    expect(serialised).not.toContain("storageKey");
  });

  it("omits the field entirely when the scene has no references", async () => {
    net.replies = veoReplies();

    await generateClip(request({ modelId: "tal/3.1" }), USAGE);

    // Absent rather than `[]`. An empty array is a different request to a vendor that
    // gates behaviour on the field's presence, and this is the ordinary path — most
    // scenes on most projects have no stored stills.
    expect(instance()).not.toHaveProperty("referenceImages");
    expect(Object.keys(instance())).toEqual(["prompt"]);
  });

  it("caps the request at the three stills the vendor accepts, keeping priority order", async () => {
    net.replies = veoReplies();

    // `referencesForScene` emits characters, then the environment, then props — so the
    // props are what a cap should drop.
    await generateClip(
      request({
        modelId: "tal/3.1",
        referenceImages: [
          reference({ entityId: "maya", bytes: Buffer.from("a") }),
          reference({ entityId: "sam", bytes: Buffer.from("b") }),
          reference({ kind: "environment", entityId: "kitchen", bytes: Buffer.from("c") }),
          reference({ kind: "prop", entityId: "kettle", bytes: Buffer.from("d") }),
        ],
      }),
      USAGE,
    );

    const sent = instance()["referenceImages"] as Array<{
      image: { inlineData: { data: string } };
    }>;
    // Truncated, not rejected: a fourth would have the vendor refuse the whole request
    // after the scene's credits were already committed.
    expect(sent).toHaveLength(3);
    expect(
      sent.map((s) => Buffer.from(s.image.inlineData.data, "base64").toString()),
    ).toEqual(["a", "b", "c"]);
  });

  it("skips a still whose stored format the vendor does not take", async () => {
    net.replies = veoReplies();

    const clip = await generateClip(
      request({
        modelId: "tal/3.1",
        referenceImages: [
          reference({ mimeType: "image/webp", bytes: Buffer.from("webp") }),
          reference({ entityId: "sam", mimeType: "image/jpeg", bytes: Buffer.from("jpeg") }),
        ],
      }),
      USAGE,
    );

    const sent = instance()["referenceImages"] as Array<{
      image: { inlineData: { mimeType: string; data: string } };
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.image.inlineData.mimeType).toBe("image/jpeg");
    // The scene still renders. A reference that cannot be sent degrades to the textual
    // continuity every other model relies on — it does not fail the build.
    expect(clip.modelId).toBe("tal/3.1");
  });

  it("skips an implausibly large still rather than building a body to be rejected", async () => {
    net.replies = veoReplies();

    const clip = await generateClip(
      request({
        modelId: "tal/3.1",
        referenceImages: [
          // Larger than anything `executeReferenceImages` produces. Base64 inflates by
          // a third and three stills share one request body.
          reference({ bytes: Buffer.alloc(7 * 1_048_576, 1) }),
          // And an empty one: a zero-byte asset is a storage fault, not an image.
          reference({ entityId: "sam", bytes: Buffer.alloc(0) }),
          reference({ entityId: "ana", bytes: Buffer.from("small-and-fine") }),
        ],
      }),
      USAGE,
    );

    const sent = instance()["referenceImages"] as Array<{
      image: { inlineData: { data: string } };
    }>;
    expect(sent).toHaveLength(1);
    expect(Buffer.from(sent[0]!.image.inlineData.data, "base64").toString()).toBe(
      "small-and-fine",
    );
    expect(clip.modelId).toBe("tal/3.1");
  });

  it("normalises image/jpg to the mime type the vendor documents", async () => {
    net.replies = veoReplies();

    await generateClip(
      request({ modelId: "tal/3.1", referenceImages: [reference({ mimeType: "image/jpg" })] }),
      USAGE,
    );

    const sent = instance()["referenceImages"] as Array<{
      image: { inlineData: { mimeType: string } };
    }>;
    expect(sent[0]!.image.inlineData.mimeType).toBe("image/jpeg");
  });

  it("relaxes personGeneration only on the reference path, because the vendor requires it", async () => {
    net.replies = veoReplies();
    await generateClip(
      request({ modelId: "tal/3.1", referenceImages: [reference()] }),
      USAGE,
    );

    // The vendor documents `allow_adult` as the *only* accepted value once
    // `referenceImages` is present. `dont_allow` here would not be a stricter request —
    // it would be a rejected one. Every still Tally sends was drawn from Tally's own
    // story bible, so the subject preserved is a generated character.
    const withRefs = ((net.calls[0] as Call).body as {
      parameters: Record<string, unknown>;
    }).parameters;
    expect(withRefs["personGeneration"]).toBe("allow_adult");

    // And the ordinary text-to-video path is untouched.
    net.calls = [];
    net.replies = veoReplies();
    await generateClip(request({ modelId: "tal/3.1" }), USAGE);
    const withoutRefs = ((net.calls[0] as Call).body as {
      parameters: Record<string, unknown>;
    }).parameters;
    expect(withoutRefs["personGeneration"]).toBe("dont_allow");
  });

  it("sends nothing when the operator has pinned a Veo version without the feature", async () => {
    // The vendor gates reference images on the model version, and GEMINI_VEO_MODEL is
    // operator-configurable. A deployment on Veo 3 must get textual continuity rather
    // than have every scene rejected for carrying an unknown field.
    for (const model of ["veo-3.0-generate-001", "veo-2.0-generate-001", "veo-3.1-lite"]) {
      configure({ ...ALL_KEYS, GEMINI_VEO_MODEL: model });
      net.calls = [];
      net.replies = veoReplies();

      const clip = await generateClip(
        request({ modelId: "tal/3.1", referenceImages: [reference()] }),
        USAGE,
      );

      expect(instance(), model).not.toHaveProperty("referenceImages");
      // Still `dont_allow`: nothing was sent, so there is no reason to relax it.
      expect(
        (((net.calls[0] as Call).body as { parameters: Record<string, unknown> })
          .parameters)["personGeneration"],
        model,
      ).toBe("dont_allow");
      // The scene renders regardless.
      expect(clip.modelId, model).toBe("tal/3.1");
    }
  });

  it("sends them on the fast 3.1 variant too", async () => {
    configure({ ...ALL_KEYS, GEMINI_VEO_MODEL: "veo-3.1-fast-generate-preview" });
    net.replies = veoReplies();

    await generateClip(
      request({ modelId: "tal/3.1", referenceImages: [reference()] }),
      USAGE,
    );

    expect(instance()["referenceImages"]).toHaveLength(1);
    expect((net.calls[0] as Call).url).toContain("veo-3.1-fast-generate-preview");
  });

  it("strips references before an adapter that cannot use them ever sees one", async () => {
    /**
     * The contract `generateClip` enforces for every model that does not declare the
     * capability. Asserted on Tal 2.0: its vendor's reference support is a different API
     * version, so if the normalisation regressed the bytes would arrive at an adapter
     * with nowhere to put them and be dropped silently rather than loudly.
     */
    net.replies = [
      { task_id: "mm-ref", base_resp: { status_code: 0 } },
      { status: "Success", file_id: "f-ref" },
      { file: { download_url: "https://cdn.minimaxi.chat/r.mp4" } },
    ];

    await generateClip(
      request({ modelId: "tal/2.0", referenceImages: [reference()] }),
      USAGE,
    );

    const serialised = JSON.stringify((net.calls[0] as Call).body);
    expect(serialised).not.toContain("still-bytes-for-maya");
    expect(serialised).not.toContain(Buffer.from("still-bytes-for-maya").toString("base64"));
    expect(serialised).not.toContain("referenceImages");
    expect(serialised).not.toContain("maya");
  });

  it("charges the same for a scene whether or not stills were sent", async () => {
    // References are a constraint on the generation, not a billable extra. A vendor
    // that priced them separately would need a pricing change rather than a silent one.
    net.replies = veoReplies();
    const plain = await generateClip(request({ modelId: "tal/3.1" }), USAGE);

    net.replies = veoReplies();
    const constrained = await generateClip(
      request({ modelId: "tal/3.1", referenceImages: [reference()] }),
      USAGE,
    );

    expect(constrained.durationMs).toBe(plain.durationMs);
    expect(constrained.modelId).toBe(plain.modelId);
  });
});

/**
 * The same half of §6 on the other vendor that signed for it.
 *
 * A separate block because nothing is shared with Veo's: this vendor takes the stills in
 * the multimodal `content` array beside the prompt, as `data:` URIs with a sibling `role`,
 * and resolves them positionally from the prompt text. Every case is offline — the HTTP
 * layer is replaced at the top of this file — so what is asserted is the body Tally
 * *would* send. Whether the live vendor accepts it is `verify:video-providers`' question
 * and is not answered here.
 */
describe("continuity reference stills on Tal 3.0 (§6)", () => {
  beforeEach(() => {
    configure(ALL_KEYS);
  });

  /** A submitted-then-finished Ark task. */
  function arkReplies(): unknown[] {
    return [
      { id: "ark-ref" },
      { status: "succeeded", content: { video_url: "https://tos.volces.com/r.mp4" } },
    ];
  }

  function reference(over: Partial<{
    kind: "character" | "environment" | "prop";
    entityId: string;
    bytes: Buffer;
    mimeType: string;
  }> = {}) {
    return {
      kind: "character" as const,
      entityId: "maya",
      bytes: Buffer.from("still-bytes-for-maya"),
      mimeType: "image/png",
      ...over,
    };
  }

  /** The `content` array of the recorded submit. */
  function content(): Array<Record<string, unknown>> {
    return ((net.calls[0] as Call).body as {
      content: Array<Record<string, unknown>>;
    }).content;
  }

  /** Only the reference items, in order. */
  function sent(): Array<{ image_url: { url: string }; role: string; type: string }> {
    return content().filter((item) => item["type"] === "image_url") as Array<{
      image_url: { url: string };
      role: string;
      type: string;
    }>;
  }

  it("sends the still as a data URI in the content array, with the documented role", async () => {
    net.replies = arkReplies();

    await generateClip(
      request({ modelId: "tal/3.0", referenceImages: [reference()] }),
      USAGE,
    );

    const images = sent();
    expect(images).toHaveLength(1);
    expect(images[0]!.type).toBe("image_url");
    // Omni reference-to-video. A sibling of `image_url`, not a field inside it.
    expect(images[0]!.role).toBe("reference_image");
    expect(images[0]!.image_url).not.toHaveProperty("role");

    // The actual bytes, decoded rather than compared as base64, so the assertion is
    // about the image the vendor receives.
    const url = images[0]!.image_url.url;
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(
      Buffer.from(url.slice("data:image/png;base64,".length), "base64").toString(),
    ).toBe("still-bytes-for-maya");

    // Beside the prompt in the same array, which is where this vendor reads them from.
    expect(content()[0]?.["type"]).toBe("text");
  });

  it("names each reference positionally in the prompt, or the vendor ignores it", async () => {
    net.replies = arkReplies();

    await generateClip(
      request({
        modelId: "tal/3.0",
        referenceImages: [
          reference(),
          reference({ kind: "environment", entityId: "kitchen" }),
        ],
      }),
      USAGE,
    );

    /**
     * The documented resolution rule: "Image n" means the nth `image_url` item of the
     * content array. A body carrying stills whose prompt never names them is a no-op at
     * the vendor — accepted and ignored — which is the silent failure this whole §6
     * apparatus exists to prevent, so the naming is asserted as strictly as the bytes.
     */
    const text = content()[0]?.["text"] as string;
    expect(text).toContain("Image 1");
    expect(text).toContain("Image 2");
    expect(text).not.toContain("Image 3");
    expect(text).toContain("Wide shot of a kitchen worktop");
    // Numbered from one, in array order, so the prompt and the array cannot disagree.
    expect(text.indexOf("Image 1")).toBeLessThan(text.indexOf("Image 2"));
    expect(sent()).toHaveLength(2);
  });

  it("never sends a private storage URL in place of the bytes (§21)", async () => {
    net.replies = arkReplies();

    await generateClip(
      request({ modelId: "tal/3.0", referenceImages: [reference()] }),
      USAGE,
    );

    /**
     * Tally's stills live in a private MinIO bucket the vendor cannot reach. The vendor
     * also accepts a fetchable URL here, which is exactly the wrong choice: it would
     * mean either publishing the bucket or putting a signed storage URL in a third
     * party's request body, which is a credential by another name.
     */
    const serialised = JSON.stringify((net.calls[0] as Call).body);
    expect(serialised).not.toContain("http://");
    expect(serialised).not.toContain("https://");
    expect(serialised).not.toContain("X-Amz-Signature");
    expect(serialised).not.toContain("storageKey");
    expect(serialised).not.toContain("localhost");
    expect(serialised).not.toContain("9000");
  });

  it("omits the images and the naming entirely when a scene has no references", async () => {
    net.replies = arkReplies();

    await generateClip(request({ modelId: "tal/3.0" }), USAGE);

    // The ordinary path: most scenes have no stored stills, and this request must stay
    // byte-identical to what a text-to-video submit always was.
    expect(content()).toHaveLength(1);
    expect(content()[0]?.["type"]).toBe("text");
    expect(content()[0]?.["text"]).not.toContain("Image 1");
    expect(JSON.stringify((net.calls[0] as Call).body)).not.toContain("reference_image");
  });

  it("caps the set at four and keeps the continuity engine's priority order", async () => {
    net.replies = arkReplies();

    /**
     * `referencesForScene` emits characters, then the environment, then props, and this
     * adapter must not reorder them: the cap is a prefix of that list, so the least
     * important reference is the one dropped. Six distinguishable stills go in; the
     * first four come out, in the same order.
     */
    await generateClip(
      request({
        modelId: "tal/3.0",
        referenceImages: ["a", "b", "c", "d", "e", "f"].map((id) =>
          reference({ entityId: id, bytes: Buffer.from(`still-${id}`) }),
        ),
      }),
      USAGE,
    );

    const images = sent();
    expect(images).toHaveLength(4);
    const decoded = images.map((image) =>
      Buffer.from(image.image_url.url.split(",")[1]!, "base64").toString(),
    );
    expect(decoded).toEqual(["still-a", "still-b", "still-c", "still-d"]);
  });

  it("skips a still the vendor would reject rather than failing the scene", async () => {
    net.replies = arkReplies();

    const clip = await generateClip(
      request({
        modelId: "tal/3.0",
        referenceImages: [
          reference(),
          // Documented formats are jpeg/png/webp/bmp/tiff/gif; a TIFF is accepted by the
          // vendor but nothing in this repository writes one, so it is not in the list.
          reference({ entityId: "svg", mimeType: "image/svg+xml" }),
          // Empty bytes: a stored asset that failed to download.
          reference({ entityId: "empty", bytes: Buffer.alloc(0) }),
          // Over the size ceiling, which sits under the vendor's 30 MB so that base64
          // inflation cannot carry a passing image over the real limit.
          reference({ entityId: "huge", bytes: Buffer.alloc(23 * 1_048_576, 1) }),
        ],
      }),
      USAGE,
    );

    // One usable still sent, three skipped, and the scene still rendered — the same
    // degradation as having no still at all, rather than losing the clip and the credits.
    expect(sent()).toHaveLength(1);
    expect(content()[0]?.["text"]).toContain("Image 1");
    expect(content()[0]?.["text"]).not.toContain("Image 2");
    expect(clip.modelId).toBe("tal/3.0");
  });

  it("accepts a webp still and canonicalises an image/jpg label", async () => {
    net.replies = arkReplies();

    await generateClip(
      request({
        modelId: "tal/3.0",
        referenceImages: [
          reference({ entityId: "w", mimeType: "image/webp" }),
          // A vendor image endpoint that labelled its output `image/jpg`. The documented
          // data URI takes a lower-case media type, and `image/jpg` is not one.
          reference({ entityId: "j", mimeType: "IMAGE/JPG" }),
        ],
      }),
      USAGE,
    );

    const urls = sent().map((image) => image.image_url.url.split(";")[0]);
    expect(urls).toEqual(["data:image/webp", "data:image/jpeg"]);
  });

  it("drops references when the configured model version cannot use them", async () => {
    /**
     * Omni reference-to-video arrived with the Seedance 2.0 series. A deployment still
     * pinned to a 1.0 model must not have its requests carry a role that version never
     * documented — the capability is declared on the model, which describes Tal 3.0
     * rather than one deployment's env, and enforced against the configured id here.
     */
    for (const videoModel of [
      "doubao-seedance-1-0-pro-250528",
      "doubao-seedance-1-0-lite-t2v-250428",
    ]) {
      configure({ ...ALL_KEYS, SEEDANCE_VIDEO_MODEL: videoModel });
      net.calls = [];
      net.replies = arkReplies();

      const clip = await generateClip(
        request({ modelId: "tal/3.0", referenceImages: [reference()] }),
        USAGE,
      );

      const serialised = JSON.stringify((net.calls[0] as Call).body);
      expect(serialised, videoModel).not.toContain("reference_image");
      expect(serialised, videoModel).not.toContain("still-bytes-for-maya");
      expect(content()[0]?.["text"], videoModel).not.toContain("Image 1");
      // And the scene still renders, on textual continuity.
      expect(clip.modelId, videoModel).toBe("tal/3.0");
    }
  });

  it("sends them on any 2.0-series id an operator configures", async () => {
    for (const videoModel of [
      "dreamina-seedance-2-0-fast-260128",
      "dreamina-seedance-2-0-260128",
      "dreamina-seedance-2-0-mini-260615",
    ]) {
      configure({ ...ALL_KEYS, SEEDANCE_VIDEO_MODEL: videoModel });
      net.calls = [];
      net.replies = arkReplies();

      await generateClip(
        request({ modelId: "tal/3.0", referenceImages: [reference()] }),
        USAGE,
      );

      expect(sent(), videoModel).toHaveLength(1);
      expect((net.calls[0] as Call).body, videoModel).toMatchObject({ model: videoModel });
    }
  });

  it("keeps the vendor's name and the still's storage identity out of the prompt (§3)", async () => {
    net.replies = arkReplies();

    await generateClip(
      request({ modelId: "tal/3.0", referenceImages: [reference()] }),
      USAGE,
    );

    // The naming sentence is generated text that reaches a vendor, and it is built from
    // the array rather than from entity ids — a prompt naming "maya" would leak a
    // workspace's internal identifiers into a third party's logs.
    const text = content()[0]?.["text"] as string;
    expect(text).not.toContain("maya");
    for (const forbidden of FORBIDDEN_NAMES) expect(text).not.toMatch(forbidden);
  });

  it("charges the same for a scene whether or not stills were sent", async () => {
    // References constrain the generation; they are not a billable extra. Same duration
    // and model, so `creditCostFor` reads identical inputs either way.
    net.replies = arkReplies();
    const plain = await generateClip(request({ modelId: "tal/3.0" }), USAGE);

    net.replies = arkReplies();
    const constrained = await generateClip(
      request({ modelId: "tal/3.0", referenceImages: [reference()] }),
      USAGE,
    );

    expect(constrained.durationMs).toBe(plain.durationMs);
    expect(constrained.modelId).toBe(plain.modelId);
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

// ---------------------------------------------------------------------------
// §6, §19 — the registry cannot claim what no adapter does
// ---------------------------------------------------------------------------

/**
 * `assertRegistryIntegrity` runs at module load, so the registry as configured is
 * already proven consistent by this file importing at all. What these cases add is
 * proof that the check is *load-bearing in both directions* — that it would actually
 * catch the two ways reference support can silently go false, rather than being a
 * comment that happens to be true today.
 *
 * The invariant matters because a capability flag is one line and an adapter is fifty.
 * Flipping the flag alone would have the visuals stage download stills from object
 * storage, attach them to a request, and have the adapter discard them — a workspace
 * charged for reference generations with no consumer, and no symptom beyond continuity
 * being worse than the operator believes.
 */
describe("reference-image registry integrity (§6, §19)", () => {
  beforeEach(() => {
    configure(ALL_KEYS);
  });

  /** The registry source, comments removed so prose cannot satisfy an assertion. */
  function registrySource(): string {
    return readFileSync(new URL("../providers/video-gen.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
  }

  it("checks the flag and the adapter against each other in both directions", () => {
    const stripped = registrySource();
    // A model claiming support with no adapter: stills generated, charged, discarded.
    expect(stripped).toContain(
      "declares reference images but its adapter ignores them",
    );
    // An adapter claiming support with no model: a dead branch that reads as shipped.
    expect(stripped).toContain(
      "accepts reference images but no model declares them",
    );
    // Enforced at load rather than only here, because a test can be skipped.
    expect(stripped).toContain("assertRegistryIntegrity();");
  });

  it("pairs every declaring model with a provider that signed for it", () => {
    // The runtime half of the same invariant, over the live registry rather than its
    // source. `availableModels()` is env-derived, so this covers what this deployment
    // would actually offer.
    const declaring = availableModels().filter(
      (model) => model.capabilities.referenceImages,
    );
    expect(declaring.length).toBeGreaterThan(0);

    // The two adapters that have signed for it. Named explicitly rather than derived
    // from the flags, so adding a third model without an adapter fails here as well as
    // at module load — a list computed from the thing under test asserts nothing.
    const signed = new Map([
      ["tal/3.0", "seedance"],
      ["tal/3.1", "veo"],
    ]);
    expect(declaring.map((model) => model.id).sort()).toEqual([...signed.keys()].sort());

    for (const model of declaring) {
      const { provider } = resolveModel(model.id);
      // The adapter's signature is not readable from outside the module, so the
      // observable consequence is asserted instead: a declaring model's provider must
      // put the bytes in its request body. `resolveModel` proves the pairing exists.
      expect(provider, model.id).toBe(signed.get(model.id));
    }
  });

  it("keeps the capability out of the customer-facing model payload (§3)", () => {
    // A capability flag is an internal fact. The picker renders `strengths` and
    // `limitations`, which say what a customer needs in plain words, and those must not
    // leak the vendor name along with it.
    const serialised = JSON.stringify(publicModels());
    for (const forbidden of FORBIDDEN_NAMES) {
      expect(serialised).not.toMatch(forbidden);
    }
    const ultra = availableModels().find((m) => m.id === "tal/3.1");
    // Stated honestly, including the cap, since §4 requires limitations to be honest.
    expect(ultra?.limitations.join(" ")).toMatch(/three continuity reference stills/i);
  });

  it("still declares image generation for the stage that draws the stills (§5)", () => {
    // The reuse path has a prerequisite: something has to draw a reference before a
    // scene can be shown one. Both halves live on the same model, which is what makes
    // reference continuity work without a second provider.
    const ultra = availableModels().find((m) => m.id === "tal/3.1");
    expect(ultra?.capabilities.imageGeneration).toBe(true);
    expect(ultra?.capabilities.referenceImages).toBe(true);
    // And image-to-video remains a separate, unimplemented feature.
    expect(ultra?.capabilities.imageToVideo).toBe(false);
  });

  it("does not populate the vendor's first-frame field (imageToVideo is separate)", async () => {
    net.replies = [
      { name: "models/veo/operations/op-nf" },
      {
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [
              { video: { uri: "https://generativelanguage.googleapis.com/v1beta/files/n" } },
            ],
          },
        },
      },
    ];

    await generateClip(
      request({
        modelId: "tal/3.1",
        referenceImages: [
          {
            kind: "character" as const,
            entityId: "maya",
            bytes: Buffer.from("still"),
            mimeType: "image/png",
          },
        ],
      }),
      USAGE,
    );

    // This vendor takes a first frame as an instance-level `image`, beside
    // `referenceImages`. Sending one would animate a still rather than generate a shot
    // constrained by it — a different feature with different framing and cost, and out
    // of scope until it is implemented deliberately.
    const body = (net.calls[0] as Call).body as {
      instances: Array<Record<string, unknown>>;
    };
    expect(body.instances[0]).not.toHaveProperty("image");
    expect(body.instances[0]).toHaveProperty("referenceImages");
  });
});

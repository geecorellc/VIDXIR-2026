/**
 * Per-segment voice identity at the provider boundary (§4, §9, §11, §32).
 *
 * `voice.test.ts` covers duration measurement. This file covers the one thing voice
 * continuity added to the adapter: a segment may name its own voice, and the request
 * that goes out must carry *that* voice rather than the batch's.
 *
 * `providers/http` is replaced entirely, so no socket is opened and no ElevenLabs
 * quota is spent. Every URL, header and body the adapter would have sent is recorded
 * and asserted instead, which is the strongest claim a test can make about a paid API
 * without paying for it. The ElevenLabs cases run with a placeholder key — obviously
 * not a credential, and never sent anywhere because nothing here reaches the network.
 *
 * The mock branch is exercised too, and one assertion about it is load-bearing: the
 * mock reports the voice id it was *asked for*. A mock that returned a constant would
 * make every voice-continuity test in the repository pass by accident, since the one
 * thing under test is whether the right id arrives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const net = vi.hoisted(() => ({
  /** One recorded outbound request the adapter would have made. */
  calls: [] as Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }>,
  /**
   * Bytes each reply returns. A real MP3 frame run, so duration parsing works.
   *
   * Annotated, because `Buffer.alloc` narrows to `Buffer<ArrayBuffer>` while
   * `Buffer.concat` widens to `Buffer<ArrayBufferLike>`, and the field has to hold
   * both.
   */
  bytes: Buffer.alloc(0) as Buffer,
}));

vi.mock("@/lib/providers/http", () => ({
  providerJson: () => Promise.reject(new Error("not used by the voice adapter")),
  providerBytes: (request: {
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  }) => {
    net.calls.push({
      url: request.url,
      headers: request.headers ?? {},
      body: (request.body ?? {}) as Record<string, unknown>,
    });
    return Promise.resolve({ bytes: net.bytes, contentType: "audio/mpeg" });
  },
}));

vi.mock("@/lib/providers/usage", () => ({
  // Pass-through. `api_usage` accounting has its own tests and a database is not
  // available in a unit run.
  withUsage: (_ctx: unknown, run: () => Promise<unknown>) => run(),
}));

const { synthesize } = await import("@/lib/providers/voice");

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** What `lib/env` needs before it will parse. Local placeholders only. */
const BASE = {
  DATABASE_URL: "postgresql://vidxir:vidxir@localhost:5432/vidxir_unit",
  REDIS_URL: "redis://127.0.0.1:6379",
  S3_BUCKET: "vidxir-unit",
  S3_ACCESS_KEY_ID: "unit",
  S3_SECRET_ACCESS_KEY: "unit",
  ENCRYPTION_KEY: "a".repeat(64),
  SESSION_SECRET: "b".repeat(64),
} as const;

const MANAGED = [
  "NODE_ENV",
  "VIDXIR_USE_MOCK_PROVIDERS",
  "VOICE_PROVIDER",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_MODEL_ID",
  ...Object.keys(BASE),
] as const;

const original = new Map<string, string | undefined>(
  MANAGED.map((key) => [key, process.env[key]]),
);

function setEnv(key: string, value: string): void {
  // Next declares NODE_ENV readonly in its ambient types; written through the index
  // signature, confined to this helper.
  (process.env as Record<string, string>)[key] = value;
}

/** Obviously a placeholder, so the repository's secret scan has nothing to flag. */
const FAKE_ELEVENLABS_KEY = "elevenlabs-unit-placeholder-not-a-real-key";

function configure(vars: Record<string, string | undefined>): void {
  setEnv("NODE_ENV", "test");
  resetEnvCache();
  for (const key of MANAGED) delete process.env[key];
  const merged = { ...BASE, VIDXIR_USE_MOCK_PROVIDERS: "false", ...vars };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete process.env[key];
    else setEnv(key, value);
  }
  resetEnvCache();
}

/** ElevenLabs configured and selected. No network is reachable from here. */
function withElevenLabs(): void {
  configure({
    VOICE_PROVIDER: "elevenlabs",
    ELEVENLABS_API_KEY: FAKE_ELEVENLABS_KEY,
  });
}

function withMock(): void {
  configure({ VIDXIR_USE_MOCK_PROVIDERS: "true" });
}

/** 40 frames of MPEG-1 Layer III, 128 kbps, 44.1 kHz — a measurable ~1 s. */
function mp3(): Buffer {
  const frameBytes = Math.floor((144 * 128_000) / 44_100);
  const frame = Buffer.alloc(frameBytes);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  return Buffer.concat(Array.from({ length: 40 }, () => frame));
}

const USAGE = { userId: "user-1", projectId: "project-1" };

const PROJECT_VOICE = "voice-unit-placeholder-project";
const MARA_VOICE = "voice-unit-placeholder-mara";
const BEN_VOICE = "voice-unit-placeholder-ben";

beforeEach(() => {
  net.calls = [];
  net.bytes = mp3();
});

afterEach(() => {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else setEnv(key, value);
  }
  resetEnvCache();
});

// ---------------------------------------------------------------------------
// The identity reaches the provider
// ---------------------------------------------------------------------------

describe("per-segment voice identity", () => {
  it("sends each segment to the voice it names", async () => {
    /**
     * The end of the chain: bible → assignment → adapter → request URL.
     *
     * ElevenLabs puts the voice id in the path, so this asserts on the URL. It is the
     * one assertion that proves character voices reach a provider at all — everything
     * upstream could be correct and this still fail if the adapter resolved one voice
     * per batch, which is exactly what it used to do.
     */
    withElevenLabs();

    await synthesize({
      segments: [
        { sceneIndex: 0, text: "Mara speaks first.", voiceId: MARA_VOICE },
        { sceneIndex: 1, text: "Then Ben answers.", voiceId: BEN_VOICE },
        { sceneIndex: 2, text: "And Mara again.", voiceId: MARA_VOICE },
      ],
      voiceId: PROJECT_VOICE,
      usage: USAGE,
    });

    expect(net.calls).toHaveLength(3);
    expect(net.calls[0]?.url).toContain(MARA_VOICE);
    expect(net.calls[1]?.url).toContain(BEN_VOICE);
    expect(net.calls[2]?.url).toContain(MARA_VOICE);
    // The project voice was overridden on every segment, so it appears nowhere.
    expect(net.calls.some((call) => call.url.includes(PROJECT_VOICE))).toBe(false);
  });

  it("falls back to the project voice for a segment that names none", async () => {
    // A bible that voices one character and not another. The unvoiced scenes get the
    // project's voice — the voice they would have had anyway — rather than an error or
    // the other character's id.
    withElevenLabs();

    await synthesize({
      segments: [
        { sceneIndex: 0, text: "Mara speaks.", voiceId: MARA_VOICE },
        { sceneIndex: 1, text: "An unvoiced character answers." },
        { sceneIndex: 2, text: "And another with an explicit null.", voiceId: null },
      ],
      voiceId: PROJECT_VOICE,
      usage: USAGE,
    });

    expect(net.calls[0]?.url).toContain(MARA_VOICE);
    expect(net.calls[1]?.url).toContain(PROJECT_VOICE);
    expect(net.calls[2]?.url).toContain(PROJECT_VOICE);
  });

  it("behaves exactly as before for a request with no per-segment voices", async () => {
    // §25 at the adapter: this is the request shape every existing caller sends, and
    // every segment must still go to the project's one voice.
    withElevenLabs();

    await synthesize({
      segments: [
        { sceneIndex: 0, text: "One." },
        { sceneIndex: 1, text: "Two." },
      ],
      voiceId: PROJECT_VOICE,
      usage: USAGE,
    });

    expect(net.calls.every((call) => call.url.includes(PROJECT_VOICE))).toBe(true);
  });

  it("reports the voice each segment was actually requested with", async () => {
    /**
     * Reported, not assumed.
     *
     * The pipeline stores this on `voiceovers.segments` and the continuity check reads
     * it back. If the adapter echoed the *request* instead of what it resolved, the
     * check would compare the bible with itself and pass for a stage that had ignored
     * the assignment entirely.
     */
    withElevenLabs();

    const result = await synthesize({
      segments: [
        { sceneIndex: 0, text: "Mara speaks.", voiceId: MARA_VOICE },
        { sceneIndex: 1, text: "An unvoiced character answers." },
        // No narration: a title card. Never sent to a provider at all.
        { sceneIndex: 2, text: "   " },
      ],
      voiceId: PROJECT_VOICE,
      usage: USAGE,
    });

    expect(result.segments[0]?.voiceId).toBe(MARA_VOICE);
    expect(result.segments[1]?.voiceId).toBe(PROJECT_VOICE);
    expect(result.segments[2]?.voiceId).toBeNull();
    // The row-level voice is still the project's: on a video with character voices it
    // is the voice every unassigned scene used.
    expect(result.voiceId).toBe(PROJECT_VOICE);
  });

  it("makes exactly one request per narrated scene, and none for a silent one", async () => {
    // §10's cost rule at the boundary. Voice continuity resolves identities from
    // stored data, so it must add no provider calls of its own — not a catalogue
    // lookup, not a validation probe.
    withElevenLabs();

    await synthesize({
      segments: [
        { sceneIndex: 0, text: "One.", voiceId: MARA_VOICE },
        { sceneIndex: 1, text: "", voiceId: BEN_VOICE },
        { sceneIndex: 2, text: "Three.", voiceId: BEN_VOICE },
      ],
      voiceId: PROJECT_VOICE,
      usage: USAGE,
    });

    expect(net.calls).toHaveLength(2);
  });

  it("never puts a credential anywhere but the auth header", async () => {
    // §21. The key is a header, and it must not reach a URL or a body where it could
    // be logged by anything that records either.
    withElevenLabs();

    await synthesize({
      segments: [{ sceneIndex: 0, text: "One.", voiceId: MARA_VOICE }],
      voiceId: PROJECT_VOICE,
      usage: USAGE,
    });

    const call = net.calls[0];
    expect(call?.headers["xi-api-key"]).toBe(FAKE_ELEVENLABS_KEY);
    expect(call?.url).not.toContain(FAKE_ELEVENLABS_KEY);
    expect(JSON.stringify(call?.body)).not.toContain(FAKE_ELEVENLABS_KEY);
  });
});

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

describe("provider-agnostic tuning", () => {
  it("translates the continuity layer's settings into the vendor's field names", async () => {
    /**
     * The division of labour §4 asks for, asserted on the wire.
     *
     * The continuity layer says `similarity`; the only code that knows the field is
     * called `similarity_boost` is the adapter. If those names ever appeared in the
     * bible schema, the continuity layer would have a vendor baked into it.
     */
    withElevenLabs();

    await synthesize({
      segments: [
        {
          sceneIndex: 0,
          text: "One.",
          voiceId: MARA_VOICE,
          tuning: { stability: 0.8, similarity: 0.9, styleIntensity: 0.4, speed: 1.1 },
        },
      ],
      voiceId: PROJECT_VOICE,
      usage: USAGE,
    });

    const settings = net.calls[0]?.body["voice_settings"] as Record<string, number>;
    expect(settings["stability"]).toBe(0.8);
    expect(settings["similarity_boost"]).toBe(0.9);
    expect(settings["style"]).toBe(0.4);
    expect(settings["speed"]).toBeCloseTo(1.1, 5);
  });

  it("sends the vendor's own defaults when the bible tuned nothing", async () => {
    // What makes the tuning additive: an untuned character voice produces exactly the
    // request every Vidxir AI voiceover produced before voice continuity existed.
    withElevenLabs();

    await synthesize({
      segments: [{ sceneIndex: 0, text: "One.", voiceId: MARA_VOICE }],
      voiceId: PROJECT_VOICE,
      usage: USAGE,
    });

    const settings = net.calls[0]?.body["voice_settings"] as Record<string, number>;
    expect(settings["stability"]).toBe(0.5);
    expect(settings["similarity_boost"]).toBe(0.75);
    // Omitted rather than defaulted: sending a neutral `style` would assert a
    // decision nobody made.
    expect("style" in settings).toBe(false);
  });

  it("prefers a segment's tuning over the batch's, and inherits what it omits", async () => {
    withElevenLabs();

    await synthesize({
      segments: [
        { sceneIndex: 0, text: "One.", voiceId: MARA_VOICE, tuning: { stability: 0.2 } },
        { sceneIndex: 1, text: "Two.", voiceId: BEN_VOICE },
      ],
      voiceId: PROJECT_VOICE,
      tuning: { stability: 0.9, similarity: 0.6 },
      usage: USAGE,
    });

    const first = net.calls[0]?.body["voice_settings"] as Record<string, number>;
    const second = net.calls[1]?.body["voice_settings"] as Record<string, number>;

    expect(first["stability"]).toBe(0.2);
    expect(second["stability"]).toBe(0.9);
    expect(second["similarity_boost"]).toBe(0.6);
  });

  it("clamps a tuning value out of range rather than sending a 422", async () => {
    withElevenLabs();

    await synthesize({
      segments: [
        {
          sceneIndex: 0,
          text: "One.",
          voiceId: MARA_VOICE,
          // Out of range in both directions, and a speed past the vendor's window.
          tuning: { stability: 4, similarity: -2, styleIntensity: 9, speed: 8 },
        },
      ],
      voiceId: PROJECT_VOICE,
      usage: USAGE,
    });

    const settings = net.calls[0]?.body["voice_settings"] as Record<string, number>;
    expect(settings["stability"]).toBe(1);
    expect(settings["similarity_boost"]).toBe(0);
    expect(settings["style"]).toBe(1);
    expect(settings["speed"]).toBeLessThanOrEqual(1.2);
  });
});

// ---------------------------------------------------------------------------
// The mock
// ---------------------------------------------------------------------------

describe("the mock branch", () => {
  it("reports the voice it was asked for, so a test cannot pass by accident", async () => {
    /**
     * The most important assertion in this file.
     *
     * Every voice-continuity test that runs under mock providers — the whole
     * integration suite — proves nothing if the mock discards the requested id and
     * reports a constant. It would report perfect voice consistency for a pipeline
     * that sent the wrong voice to every scene.
     */
    withMock();

    const result = await synthesize({
      segments: [
        { sceneIndex: 0, text: "Mara speaks.", voiceId: MARA_VOICE },
        { sceneIndex: 1, text: "Then Ben.", voiceId: BEN_VOICE },
        { sceneIndex: 2, text: "An unvoiced character." },
      ],
      voiceId: PROJECT_VOICE,
      usage: USAGE,
    });

    expect(result.provider).toBe("mock");
    expect(result.segments[0]?.voiceId).toBe(MARA_VOICE);
    expect(result.segments[1]?.voiceId).toBe(BEN_VOICE);
    expect(result.segments[2]?.voiceId).toBe(PROJECT_VOICE);
    expect(result.segments[0]?.voiceId).not.toBe(result.segments[1]?.voiceId);
  });

  it("opens no socket at all", async () => {
    withMock();

    await synthesize({
      segments: [{ sceneIndex: 0, text: "One.", voiceId: MARA_VOICE }],
      voiceId: PROJECT_VOICE,
      usage: USAGE,
    });

    expect(net.calls).toEqual([]);
  });

  it("still produces real audio of a measured length", async () => {
    // §40: the mock produces a real WAV of a real length rather than pretending, so
    // the timeline offsets a mock build computes are plausible and consistent.
    withMock();

    const result = await synthesize({
      segments: [
        { sceneIndex: 0, text: Array.from({ length: 75 }, () => "word").join(" ") },
      ],
      voiceId: PROJECT_VOICE,
      usage: USAGE,
    });

    expect(result.segments[0]?.durationMs).toBeGreaterThan(0);
    expect(result.segments[0]?.bytes.byteLength).toBeGreaterThan(44);
    expect(result.totalDurationMs).toBe(result.segments[0]?.durationMs);
  });
});

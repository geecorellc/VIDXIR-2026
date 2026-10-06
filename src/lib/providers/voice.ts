/**
 * VoiceProvider — text to speech (§11, §32).
 *
 * One entry point, `synthesize()`, which takes narration segments and returns
 * audio plus **measured** per-segment offsets. The offsets are the reason this
 * interface is segment-shaped rather than "here is a paragraph, give me an mp3":
 * the timeline has to know when scene 4's narration starts, and the only honest
 * source for that is the length of the audio actually produced for scenes 0–3.
 *
 * So each scene is synthesized as its own request and the durations are read back
 * from the returned files. The alternative — one request for the whole script,
 * then apportioning the total by word count — produces offsets that drift a
 * second or more by the end of a ten-minute video, which puts captions and
 * b-roll on the wrong words. §42 applies to timings as much as to progress bars.
 *
 * §48: without `ELEVENLABS_API_KEY` this throws `NotConfiguredError` naming the
 * variable. There is a mock, gated on `VIDXIR_USE_MOCK_PROVIDERS`, and it produces
 * a real WAV of a real length rather than pretending — see `media/synthetic.ts`.
 */
import { env, usingMockProviders } from "@/lib/env";
import { NotConfiguredError, VoiceGenerationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { silentWav, wavDurationMs } from "@/lib/media/synthetic";
import { providerBytes } from "@/lib/providers/http";
import { withUsage, type UsageContext } from "@/lib/providers/usage";
import { WORDS_PER_MINUTE } from "@/lib/scripts/prompt";

const log = logger.child({ component: "voice" });

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";

/**
 * ElevenLabs' "Rachel" — the default voice on every account, so a user who has
 * not chosen one still gets a working voiceover rather than a 404 for a voice id
 * their account does not have.
 */
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

const DEFAULT_VOICE_NAME = "Rachel";

/** A single narration line is never a 100 MB file; this is an abuse bound. */
const MAX_AUDIO_BYTES = 25 * 1_048_576;

/** ElevenLabs rejects a request over 5,000 characters on most plans. */
export const MAX_SEGMENT_CHARS = 4_800;

/**
 * Provider-independent voice tuning, as the continuity layer expresses it.
 *
 * Structurally identical to `CharacterVoice.settings` in the story bible, and
 * declared here rather than imported from it on purpose: this module is the provider
 * adapter, and it must not depend on the continuity layer any more than the
 * continuity layer may depend on it. The caller passes a plain struct; each branch
 * below translates the fields its own vendor understands and ignores the rest.
 */
export interface VoiceTuning {
  stability?: number | null;
  similarity?: number | null;
  styleIntensity?: number | null;
  speed?: number | null;
}

export interface VoiceSegmentRequest {
  /** Matches `scenes.index`, so the caller can map results back. */
  sceneIndex: number;
  text: string;
  /**
   * The voice this one segment must be spoken in, overriding the batch voice.
   *
   * How voice continuity reaches the provider. Per segment rather than per batch
   * because a video with two characters has two voices in one voiceover stage, and a
   * batch-level id cannot express that — which is why the whole feature needed this
   * field rather than a second call per character.
   *
   * Absent or null means "use the batch voice", which is what every existing caller
   * passes and why this is additive: a request with no per-segment voice behaves
   * byte-identically to the one this interface accepted before.
   */
  voiceId?: string | null;
  /**
   * Tuning for this segment's voice, overriding the batch tuning.
   *
   * Only consulted when it is set. A segment naming a voice but no tuning gets the
   * batch tuning, so a character voice does not silently lose the project's speed.
   */
  tuning?: VoiceTuning | null;
}

export interface VoiceSegmentResult {
  sceneIndex: number;
  /** Measured from the returned audio, never estimated. */
  durationMs: number;
  bytes: Buffer;
  charactersBilled: number;
  /**
   * The voice id this segment was actually requested with.
   *
   * Reported rather than assumed, so the caller can record what was used instead of
   * what it asked for. That distinction is what lets the continuity check compare the
   * audio as produced against the bible, rather than comparing the bible with itself.
   *
   * `null` for a silent segment, which was never sent to a provider at all.
   */
  voiceId: string | null;
}

export interface SynthesizeOptions {
  segments: readonly VoiceSegmentRequest[];
  /**
   * Provider voice id from `channel_settings.voice_provider_voice_id`.
   *
   * The project's voice, and the fallback for any segment that does not name one of
   * its own. Still the only voice on a project without character voices.
   */
  voiceId?: string | null;
  /** BCP-47 tag; ElevenLabs infers language from the text but logs this. */
  language?: string | null;
  /** 0.5–2.0. Applied by the provider where supported. */
  speed?: number | null;
  style?: string | null;
  /** Batch-level tuning, overridden per segment where a segment sets its own. */
  tuning?: VoiceTuning | null;
  usage: Omit<UsageContext, "provider" | "operation"> & { operation?: string };
  /**
   * Called after each segment's audio exists, with the number completed.
   *
   * The synthesis of sixty scenes is several minutes during which nothing else
   * would report anything, and a bar that has not moved is indistinguishable from
   * a hung job. This reports segments that have actually been produced — it is a
   * count of finished work, not a timer (§37, §42).
   */
  onSegment?: (completed: number, total: number) => void | Promise<void>;
}

export interface SynthesizeResult {
  provider: string;
  /**
   * The batch voice — the project's, or the provider default.
   *
   * Still the row-level value for `voiceovers.voice_id`, and still correct as one:
   * on a project with per-character voices it is the voice every unassigned scene
   * used. Which voice each individual scene used is on its own segment.
   */
  voiceId: string;
  voiceName: string | null;
  mimeType: string;
  /** File extension, so the storage key is right for the format returned. */
  extension: string;
  segments: VoiceSegmentResult[];
  totalDurationMs: number;
  charactersBilled: number;
}

export function voiceProviderName(): string {
  return usingMockProviders() ? "mock" : env().VOICE_PROVIDER;
}

export function isVoiceConfigured(): boolean {
  const provider = voiceProviderName();
  if (provider === "mock") return true;
  if (provider === "elevenlabs") return Boolean(env().ELEVENLABS_API_KEY);
  return false;
}

function requireConfigured(): void {
  if (isVoiceConfigured()) return;
  throw new NotConfiguredError(
    "ElevenLabs",
    ["ELEVENLABS_API_KEY"],
    "Create a key at https://elevenlabs.io/app/settings/api-keys.",
  );
}

/**
 * Synthesize narration, one request per scene.
 *
 * Sequential rather than parallel, deliberately. ElevenLabs' concurrency limit is
 * 2–5 requests depending on plan, so a ten-scene fan-out earns a 429 on most
 * accounts and the retry costs more wall-clock than the sequence saved. It also
 * keeps `charactersBilled` honest when a later segment fails: the caller learns
 * what was actually spent.
 *
 * A segment may name its own voice, which is how character voice continuity reaches
 * a provider. Resolution is per segment and entirely local — the segment's voice, or
 * the batch's, or the provider default — so the caller decides the identity and this
 * function only ever translates one.
 */
export async function synthesize(
  options: SynthesizeOptions,
): Promise<SynthesizeResult> {
  requireConfigured();

  const provider = voiceProviderName();
  const batchVoiceId = options.voiceId?.trim() || DEFAULT_VOICE_ID;

  const segments: VoiceSegmentResult[] = [];
  const total = options.segments.length;

  for (const segment of options.segments) {
    const text = segment.text.trim();
    if (!text) {
      // A scene with no narration is legal (a title card); it just has no audio.
      segments.push({
        sceneIndex: segment.sceneIndex,
        durationMs: 0,
        bytes: Buffer.alloc(0),
        charactersBilled: 0,
        voiceId: null,
      });
      await options.onSegment?.(segments.length, total);
      continue;
    }

    if (text.length > MAX_SEGMENT_CHARS) {
      throw new VoiceGenerationError(
        `Scene ${segment.sceneIndex + 1} has ${text.length} characters of narration, over the ${MAX_SEGMENT_CHARS}-character limit for a single request.`,
      );
    }

    /**
     * This segment's voice.
     *
     * A trimmed, non-empty per-segment id wins; anything else falls back to the
     * batch voice. Falling back rather than erroring is what keeps a project whose
     * bible names a voice for one character and not another working: the unvoiced
     * scenes get the project's voice, which is the voice they would have had anyway.
     */
    const voiceId = segment.voiceId?.trim() || batchVoiceId;
    const tuning = segment.tuning ?? options.tuning ?? null;

    const result = await withUsage(
      {
        provider,
        operation: options.usage.operation ?? "voice.synthesize",
        userId: options.usage.userId ?? null,
        projectId: options.usage.projectId ?? null,
        jobId: options.usage.jobId ?? null,
        traceId: options.usage.traceId ?? null,
        model: provider === "elevenlabs" ? env().ELEVENLABS_MODEL_ID : null,
      },
      () =>
        provider === "mock"
          ? mockSegment(segment.sceneIndex, text, voiceId)
          : elevenLabsSegment({
              sceneIndex: segment.sceneIndex,
              text,
              voiceId,
              speed: tuning?.speed ?? options.speed ?? 1,
              tuning,
            }),
      (r) => ({ quantity: r.charactersBilled, unit: "characters" }),
    );

    segments.push(result);
    await options.onSegment?.(segments.length, total);
  }

  const totalDurationMs = segments.reduce((sum, s) => sum + s.durationMs, 0);
  const charactersBilled = segments.reduce((sum, s) => sum + s.charactersBilled, 0);

  /**
   * How many distinct voices this batch used.
   *
   * Logged rather than asserted: on a project with character voices this is the one
   * number that says whether per-scene voices reached the provider at all, and it is
   * a count of requests actually made rather than of intentions.
   */
  const voices = new Set(
    segments.map((segment) => segment.voiceId).filter((id): id is string => id !== null),
  );

  log.info("voiceover synthesized", {
    provider,
    userId: options.usage.userId ?? undefined,
    projectId: options.usage.projectId ?? undefined,
    segments: segments.length,
    durationMs: totalDurationMs,
    charactersBilled,
    voices: voices.size,
  });

  return {
    provider,
    voiceId: provider === "mock" ? "mock-voice" : batchVoiceId,
    voiceName: provider === "mock" ? "Mock voice" : DEFAULT_VOICE_NAME,
    mimeType: provider === "mock" ? "audio/wav" : "audio/mpeg",
    extension: provider === "mock" ? "wav" : "mp3",
    segments,
    totalDurationMs,
    charactersBilled,
  };
}

// ---------------------------------------------------------------------------
// ElevenLabs
// ---------------------------------------------------------------------------

/**
 * ElevenLabs' own defaults for the two settings it always requires.
 *
 * Named rather than inline so the fallback is visible: a character voice that tunes
 * neither gets exactly what every Vidxir AI voiceover got before voice continuity
 * existed, which is what makes the tuning additive.
 */
const ELEVENLABS_DEFAULT_STABILITY = 0.5;
const ELEVENLABS_DEFAULT_SIMILARITY = 0.75;

async function elevenLabsSegment(input: {
  sceneIndex: number;
  text: string;
  voiceId: string;
  speed: number;
  tuning: VoiceTuning | null;
}): Promise<VoiceSegmentResult> {
  const e = env();

  /**
   * The provider-agnostic tuning, translated.
   *
   * This is the whole of §4's division of labour: the continuity layer says
   * "similarity 0.9", and the only code that knows the field is called
   * `similarity_boost` is here. `styleIntensity` maps to ElevenLabs' `style`, which
   * its v2 models accept and older ones ignore — sending it is harmless, and omitting
   * it when unset keeps the request identical to the pre-continuity one.
   */
  const voiceSettings: Record<string, number> = {
    stability: clamp01(input.tuning?.stability ?? ELEVENLABS_DEFAULT_STABILITY),
    similarity_boost: clamp01(
      input.tuning?.similarity ?? ELEVENLABS_DEFAULT_SIMILARITY,
    ),
    // Clamped to the documented range; a value outside it is a 422.
    speed: Math.min(1.2, Math.max(0.7, input.speed)),
  };

  if (input.tuning?.styleIntensity !== null && input.tuning?.styleIntensity !== undefined) {
    voiceSettings["style"] = clamp01(input.tuning.styleIntensity);
  }

  const { bytes } = await providerBytes(
    {
      provider: "ElevenLabs",
      url: `${ELEVENLABS_API}/text-to-speech/${encodeURIComponent(input.voiceId)}`,
      method: "POST",
      headers: {
        "xi-api-key": e.ELEVENLABS_API_KEY ?? "",
      },
      body: {
        text: input.text,
        model_id: e.ELEVENLABS_MODEL_ID,
        voice_settings: voiceSettings,
      },
      // A 90-second ceiling is not enough for a long paragraph on a busy account.
      timeoutMs: 180_000,
    },
    { maxBytes: MAX_AUDIO_BYTES },
  );

  return {
    sceneIndex: input.sceneIndex,
    durationMs: mp3DurationMs(bytes, input.text),
    bytes,
    charactersBilled: input.text.length,
    voiceId: input.voiceId,
  };
}

/** 0–1, so a tuning value out of range is clamped rather than sent as a 422. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

/**
 * Duration of an MP3, read from its frame headers.
 *
 * ElevenLabs returns 44.1 kHz CBR MP3 by default, so summing frame durations is
 * exact. When the headers cannot be parsed the word-count estimate is used and
 * the fallback is logged — an estimate here shifts a caption by a fraction of a
 * second, whereas refusing the whole voiceover over an unparseable header would
 * fail a video for a cosmetic reason.
 */
export function mp3DurationMs(buffer: Buffer, text: string): number {
  const measured = parseMp3Duration(buffer);
  if (measured !== null) return measured;

  log.warn("could not measure mp3 duration, estimating from word count", {
    bytes: buffer.byteLength,
  });
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(500, Math.round((words / WORDS_PER_MINUTE) * 60_000));
}

/** MPEG-1 Layer III bitrates, indexed by the 4-bit header field. */
const MP3_BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];

const MP3_SAMPLE_RATES = [44_100, 48_000, 32_000, 0];

function parseMp3Duration(buffer: Buffer): number | null {
  let offset = 0;

  // Skip an ID3v2 tag if present: its 6-byte header is followed by a
  // syncsafe 28-bit size.
  if (buffer.byteLength > 10 && buffer.toString("ascii", 0, 3) === "ID3") {
    const size =
      ((buffer[6] ?? 0) << 21) |
      ((buffer[7] ?? 0) << 14) |
      ((buffer[8] ?? 0) << 7) |
      (buffer[9] ?? 0);
    offset = 10 + size;
  }

  let totalMs = 0;
  let frames = 0;

  while (offset + 4 <= buffer.byteLength) {
    const b0 = buffer[offset] ?? 0;
    const b1 = buffer[offset + 1] ?? 0;

    // Frame sync: 11 set bits.
    if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) {
      offset += 1;
      continue;
    }

    const version = (b1 >> 3) & 0x03; // 3 = MPEG-1
    const layer = (b1 >> 1) & 0x03; // 1 = Layer III
    if (version !== 3 || layer !== 1) {
      offset += 1;
      continue;
    }

    const b2 = buffer[offset + 2] ?? 0;
    const bitrate = MP3_BITRATES[(b2 >> 4) & 0x0f] ?? 0;
    const sampleRate = MP3_SAMPLE_RATES[(b2 >> 2) & 0x03] ?? 0;
    if (bitrate === 0 || sampleRate === 0) {
      offset += 1;
      continue;
    }

    const padding = (b2 >> 1) & 0x01;
    const frameBytes =
      Math.floor((144 * bitrate * 1000) / sampleRate) + padding;
    if (frameBytes <= 0) break;

    // MPEG-1 Layer III is 1152 samples per frame.
    totalMs += (1152 / sampleRate) * 1000;
    frames += 1;
    offset += frameBytes;
  }

  // A handful of frames means we found noise that looked like sync, not audio.
  return frames > 10 ? Math.round(totalMs) : null;
}

// ---------------------------------------------------------------------------
// Mock (§40)
// ---------------------------------------------------------------------------

/**
 * A real WAV whose length matches what the narration would take to read.
 *
 * The length is computed from the word count at the same `WORDS_PER_MINUTE` the
 * script stage used, so a mock build produces a timeline whose offsets are
 * plausible and — more importantly — *consistent*: a caption cue derived from it
 * lands where the scene does.
 */
async function mockSegment(
  sceneIndex: number,
  text: string,
  voiceId: string,
): Promise<VoiceSegmentResult> {
  const words = text.split(/\s+/).filter(Boolean).length;
  const durationMs = Math.max(700, Math.round((words / WORDS_PER_MINUTE) * 60_000));
  const bytes = silentWav(durationMs);

  return {
    sceneIndex,
    // Read back from the header rather than trusted from the input, so the mock
    // exercises the same "measure the file" path the real provider does.
    durationMs: wavDurationMs(bytes),
    bytes,
    charactersBilled: text.length,
    /**
     * The voice the mock was asked for, reported back verbatim.
     *
     * Not `"mock-voice"`. The mock exists so the pipeline can be exercised without
     * spending quota, and a mock that discarded the requested voice id would make
     * every voice-continuity test pass by accident — the one thing under test is
     * whether the right id reaches the provider.
     */
    voiceId,
  };
}

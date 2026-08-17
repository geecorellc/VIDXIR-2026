/**
 * TranscriptionProvider — caption cues from the finished voiceover (§14, §32).
 *
 * Captions are transcribed from the **audio**, not sliced from the script, and
 * that choice is the whole reason this module exists. Deriving cues from the script
 * means guessing when each word was spoken; transcribing means asking a model that
 * has heard the file. The difference is visible: script-derived captions drift out
 * of sync within thirty seconds, and drifted captions are worse than none.
 *
 * Both providers return word-level timings, which are collapsed into short cues
 * here rather than in the renderer, so `captions.cues` is the single stored truth
 * and an SRT, a VTT and a burned-in overlay are all built from the same rows.
 *
 * §48: without a key this throws `NotConfiguredError`. The mock — development only
 * — derives cues from the narration text and the measured segment durations. It is
 * labelled `provider: "mock"` on the row, and it never claims to have heard
 * anything.
 */
import { env, usingMockProviders } from "@/lib/env";
import { NotConfiguredError, TranscriptionError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { providerJson } from "@/lib/providers/http";
import { withUsage, type UsageContext } from "@/lib/providers/usage";

const log = logger.child({ component: "transcription" });

const OPENAI_API = "https://api.openai.com/v1/audio/transcriptions";

const DEEPGRAM_API = "https://api.deepgram.com/v1/listen";

/** Whisper's documented upload limit. */
const MAX_AUDIO_BYTES = 25 * 1_048_576;

/** Characters per caption cue. Two lines of ~21 characters reads comfortably. */
const MAX_CUE_CHARS = 42;

/** A cue held longer than this reads as stalled; shorter than this flashes. */
const MAX_CUE_MS = 5_000;
const MIN_CUE_MS = 700;

/** A gap this long between words is a sentence boundary worth breaking on. */
const CUE_BREAK_GAP_MS = 400;

export interface CaptionCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscribeInput {
  audio: Buffer;
  /** File name with extension — Whisper infers the format from it. */
  filename: string;
  mimeType: string;
  /** ISO-639-1 hint, improves accuracy and prevents spurious translation. */
  language?: string | null;
  /**
   * The narration as written. Passed to Whisper as a prompt so proper nouns and
   * product names in the script are spelled the way the script spells them.
   */
  scriptHint?: string | null;
  usage: Omit<UsageContext, "provider" | "operation"> & { operation?: string };
}

export interface TranscribeResult {
  provider: string;
  cues: CaptionCue[];
  language: string;
  /** Measured audio length as the provider reports it, when it reports one. */
  durationMs: number | null;
}

export function transcriptionProviderName(): string {
  return usingMockProviders() ? "mock" : env().TRANSCRIPTION_PROVIDER;
}

export function isTranscriptionConfigured(): boolean {
  const provider = transcriptionProviderName();
  if (provider === "mock") return true;
  if (provider === "openai-whisper") return Boolean(env().OPENAI_API_KEY);
  if (provider === "deepgram") return Boolean(env().DEEPGRAM_API_KEY);
  return false;
}

function requireConfigured(): void {
  if (isTranscriptionConfigured()) return;

  const provider = transcriptionProviderName();
  if (provider === "deepgram") {
    throw new NotConfiguredError(
      "Deepgram",
      ["DEEPGRAM_API_KEY"],
      "Create a key at https://console.deepgram.com.",
    );
  }
  throw new NotConfiguredError(
    "Whisper",
    ["OPENAI_API_KEY"],
    "Create a key at https://platform.openai.com/api-keys, or set TRANSCRIPTION_PROVIDER=deepgram.",
  );
}

/** Transcribe narration audio into caption cues. */
export async function transcribe(
  input: TranscribeInput,
): Promise<TranscribeResult> {
  requireConfigured();

  const provider = transcriptionProviderName();

  if (provider !== "mock" && input.audio.byteLength > MAX_AUDIO_BYTES) {
    throw new TranscriptionError(
      `The narration audio is ${Math.round(
        input.audio.byteLength / 1_048_576,
      )}MB, over the ${MAX_AUDIO_BYTES / 1_048_576}MB transcription limit.`,
    );
  }

  const result = await withUsage(
    {
      provider,
      operation: input.usage.operation ?? "transcription.transcribe",
      userId: input.usage.userId ?? null,
      projectId: input.usage.projectId ?? null,
      jobId: input.usage.jobId ?? null,
      traceId: input.usage.traceId ?? null,
      model: provider === "openai-whisper" ? "whisper-1" : null,
    },
    () => {
      if (provider === "deepgram") return deepgram(input);
      if (provider === "openai-whisper") return whisper(input);
      return mockTranscription(input);
    },
    (r) => ({
      quantity: r.durationMs === null ? null : Math.round(r.durationMs / 1000),
      unit: "seconds",
    }),
  );

  if (result.cues.length === 0) {
    // Silence in, nothing out. Retryable: the usual cause is a truncated upload.
    throw new TranscriptionError(
      "The transcription came back empty. The narration audio may be silent or truncated.",
    );
  }

  log.info("transcribed", {
    provider,
    projectId: input.usage.projectId ?? undefined,
    cues: result.cues.length,
    durationMs: result.durationMs ?? undefined,
  });

  return result;
}

// ---------------------------------------------------------------------------
// OpenAI Whisper
// ---------------------------------------------------------------------------

interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

interface WhisperResponse {
  text?: string;
  language?: string;
  duration?: number;
  words?: WhisperWord[] | null;
}

async function whisper(input: TranscribeInput): Promise<TranscribeResult> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(input.audio)], { type: input.mimeType }),
    input.filename,
  );
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  // Word granularity is what makes a cue land on a word boundary rather than in
  // the middle of one.
  form.append("timestamp_granularities[]", "word");
  if (input.language) form.append("language", isoLanguage(input.language));
  if (input.scriptHint) form.append("prompt", input.scriptHint.slice(0, 800));

  const body = await providerJson<WhisperResponse>({
    provider: "Whisper",
    url: OPENAI_API,
    method: "POST",
    headers: { authorization: `Bearer ${env().OPENAI_API_KEY ?? ""}` },
    body: form,
    // Transcribing ten minutes of audio takes a while on a busy account.
    timeoutMs: 300_000,
  });

  const words = (body.words ?? []).map((w) => ({
    text: w.word,
    startMs: Math.round(w.start * 1000),
    endMs: Math.round(w.end * 1000),
  }));

  return {
    provider: "openai-whisper",
    cues: groupWords(words),
    language: body.language ?? input.language ?? "en",
    durationMs: body.duration ? Math.round(body.duration * 1000) : null,
  };
}

// ---------------------------------------------------------------------------
// Deepgram
// ---------------------------------------------------------------------------

interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
}

interface DeepgramResponse {
  metadata?: { duration?: number } | null;
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
        words?: DeepgramWord[] | null;
      }> | null;
    }> | null;
  } | null;
}

async function deepgram(input: TranscribeInput): Promise<TranscribeResult> {
  const language = isoLanguage(input.language ?? "en");

  const url =
    `${DEEPGRAM_API}?model=nova-2&smart_format=true&punctuate=true` +
    `&language=${encodeURIComponent(language)}`;

  const body = await providerJson<DeepgramResponse>({
    provider: "Deepgram",
    url,
    method: "POST",
    headers: {
      authorization: `Token ${env().DEEPGRAM_API_KEY ?? ""}`,
      "content-type": input.mimeType,
    },
    // Deepgram takes raw audio as the request body, not multipart.
    body: new Uint8Array(input.audio),
    timeoutMs: 300_000,
  });

  const alternative = body.results?.channels?.[0]?.alternatives?.[0];
  const words = (alternative?.words ?? []).map((w) => ({
    text: w.punctuated_word ?? w.word,
    startMs: Math.round(w.start * 1000),
    endMs: Math.round(w.end * 1000),
  }));

  return {
    provider: "deepgram",
    cues: groupWords(words),
    language,
    durationMs: body.metadata?.duration
      ? Math.round(body.metadata.duration * 1000)
      : null,
  };
}

// ---------------------------------------------------------------------------
// Cue assembly
// ---------------------------------------------------------------------------

interface TimedWord {
  text: string;
  startMs: number;
  endMs: number;
}

/**
 * Collapse word timings into readable cues.
 *
 * Breaks on, in order of priority: sentence-ending punctuation, a pause longer
 * than `CUE_BREAK_GAP_MS`, the character limit, and the duration limit. Breaking on
 * punctuation first is what makes a caption read as a sentence rather than as a
 * sliding window of words.
 *
 * Exported for unit tests — this is pure, and the grouping rules are the part of
 * captioning most worth pinning.
 */
export function groupWords(words: readonly TimedWord[]): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let current: TimedWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) return;

    const text = current
      .map((w) => w.text.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+([,.!?;:])/g, "$1");

    if (text) {
      cues.push({
        startMs: first.startMs,
        // A cue that ends exactly on the last syllable disappears as the word
        // finishes; a short hold makes it readable.
        endMs: Math.max(first.startMs + MIN_CUE_MS, last.endMs + 120),
        text,
      });
    }
    current = [];
  };

  for (const word of words) {
    const clean = word.text.trim();
    if (!clean) continue;

    const previous = current[current.length - 1];
    const wouldBeChars =
      current.reduce((n, w) => n + w.text.trim().length + 1, 0) + clean.length;
    const wouldBeMs = current[0] ? word.endMs - current[0].startMs : 0;

    const gap = previous ? word.startMs - previous.endMs : 0;

    if (
      current.length > 0 &&
      (wouldBeChars > MAX_CUE_CHARS ||
        wouldBeMs > MAX_CUE_MS ||
        gap > CUE_BREAK_GAP_MS)
    ) {
      flush();
    }

    current.push({ ...word, text: clean });

    // Sentence end: break here even if the cue is short, because a caption that
    // spans two sentences reads as one.
    if (/[.!?]["')\]]?$/.test(clean)) flush();
  }

  flush();

  return dedupeOverlaps(cues);
}

/**
 * Ensure cues are strictly ordered and non-overlapping.
 *
 * Providers occasionally emit a word whose start precedes the previous word's end
 * (an alignment artefact around a hesitation). An overlapping cue makes a player
 * show two captions at once, so the later cue is nudged rather than dropped —
 * dropping would lose spoken words.
 */
function dedupeOverlaps(cues: readonly CaptionCue[]): CaptionCue[] {
  const out: CaptionCue[] = [];

  for (const cue of cues) {
    const previous = out[out.length - 1];
    if (!previous) {
      out.push(cue);
      continue;
    }
    const startMs = Math.max(cue.startMs, previous.endMs + 1);
    const endMs = Math.max(startMs + MIN_CUE_MS, cue.endMs);
    out.push({ startMs, endMs, text: cue.text });
  }

  return out;
}

/** "en-GB" → "en". Both APIs take the base tag. */
function isoLanguage(tag: string): string {
  return (tag.split("-")[0] ?? "en").toLowerCase();
}

// ---------------------------------------------------------------------------
// Mock (§40)
// ---------------------------------------------------------------------------

/**
 * Cues derived from the narration text and the audio's real length.
 *
 * Words are distributed proportionally by length across the measured duration.
 * This is an approximation and it is labelled as one — `provider: "mock"` on the
 * `captions` row — but it is an approximation over a *real* measured duration, so
 * the last cue ends where the audio does.
 */
async function mockTranscription(
  input: TranscribeInput,
): Promise<TranscribeResult> {
  const text = (input.scriptHint ?? "").trim();
  if (!text) return { provider: "mock", cues: [], language: "en", durationMs: null };

  // The mock voice provider emits WAV, whose length is in the header.
  const durationMs = wavHeaderDuration(input.audio) ?? 0;
  if (durationMs <= 0) {
    throw new TranscriptionError(
      "The mock transcriber could not read the audio length from the file header.",
    );
  }

  const tokens = text.split(/\s+/).filter(Boolean);
  const totalChars = tokens.reduce((n, t) => n + t.length, 0) || 1;

  const words: TimedWord[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const span = Math.max(60, Math.round((token.length / totalChars) * durationMs));
    words.push({ text: token, startMs: cursor, endMs: cursor + span });
    cursor += span;
  }

  return {
    provider: "mock",
    cues: groupWords(words),
    language: isoLanguage(input.language ?? "en"),
    durationMs,
  };
}

function wavHeaderDuration(buffer: Buffer): number | null {
  if (buffer.byteLength < 44 || buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  const byteRate = buffer.readUInt32LE(28);
  const dataBytes = buffer.readUInt32LE(40);
  if (byteRate === 0) return null;
  return Math.round((dataBytes / byteRate) * 1000);
}

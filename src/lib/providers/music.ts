/**
 * MusicProvider — background bed under the narration (§13, §29, §32).
 *
 * Freesound is the source, and the query is the interesting part: it is filtered
 * to Creative Commons Zero only. Freesound also hosts CC-BY and CC-BY-NC content,
 * and both are wrong here — CC-BY needs an attribution the user may never add to
 * their description, and CC-BY-NC forbids the monetised upload that is the entire
 * point of the product. Filtering at the query means a non-commercial track never
 * reaches a timeline, rather than being caught by a check we might forget.
 *
 * `musicTracks.volume` defaults to 0.14 and this module does not override it: a
 * bed you notice is a bed that is too loud, and narration intelligibility is worth
 * more than the music. The renderer ducks it further under speech.
 */
import { env, usingMockProviders } from "@/lib/env";
import { AssetMissingError, NotConfiguredError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { silentWav, wavDurationMs } from "@/lib/media/synthetic";
import { fetchRemoteAsset } from "@/lib/providers/fetch";
import { providerJson } from "@/lib/providers/http";
import { withUsage, type UsageContext } from "@/lib/providers/usage";

const log = logger.child({ component: "music" });

const FREESOUND_API = "https://freesound.org/apiv2";

/** A background bed. Anything larger is a full album, not a loop. */
const MAX_TRACK_BYTES = 60 * 1_048_576;

/** Results considered per query. */
const CANDIDATES = 20;

/**
 * Only CC0. See the file header — this is a licensing constraint, not a
 * preference, and it is applied in the query string so it cannot be bypassed by a
 * later code path.
 */
const CC0_FILTER = "license:\"Creative Commons 0\"";

export interface MusicRequest {
  /** Mood words from the scene plan, e.g. "calm, curious". */
  mood: string | null;
  /** How long the video runs, so a track long enough is preferred. */
  durationMs: number;
}

export interface AcquiredMusic {
  provider: string;
  bytes: Buffer;
  mimeType: string;
  extension: string;
  durationMs: number | null;
  providerAssetId: string | null;
  sourceUrl: string | null;
  license: string | null;
  attribution: string | null;
  authorName: string | null;
  mood: string | null;
}

export interface AcquireMusicOptions {
  usage: Omit<UsageContext, "provider" | "operation"> & { operation?: string };
}

export function musicProviderName(): string {
  return usingMockProviders() ? "mock" : env().MUSIC_PROVIDER;
}

export function isMusicConfigured(): boolean {
  const provider = musicProviderName();
  if (provider === "mock") return true;
  if (provider === "freesound") return Boolean(env().FREESOUND_API_KEY);
  return false;
}

function requireConfigured(): void {
  if (isMusicConfigured()) return;
  throw new NotConfiguredError(
    "Freesound",
    ["FREESOUND_API_KEY"],
    "Apply for a key at https://freesound.org/apiv2/apply/.",
  );
}

/** Find and download one background track. */
export async function acquireMusic(
  request: MusicRequest,
  options: AcquireMusicOptions,
): Promise<AcquiredMusic> {
  requireConfigured();

  const provider = musicProviderName();

  const result = await withUsage(
    {
      provider,
      operation: options.usage.operation ?? "music.acquire",
      userId: options.usage.userId ?? null,
      projectId: options.usage.projectId ?? null,
      jobId: options.usage.jobId ?? null,
      traceId: options.usage.traceId ?? null,
    },
    () => (provider === "mock" ? mockMusic(request) : freesoundMusic(request)),
    (r) => ({ quantity: r?.bytes.byteLength ?? 0, unit: "bytes" }),
  );

  if (!result) {
    // Not retryable: the query would be identical. §13 treats music as optional
    // decoration, and the pipeline stage catches this and continues without a bed
    // rather than failing a whole render over background audio.
    throw new AssetMissingError(
      `a CC0 background track for "${request.mood ?? "any mood"}"`,
    );
  }

  log.info("music acquired", {
    provider,
    projectId: options.usage.projectId ?? undefined,
    durationMs: result.durationMs ?? undefined,
    license: result.license ?? undefined,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Freesound
// ---------------------------------------------------------------------------

interface FreesoundResult {
  id: number;
  name: string;
  /** Seconds. */
  duration: number;
  license: string;
  username: string;
  url: string;
  /** Direct download needs OAuth2; previews are token-authenticated. */
  previews?: Record<string, string> | null;
}

async function freesoundMusic(
  request: MusicRequest,
): Promise<AcquiredMusic | null> {
  const key = env().FREESOUND_API_KEY;
  if (!key) return null;

  const seconds = Math.max(30, Math.round(request.durationMs / 1000));

  for (const query of queriesFor(request.mood)) {
    const url =
      `${FREESOUND_API}/search/text/?query=${encodeURIComponent(query)}` +
      `&filter=${encodeURIComponent(`${CC0_FILTER} duration:[30 TO 600]`)}` +
      `&sort=rating_desc&page_size=${CANDIDATES}` +
      `&fields=${encodeURIComponent("id,name,duration,license,username,url,previews")}`;

    const body = await providerJson<{ results?: FreesoundResult[] | null }>({
      provider: "Freesound",
      url,
      headers: { authorization: `Token ${key}` },
    });

    const candidates = (body.results ?? [])
      // Belt and braces on the licence: the filter above should make this
      // redundant, and a licensing check is exactly where redundancy is cheap.
      .filter((r) => /creative commons 0|cc0/i.test(r.license))
      // A track shorter than the video means an audible loop point; prefer one
      // that covers it, but do not refuse a shorter one — the renderer loops.
      .sort((a, b) => coverage(b, seconds) - coverage(a, seconds));

    for (const candidate of candidates) {
      const preview =
        candidate.previews?.["preview-hq-mp3"] ??
        candidate.previews?.["preview-lq-mp3"];
      if (!preview) continue;

      const asset = await fetchRemoteAsset(`${preview}?token=${encodeURIComponent(key)}`, {
        provider: "Freesound",
        maxBytes: MAX_TRACK_BYTES,
      });

      return {
        provider: "freesound",
        bytes: asset.bytes,
        mimeType: "audio/mpeg",
        extension: "mp3",
        durationMs: Math.round(candidate.duration * 1000) || null,
        providerAssetId: `freesound:${candidate.id}`,
        sourceUrl: candidate.url,
        license: "CC0 1.0 Universal (public domain dedication)",
        // Recorded even though CC0 requires none: §29 wants provenance kept, and
        // a creator credit costs nothing to store.
        attribution: `"${candidate.name}" by ${candidate.username} (Freesound, CC0)`,
        authorName: candidate.username,
        mood: request.mood,
      };
    }
  }

  return null;
}

/** How well a track covers the video, capped so a 10-minute track is not favoured over a 6-minute one for a 5-minute video. */
function coverage(track: FreesoundResult, seconds: number): number {
  return Math.min(track.duration, seconds * 1.5);
}

/**
 * Queries to try, in order.
 *
 * The mood words come from the scene plan and can be anything the model wrote, so
 * "instrumental background" is appended: without it a mood like "tense" returns
 * sound effects and field recordings rather than music.
 */
function queriesFor(mood: string | null): string[] {
  const cleaned = (mood ?? "")
    .split(/[,/]/)
    .map((m) => m.trim().toLowerCase())
    .filter((m) => m.length >= 3)
    .slice(0, 2);

  const queries = cleaned.map((m) => `${m} instrumental background music loop`);
  queries.push("ambient instrumental background music loop");
  return queries;
}

// ---------------------------------------------------------------------------
// Mock (§40)
// ---------------------------------------------------------------------------

async function mockMusic(request: MusicRequest): Promise<AcquiredMusic> {
  // Silence is the honest mock for a background bed: the timeline gets a real
  // audio file of the right length, and nothing pretends to be music.
  const durationMs = Math.max(30_000, request.durationMs);
  const bytes = silentWav(durationMs);

  return {
    provider: "mock",
    bytes,
    mimeType: "audio/wav",
    extension: "wav",
    durationMs: wavDurationMs(bytes),
    providerAssetId: "mock:silence",
    sourceUrl: null,
    license: "Development placeholder — silent track, not for publication",
    attribution: null,
    authorName: null,
    mood: request.mood,
  };
}

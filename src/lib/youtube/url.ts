/**
 * YouTube URL normalisation (Phase 11 §4).
 *
 * The link-mode entry point takes a string a human pasted and has to end up with
 * a canonical video id or a clear refusal. Nothing downstream may guess: §4 is
 * explicit that an arbitrary user-provided id is not to be trusted, and the id
 * travels from here into a Google API call, a database row and a job payload.
 *
 * So this module is deliberately narrow and has no dependencies at all — no env,
 * no database, no provider. It is a parser:
 *
 *  - The host must be a YouTube host from a fixed list. `youtu.be.evil.com` is
 *    not YouTube, and a suffix check would say it was.
 *  - The path must be a *video* path. A playlist, a channel, a handle or a search
 *    page all parse fine as URLs and none of them identifies a video, so each
 *    gets its own refusal rather than a generic one — a user who pasted a channel
 *    link needs to be told that, not "invalid URL".
 *  - The id must match YouTube's own id shape exactly. Eleven characters of
 *    base64url. Anything else is rejected before it can reach `videos.list`.
 *
 * What it deliberately does not do: reach the network to confirm the video
 * exists. Existence is the source-analysis step's job (§5) and it degrades
 * gracefully for private, deleted and region-blocked videos. Mixing the two
 * would make a parse failure and a missing video indistinguishable.
 */
import { ValidationError } from "@/lib/errors";

/**
 * YouTube's video id shape: 11 characters of base64url.
 *
 * Not a loose `\w+`. The id is interpolated into an API request and persisted, so
 * the tighter the accepted set the smaller the surface — and YouTube has never
 * issued an id outside this alphabet or length.
 */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Hosts that are actually YouTube.
 *
 * Matched exactly after stripping a leading `www.`, never by suffix: `endsWith`
 * on "youtube.com" also accepts "notyoutube.com", and a suffix check with a dot
 * still accepts a host an attacker controls under a lookalike registrable
 * domain. An exact list is boring and correct.
 *
 * `youtube-nocookie.com` is the privacy-preserving embed host and serves the
 * same ids. `music.youtube.com` and `m.youtube.com` are the music and mobile
 * front ends.
 */
const HOSTS = new Set([
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
]);

/** Path prefixes that carry the video id as the next segment. */
const ID_PATH_PREFIXES = ["shorts", "embed", "live", "v"] as const;

/** Which URL form a link was recognised as. Recorded for support and tests. */
export type YouTubeLinkForm =
  | "watch"
  | "short_link"
  | "shorts"
  | "embed"
  | "live"
  | "legacy_v"
  | "bare_id";

export interface ParsedYouTubeLink {
  /** The canonical, validated 11-character video id. */
  videoId: string;
  /** The form the input was recognised as. */
  form: YouTubeLinkForm;
  /**
   * The canonical watch URL for the id.
   *
   * Always regenerated from the id rather than echoed from the input, so a
   * tracking parameter, an affiliate tag or a `redirect` query string cannot
   * survive into anything Tally stores or renders as a link.
   */
  canonicalUrl: string;
}

/** Longest input accepted, before any parsing. A URL is not a document. */
const MAX_INPUT_CHARS = 2_048;

/**
 * True when a string is exactly a YouTube video id.
 *
 * Exported because the boundary between "id" and "arbitrary string" has to be
 * checkable wherever an id arrives — a job payload over Redis is data, not an
 * authorisation, and the same rule applies to an id inside it.
 */
export function isValidVideoId(value: string): boolean {
  return VIDEO_ID_RE.test(value);
}

/**
 * Parse a pasted YouTube link, or throw `ValidationError`.
 *
 * Throws rather than returning null: every caller is a request handler or a
 * worker, both of which need the specific reason to report, and a boolean would
 * throw that away.
 */
export function parseYouTubeLink(input: string): ParsedYouTubeLink {
  const raw = input.trim();

  if (!raw) throw new ValidationError("Paste a YouTube video link.");
  if (raw.length > MAX_INPUT_CHARS) {
    throw new ValidationError("That link is too long to be a YouTube URL.");
  }

  // A bare id is accepted because it is the one non-URL input that can be
  // validated completely: it either matches YouTube's id shape exactly or it is
  // refused. Note this is not "trusting a user-provided id" — the id is checked
  // against the pattern here and its existence is checked against YouTube later.
  if (isValidVideoId(raw) && !raw.includes("/") && !raw.includes(".")) {
    return finish(raw, "bare_id");
  }

  const url = toUrl(raw);
  const host = normaliseHost(url.hostname);

  if (!HOSTS.has(host)) {
    throw new ValidationError(
      "That is not a YouTube link. Paste a link from youtube.com or youtu.be.",
      { field: "url" },
    );
  }

  const segments = url.pathname.split("/").filter(Boolean);

  // youtu.be/<id> — the whole path is the id.
  if (host === "youtu.be") {
    const candidate = segments[0];
    if (!candidate) throw notAVideo();
    return finish(requireId(candidate), "short_link");
  }

  const first = segments[0]?.toLowerCase();

  // Refuse the near-misses by name. A user who pasted a channel or a playlist
  // has made an understandable mistake and "invalid URL" does not help them.
  if (first === "playlist") {
    throw new ValidationError(
      "That is a playlist link. Paste a link to a single video.",
      { field: "url" },
    );
  }
  if (first === "channel" || first === "c" || first === "user" || first?.startsWith("@")) {
    throw new ValidationError(
      "That is a channel link. Paste a link to a single video.",
      { field: "url" },
    );
  }
  if (first === "results") {
    throw new ValidationError(
      "That is a search results link. Paste a link to a single video.",
      { field: "url" },
    );
  }

  if (first === "watch") {
    // `v` is the video; a `list`, `index`, `t` or `si` alongside it is ignored
    // rather than rejected, because sharing a video from inside a playlist is
    // the most common way a link is copied.
    const v = url.searchParams.get("v");
    if (!v) throw notAVideo();
    return finish(requireId(v), "watch");
  }

  if (first && (ID_PATH_PREFIXES as readonly string[]).includes(first)) {
    const candidate = segments[1];
    if (!candidate) throw notAVideo();
    const form: YouTubeLinkForm =
      first === "shorts"
        ? "shorts"
        : first === "embed"
          ? "embed"
          : first === "live"
            ? "live"
            : "legacy_v";
    return finish(requireId(candidate), form);
  }

  throw notAVideo();
}

/**
 * Parse without throwing, for a caller that wants to offer a hint rather than
 * fail — the paste field validating as the user types, for instance.
 */
export function tryParseYouTubeLink(input: string): ParsedYouTubeLink | null {
  try {
    return parseYouTubeLink(input);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The canonical watch URL for a validated id.
 *
 * Deliberately a private copy of `providers/youtube.watchUrl`. This module has no
 * dependencies by design — it is the one piece of the link flow that can be
 * unit-tested without an environment — and importing the provider would pull in
 * `env()` and the Google SDK for a string template.
 */
function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function finish(videoId: string, form: YouTubeLinkForm): ParsedYouTubeLink {
  return { videoId, form, canonicalUrl: watchUrl(videoId) };
}

/**
 * Build a URL from a paste.
 *
 * A scheme-less paste ("youtube.com/watch?v=...") is the normal case when a user
 * copies from a browser's omnibox, so `https://` is prepended. Any scheme other
 * than http(s) is refused outright — `javascript:`, `data:` and `file:` all parse
 * as URLs and none of them is a link to a video.
 */
function toUrl(raw: string): URL {
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ValidationError("That is not a valid URL.", { field: "url" });
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ValidationError("Only http(s) YouTube links are accepted.", {
      field: "url",
    });
  }

  return url;
}

function normaliseHost(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

function requireId(candidate: string): string {
  // A trailing path segment can carry the id plus junk from a copied link.
  const cleaned = candidate.trim();
  if (!isValidVideoId(cleaned)) {
    throw new ValidationError(
      "That link does not contain a YouTube video id.",
      { field: "url" },
    );
  }
  return cleaned;
}

function notAVideo(): ValidationError {
  return new ValidationError(
    "That YouTube link does not point at a video. Use a watch, shorts or " +
      "youtu.be link.",
    { field: "url" },
  );
}

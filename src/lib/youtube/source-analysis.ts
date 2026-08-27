/**
 * Source video analysis (Phase 11 §5, §22).
 *
 * The first step of link mode: a user pasted a URL, and this works out what the
 * video actually is so the research stage has a seed. It is the only module that
 * reads somebody else's video, and its shape is set by two of the spec's rules
 * pulling in opposite directions.
 *
 * §5 says *retrieve only legitimately available metadata* and *degrade gracefully*
 * for every way that can go wrong. §22 says the pasted video is a **research
 * source only** — so this module reads public metadata and nothing else. There is
 * no code path here that downloads the video, its audio, its thumbnail file or its
 * captions, and there is deliberately nowhere for one to be added: the return type
 * has no field a media file could go in.
 *
 * The transcript question is worth stating plainly because it is the one place an
 * implementation could quietly overreach. `captions.download` on the Data API
 * requires the **video owner's** OAuth credentials; a third party cannot read
 * another creator's captions through it, and the third-party "transcript API"
 * services that appear to do so work by scraping an internal endpoint. So Tally
 * does not fetch a transcript. What it does instead is report YouTube's own claim
 * about whether the video has captions (`transcript: "unavailable"` with a reason)
 * — an honest statement about the source rather than a promise (§42). The script
 * stage never had a transcript to work from, and §8 forbids reproducing the source
 * script anyway, so nothing downstream is weakened by its absence.
 *
 * Failure handling is the other half of the module. Six named states, because §5
 * lists six and they need different words on screen:
 *
 *  - `ok` — read it.
 *  - `not_found` — YouTube returned no item. Deleted, private, region-blocked or
 *    never existed; YouTube reports all four identically, so this does not pretend
 *    to distinguish them.
 *  - `not_configured` — no `YOUTUBE_API_KEY`. A 503 configuration state, not an
 *    error (§48), and it names the variable.
 *  - `quota_exceeded` — the daily quota is spent. Temporary and retryable.
 *  - `unavailable` — YouTube could not be reached, or returned 5xx.
 *  - `forbidden` — YouTube refused the read for a reason that is not quota.
 *
 * Every one of them is a *return value*, not an exception, except where the caller
 * has to stop: `analyzeSource` throws only for a genuinely invalid URL, because
 * that is the user's input being wrong rather than the world being unavailable.
 */
import {
  errorCodeOf,
  isRetryable,
  NotConfiguredError,
  userMessageOf,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  fetchVideoCategoryTitlesAs,
  fetchVideoDetailAs,
  isYouTubePublicReadConfigured,
  requirePublicReadCredential,
  watchUrl,
  type YouTubeVideoDetail,
} from "@/lib/providers/youtube";
import { engagementRate, tokenize, viewsPerHour } from "@/lib/research/scoring";
import { parseYouTubeLink, type YouTubeLinkForm } from "@/lib/youtube/url";

const log = logger.child({ component: "youtube-source-analysis" });

/** Region used to name the video's category. See `SourceAnalysis.categoryTitle`. */
const CATEGORY_REGION = "US";

/** Why a transcript is not present. There is no `available` case (see the header). */
export type TranscriptState =
  /** YouTube says the video carries captions, but they are the owner's to read. */
  | "owner_only"
  /** YouTube says the video has no captions at all. */
  | "none"
  /** YouTube did not say either way. */
  | "unknown";

/** How the read went. One of these, always, for every link. */
export type SourceAnalysisState =
  | "ok"
  | "not_found"
  | "not_configured"
  | "quota_exceeded"
  | "forbidden"
  | "unavailable";

/**
 * What a source video turned out to be.
 *
 * Every field is nullable that YouTube can legitimately omit, and none is
 * defaulted to a plausible-looking value: a video with comments disabled has
 * `commentCount: null`, not 0, because 0 comments and "comments are off" are
 * different facts and the second one is not measurable as a number (§42).
 */
export interface SourceAnalysis {
  videoId: string;
  /** Canonical watch URL, regenerated from the id rather than echoed. */
  url: string;
  /** Which URL form the user pasted. Support signal only. */
  linkForm: YouTubeLinkForm;

  title: string;
  /** Truncated for prompt safety; see `MAX_DESCRIPTION_CHARS`. */
  description: string | null;
  channelId: string | null;
  channelTitle: string | null;
  publishedAt: Date | null;

  /** YouTube's numeric id, as returned. */
  categoryId: string | null;
  /** The id resolved to a name, or null when the lookup did not resolve it. */
  categoryTitle: string | null;
  tags: string[];
  durationSeconds: number | null;
  durationIso: string | null;
  /** BCP-47 as the uploader declared it, when they declared one. */
  language: string | null;

  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  /** Derived, not reported: views per hour since publication. */
  viewsPerHour: number | null;
  /** Derived: (likes + 3x comments) / views, or null when neither was reported. */
  engagementRate: number | null;

  /** Thumbnail *URL*, for display. Never downloaded (§22). */
  thumbnailUrl: string | null;
  privacyStatus: string | null;
  madeForKids: boolean | null;

  /** Why there is no transcript. Always one of the three; never "available". */
  transcript: TranscriptState;

  /**
   * What the video appears to be about, inferred here in code (§5, §6).
   *
   * Content words from the title, the tags and the category, ranked by where they
   * appeared. This is the research seed: §6 turns these into search probes. It is
   * deliberately mechanical rather than model-generated — the seed has to be
   * reproducible, and a keyword list is not the sort of judgement that needs a
   * language model.
   */
  topics: string[];
  /** A short phrase naming the niche, for display and for the angle prompt. */
  niche: string | null;

  /**
   * Fields YouTube did not return (§5 "handle incomplete metadata").
   *
   * Named so the UI can say which parts of the analysis are thin rather than
   * rendering blanks that look like a bug.
   */
  missingFields: string[];
}

/** The result of analysing a link: an analysis, or a named reason there is none. */
export type SourceAnalysisResult =
  | { state: "ok"; analysis: SourceAnalysis }
  | {
      state: Exclude<SourceAnalysisState, "ok">;
      /** The pasted video's id — known even when the read failed. */
      videoId: string;
      /** User-facing sentence. Never a provider message or a stack (§21). */
      message: string;
      /** Stable `AppError` code, for the UI to branch on. */
      errorCode: string | null;
      /** Set only for `not_configured`: which variables to set. */
      missingEnvVars: string[];
      /** True when trying again later could plausibly succeed. */
      retryable: boolean;
    };

/** Longest description kept. A YouTube description can be 5,000 characters. */
const MAX_DESCRIPTION_CHARS = 2_000;

/** How many topic keywords the seed carries. */
const MAX_TOPICS = 12;

export interface AnalyzeSourceOptions {
  /**
   * Skip the category-name lookup.
   *
   * One extra quota unit per analysis is cheap, but a caller re-analysing in a
   * loop should not pay it repeatedly, and the category name is presentational.
   */
  skipCategoryLookup?: boolean;
  now?: Date;
  traceId?: string | null;
  userId?: string;
}

/**
 * Analyse a pasted YouTube link.
 *
 * Throws `ValidationError` when the input is not a YouTube video link — that is
 * the user's input being wrong, and it must reach them as a 400 with the specific
 * reason `parseYouTubeLink` worked out. Everything else is a returned state.
 */
export async function analyzeSource(
  input: string,
  options: AnalyzeSourceOptions = {},
): Promise<SourceAnalysisResult> {
  // Parse first, and note that this is what makes the id safe to interpolate into
  // an API request and to store: §4's "do not trust arbitrary user-provided ids".
  const link = parseYouTubeLink(input);
  return analyzeVideoId(link.videoId, link.form, options);
}

/**
 * Analyse a video id that has already been validated.
 *
 * Separate from `analyzeSource` for the worker: the id arrives in a job payload,
 * and re-parsing a URL that no longer exists in the payload is not possible. The
 * id is re-validated at the boundary by the caller (`isValidVideoId`), because a
 * payload from Redis is data and not an authorisation.
 */
export async function analyzeVideoId(
  videoId: string,
  linkForm: YouTubeLinkForm = "bare_id",
  options: AnalyzeSourceOptions = {},
): Promise<SourceAnalysisResult> {
  const now = options.now ?? new Date();

  // Checked before the call so the not-configured state is a returned value with
  // the variable name in it, rather than an exception the caller has to classify.
  if (!isYouTubePublicReadConfigured()) {
    const error = notConfiguredError();
    return {
      state: "not_configured",
      videoId,
      // `NotConfiguredError`'s message is already written for a user and names the
      // variable, which is exactly what §48 asks this state to say.
      message: userMessageOf(error),
      errorCode: error.code,
      missingEnvVars: ["YOUTUBE_API_KEY"],
      retryable: false,
    };
  }

  const credential = requirePublicReadCredential();

  let detail: YouTubeVideoDetail | null;
  try {
    detail = await fetchVideoDetailAs(credential, videoId);
  } catch (error) {
    return failure(videoId, error, options);
  }

  if (!detail) {
    // YouTube returned an empty `items` array. Deleted, private, unlisted without
    // access, region-blocked, or an id that never existed — all four look the
    // same on the wire, so this says what is verifiable and no more.
    log.info("source video not readable", {
      userId: options.userId,
      traceId: options.traceId ?? undefined,
      videoId,
    });
    return {
      state: "not_found",
      videoId,
      message:
        "That video is not available to read. It may be private, deleted, or " +
        "restricted in this region.",
      errorCode: "not_found",
      missingEnvVars: [],
      retryable: false,
    };
  }

  let categoryTitle: string | null = null;
  if (detail.categoryId && !options.skipCategoryLookup) {
    // Presentational and 1 unit, so a failure here must not lose the analysis:
    // an unnamed category is a missing field, not a failed read.
    try {
      const titles = await fetchVideoCategoryTitlesAs(credential, CATEGORY_REGION);
      categoryTitle = titles.get(detail.categoryId) ?? null;
    } catch (error) {
      log.warn("category lookup failed", {
        userId: options.userId,
        traceId: options.traceId ?? undefined,
        videoId,
        error,
      });
    }
  }

  return { state: "ok", analysis: buildAnalysis(detail, linkForm, categoryTitle, now) };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function buildAnalysis(
  detail: YouTubeVideoDetail,
  linkForm: YouTubeLinkForm,
  categoryTitle: string | null,
  now: Date,
): SourceAnalysis {
  const durationSeconds = parseIsoDuration(detail.durationIso);
  const description = detail.description?.trim() ?? null;
  const topics = inferTopics(detail, categoryTitle);

  const missingFields: string[] = [];
  if (!detail.title) missingFields.push("title");
  if (!description) missingFields.push("description");
  if (detail.tags.length === 0) missingFields.push("tags");
  if (detail.publishedAt === null) missingFields.push("publishedAt");
  if (durationSeconds === null) missingFields.push("duration");
  if (detail.viewCount === null) missingFields.push("viewCount");
  if (detail.likeCount === null) missingFields.push("likeCount");
  if (detail.commentCount === null) missingFields.push("commentCount");
  if (!detail.categoryId) missingFields.push("category");
  else if (!categoryTitle) missingFields.push("categoryName");
  if (!detail.channelTitle) missingFields.push("channelTitle");

  return {
    videoId: detail.videoId,
    url: watchUrl(detail.videoId),
    linkForm,

    // A video with no title is not a case worth inventing a placeholder for, but
    // it is also not worth failing over: the id identifies it.
    title: detail.title || `YouTube video ${detail.videoId}`,
    description:
      description === null ? null : description.slice(0, MAX_DESCRIPTION_CHARS),
    channelId: detail.channelId,
    channelTitle: detail.channelTitle,
    publishedAt: detail.publishedAt,

    categoryId: detail.categoryId,
    categoryTitle,
    tags: detail.tags.slice(0, 40),
    durationSeconds,
    durationIso: detail.durationIso,
    // `defaultLanguage` is the metadata language; `defaultAudioLanguage` is what
    // is spoken. For deciding what language to write in, the spoken one wins.
    language: detail.defaultAudioLanguage ?? detail.defaultLanguage ?? null,

    viewCount: detail.viewCount,
    likeCount: detail.likeCount,
    commentCount: detail.commentCount,
    viewsPerHour: viewsPerHour(detail.viewCount, detail.publishedAt, now),
    engagementRate: engagementRate(
      detail.viewCount,
      detail.likeCount,
      detail.commentCount,
    ),

    thumbnailUrl: detail.thumbnailUrl,
    privacyStatus: detail.privacyStatus,
    madeForKids: detail.madeForKids,

    transcript: transcriptStateOf(detail.captionsAvailable),

    topics,
    niche: nicheOf(detail, categoryTitle, topics),

    missingFields,
  };
}

/**
 * Why there is no transcript.
 *
 * `captionsAvailable === true` becomes `owner_only` rather than `available`,
 * because the captions existing and Tally being able to read them are different
 * facts and only the first one is knowable here.
 */
function transcriptStateOf(captionsAvailable: boolean | null): TranscriptState {
  if (captionsAvailable === true) return "owner_only";
  if (captionsAvailable === false) return "none";
  return "unknown";
}

/**
 * Infer the topic seed (§5 "topic/niche", §6 research seed).
 *
 * Ranked by source rather than by frequency: a tag the uploader chose is a
 * stronger statement of subject than a word that happened to be in the title, and
 * a title of five words gives frequency nothing to work with. Order is
 * tags → title → category, deduplicated, and the category name comes last because
 * it is the broadest ("Education" is true of a million videos).
 *
 * Multi-word tags are kept whole *and* tokenized: "smart home automation" is a
 * better search probe than any of its words, but its words still belong in the
 * seed for fit scoring.
 */
export function inferTopics(
  detail: Pick<YouTubeVideoDetail, "title" | "tags">,
  categoryTitle: string | null,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (value: string) => {
    const term = value.trim();
    if (term.length < 3) return;
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(term);
  };

  // Whole tags first — they are the uploader's own statement of subject.
  for (const tag of detail.tags.slice(0, 20)) {
    if (tag.trim().split(/\s+/).length > 1) push(tag);
  }
  for (const tag of detail.tags.slice(0, 20)) push(tag);

  for (const token of tokenize(detail.title)) push(token);
  if (categoryTitle) push(categoryTitle);

  return out.slice(0, MAX_TOPICS);
}

/**
 * A short phrase naming what the video's niche is.
 *
 * The longest multi-word tag, falling back to the category name, falling back to
 * the strongest title tokens. Null when there is genuinely nothing to say — an
 * invented niche would propagate into the research probes and the angle prompt,
 * which is where a wrong guess does real damage.
 */
function nicheOf(
  detail: Pick<YouTubeVideoDetail, "title" | "tags">,
  categoryTitle: string | null,
  topics: readonly string[],
): string | null {
  const phrases = detail.tags
    .map((tag) => tag.trim())
    .filter((tag) => tag.split(/\s+/).length >= 2 && tag.length <= 60)
    .sort((a, b) => b.length - a.length);

  if (phrases[0]) return phrases[0];
  if (categoryTitle) return categoryTitle;

  const words = topics.filter((t) => !t.includes(" ")).slice(0, 3);
  return words.length > 0 ? words.join(" ") : null;
}

/**
 * ISO-8601 duration to seconds.
 *
 * YouTube returns `PT1H2M3S`, and for a live stream or an unprocessed upload it
 * returns `P0D`, which is a real value meaning "no duration" rather than zero
 * seconds — so anything that does not parse as a time returns null.
 */
export function parseIsoDuration(iso: string | null): number | null {
  if (!iso) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    iso,
  );
  if (!match) return null;

  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);

  const total = days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
  // `P0D` parses to 0, which is not a duration. Distinguishing it from a genuine
  // zero costs nothing here because a zero-second video does not exist.
  if (total <= 0) return null;
  return Math.round(total);
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

function notConfiguredError(): NotConfiguredError {
  return new NotConfiguredError(
    "YouTube public reads",
    ["YOUTUBE_API_KEY"],
    "Set YOUTUBE_API_KEY to a Google API key restricted to the YouTube Data API v3.",
  );
}

/**
 * Turn a provider failure into a named state.
 *
 * The provider has already translated Google's wire format into Tally's taxonomy,
 * so this switches on the code rather than re-parsing an HTTP response. The
 * messages below are written here rather than taken from the error, because §21
 * forbids letting an internal error or a provider detail reach the browser.
 */
function failure(
  videoId: string,
  error: unknown,
  options: AnalyzeSourceOptions,
): SourceAnalysisResult {
  const code = errorCodeOf(error);

  log.warn("source analysis failed", {
    userId: options.userId,
    traceId: options.traceId ?? undefined,
    videoId,
    errorCode: code,
    error,
  });

  const state: Exclude<SourceAnalysisState, "ok"> =
    code === "provider_not_configured"
      ? "not_configured"
      : code === "provider_rate_limited"
        ? "quota_exceeded"
        : code === "not_found"
          ? "not_found"
          : code === "provider_scope_missing" ||
              code === "provider_auth_failed" ||
              code === "forbidden"
            ? "forbidden"
            : "unavailable";

  // Written here rather than passed through from the provider. A translated
  // provider message can carry a URL, a project id or a quota table, and §21
  // forbids any of that reaching the browser — the only exception is
  // `not_configured`, whose message is a variable name Tally itself wrote.
  const message =
    state === "quota_exceeded"
      ? "YouTube's daily API quota is used up. Research will work again once it " +
        "resets, usually within 24 hours."
      : state === "forbidden"
        ? "YouTube refused to return this video's details."
        : state === "not_found"
          ? "That video is not available to read."
          : state === "not_configured"
            ? userMessageOf(error)
            : "Could not reach YouTube to read that video. Try again shortly.";

  return {
    state,
    videoId,
    message,
    errorCode: code,
    missingEnvVars: state === "not_configured" ? ["YOUTUBE_API_KEY"] : [],
    /**
     * Quota resets, and an unreachable API recovers; a refusal and a missing key
     * do not fix themselves.
     *
     * The `unavailable` bucket asks the error rather than assuming, because it is
     * the catch-all: the provider already decided whether *its* failure is worth
     * another attempt, and `translate()` marks a permanent 403 non-retryable
     * while leaving a 5xx or a socket error retryable. Assuming true here told a
     * user to try again after a refusal that will never change (§23 case 20).
     */
    retryable:
      state === "quota_exceeded" || (state === "unavailable" && isRetryable(error)),
  };
}

// ---------------------------------------------------------------------------
// Persistence shape
// ---------------------------------------------------------------------------

/**
 * The analysis reduced to what `research_runs.source_analysis` stores.
 *
 * `Date` does not survive a `jsonb` round trip as a Date, so timestamps are
 * written as ISO strings and the reader knows to parse them. Explicit rather than
 * a spread cast, so adding a field to `SourceAnalysis` is a deliberate decision
 * about whether it belongs in the durable record.
 */
export function toStoredAnalysis(
  analysis: SourceAnalysis,
): Record<string, unknown> {
  return {
    videoId: analysis.videoId,
    url: analysis.url,
    linkForm: analysis.linkForm,
    title: analysis.title,
    description: analysis.description,
    channelId: analysis.channelId,
    channelTitle: analysis.channelTitle,
    publishedAt: analysis.publishedAt?.toISOString() ?? null,
    categoryId: analysis.categoryId,
    categoryTitle: analysis.categoryTitle,
    tags: analysis.tags,
    durationSeconds: analysis.durationSeconds,
    language: analysis.language,
    viewCount: analysis.viewCount,
    likeCount: analysis.likeCount,
    commentCount: analysis.commentCount,
    viewsPerHour: analysis.viewsPerHour,
    engagementRate: analysis.engagementRate,
    thumbnailUrl: analysis.thumbnailUrl,
    privacyStatus: analysis.privacyStatus,
    madeForKids: analysis.madeForKids,
    transcript: analysis.transcript,
    topics: analysis.topics,
    niche: analysis.niche,
    missingFields: analysis.missingFields,
  };
}

/**
 * YouTubeProvider — the only place Tally talks to Google (§6, §32).
 *
 * Everything above this module deals in Tally's own types. That boundary is what
 * makes the rest of the codebase testable without a Google account, and it is
 * where three of the spec's hard rules are enforced:
 *
 *  - §6 Tally never sees a YouTube password. The user authorises Google, Google
 *    hands us tokens, and those tokens live encrypted in Postgres. This module
 *    receives an access token as an argument and never reads the database.
 *  - §42 There is no mock. YouTube is the one capability that cannot be faked:
 *    a "published" video that YouTube never received is precisely the lie the
 *    spec forbids. Without credentials every entry point throws
 *    NotConfiguredError, which the API layer renders as a 503 configuration
 *    state naming GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
 *  - §40 Upload and publish additionally refuse to run while
 *    TALLY_BLOCK_REAL_PUBLISH is set, so local work cannot touch a real channel.
 *
 * Errors are translated into the taxonomy in lib/errors, because the caller's
 * decision — retry, surface, or force re-authorisation — depends on the class of
 * failure and not on Google's wire format. In particular `invalid_grant` on
 * refresh becomes ReauthRequiredError: only the user can fix it.
 */
import { Readable } from "node:stream";
import { google, type youtube_v3 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { env, realPublishBlocked, youtubeRedirectUri } from "@/lib/env";
import {
  AppError,
  isAppError,
  NotConfiguredError,
  ProviderError,
  ProviderRateLimitError,
  ProviderScopeError,
  PublishBlockedError,
  ReauthRequiredError,
  YouTubeUploadError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "youtube", provider: "google" });

export const YOUTUBE_PROVIDER = "google";

/**
 * Scopes requested at consent.
 *
 * `youtube` (read/write) rather than `youtube.readonly` + `youtube.upload`
 * separately, because setting a thumbnail and editing metadata after upload both
 * require the read/write scope. `yt-analytics.readonly` powers §26.
 *
 * Deliberately NOT requested: `youtube.force-ssl` beyond what we need, and any
 * monetary-analytics scope. Revenue figures would require
 * `yt-analytics-monetary.readonly`; Tally does not ask for it, so it does not
 * display revenue it cannot measure (§42).
 */
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
] as const;

/** Scopes without which the pipeline cannot do its job. */
const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.upload",
] as const;

/**
 * The scope YouTube requires before it will report earnings.
 *
 * Named here, and checked before any revenue query is issued, because the
 * failure mode without it is the one §7 of Phase 9 singles out: a monetised
 * channel silently reporting $0.00. Tally does not request this scope at consent
 * (see `YOUTUBE_SCOPES`), so in practice `revenueState` is `scope_missing` — an
 * explicit permission state, not an earnings figure.
 */
export const YOUTUBE_MONETARY_SCOPE =
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly";

/** Whether a granted-scope string permits revenue reporting. */
export function hasMonetaryScope(grantedScope: string | null | undefined): boolean {
  if (!grantedScope) return false;
  return grantedScope.split(/\s+/).includes(YOUTUBE_MONETARY_SCOPE);
}

const CONFIG_HINT =
  "Google Cloud console -> APIs & Services -> Credentials -> OAuth 2.0 Client ID " +
  "(type: Web application). Enable YouTube Data API v3 and YouTube Analytics API, " +
  `and add ${youtubeRedirectUriSafe()} as an authorised redirect URI.`;

/** The redirect URI, or a placeholder if the env is not loadable yet. */
function youtubeRedirectUriSafe(): string {
  try {
    return youtubeRedirectUri();
  } catch {
    return "{APP_URL}/api/channels/callback";
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
}

/** True when the OAuth client credentials are present. */
export function isYouTubeConfigured(): boolean {
  const e = env();
  return Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET);
}

/**
 * Missing credential names, for the configuration banner. Empty when ready.
 */
export function youtubeMissingEnvVars(): string[] {
  const e = env();
  const missing: string[] = [];
  if (!e.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!e.GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  return missing;
}

/**
 * Credentials or a 503. Called at the top of every operation, so there is no
 * code path that reaches Google without them and none that silently degrades.
 */
export function requireGoogleCredentials(): GoogleCredentials {
  const e = env();
  if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET) {
    throw new NotConfiguredError("YouTube", youtubeMissingEnvVars(), CONFIG_HINT);
  }
  return { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET };
}

function oauthClient(): OAuth2Client {
  const { clientId, clientSecret } = requireGoogleCredentials();
  return new OAuth2Client({
    clientId,
    clientSecret,
    redirectUri: youtubeRedirectUri(),
  });
}

/** An API client bound to one channel's access token. */
function youtubeClient(accessToken: string): youtube_v3.Youtube {
  const auth = new OAuth2Client();
  auth.setCredentials({ access_token: accessToken });
  return google.youtube({ version: "v3", auth });
}

// ---------------------------------------------------------------------------
// Consent + token exchange
// ---------------------------------------------------------------------------

export interface ConsentUrlOptions {
  /** Signed, single-use nonce echoed back by Google. */
  state: string;
  /**
   * Force the account chooser. Used when adding a second channel, otherwise
   * Google silently reuses the signed-in account and the user cannot pick.
   */
  forceAccountSelection?: boolean;
  /** Pre-fill the account, e.g. when re-authorising a known channel. */
  loginHint?: string;
}

/**
 * Build the Google consent URL.
 *
 * `access_type: "offline"` + `prompt: "consent"` is required to receive a
 * refresh token. Google only returns one on the first authorisation unless
 * consent is re-prompted — and without a refresh token the channel would break
 * an hour later with no way to recover but a manual reconnect (§6).
 */
export function buildConsentUrl(options: ConsentUrlOptions): string {
  const client = oauthClient();
  const prompts = ["consent"];
  if (options.forceAccountSelection) prompts.push("select_account");

  return client.generateAuthUrl({
    access_type: "offline",
    scope: [...YOUTUBE_SCOPES],
    include_granted_scopes: true,
    prompt: prompts.join(" "),
    state: options.state,
    ...(options.loginHint ? { login_hint: options.loginHint } : {}),
  });
}

export interface TokenSet {
  accessToken: string;
  /** Absent when Google reuses an existing grant; callers must keep the old one. */
  refreshToken: string | null;
  expiresAt: Date;
  /** Space-separated scope list as granted, which may differ from requested. */
  scope: string;
}

/** Exchange an authorisation code for tokens. */
export async function exchangeCode(code: string): Promise<TokenSet> {
  const client = oauthClient();
  try {
    const { tokens } = await client.getToken(code);
    if (!tokens.access_token) {
      throw new ProviderError("YouTube", "Google returned no access token.", {
        retryable: false,
      });
    }
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt: expiryFrom(tokens.expiry_date),
      scope: tokens.scope ?? "",
    };
  } catch (error) {
    throw translate(error, "oauth.exchange");
  }
}

/**
 * Exchange a refresh token for a new access token.
 *
 * Done with a direct call to the token endpoint rather than
 * `OAuth2Client.refreshAccessToken()`: that method is deprecated in
 * google-auth-library 9.x, and the raw response lets us distinguish
 * `invalid_grant` — a revoked or expired grant that only the user can fix — from
 * a transient 5xx that should be retried.
 */
export async function refreshAccessToken(refreshToken: string): Promise<TokenSet> {
  const { clientId, clientSecret } = requireGoogleCredentials();

  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } catch (error) {
    // Network-level failure: the grant may well still be valid.
    throw new ProviderError("YouTube", "Could not reach Google to refresh the token.", {
      retryable: true,
      cause: error,
    });
  }

  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok) {
    // `invalid_grant` means revoked, expired, or password-changed. Retrying is
    // pointless; the channel needs re-authorisation by its owner (§30).
    if (body.error === "invalid_grant" || response.status === 400) {
      throw new ReauthRequiredError(
        "unknown",
        body.error_description ?? body.error ?? "Google rejected the refresh token.",
      );
    }
    if (response.status === 429) {
      throw new ProviderRateLimitError("YouTube", 60);
    }
    throw new ProviderError(
      "YouTube",
      `Token refresh failed (${response.status}): ${body.error ?? "unknown error"}`,
      { retryable: response.status >= 500 },
    );
  }

  if (!body.access_token) {
    throw new ProviderError("YouTube", "Token refresh returned no access token.", {
      retryable: false,
    });
  }

  return {
    accessToken: body.access_token,
    // Google normally omits this on refresh; the stored one stays valid.
    refreshToken: body.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000),
    scope: body.scope ?? "",
  };
}

/**
 * Best-effort revocation at Google, used when a user disconnects a channel.
 *
 * Failure is logged, not thrown: the local disconnect must still complete, or a
 * user could be stuck with a channel they cannot remove.
 */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const response = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    if (!response.ok) {
      log.warn("google refused token revocation", { httpStatus: response.status });
    }
    return response.ok;
  } catch (error) {
    log.warn("could not reach google to revoke token", { error });
    return false;
  }
}

function expiryFrom(expiryDate: number | null | undefined): Date {
  if (typeof expiryDate === "number") return new Date(expiryDate);
  // Google's access tokens are one hour; assume the floor rather than treating
  // the token as non-expiring, which would defer refresh until a 401.
  return new Date(Date.now() + 3600 * 1000);
}

/** Scopes the user did not grant, out of the ones the pipeline needs. */
export function missingRequiredScopes(grantedScope: string): string[] {
  const granted = new Set(grantedScope.split(/\s+/).filter(Boolean));
  return REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
}

// ---------------------------------------------------------------------------
// Channel reads
// ---------------------------------------------------------------------------

export interface YouTubeChannel {
  channelId: string;
  title: string;
  handle: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  /** null when the channel hides its subscriber count — not zero (§42). */
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: string | null;
  uploadsPlaylistId: string | null;
  country: string | null;
  defaultLanguage: string | null;
}

/**
 * The channel belonging to the authorising account (`mine: true`).
 *
 * Returns null when the Google account has no YouTube channel at all, which is a
 * real and common case: the user has to create one before Tally can help.
 */
export async function fetchMyChannel(
  accessToken: string,
): Promise<YouTubeChannel | null> {
  try {
    const response = await youtubeClient(accessToken).channels.list({
      part: ["id", "snippet", "statistics", "contentDetails", "brandingSettings"],
      mine: true,
      maxResults: 1,
    });
    const item = response.data.items?.[0];
    return item ? mapChannel(item) : null;
  } catch (error) {
    throw translate(error, "channels.list.mine");
  }
}

/** Refresh cached statistics for a known channel id. */
export async function fetchChannelById(
  accessToken: string,
  youtubeChannelId: string,
): Promise<YouTubeChannel | null> {
  try {
    const response = await youtubeClient(accessToken).channels.list({
      part: ["id", "snippet", "statistics", "contentDetails", "brandingSettings"],
      id: [youtubeChannelId],
      maxResults: 1,
    });
    const item = response.data.items?.[0];
    return item ? mapChannel(item) : null;
  } catch (error) {
    throw translate(error, "channels.list.byId");
  }
}

function mapChannel(item: youtube_v3.Schema$Channel): YouTubeChannel {
  const stats = item.statistics;
  const snippet = item.snippet;
  return {
    channelId: item.id ?? "",
    title: snippet?.title ?? "Untitled channel",
    handle: snippet?.customUrl ?? null,
    description: snippet?.description ?? null,
    thumbnailUrl:
      snippet?.thumbnails?.high?.url ??
      snippet?.thumbnails?.medium?.url ??
      snippet?.thumbnails?.default?.url ??
      null,
    // `hiddenSubscriberCount` means the number is genuinely unavailable. Storing
    // 0 would render as "0 subscribers", which is a fabrication.
    subscriberCount:
      stats?.hiddenSubscriberCount === true
        ? null
        : numberOrNull(stats?.subscriberCount),
    videoCount: numberOrNull(stats?.videoCount),
    viewCount: stats?.viewCount ?? null,
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
    country: snippet?.country ?? null,
    defaultLanguage: snippet?.defaultLanguage ?? null,
  };
}

function numberOrNull(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface YouTubeVideoSummary {
  videoId: string;
  title: string;
  description: string | null;
  publishedAt: Date | null;
  thumbnailUrl: string | null;
  durationIso: string | null;
  privacyStatus: string | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  tags: string[];
}

/**
 * Recent uploads on a channel.
 *
 * Two calls: the uploads playlist for ordering, then `videos.list` for
 * statistics and duration, which playlist items do not carry. Batched into one
 * `videos.list` rather than N calls, because quota is per-request.
 */
export async function listRecentVideos(
  accessToken: string,
  uploadsPlaylistId: string,
  limit = 25,
): Promise<YouTubeVideoSummary[]> {
  const client = youtubeClient(accessToken);
  try {
    const playlist = await client.playlistItems.list({
      part: ["contentDetails"],
      playlistId: uploadsPlaylistId,
      maxResults: Math.min(Math.max(limit, 1), 50),
    });

    const ids = (playlist.data.items ?? [])
      .map((item) => item.contentDetails?.videoId)
      .filter((id): id is string => Boolean(id));

    if (ids.length === 0) return [];

    const videos = await client.videos.list({
      part: ["snippet", "statistics", "contentDetails", "status"],
      id: ids,
      maxResults: ids.length,
    });

    return (videos.data.items ?? []).map((item) => ({
      videoId: item.id ?? "",
      title: item.snippet?.title ?? "",
      description: item.snippet?.description ?? null,
      publishedAt: item.snippet?.publishedAt
        ? new Date(item.snippet.publishedAt)
        : null,
      thumbnailUrl:
        item.snippet?.thumbnails?.high?.url ??
        item.snippet?.thumbnails?.medium?.url ??
        null,
      durationIso: item.contentDetails?.duration ?? null,
      privacyStatus: item.status?.privacyStatus ?? null,
      viewCount: numberOrNull(item.statistics?.viewCount),
      likeCount: numberOrNull(item.statistics?.likeCount),
      commentCount: numberOrNull(item.statistics?.commentCount),
      tags: item.snippet?.tags ?? [],
    }));
  } catch (error) {
    throw translate(error, "playlistItems.list");
  }
}

// ---------------------------------------------------------------------------
// Discovery reads (§7)
// ---------------------------------------------------------------------------

export interface SearchVideosQuery {
  /** Free-text query, e.g. a niche keyword. */
  query: string;
  /** Only videos published at or after this instant. */
  publishedAfter?: Date;
  /**
   * `viewCount` finds what is already big; `date` finds what is breaking out.
   * Research asks for both and treats them as different signals.
   */
  order?: "relevance" | "viewCount" | "date";
  maxResults?: number;
  /** ISO-3166-1 alpha-2. Narrows results to the channel's market. */
  regionCode?: string;
  /** BCP-47 language of the results the caller wants. */
  relevanceLanguage?: string;
  /** Restrict to one channel — used to read a competitor's catalogue. */
  channelId?: string;
}

/** One search hit. Statistics are absent: `search.list` does not return them. */
export interface SearchHit {
  videoId: string;
  title: string;
  description: string | null;
  channelId: string | null;
  channelTitle: string | null;
  publishedAt: Date | null;
  thumbnailUrl: string | null;
}

/**
 * Search public YouTube for videos.
 *
 * Quota: `search.list` costs **100 units** against a 10,000/day default project
 * quota, which is why the research engine issues a small fixed number of these
 * per run and never one per keyword. `videos.list` (1 unit) is used for the
 * statistics afterwards, batched 50 at a time.
 *
 * `type: ["video"]` matters — without it the response mixes channels and
 * playlists, whose `id` has no `videoId` and which would silently drop out.
 */
export async function searchVideos(
  accessToken: string,
  query: SearchVideosQuery,
): Promise<SearchHit[]> {
  const client = youtubeClient(accessToken);
  try {
    const response = await client.search.list({
      part: ["snippet"],
      q: query.query,
      type: ["video"],
      order: query.order ?? "relevance",
      maxResults: Math.min(Math.max(query.maxResults ?? 25, 1), 50),
      ...(query.publishedAfter
        ? { publishedAfter: query.publishedAfter.toISOString() }
        : {}),
      ...(query.regionCode ? { regionCode: query.regionCode } : {}),
      ...(query.relevanceLanguage
        ? { relevanceLanguage: query.relevanceLanguage }
        : {}),
      ...(query.channelId ? { channelId: query.channelId } : {}),
    });

    return (response.data.items ?? []).flatMap((item) => {
      const videoId = item.id?.videoId;
      if (!videoId) return [];
      const snippet = item.snippet;
      return [
        {
          videoId,
          title: snippet?.title ?? "",
          description: snippet?.description ?? null,
          channelId: snippet?.channelId ?? null,
          channelTitle: snippet?.channelTitle ?? null,
          publishedAt: snippet?.publishedAt
            ? new Date(snippet.publishedAt)
            : null,
          thumbnailUrl:
            snippet?.thumbnails?.high?.url ??
            snippet?.thumbnails?.medium?.url ??
            null,
        },
      ];
    });
  } catch (error) {
    throw translate(error, "search.list");
  }
}

/**
 * Statistics and duration for known video ids.
 *
 * Batched in 50s because that is the `id` limit per request, and one request per
 * video would multiply quota by fifty for no benefit. Ids YouTube does not
 * return (deleted, private, region-blocked) are simply absent from the result —
 * the caller must not assume a 1:1 mapping.
 */
export async function fetchVideosByIds(
  accessToken: string,
  videoIds: string[],
): Promise<YouTubeVideoSummary[]> {
  if (videoIds.length === 0) return [];
  const client = youtubeClient(accessToken);
  const unique = [...new Set(videoIds)];
  const out: YouTubeVideoSummary[] = [];

  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    try {
      const response = await client.videos.list({
        part: ["snippet", "statistics", "contentDetails", "status"],
        id: batch,
        maxResults: batch.length,
      });
      for (const item of response.data.items ?? []) {
        out.push({
          videoId: item.id ?? "",
          title: item.snippet?.title ?? "",
          description: item.snippet?.description ?? null,
          publishedAt: item.snippet?.publishedAt
            ? new Date(item.snippet.publishedAt)
            : null,
          thumbnailUrl:
            item.snippet?.thumbnails?.high?.url ??
            item.snippet?.thumbnails?.medium?.url ??
            null,
          durationIso: item.contentDetails?.duration ?? null,
          privacyStatus: item.status?.privacyStatus ?? null,
          viewCount: numberOrNull(item.statistics?.viewCount),
          likeCount: numberOrNull(item.statistics?.likeCount),
          commentCount: numberOrNull(item.statistics?.commentCount),
          tags: item.snippet?.tags ?? [],
        });
      }
    } catch (error) {
      throw translate(error, "videos.list.byIds");
    }
  }

  return out;
}

/** A competitor channel as YouTube reports it, for the §7 competitor view. */
export interface CompetitorChannel {
  channelId: string;
  title: string;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: string | null;
  thumbnailUrl: string | null;
}

/**
 * Public statistics for channel ids discovered in search results.
 *
 * Competitors are derived from who actually ranks for the user's topics rather
 * than from a list someone typed in, so this takes the ids the search returned.
 * Batched 50 at a time, 1 quota unit per request.
 */
export async function fetchChannelsByIds(
  accessToken: string,
  channelIds: string[],
): Promise<CompetitorChannel[]> {
  if (channelIds.length === 0) return [];
  const client = youtubeClient(accessToken);
  const unique = [...new Set(channelIds)];
  const out: CompetitorChannel[] = [];

  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    try {
      const response = await client.channels.list({
        part: ["id", "snippet", "statistics"],
        id: batch,
        maxResults: batch.length,
      });
      for (const item of response.data.items ?? []) {
        const stats = item.statistics;
        out.push({
          channelId: item.id ?? "",
          title: item.snippet?.title ?? "",
          // Hidden means unavailable, not zero — same rule as `mapChannel`.
          subscriberCount:
            stats?.hiddenSubscriberCount === true
              ? null
              : numberOrNull(stats?.subscriberCount),
          videoCount: numberOrNull(stats?.videoCount),
          viewCount: stats?.viewCount ?? null,
          thumbnailUrl:
            item.snippet?.thumbnails?.medium?.url ??
            item.snippet?.thumbnails?.default?.url ??
            null,
        });
      }
    } catch (error) {
      throw translate(error, "channels.list.byIds");
    }
  }

  return out;
}

/**
 * The regional "most popular" chart.
 *
 * A cheap (1 unit) broad-trend signal, used to notice a topic rising across all
 * of YouTube rather than only inside the user's niche. Category filtering is
 * left to the caller: `videoCategoryId` narrows it, but the numeric ids differ
 * per region, so passing one blindly returns nothing.
 */
export async function fetchMostPopular(
  accessToken: string,
  options: { regionCode?: string; videoCategoryId?: string; maxResults?: number } = {},
): Promise<YouTubeVideoSummary[]> {
  const client = youtubeClient(accessToken);
  try {
    const response = await client.videos.list({
      part: ["snippet", "statistics", "contentDetails", "status"],
      chart: "mostPopular",
      regionCode: options.regionCode ?? "US",
      ...(options.videoCategoryId
        ? { videoCategoryId: options.videoCategoryId }
        : {}),
      maxResults: Math.min(Math.max(options.maxResults ?? 25, 1), 50),
    });

    return (response.data.items ?? []).map((item) => ({
      videoId: item.id ?? "",
      title: item.snippet?.title ?? "",
      description: item.snippet?.description ?? null,
      publishedAt: item.snippet?.publishedAt
        ? new Date(item.snippet.publishedAt)
        : null,
      thumbnailUrl:
        item.snippet?.thumbnails?.high?.url ??
        item.snippet?.thumbnails?.medium?.url ??
        null,
      durationIso: item.contentDetails?.duration ?? null,
      privacyStatus: item.status?.privacyStatus ?? null,
      viewCount: numberOrNull(item.statistics?.viewCount),
      likeCount: numberOrNull(item.statistics?.likeCount),
      commentCount: numberOrNull(item.statistics?.commentCount),
      tags: item.snippet?.tags ?? [],
    }));
  } catch (error) {
    throw translate(error, "videos.list.mostPopular");
  }
}

/** Processing/publication state of one video, as YouTube reports it. */
export interface YouTubeVideoStatus {
  videoId: string;
  uploadStatus: string | null;
  privacyStatus: string | null;
  /** Present while YouTube is still transcoding. */
  processingStatus: string | null;
  publishAt: Date | null;
  rejectionReason: string | null;
  /**
   * True when YouTube rejected the upload over a copyright claim (§29).
   *
   * `rejectionReason === "claim"` is the only signal the Data API gives for
   * this. Note it is NOT `contentDetails.licensedContent`, which means something
   * unrelated ("this video is claimed by a content partner") and is commonly
   * true on legitimate uploads.
   */
  hasCopyrightClaim: boolean;
}

/**
 * The authoritative answer to "is it published?".
 *
 * §42 forbids showing "Published" on our own optimism; the publish worker polls
 * this and only writes PUBLISHED once `privacyStatus` and `uploadStatus` confirm
 * it.
 */
export async function fetchVideoStatus(
  accessToken: string,
  videoId: string,
): Promise<YouTubeVideoStatus | null> {
  try {
    const response = await youtubeClient(accessToken).videos.list({
      part: ["status", "processingDetails"],
      id: [videoId],
      maxResults: 1,
    });
    const item = response.data.items?.[0];
    if (!item) return null;
    return {
      videoId: item.id ?? videoId,
      uploadStatus: item.status?.uploadStatus ?? null,
      privacyStatus: item.status?.privacyStatus ?? null,
      processingStatus: item.processingDetails?.processingStatus ?? null,
      publishAt: item.status?.publishAt ? new Date(item.status.publishAt) : null,
      rejectionReason: item.status?.rejectionReason ?? null,
      hasCopyrightClaim: item.status?.rejectionReason === "claim",
    };
  } catch (error) {
    throw translate(error, "videos.list.status");
  }
}

// ---------------------------------------------------------------------------
// Analytics (§26)
// ---------------------------------------------------------------------------

export interface AnalyticsRow {
  /** YYYY-MM-DD as returned by the API. */
  date: string;
  videoId: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  subscribersGained: number | null;
  subscribersLost: number | null;
  watchTimeMinutes: number | null;
  averageViewDurationSeconds: number | null;
  averageViewPercentage: number | null;
  /**
   * Estimated revenue as the *exact decimal string* the API returned, not a
   * float.
   *
   * A string because this is money: `0.017` cannot be represented exactly in
   * binary floating point, and the value is on its way to a `numeric` column. It
   * is never parsed with `Number()` on the write path (§7 of Phase 9).
   *
   * `null` means the metric was not returned. `revenueRequested` distinguishes
   * "not asked for" from "asked for and absent".
   */
  estimatedRevenue: string | null;
  /** True when the revenue metric was included in the request. */
  revenueRequested: boolean;
  /** ISO-4217 the figure is denominated in. Preserved, never converted. */
  currency: string | null;
}

/**
 * Metrics requested from YouTube Analytics.
 *
 * Thumbnail impressions and impression click-through rate are deliberately
 * absent: YouTube Analytics API v2 does not expose them (they exist only in
 * Studio). Tally therefore leaves `ctr` null rather than estimating it — an
 * invented CTR would poison the scoring loop in §8 and violate §42.
 */
const ANALYTICS_METRICS = [
  "views",
  "likes",
  "comments",
  "shares",
  "subscribersGained",
  "subscribersLost",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
] as const;

/**
 * Revenue metrics, requested only when the caller has confirmed the monetary
 * scope is granted.
 *
 * Appended rather than merged into `ANALYTICS_METRICS` because asking for
 * `estimatedRevenue` without the scope makes the *whole* query fail with a 403 —
 * so an unconditional request would take the view counts down with it.
 */
const REVENUE_METRICS = ["estimatedRevenue"] as const;

/**
 * The currency revenue is requested in.
 *
 * Fixed rather than per-user because the figure is stored alongside its currency
 * code and never converted; a per-request currency would mean the same channel's
 * history was denominated in whatever was configured on the day (§7).
 */
export const ANALYTICS_REVENUE_CURRENCY = "USD";

export interface AnalyticsQuery {
  /** ISO date, inclusive. */
  startDate: string;
  endDate: string;
  /** Restrict to specific videos. Omit for channel totals. */
  videoIds?: string[];
  /** Break the result down per video as well as per day. */
  byVideo?: boolean;
  /**
   * Include revenue metrics.
   *
   * The caller must have verified `hasMonetaryScope()` first. This function does
   * not check, because it only holds an access token and not the grant record —
   * but it does report back, per row, whether revenue was requested, so a caller
   * cannot mistake an unrequested metric for a zero.
   */
  includeRevenue?: boolean;
}

/**
 * Daily analytics for the authorising channel.
 *
 * `ids: "channel==MINE"` scopes the query to the token's own channel, so this
 * cannot read another creator's numbers even if a channel id were passed in.
 */
export async function fetchAnalytics(
  accessToken: string,
  query: AnalyticsQuery,
): Promise<AnalyticsRow[]> {
  const auth = new OAuth2Client();
  auth.setCredentials({ access_token: accessToken });
  const analytics = google.youtubeAnalytics({ version: "v2", auth });

  const dimensions = query.byVideo ? ["day", "video"] : ["day"];
  const withRevenue = query.includeRevenue === true;
  const metrics = withRevenue
    ? [...ANALYTICS_METRICS, ...REVENUE_METRICS]
    : [...ANALYTICS_METRICS];

  try {
    const response = await analytics.reports.query({
      ids: "channel==MINE",
      startDate: query.startDate,
      endDate: query.endDate,
      metrics: metrics.join(","),
      dimensions: dimensions.join(","),
      ...(query.videoIds && query.videoIds.length > 0
        ? { filters: `video==${query.videoIds.join(",")}` }
        : {}),
      ...(withRevenue ? { currency: ANALYTICS_REVENUE_CURRENCY } : {}),
      maxResults: 10_000,
    });

    const headers = (response.data.columnHeaders ?? []).map((h) => h.name ?? "");
    const rows = response.data.rows ?? [];

    return rows.map((row) => {
      const cells = row as Array<string | number>;
      const at = (name: string): string | number | undefined => {
        const index = headers.indexOf(name);
        return index === -1 ? undefined : cells[index];
      };
      const num = (name: string): number | null => {
        const value = at(name);
        return typeof value === "number" ? value : null;
      };
      /**
       * Money as an exact decimal string.
       *
       * The googleapis client has already parsed the JSON, so a numeric cell is
       * a JS number by the time it reaches here. `toString()` on it is lossless
       * for every value the API can send — the loss §7 forbids would come from
       * *arithmetic* on the float, and none is done: the string goes straight to
       * a `numeric` column.
       */
      const money = (name: string): string | null => {
        const value = at(name);
        if (typeof value === "number") {
          return Number.isFinite(value) ? value.toString() : null;
        }
        if (typeof value === "string" && value.trim() !== "") return value.trim();
        return null;
      };
      return {
        date: String(at("day") ?? ""),
        videoId: query.byVideo ? String(at("video") ?? "") || null : null,
        views: num("views"),
        likes: num("likes"),
        comments: num("comments"),
        shares: num("shares"),
        subscribersGained: num("subscribersGained"),
        subscribersLost: num("subscribersLost"),
        watchTimeMinutes: num("estimatedMinutesWatched"),
        averageViewDurationSeconds: num("averageViewDuration"),
        averageViewPercentage: num("averageViewPercentage"),
        estimatedRevenue: withRevenue ? money("estimatedRevenue") : null,
        revenueRequested: withRevenue,
        currency: withRevenue ? ANALYTICS_REVENUE_CURRENCY : null,
      };
    });
  } catch (error) {
    throw translate(error, "youtubeAnalytics.reports.query");
  }
}

// ---------------------------------------------------------------------------
// Upload + publish (§6, §18, §40)
// ---------------------------------------------------------------------------

export interface UploadVideoInput {
  accessToken: string;
  title: string;
  description: string;
  tags: string[];
  categoryId?: string;
  /** BCP-47 tag for the audio/description language. */
  language?: string;
  /**
   * `private` + publishAt schedules; `public` publishes immediately.
   * `unlisted` is used for review copies.
   */
  privacyStatus: "public" | "unlisted" | "private";
  /** Only honoured by YouTube when privacyStatus is `private`. */
  publishAt?: Date | null;
  /** The rendered video. A stream, so a 500MB file is never buffered in RAM. */
  body: Readable;
  mimeType?: string;
  /**
   * Called with the cumulative byte count as the stream is consumed, so the job
   * row can carry a real percentage rather than an invented one (§37, §42). The
   * caller supplies the total, since it is the side that knows the file size.
   */
  onProgress?: (bytesUploaded: number) => void;
  /** Whether the user declared the video as made for kids. Required by YouTube. */
  madeForKids?: boolean;
}

export interface UploadVideoResult {
  videoId: string;
  uploadStatus: string | null;
  privacyStatus: string | null;
  publishAt: Date | null;
  url: string;
}

/**
 * Upload a rendered video.
 *
 * The body is streamed rather than buffered, so a large render never sits in
 * memory. `onUploadProgress` is a googleapis-common feature (it pipes the media
 * stream through a counting stream), which is what lets the publish stage report
 * bytes actually sent instead of a fabricated percentage.
 *
 * The §40 publish guard is checked first: in development this throws before a
 * single byte leaves the machine.
 *
 * §29 note: YouTube's altered/synthetic-content disclosure has no field in the
 * Data API — it is made in Studio — so `videos.insert` cannot file it. The
 * publish stage therefore records the disclosure as outstanding on the project
 * and surfaces it to the user; nothing here claims it was filed.
 */
export async function uploadVideo(
  input: UploadVideoInput,
): Promise<UploadVideoResult> {
  requireGoogleCredentials();
  if (realPublishBlocked()) throw new PublishBlockedError();

  const client = youtubeClient(input.accessToken);

  try {
    const response = await client.videos.insert(
      {
        part: ["snippet", "status"],
        notifySubscribers: input.privacyStatus === "public",
        requestBody: {
          snippet: {
            title: input.title.slice(0, 100),
            description: input.description.slice(0, 5000),
            tags: input.tags.slice(0, 60),
            categoryId: input.categoryId ?? "22",
            ...(input.language
              ? {
                  defaultLanguage: input.language,
                  defaultAudioLanguage: input.language,
                }
              : {}),
          },
          status: {
            privacyStatus: input.privacyStatus,
            // YouTube only honours publishAt on a private video, and rejects
            // the combination otherwise.
            ...(input.publishAt && input.privacyStatus === "private"
              ? { publishAt: input.publishAt.toISOString() }
              : {}),
            selfDeclaredMadeForKids: input.madeForKids ?? false,
          },
        },
        media: {
          mimeType: input.mimeType ?? "video/mp4",
          body: input.body,
        },
      },
      {
        // Resumable upload with progress. Without this the UI could only show an
        // indeterminate spinner for a multi-minute upload (§37).
        onUploadProgress: (event: { bytesRead?: number }) => {
          if (input.onProgress && typeof event.bytesRead === "number") {
            input.onProgress(event.bytesRead);
          }
        },
      },
    );

    const videoId = response.data.id;
    if (!videoId) {
      throw new YouTubeUploadError("YouTube accepted the upload but returned no video id.", {
        retryable: false,
      });
    }

    log.info("video uploaded", {
      status: "ok",
      videoId,
      privacyStatus: response.data.status?.privacyStatus ?? null,
    });

    return {
      videoId,
      uploadStatus: response.data.status?.uploadStatus ?? null,
      privacyStatus: response.data.status?.privacyStatus ?? null,
      publishAt: response.data.status?.publishAt
        ? new Date(response.data.status.publishAt)
        : null,
      url: watchUrl(videoId),
    };
  } catch (error) {
    const translated = translate(error, "videos.insert");
    // Keep the upload-specific code so the publish stage can present it, but
    // preserve the retryability the translation worked out.
    throw new YouTubeUploadError(translated.message, {
      retryable: translated.retryable,
      cause: error,
    });
  }
}

/** Public watch URL. Built here so nothing else has to know the format. */
export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export interface SetThumbnailInput {
  accessToken: string;
  videoId: string;
  body: Readable;
  mimeType?: string;
}

/**
 * Attach a custom thumbnail.
 *
 * A separate call from the upload because YouTube requires the video to exist
 * first, and because thumbnail A/B testing (§16) replaces it later without
 * re-uploading the video.
 */
export async function setThumbnail(input: SetThumbnailInput): Promise<void> {
  requireGoogleCredentials();
  if (realPublishBlocked()) throw new PublishBlockedError();

  try {
    await youtubeClient(input.accessToken).thumbnails.set({
      videoId: input.videoId,
      media: {
        mimeType: input.mimeType ?? "image/jpeg",
        body: input.body,
      },
    });
    log.info("thumbnail set", { status: "ok", videoId: input.videoId });
  } catch (error) {
    throw translate(error, "thumbnails.set");
  }
}

export interface UpdateVideoInput {
  accessToken: string;
  videoId: string;
  title?: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  privacyStatus?: "public" | "unlisted" | "private";
  publishAt?: Date | null;
}

/**
 * Update metadata or visibility on an existing video.
 *
 * `videos.update` replaces whole parts, so the current snippet is read first and
 * merged — a partial update would otherwise blank the description.
 */
export async function updateVideo(input: UpdateVideoInput): Promise<void> {
  requireGoogleCredentials();
  const client = youtubeClient(input.accessToken);

  try {
    const current = await client.videos.list({
      part: ["snippet", "status"],
      id: [input.videoId],
      maxResults: 1,
    });
    const existing = current.data.items?.[0];
    if (!existing) {
      throw new ProviderError("YouTube", `Video ${input.videoId} not found.`, {
        retryable: false,
      });
    }

    const parts: string[] = [];
    const requestBody: youtube_v3.Schema$Video = { id: input.videoId };

    if (
      input.title !== undefined ||
      input.description !== undefined ||
      input.tags !== undefined ||
      input.categoryId !== undefined
    ) {
      parts.push("snippet");
      requestBody.snippet = {
        ...existing.snippet,
        ...(input.title !== undefined ? { title: input.title.slice(0, 100) } : {}),
        ...(input.description !== undefined
          ? { description: input.description.slice(0, 5000) }
          : {}),
        ...(input.tags !== undefined ? { tags: input.tags.slice(0, 60) } : {}),
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      };
    }

    if (input.privacyStatus !== undefined || input.publishAt !== undefined) {
      // Making a video public is a publish. The dev guard applies.
      if (input.privacyStatus === "public" && realPublishBlocked()) {
        throw new PublishBlockedError();
      }
      parts.push("status");
      requestBody.status = {
        ...existing.status,
        ...(input.privacyStatus !== undefined
          ? { privacyStatus: input.privacyStatus }
          : {}),
        ...(input.publishAt !== undefined
          ? { publishAt: input.publishAt ? input.publishAt.toISOString() : null }
          : {}),
      };
    }

    if (parts.length === 0) return;

    await client.videos.update({ part: parts, requestBody });
    log.info("video updated", {
      status: "ok",
      videoId: input.videoId,
      parts,
    });
  } catch (error) {
    throw translate(error, "videos.update");
  }
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

interface GoogleApiErrorShape {
  code?: number;
  status?: number;
  message?: string;
  response?: {
    status?: number;
    data?: {
      error?: {
        code?: number;
        message?: string;
        errors?: Array<{ reason?: string; message?: string }>;
      };
      error_description?: string;
    };
    headers?: Record<string, string | undefined>;
  };
}

/**
 * Map a Google failure onto Tally's taxonomy.
 *
 * The distinctions that matter to callers:
 *  - 401 / invalid_credentials → the access token is stale; refresh and retry.
 *  - invalid_grant → the *refresh* token is dead; only the user can fix it.
 *  - 403 quotaExceeded / rateLimitExceeded → back off, do not burn more quota.
 *  - other 403 (e.g. `youtubeSignupRequired`, `uploadLimitExceeded`) → the user
 *    must act; retrying forever would be pointless and noisy.
 */
export function translate(error: unknown, operation: string): AppError {
  const e = error as GoogleApiErrorShape;

  // Already one of ours (PublishBlockedError, NotConfiguredError, or a nested
  // translation). Re-wrapping would bury the code the caller switches on.
  if (isAppError(error)) return error;

  const status = e.response?.status ?? e.code ?? e.status ?? 0;
  const detail = e.response?.data?.error;
  const reasons = (detail?.errors ?? [])
    .map((r) => r.reason)
    .filter((r): r is string => Boolean(r));
  const message =
    detail?.message ??
    e.response?.data?.error_description ??
    e.message ??
    "Unknown error";

  log.warn("google api call failed", {
    operation,
    httpStatus: status,
    reasons,
    error,
  });

  if (reasons.includes("invalid_grant") || message.includes("invalid_grant")) {
    return new ReauthRequiredError("unknown", message);
  }

  if (status === 401) {
    // Access token expired or revoked. The channel service refreshes and
    // retries once; if the refresh also fails it becomes ReauthRequired.
    return new ReauthRequiredError("unknown", message);
  }

  if (status === 403) {
    if (
      reasons.some((r) =>
        ["quotaExceeded", "rateLimitExceeded", "userRateLimitExceeded"].includes(r),
      )
    ) {
      return new ProviderRateLimitError("YouTube", 15 * 60, error);
    }
    if (reasons.includes("youtubeSignupRequired")) {
      return new ProviderError(
        "YouTube",
        "This Google account has no YouTube channel. Create one, then reconnect.",
        { retryable: false, status: 400, cause: error },
      );
    }
    if (reasons.includes("uploadLimitExceeded")) {
      return new ProviderError(
        "YouTube",
        "This channel has reached its daily upload limit. Try again tomorrow.",
        { retryable: false, cause: error },
      );
    }
    /**
     * Insufficient scope, which is a *permanent* failure that no retry fixes and
     * that must not be reported as a quota problem or as an absence of earnings.
     *
     * Separated out for the revenue path specifically: without this branch, a
     * channel connected before the monetary scope existed would look
     * rate-limited, the analytics job would back off and retry forever, and the
     * dashboard would keep showing a pending state instead of "reconnect to see
     * revenue" (Phase 9 §7, §13).
     */
    if (
      reasons.includes("insufficientPermissions") ||
      reasons.includes("forbidden") ||
      /insufficient (authentication )?scope|insufficientPermissions/i.test(message)
    ) {
      return new ProviderScopeError("YouTube", message, error);
    }
    return new ProviderError("YouTube", message, {
      retryable: false,
      cause: error,
    });
  }

  if (status === 404) {
    return new ProviderError("YouTube", message, {
      retryable: false,
      status: 404,
      cause: error,
    });
  }

  if (status === 429) {
    const retryAfter = Number(e.response?.headers?.["retry-after"] ?? 60);
    return new ProviderRateLimitError(
      "YouTube",
      Number.isFinite(retryAfter) ? retryAfter : 60,
      error,
    );
  }

  if (status >= 500) {
    return new ProviderError("YouTube", message, { retryable: true, cause: error });
  }

  return new ProviderError("YouTube", message, {
    retryable: false,
    cause: error,
  });
}


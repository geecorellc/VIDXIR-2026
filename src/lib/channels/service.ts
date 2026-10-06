/**
 * Channel persistence: encrypted OAuth credentials, token lifecycle, stats (§6, §27).
 *
 * This is the only module that reads or writes channel credentials, and the
 * rules it enforces are the ones §6 and §34 state outright:
 *
 *  - Tokens are AES-256-GCM encrypted before they touch a column, and are
 *    decrypted only inside `withChannelToken` — nothing outside this file ever
 *    holds one, and no function here returns one to a caller.
 *  - `channelView()` is the only shape allowed to leave the server. It has no
 *    token fields at all, so a route cannot leak one by forgetting to strip it.
 *  - Every query carries `userId` in its predicate. Ownership was already proven
 *    by `requireChannelAccess`; the predicate stays because tenant isolation
 *    belongs in the SQL (§34).
 *
 * Token refresh is lazy and shared: any operation that needs Google calls
 * `withChannelToken`, which refreshes when the access token is within the skew
 * window, persists the new one, and retries the operation exactly once if Google
 * rejects a token we believed was live. A dead refresh token sets
 * `reauth_required_at`, which the UI renders as a reconnect prompt (§30) instead
 * of silently failing every job forever.
 */
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/lib/db/schema";
import {
  decryptNullable,
  encryptNullable,
  encryptSecret,
} from "@/lib/crypto";
import {
  ConflictError,
  ForbiddenError,
  ReauthRequiredError,
  isAppError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  fetchChannelById,
  fetchMyChannel,
  hasMonetaryScope,
  missingRequiredScopes,
  refreshAccessToken,
  revokeToken,
  type TokenSet,
  type YouTubeChannel,
} from "@/lib/providers/youtube";
import { initialiseChannelConfig } from "@/lib/settings/service";

const log = logger.child({ component: "channels" });

/**
 * Refresh when this little life remains on the access token.
 *
 * Five minutes covers a slow render upload starting just before expiry: the
 * token has to outlive the whole request, not just its first byte.
 */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Safe views
// ---------------------------------------------------------------------------

/**
 * Everything about a channel that may cross the network boundary.
 *
 * Note what is absent: `accessTokenEnc`, `refreshTokenEnc`. Even encrypted, a
 * ciphertext in a JSON payload is an invitation (§6).
 */
export interface ChannelView {
  id: string;
  youtubeChannelId: string;
  title: string;
  handle: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
  statsRefreshedAt: Date | null;
  /** True when the refresh token was rejected and the user must reconnect. */
  needsReauth: boolean;
  reauthReason: string | null;
  /** Granted scopes, so the UI can explain a partial authorisation. */
  grantedScopes: string[];
  missingScopes: string[];
  connectedAt: Date;
  disconnectedAt: Date | null;
}

const VIEW_COLUMNS = {
  id: channels.id,
  youtubeChannelId: channels.youtubeChannelId,
  title: channels.title,
  handle: channels.handle,
  description: channels.description,
  thumbnailUrl: channels.thumbnailUrl,
  subscriberCount: channels.subscriberCount,
  videoCount: channels.videoCount,
  viewCount: channels.viewCount,
  statsRefreshedAt: channels.statsRefreshedAt,
  reauthRequiredAt: channels.reauthRequiredAt,
  lastTokenErrorMessage: channels.lastTokenErrorMessage,
  grantedScopes: channels.grantedScopes,
  connectedAt: channels.connectedAt,
  disconnectedAt: channels.disconnectedAt,
} as const;

/**
 * The row shape `VIEW_COLUMNS` selects, inferred from the schema rather than
 * declared. Declaring it by hand (or as `Record<string, unknown>`) would let a
 * column rename compile and fail at runtime.
 */
type ViewRow = {
  [K in keyof typeof VIEW_COLUMNS]: (typeof VIEW_COLUMNS)[K]["_"]["data"] | null;
};

function toView(row: ViewRow): ChannelView {
  const scopeText = row.grantedScopes ?? "";
  const granted = scopeText.split(/\s+/).filter(Boolean);
  return {
    id: row.id as string,
    youtubeChannelId: row.youtubeChannelId as string,
    title: row.title as string,
    handle: row.handle,
    description: row.description,
    thumbnailUrl: row.thumbnailUrl,
    subscriberCount: row.subscriberCount,
    videoCount: row.videoCount,
    // numeric(20,0) comes back as a string; Number is safe below 2^53 and
    // YouTube's largest channel is four orders of magnitude short of it.
    viewCount: row.viewCount === null ? null : Number(row.viewCount),
    statsRefreshedAt: row.statsRefreshedAt,
    needsReauth: row.reauthRequiredAt !== null,
    reauthReason: row.lastTokenErrorMessage,
    grantedScopes: granted,
    missingScopes: missingRequiredScopes(scopeText),
    connectedAt: row.connectedAt as Date,
    disconnectedAt: row.disconnectedAt,
  };
}

/** Connected channels for a user, newest first. */
export async function listChannels(userId: string): Promise<ChannelView[]> {
  const rows = await db
    .select(VIEW_COLUMNS)
    .from(channels)
    .where(and(eq(channels.userId, userId), isNull(channels.disconnectedAt)))
    .orderBy(channels.connectedAt);
  return rows.map(toView);
}

/** One channel the user owns, or null. */
export async function getChannel(
  userId: string,
  channelId: string,
): Promise<ChannelView | null> {
  const rows = await db
    .select(VIEW_COLUMNS)
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
    .limit(1);
  const row = rows[0];
  return row ? toView(row) : null;
}

// ---------------------------------------------------------------------------
// Connect / reconnect
// ---------------------------------------------------------------------------

export interface ConnectResult {
  channelId: string;
  /** False when this authorisation re-connected an existing channel. */
  created: boolean;
  title: string;
  /** Scopes the pipeline needs but the user did not grant. */
  missingScopes: string[];
}

/**
 * Persist a completed authorisation.
 *
 * Upserts on `(user_id, youtube_channel_id)` — the unique index — so
 * re-authorising an existing channel updates its credentials rather than
 * creating a duplicate row, and a previously disconnected channel is revived.
 *
 * The refresh token is the subtle part. Google issues one only when it feels
 * like it (first grant, or after `prompt=consent`); on a silent re-authorisation
 * the response has none. Overwriting the stored value with null in that case
 * would destroy the only credential capable of long-lived access, so a null
 * incoming refresh token is *not* written.
 */
export async function connectChannel(input: {
  userId: string;
  tokens: TokenSet;
  channel: YouTubeChannel;
  /** Set when this authorisation was started as a reconnect of a known row. */
  expectedChannelId?: string | null;
}): Promise<ConnectResult> {
  const { userId, tokens, channel } = input;

  // A reconnect that lands on a different YouTube account would silently
  // repoint the channel — and every project already attached to it. Refuse.
  if (input.expectedChannelId) {
    const existing = await getChannel(userId, input.expectedChannelId);
    if (!existing) throw new ForbiddenError("Channel not found or not accessible.");
    if (existing.youtubeChannelId !== channel.channelId) {
      throw new ConflictError(
        `You authorised "${channel.title}", but this was a reconnect of "${existing.title}". ` +
          "Sign in to the matching Google account, or connect it as a new channel.",
        { expected: existing.title, received: channel.title },
      );
    }
  }

  const missingScopes = missingRequiredScopes(tokens.scope);

  // Asked before the upsert so the caller can tell "connected" from
  // "reconnected" — the two need different copy on the way back to the UI.
  const priorRows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.userId, userId),
        eq(channels.youtubeChannelId, channel.channelId),
      ),
    )
    .limit(1);
  const created = priorRows.length === 0;

  const shared = {
    title: channel.title,
    handle: channel.handle,
    description: channel.description,
    thumbnailUrl: channel.thumbnailUrl,
    subscriberCount: channel.subscriberCount,
    videoCount: channel.videoCount,
    viewCount: channel.viewCount,
    statsRefreshedAt: new Date(),
    accessTokenEnc: encryptSecret(tokens.accessToken),
    tokenExpiresAt: tokens.expiresAt,
    grantedScopes: tokens.scope,
    // A fresh authorisation clears any outstanding re-auth demand.
    reauthRequiredAt: null,
    lastTokenErrorMessage: null,
    disconnectedAt: null,
    updatedAt: new Date(),
  };

  // Only written when Google actually sent one, so a silent re-authorisation
  // cannot erase the long-lived credential.
  const refreshPatch = tokens.refreshToken
    ? { refreshTokenEnc: encryptSecret(tokens.refreshToken) }
    : {};

  const rows = await db
    .insert(channels)
    .values({
      userId,
      youtubeChannelId: channel.channelId,
      connectedAt: new Date(),
      ...shared,
      refreshTokenEnc: encryptNullable(tokens.refreshToken),
    })
    .onConflictDoUpdate({
      target: [channels.userId, channels.youtubeChannelId],
      set: { ...shared, ...refreshPatch },
    })
    .returning({ id: channels.id });

  const row = rows[0];
  if (!row) {
    throw new ConflictError("Could not save the channel connection. Try again.");
  }

  // Seed strategy, brand kit and automation from the onboarding answers, so the
  // stage screens have complete settings the moment the channel appears (§28).
  await initialiseChannelConfig(userId, row.id);

  log.info("channel connected", {
    userId,
    channelId: row.id,
    created,
    missingScopes,
    // The channel id is not a secret; the tokens are, and are never logged.
    youtubeChannelId: channel.channelId,
  });

  return {
    channelId: row.id,
    created,
    title: channel.title,
    missingScopes,
  };
}

/**
 * Disconnect a channel.
 *
 * Soft delete: `disconnected_at` is set and the credentials are erased, but the
 * row and everything referencing it (projects, published videos, analytics)
 * survive. Hard-deleting would take a user's publishing history with it, and
 * `published_videos` is the record that a real upload happened.
 *
 * The grant is also revoked at Google — leaving a live refresh token behind
 * after the user asked us to disconnect would be the wrong default.
 */
export async function disconnectChannel(
  userId: string,
  channelId: string,
): Promise<void> {
  const rows = await db
    .select({
      refreshTokenEnc: channels.refreshTokenEnc,
      accessTokenEnc: channels.accessTokenEnc,
    })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
    .limit(1);

  const row = rows[0];
  if (!row) throw new ForbiddenError("Channel not found or not accessible.");

  const token =
    safeDecrypt(row.refreshTokenEnc) ?? safeDecrypt(row.accessTokenEnc);
  if (token) await revokeToken(token);

  await db
    .update(channels)
    .set({
      disconnectedAt: new Date(),
      accessTokenEnc: null,
      refreshTokenEnc: null,
      tokenExpiresAt: null,
      grantedScopes: null,
      reauthRequiredAt: null,
      lastTokenErrorMessage: null,
      updatedAt: new Date(),
    })
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)));

  log.info("channel disconnected", { userId, channelId });
}

/**
 * The diagnostic behind a re-auth demand, for `last_token_error_message`.
 *
 * `ReauthRequiredError` carries fixed user-facing copy and puts the actual cause
 * in `details.reason`, so the reason is what gets persisted — an operator reading
 * the row needs to know it was `invalid_grant` and not a scope change.
 */
function reasonOf(error: { message: string; details?: Record<string, unknown> }): string {
  const reason = error.details?.["reason"];
  return typeof reason === "string" && reason.length > 0 ? reason : error.message;
}

/** A corrupt or key-rotated ciphertext must not become a 500. */
function safeDecrypt(value: string | null): string | null {
  if (!value) return null;
  try {
    return decryptNullable(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token lifecycle
// ---------------------------------------------------------------------------

/**
 * Mark a channel as needing re-authorisation.
 *
 * This is the visible half of §30: rather than every job failing with an opaque
 * provider error, the channel carries the reason and the UI offers a reconnect
 * link.
 */
export async function markReauthRequired(
  userId: string,
  channelId: string,
  reason: string,
): Promise<void> {
  await db
    .update(channels)
    .set({
      reauthRequiredAt: new Date(),
      lastTokenErrorMessage: reason.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)));

  log.warn("channel needs re-authorisation", { userId, channelId, reason });
}

interface CredentialRow {
  id: string;
  youtubeChannelId: string;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
  reauthRequiredAt: Date | null;
  grantedScopes: string | null;
}

async function loadCredentials(
  userId: string,
  channelId: string,
): Promise<CredentialRow> {
  const rows = await db
    .select({
      id: channels.id,
      youtubeChannelId: channels.youtubeChannelId,
      accessTokenEnc: channels.accessTokenEnc,
      refreshTokenEnc: channels.refreshTokenEnc,
      tokenExpiresAt: channels.tokenExpiresAt,
      reauthRequiredAt: channels.reauthRequiredAt,
      grantedScopes: channels.grantedScopes,
    })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
    .limit(1);

  const row = rows[0];
  if (!row) throw new ForbiddenError("Channel not found or not accessible.");
  return row;
}

/**
 * Produce a usable access token, refreshing if necessary.
 *
 * Throws ReauthRequiredError — and records it on the channel — whenever only the
 * user can resolve the situation: no credentials stored, an undecryptable
 * ciphertext (the encryption key was rotated), a missing refresh token, or a
 * refresh Google refused.
 */
async function accessTokenFor(
  userId: string,
  channelId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<string> {
  const row = await loadCredentials(userId, channelId);

  if (row.reauthRequiredAt && !options.forceRefresh) {
    throw new ReauthRequiredError(channelId, "Channel is awaiting re-authorisation.");
  }

  const access = safeDecrypt(row.accessTokenEnc);
  const expiresAt = row.tokenExpiresAt?.getTime() ?? 0;
  const stillFresh =
    access !== null && expiresAt - Date.now() > REFRESH_SKEW_MS;

  if (stillFresh && !options.forceRefresh) return access;

  const refresh = safeDecrypt(row.refreshTokenEnc);
  if (!refresh) {
    const reason = row.refreshTokenEnc
      ? // Present but undecryptable: ENCRYPTION_KEY changed since it was stored.
        "Stored credentials could not be decrypted. Reconnect the channel."
      : "No refresh token is stored for this channel. Reconnect it.";
    await markReauthRequired(userId, channelId, reason);
    throw new ReauthRequiredError(channelId, reason);
  }

  let tokens: TokenSet;
  try {
    tokens = await refreshAccessToken(refresh);
  } catch (error) {
    if (isAppError(error) && error.code === "oauth_reauth_required") {
      // `ReauthRequiredError.message` is deliberately generic user-facing copy;
      // the diagnostic (`invalid_grant`, `token has been revoked`) is in details.
      // Storing the message would throw away the only clue as to why.
      const reason = reasonOf(error);
      await markReauthRequired(userId, channelId, reason);
      throw new ReauthRequiredError(channelId, reason);
    }
    // Transient (5xx, network, rate limit). Leave the channel healthy so the
    // worker's retry can succeed rather than demanding a pointless reconnect.
    throw error;
  }

  await db
    .update(channels)
    .set({
      accessTokenEnc: encryptSecret(tokens.accessToken),
      // Google usually omits a new refresh token; keep the working one.
      ...(tokens.refreshToken
        ? { refreshTokenEnc: encryptSecret(tokens.refreshToken) }
        : {}),
      tokenExpiresAt: tokens.expiresAt,
      ...(tokens.scope ? { grantedScopes: tokens.scope } : {}),
      reauthRequiredAt: null,
      lastTokenErrorMessage: null,
      updatedAt: new Date(),
    })
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)));

  log.info("access token refreshed", {
    userId,
    channelId,
    expiresAt: tokens.expiresAt.toISOString(),
  });

  return tokens.accessToken;
}

/**
 * What a channel's stored grant permits, read from the database.
 *
 * Exists so callers can decide whether to *ask* a provider for something before
 * asking — specifically revenue, which fails the entire analytics query with a
 * 403 when the monetary scope is absent. Phase 9 §12 is the reason it reads the
 * `channels` row rather than accepting a scope list: a client-supplied
 * "monetary: true" would otherwise decide what Vidxir AI requests, and a client must
 * never widen its own authorisation.
 *
 * Returns null when the channel is not this user's, matching the tenant-scoped
 * read every other accessor here performs.
 */
export interface ChannelGrant {
  channelId: string;
  youtubeChannelId: string;
  /** Scopes as granted, split. Empty when nothing is recorded. */
  grantedScopes: string[];
  /** Whether earnings can be requested at all. */
  canReadRevenue: boolean;
  needsReauth: boolean;
}

export async function channelGrant(
  userId: string,
  channelId: string,
): Promise<ChannelGrant | null> {
  const rows = await db
    .select({
      id: channels.id,
      youtubeChannelId: channels.youtubeChannelId,
      grantedScopes: channels.grantedScopes,
      reauthRequiredAt: channels.reauthRequiredAt,
    })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const scopeText = row.grantedScopes ?? "";
  return {
    channelId: row.id,
    youtubeChannelId: row.youtubeChannelId,
    grantedScopes: scopeText.split(/\s+/).filter(Boolean),
    canReadRevenue: hasMonetaryScope(scopeText),
    needsReauth: row.reauthRequiredAt !== null,
  };
}

/**
 * Run a YouTube operation with a valid access token.
 *
 * Every caller in the codebase goes through here, which is what keeps decrypted
 * tokens inside this module. If Google rejects the token anyway — revoked
 * mid-flight, or a clock skew we did not anticipate — the operation is retried
 * once against a forcibly refreshed token before the failure is surfaced.
 */
export async function withChannelToken<T>(
  userId: string,
  channelId: string,
  operation: (accessToken: string) => Promise<T>,
): Promise<T> {
  const token = await accessTokenFor(userId, channelId);
  try {
    return await operation(token);
  } catch (error) {
    if (!isAppError(error) || error.code !== "oauth_reauth_required") throw error;

    // The token we just used was rejected. One forced refresh, one retry.
    const refreshed = await accessTokenFor(userId, channelId, {
      forceRefresh: true,
    });
    try {
      return await operation(refreshed);
    } catch (retryError) {
      if (isAppError(retryError) && retryError.code === "oauth_reauth_required") {
        const reason =
          "Google rejected this channel's credentials. Reconnect the channel.";
        await markReauthRequired(userId, channelId, reason);
        throw new ReauthRequiredError(channelId, reason);
      }
      throw retryError;
    }
  }
}

// ---------------------------------------------------------------------------
// Statistics (§25)
// ---------------------------------------------------------------------------

/**
 * Refresh cached channel statistics from the YouTube Data API.
 *
 * Cached rather than fetched per page view because the dashboard renders on
 * every navigation and the Data API bills quota per call. `stats_refreshed_at`
 * is what the UI uses to decide between a figure and "—": a null timestamp means
 * nothing has been measured, and §42 forbids inventing a number to fill the gap.
 */
export async function refreshChannelStats(
  userId: string,
  channelId: string,
): Promise<ChannelView> {
  const row = await loadCredentials(userId, channelId);

  const channel = await withChannelToken(userId, channelId, async (token) => {
    // Addressed by the stored id rather than `mine: true`, so a token that
    // somehow belongs to a different account cannot overwrite this row's stats
    // with another channel's numbers. `mine` is the fallback for the case where
    // the id read returns nothing (channel renamed its id — rare but possible).
    const byId = await fetchChannelById(token, row.youtubeChannelId);
    return byId ?? (await fetchMyChannel(token));
  });

  if (!channel) {
    const reason =
      "The connected Google account no longer has access to this YouTube channel.";
    await markReauthRequired(userId, channelId, reason);
    throw new ReauthRequiredError(channelId, reason);
  }

  await db
    .update(channels)
    .set({
      title: channel.title,
      handle: channel.handle,
      description: channel.description,
      thumbnailUrl: channel.thumbnailUrl,
      subscriberCount: channel.subscriberCount,
      videoCount: channel.videoCount,
      viewCount: channel.viewCount,
      statsRefreshedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(channels.id, row.id), eq(channels.userId, userId)));

  const updated = await getChannel(userId, channelId);
  if (!updated) throw new ForbiddenError("Channel not found or not accessible.");
  return updated;
}

/**
 * Channels whose cached stats are stale, for the scheduler (§19).
 *
 * Channels already flagged for re-authorisation are skipped: refreshing them
 * would fail on every pass and burn quota to learn what we already know.
 */
export async function channelsNeedingStatsRefresh(
  olderThan: Date,
  limit = 50,
): Promise<Array<{ id: string; userId: string }>> {
  return db
    .select({ id: channels.id, userId: channels.userId })
    .from(channels)
    .where(
      and(
        isNull(channels.disconnectedAt),
        isNull(channels.reauthRequiredAt),
        or(
          isNull(channels.statsRefreshedAt),
          lt(channels.statsRefreshedAt, olderThan),
        ),
      ),
    )
    .limit(limit);
}

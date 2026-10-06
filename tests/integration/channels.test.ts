/**
 * YouTube connection integration tests (§39, §6, §34, §42).
 *
 * The YouTube provider is mocked at the module boundary — and only there. Google
 * is the one dependency that cannot be exercised in CI, but everything on Vidxir AI's
 * side of the boundary is real: real Postgres, real AES-256-GCM, real HMAC state
 * signing, real session cookies. The mock returns token sets and channel payloads
 * shaped exactly as Google's, so what is under test is Vidxir AI's handling of them.
 *
 * The properties these tests exist to pin down:
 *
 *  - **No token ever reaches a caller.** `ChannelView` is serialised and searched
 *    for ciphertext. A future refactor that adds a token field to the view breaks
 *    a test rather than shipping (§6).
 *  - **A silent re-authorisation cannot destroy the refresh token.** Google omits
 *    `refresh_token` when it reuses a grant; overwriting with null would break the
 *    channel an hour later with no recovery but a manual reconnect.
 *  - **State is single-use and session-bound.** Each of the four independent
 *    failure modes is tested separately, because a check that silently stopped
 *    running would otherwise leave the other three looking like coverage.
 *  - **A dead grant becomes a visible reconnect prompt, not a permanent failure
 *    loop** (§30).
 *  - **Analytics ingestion converges.** The scheduler re-pulls overlapping
 *    windows, so ingesting twice must not double the rows.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChannel,
  createUser,
  hasDatabase,
  jar,
  resetDatabase,
  setTier,
  useDatabase,
} from "./setup";

vi.mock("next/headers", () => ({
  cookies: async () => jar,
}));

// ---------------------------------------------------------------------------
// Google boundary
// ---------------------------------------------------------------------------

/**
 * Hoisted so the factory below can close over it: vitest lifts `vi.mock` above
 * the imports, and a plain `const` would not exist yet when the factory runs.
 */
const google = vi.hoisted(() => ({
  refreshAccessToken: vi.fn(),
  fetchChannelById: vi.fn(),
  fetchMyChannel: vi.fn(),
  fetchAnalytics: vi.fn(),
  revokeToken: vi.fn(),
  exchangeCode: vi.fn(),
}));

vi.mock("@/lib/providers/youtube", async (importOriginal) => {
  // `importOriginal`, not `await import(...)` — a plain dynamic import of the
  // path being mocked resolves back to the mock and deadlocks the factory. The
  // real module is loaded so scope logic, redirect-URI construction and the
  // error classes stay under test; only the network calls are replaced.
  const actual = await importOriginal<typeof import("@/lib/providers/youtube")>();
  return {
    ...actual,
    refreshAccessToken: google.refreshAccessToken,
    fetchChannelById: google.fetchChannelById,
    fetchMyChannel: google.fetchMyChannel,
    fetchAnalytics: google.fetchAnalytics,
    revokeToken: google.revokeToken,
    exchangeCode: google.exchangeCode,
  };
});

const YOUTUBE_SCOPE =
  "https://www.googleapis.com/auth/youtube " +
  "https://www.googleapis.com/auth/youtube.upload " +
  "https://www.googleapis.com/auth/yt-analytics.readonly";

function tokenSet(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: "ya29.fresh-access-token",
    refreshToken: "1//refresh-token",
    expiresAt: new Date(Date.now() + 3600_000),
    scope: YOUTUBE_SCOPE,
    ...overrides,
  };
}

function channelPayload(overrides: Record<string, unknown> = {}) {
  return {
    channelId: "UCtest0000000000000000",
    title: "Practical Woodworking",
    handle: "@practicalwoodworking",
    description: "Hand tools, no filler.",
    thumbnailUrl: "https://yt3.example/photo.jpg",
    subscriberCount: 12_400,
    videoCount: 87,
    // numeric(20,0) — a string on the wire, as googleapis returns it.
    viewCount: "1874203",
    uploadsPlaylistId: "UUtest0000000000000000",
    country: "GB",
    defaultLanguage: "en",
    ...overrides,
  };
}

const suite = hasDatabase ? describe : describe.skip;

suite("youtube channel connection (integration)", () => {
  useDatabase();

  /**
   * Load the channel modules before any test needs them.
   *
   * `@/lib/channels/service` pulls in the `googleapis` barrel, which is tens of
   * seconds of module resolution on a cold Windows machine — enough to exhaust
   * the 30s per-test budget for whichever test imports it first, while every
   * later test in the file finishes in about a second. Paying it in a hook with
   * its own 60s budget beats raising the global `testTimeout`, which would mask
   * genuine hangs. (The same cold start is warmed in `research.test.ts`.)
   */
  beforeAll(async () => {
    await import("@/lib/channels/service");
    await import("@/lib/channels/analytics");
  }, 60_000);

  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();
    // Credentials have to look present, or every provider entry point correctly
    // throws NotConfiguredError before the code under test runs (§48).
    process.env["GOOGLE_CLIENT_ID"] = "test-client-id.apps.googleusercontent.com";
    process.env["GOOGLE_CLIENT_SECRET"] = "test-client-secret";
  });

  // -------------------------------------------------------------------------
  // OAuth state (§34)
  // -------------------------------------------------------------------------

  describe("oauth state", () => {
    it("round-trips a state it issued for the same session", async () => {
      const { issueOAuthState, consumeOAuthState } = await import(
        "@/lib/channels/oauth-state"
      );
      const user = await createUser();

      const { state } = await issueOAuthState({
        userId: user.id,
        returnTo: "/dashboard/channels",
      });

      await expect(consumeOAuthState(state, user.id)).resolves.toMatchObject({
        userId: user.id,
        channelId: null,
        returnTo: "/dashboard/channels",
      });
    });

    it("refuses a state whose signature was tampered with", async () => {
      const { issueOAuthState, consumeOAuthState } = await import(
        "@/lib/channels/oauth-state"
      );
      const user = await createUser();
      const { state } = await issueOAuthState({ userId: user.id });

      // Flip the last character of the signature.
      const forged = state.slice(0, -1) + (state.endsWith("A") ? "B" : "A");

      await expect(consumeOAuthState(forged, user.id)).rejects.toMatchObject({
        code: "validation_failed",
      });
    });

    it("refuses a state issued for a different user", async () => {
      const { issueOAuthState, consumeOAuthState } = await import(
        "@/lib/channels/oauth-state"
      );
      const victim = await createUser({ email: "victim@vidxir.test" });
      const attacker = await createUser({ email: "attacker@vidxir.test" });

      // The attacker starts the flow, so the signature and the cookie are valid.
      const { state } = await issueOAuthState({ userId: attacker.id });

      // Delivering that callback to the victim's session must not attach the
      // attacker's channel to the victim's account.
      await expect(consumeOAuthState(state, victim.id)).rejects.toMatchObject({
        code: "validation_failed",
      });
    });

    it("refuses a state without its paired cookie", async () => {
      const { issueOAuthState, consumeOAuthState, OAUTH_STATE_COOKIE } =
        await import("@/lib/channels/oauth-state");
      const user = await createUser();
      const { state } = await issueOAuthState({ userId: user.id });

      // A state captured from a URL — history, referrer log, shared link — with
      // no access to the HttpOnly cookie.
      jar.delete(OAUTH_STATE_COOKIE);

      await expect(consumeOAuthState(state, user.id)).rejects.toMatchObject({
        code: "validation_failed",
      });
    });

    it("is single-use: a replayed state fails the second time", async () => {
      const { issueOAuthState, consumeOAuthState } = await import(
        "@/lib/channels/oauth-state"
      );
      const user = await createUser();
      const { state } = await issueOAuthState({ userId: user.id });

      await expect(consumeOAuthState(state, user.id)).resolves.toBeTruthy();
      await expect(consumeOAuthState(state, user.id)).rejects.toMatchObject({
        code: "validation_failed",
      });
    });

    it("rejects an expired state", async () => {
      const { issueOAuthState, consumeOAuthState } = await import(
        "@/lib/channels/oauth-state"
      );
      const user = await createUser();
      const { state } = await issueOAuthState({ userId: user.id });

      // Eleven minutes: past the ten-minute TTL.
      vi.setSystemTime(new Date(Date.now() + 11 * 60_000));
      try {
        await expect(consumeOAuthState(state, user.id)).rejects.toMatchObject({
          code: "validation_failed",
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("refuses an off-site returnTo, so the callback is not an open redirect", async () => {
      const { safeReturnTo } = await import("@/lib/channels/oauth-state");

      expect(safeReturnTo("//evil.example/steal")).toBe("/dashboard/channels");
      expect(safeReturnTo("https://evil.example")).toBe("/dashboard/channels");
      expect(safeReturnTo("/\\evil.example")).toBe("/dashboard/channels");
      expect(safeReturnTo(null)).toBe("/dashboard/channels");
      // A genuine in-app path survives.
      expect(safeReturnTo("/dashboard/research")).toBe("/dashboard/research");
    });
  });

  // -------------------------------------------------------------------------
  // Connect / reconnect (§6, §27)
  // -------------------------------------------------------------------------

  describe("connectChannel", () => {
    it("stores an encrypted credential and seeds channel configuration", async () => {
      const { connectChannel } = await import("@/lib/channels/service");
      const { db } = await import("@/lib/db");
      const { brandKits, channels, channelSettings } = await import(
        "@/lib/db/schema"
      );
      const { eq } = await import("drizzle-orm");
      const user = await createUser();

      const result = await connectChannel({
        userId: user.id,
        tokens: tokenSet(),
        channel: channelPayload(),
      });

      expect(result).toMatchObject({
        created: true,
        title: "Practical Woodworking",
        missingScopes: [],
      });

      const rows = await db
        .select()
        .from(channels)
        .where(eq(channels.id, result.channelId));
      const row = rows[0];
      expect(row).toBeDefined();

      // Ciphertext, not the token. The version prefix is the encryption format.
      expect(row?.accessTokenEnc).toMatch(/^v1\./);
      expect(row?.refreshTokenEnc).toMatch(/^v1\./);
      expect(row?.accessTokenEnc).not.toContain("ya29.");
      expect(row?.refreshTokenEnc).not.toContain("1//");

      // §28: settings and the brand kit exist the moment the channel does, so
      // the stage screens are never rendering against absent configuration.
      await expect(
        db
          .select()
          .from(channelSettings)
          .where(eq(channelSettings.channelId, result.channelId)),
      ).resolves.toHaveLength(1);
      await expect(
        db.select().from(brandKits).where(eq(brandKits.channelId, result.channelId)),
      ).resolves.toHaveLength(1);
    });

    it("updates in place rather than duplicating on reconnect", async () => {
      const { connectChannel } = await import("@/lib/channels/service");
      const { db } = await import("@/lib/db");
      const { channels } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const user = await createUser();

      const first = await connectChannel({
        userId: user.id,
        tokens: tokenSet(),
        channel: channelPayload(),
      });
      const second = await connectChannel({
        userId: user.id,
        tokens: tokenSet({ accessToken: "ya29.second" }),
        channel: channelPayload({ title: "Practical Woodworking (renamed)" }),
      });

      expect(second.channelId).toBe(first.channelId);
      expect(second.created).toBe(false);

      const rows = await db
        .select({ id: channels.id, title: channels.title })
        .from(channels)
        .where(eq(channels.userId, user.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe("Practical Woodworking (renamed)");
    });

    it("keeps the stored refresh token when Google sends none", async () => {
      const { connectChannel } = await import("@/lib/channels/service");
      const { db } = await import("@/lib/db");
      const { channels } = await import("@/lib/db/schema");
      const { decryptNullable } = await import("@/lib/crypto");
      const { eq } = await import("drizzle-orm");
      const user = await createUser();

      const first = await connectChannel({
        userId: user.id,
        tokens: tokenSet({ refreshToken: "1//original-refresh" }),
        channel: channelPayload(),
      });

      // A silent re-authorisation: Google reuses the grant and omits the refresh
      // token. Nulling the column here would leave the channel unable to refresh.
      await connectChannel({
        userId: user.id,
        tokens: tokenSet({ refreshToken: null }),
        channel: channelPayload(),
      });

      const rows = await db
        .select({ refreshTokenEnc: channels.refreshTokenEnc })
        .from(channels)
        .where(eq(channels.id, first.channelId));

      const stored = rows[0]?.refreshTokenEnc ?? null;
      expect(stored).not.toBeNull();
      expect(decryptNullable(stored)).toBe("1//original-refresh");
    });

    it("reports missing scopes rather than treating a partial grant as connected", async () => {
      const { connectChannel } = await import("@/lib/channels/service");
      const user = await createUser();

      // The user unticked the upload permission on the consent screen.
      const result = await connectChannel({
        userId: user.id,
        tokens: tokenSet({
          scope: "https://www.googleapis.com/auth/yt-analytics.readonly",
        }),
        channel: channelPayload(),
      });

      expect(result.missingScopes).toEqual([
        "https://www.googleapis.com/auth/youtube",
        "https://www.googleapis.com/auth/youtube.upload",
      ]);
    });

    it("refuses a reconnect that authorised a different YouTube channel", async () => {
      const { connectChannel } = await import("@/lib/channels/service");
      const user = await createUser();

      const original = await connectChannel({
        userId: user.id,
        tokens: tokenSet(),
        channel: channelPayload(),
      });

      // Repointing the row would silently move every project attached to it.
      await expect(
        connectChannel({
          userId: user.id,
          tokens: tokenSet(),
          channel: channelPayload({
            channelId: "UCdifferent00000000000",
            title: "Someone Else's Channel",
          }),
          expectedChannelId: original.channelId,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    });

    it("refuses a reconnect of a channel belonging to another user", async () => {
      const { connectChannel } = await import("@/lib/channels/service");
      const owner = await createUser({ email: "owner@vidxir.test" });
      const other = await createUser({ email: "other@vidxir.test" });
      const ownedId = await createChannel(owner.id);

      await expect(
        connectChannel({
          userId: other.id,
          tokens: tokenSet(),
          channel: channelPayload(),
          expectedChannelId: ownedId,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    });

    it("lets two users connect the same YouTube channel independently", async () => {
      const { connectChannel } = await import("@/lib/channels/service");
      const a = await createUser({ email: "a@vidxir.test" });
      const b = await createUser({ email: "b@vidxir.test" });

      // The unique index is (user_id, youtube_channel_id), not youtube_channel_id
      // alone — an agency and a creator may both connect the same channel.
      const first = await connectChannel({
        userId: a.id,
        tokens: tokenSet(),
        channel: channelPayload(),
      });
      const second = await connectChannel({
        userId: b.id,
        tokens: tokenSet(),
        channel: channelPayload(),
      });

      expect(second.channelId).not.toBe(first.channelId);
      expect(second.created).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // No token leaves the server (§6)
  // -------------------------------------------------------------------------

  describe("ChannelView", () => {
    it("carries no token material, not even ciphertext", async () => {
      const { connectChannel, getChannel, listChannels } = await import(
        "@/lib/channels/service"
      );
      const user = await createUser();

      const { channelId } = await connectChannel({
        userId: user.id,
        tokens: tokenSet(),
        channel: channelPayload(),
      });

      const one = await getChannel(user.id, channelId);
      const all = await listChannels(user.id);

      // Serialised, because that is what a route would send. Any key or value
      // resembling a credential is a leak regardless of what it is called.
      for (const payload of [JSON.stringify(one), JSON.stringify(all)]) {
        expect(payload).not.toContain("v1.");
        expect(payload).not.toContain("ya29.");
        expect(payload).not.toContain("1//");
        expect(payload.toLowerCase()).not.toContain("accesstoken");
        expect(payload.toLowerCase()).not.toContain("refreshtoken");
      }

      // What it does carry is the state the UI needs.
      expect(one).toMatchObject({
        title: "Practical Woodworking",
        needsReauth: false,
        missingScopes: [],
      });
    });

    it("does not return another user's channel", async () => {
      const { getChannel } = await import("@/lib/channels/service");
      const owner = await createUser({ email: "owner@vidxir.test" });
      const other = await createUser({ email: "other@vidxir.test" });
      const channelId = await createChannel(owner.id);

      await expect(getChannel(owner.id, channelId)).resolves.toMatchObject({
        id: channelId,
      });
      await expect(getChannel(other.id, channelId)).resolves.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Token lifecycle (§6, §30)
  // -------------------------------------------------------------------------

  describe("withChannelToken", () => {
    it("uses the stored token while it is still fresh", async () => {
      const { withChannelToken } = await import("@/lib/channels/service");
      const user = await createUser();
      const channelId = await createChannel(user.id);

      const seen = await withChannelToken(user.id, channelId, async (token) => token);

      expect(seen).toBe("test-access-token");
      expect(google.refreshAccessToken).not.toHaveBeenCalled();
    });

    it("refreshes an expired token and persists the new one", async () => {
      const { withChannelToken } = await import("@/lib/channels/service");
      const { db } = await import("@/lib/db");
      const { channels } = await import("@/lib/db/schema");
      const { decryptNullable } = await import("@/lib/crypto");
      const { eq } = await import("drizzle-orm");
      const user = await createUser();
      const channelId = await createChannel(user.id);

      // Expire it.
      await db
        .update(channels)
        .set({ tokenExpiresAt: new Date(Date.now() - 60_000) })
        .where(eq(channels.id, channelId));

      google.refreshAccessToken.mockResolvedValue(
        tokenSet({ accessToken: "ya29.refreshed", refreshToken: null }),
      );

      const seen = await withChannelToken(user.id, channelId, async (token) => token);

      expect(seen).toBe("ya29.refreshed");
      expect(google.refreshAccessToken).toHaveBeenCalledWith("test-refresh-token");

      // Persisted, so the next request does not refresh again.
      const rows = await db
        .select({
          accessTokenEnc: channels.accessTokenEnc,
          refreshTokenEnc: channels.refreshTokenEnc,
        })
        .from(channels)
        .where(eq(channels.id, channelId));
      expect(decryptNullable(rows[0]?.accessTokenEnc ?? null)).toBe("ya29.refreshed");
      // The refresh token Google did not re-send is still the original.
      expect(decryptNullable(rows[0]?.refreshTokenEnc ?? null)).toBe(
        "test-refresh-token",
      );
    });

    it("retries once when Google rejects a token we believed was live", async () => {
      const { withChannelToken } = await import("@/lib/channels/service");
      const { ReauthRequiredError } = await import("@/lib/errors");
      const user = await createUser();
      const channelId = await createChannel(user.id);

      google.refreshAccessToken.mockResolvedValue(
        tokenSet({ accessToken: "ya29.second-chance" }),
      );

      let attempts = 0;
      const result = await withChannelToken(user.id, channelId, async (token) => {
        attempts += 1;
        // First call: the token was revoked between storage and use.
        if (attempts === 1) throw new ReauthRequiredError(channelId, "revoked");
        return token;
      });

      expect(attempts).toBe(2);
      expect(result).toBe("ya29.second-chance");
    });

    it("flags the channel for re-authorisation when the refresh token is dead", async () => {
      const { withChannelToken, getChannel } = await import(
        "@/lib/channels/service"
      );
      const { ReauthRequiredError } = await import("@/lib/errors");
      const { db } = await import("@/lib/db");
      const { channels } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const user = await createUser();
      const channelId = await createChannel(user.id);

      await db
        .update(channels)
        .set({ tokenExpiresAt: new Date(Date.now() - 60_000) })
        .where(eq(channels.id, channelId));

      // `invalid_grant`: the user revoked access in their Google account, or the
      // token went unused for six months. Only the user can fix this.
      google.refreshAccessToken.mockRejectedValue(
        new ReauthRequiredError(channelId, "invalid_grant"),
      );

      await expect(
        withChannelToken(user.id, channelId, async () => "unreachable"),
      ).rejects.toMatchObject({ code: "oauth_reauth_required" });

      // §30: recorded on the row, so the UI shows a reconnect prompt instead of
      // failing every job with an opaque provider error forever.
      const view = await getChannel(user.id, channelId);
      expect(view?.needsReauth).toBe(true);
      expect(view?.reauthReason).toContain("invalid_grant");
    });

    it("does not flag the channel on a transient provider failure", async () => {
      const { withChannelToken, getChannel } = await import(
        "@/lib/channels/service"
      );
      const { ProviderError } = await import("@/lib/errors");
      const { db } = await import("@/lib/db");
      const { channels } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const user = await createUser();
      const channelId = await createChannel(user.id);

      await db
        .update(channels)
        .set({ tokenExpiresAt: new Date(Date.now() - 60_000) })
        .where(eq(channels.id, channelId));

      google.refreshAccessToken.mockRejectedValue(
        new ProviderError("YouTube", "Google returned 503", { retryable: true }),
      );

      await expect(
        withChannelToken(user.id, channelId, async () => "unreachable"),
      ).rejects.toMatchObject({ retryable: true });

      // A demand to reconnect would be wrong: nothing is broken but the network,
      // and the worker's retry can still succeed.
      const view = await getChannel(user.id, channelId);
      expect(view?.needsReauth).toBe(false);
    });

    it("demands re-authorisation when the ciphertext cannot be decrypted", async () => {
      const { withChannelToken, getChannel } = await import(
        "@/lib/channels/service"
      );
      const { db } = await import("@/lib/db");
      const { channels } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const user = await createUser();
      const channelId = await createChannel(user.id);

      // What an ENCRYPTION_KEY rotation looks like: well-formed, undecryptable.
      await db
        .update(channels)
        .set({
          accessTokenEnc: "v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBB.CCCC",
          refreshTokenEnc: "v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBB.CCCC",
          tokenExpiresAt: new Date(Date.now() - 60_000),
        })
        .where(eq(channels.id, channelId));

      await expect(
        withChannelToken(user.id, channelId, async () => "unreachable"),
      ).rejects.toMatchObject({ code: "oauth_reauth_required" });

      const view = await getChannel(user.id, channelId);
      expect(view?.needsReauth).toBe(true);
      // Recoverable, and the message says how — not a 500.
      expect(view?.reauthReason).toContain("Reconnect");
    });

    it("refuses to run for a channel belonging to another user", async () => {
      const { withChannelToken } = await import("@/lib/channels/service");
      const owner = await createUser({ email: "owner@vidxir.test" });
      const other = await createUser({ email: "other@vidxir.test" });
      const channelId = await createChannel(owner.id);

      await expect(
        withChannelToken(other.id, channelId, async () => "leaked"),
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  // -------------------------------------------------------------------------
  // Statistics (§25, §42)
  // -------------------------------------------------------------------------

  describe("refreshChannelStats", () => {
    it("stores what YouTube reported, addressed by the stored channel id", async () => {
      const { connectChannel, refreshChannelStats } = await import(
        "@/lib/channels/service"
      );
      const user = await createUser();
      const { channelId } = await connectChannel({
        userId: user.id,
        tokens: tokenSet(),
        channel: channelPayload({ subscriberCount: 1_000, viewCount: "50000" }),
      });

      google.fetchChannelById.mockResolvedValue(
        channelPayload({ subscriberCount: 13_100, viewCount: "1900000" }),
      );

      const view = await refreshChannelStats(user.id, channelId);

      expect(view.subscriberCount).toBe(13_100);
      expect(view.viewCount).toBe(1_900_000);
      expect(view.statsRefreshedAt).toBeInstanceOf(Date);
      // By id, not `mine: true` — a token for another account must not be able
      // to overwrite this row with a different channel's numbers.
      expect(google.fetchChannelById).toHaveBeenCalledWith(
        expect.any(String),
        "UCtest0000000000000000",
      );
      expect(google.fetchMyChannel).not.toHaveBeenCalled();
    });

    it("stores null, not zero, when the channel hides its subscriber count", async () => {
      const { connectChannel, refreshChannelStats } = await import(
        "@/lib/channels/service"
      );
      const user = await createUser();
      const { channelId } = await connectChannel({
        userId: user.id,
        tokens: tokenSet(),
        channel: channelPayload(),
      });

      // §42: a hidden count is unknown, and "0 subscribers" would be a lie.
      google.fetchChannelById.mockResolvedValue(
        channelPayload({ subscriberCount: null }),
      );

      const view = await refreshChannelStats(user.id, channelId);
      expect(view.subscriberCount).toBeNull();
    });

    it("demands re-authorisation when the account can no longer see the channel", async () => {
      const { connectChannel, refreshChannelStats, getChannel } = await import(
        "@/lib/channels/service"
      );
      const user = await createUser();
      const { channelId } = await connectChannel({
        userId: user.id,
        tokens: tokenSet(),
        channel: channelPayload(),
      });

      google.fetchChannelById.mockResolvedValue(null);
      google.fetchMyChannel.mockResolvedValue(null);

      await expect(
        refreshChannelStats(user.id, channelId),
      ).rejects.toMatchObject({ code: "oauth_reauth_required" });

      const view = await getChannel(user.id, channelId);
      expect(view?.needsReauth).toBe(true);
    });
  });

  describe("channelsNeedingStatsRefresh", () => {
    it("skips disconnected and reauth-flagged channels", async () => {
      const {
        channelsNeedingStatsRefresh,
        disconnectChannel,
        markReauthRequired,
      } = await import("@/lib/channels/service");
      const user = await createUser();

      const healthy = await createChannel(user.id, { youtubeChannelId: "UCa" });
      const flagged = await createChannel(user.id, { youtubeChannelId: "UCb" });
      const gone = await createChannel(user.id, { youtubeChannelId: "UCc" });

      await markReauthRequired(user.id, flagged, "invalid_grant");
      google.revokeToken.mockResolvedValue(true);
      await disconnectChannel(user.id, gone);

      const due = await channelsNeedingStatsRefresh(new Date());
      const ids = due.map((c) => c.id);

      expect(ids).toContain(healthy);
      // Both would fail on every pass and burn quota to learn what we know.
      expect(ids).not.toContain(flagged);
      expect(ids).not.toContain(gone);
    });
  });

  // -------------------------------------------------------------------------
  // Disconnect (§23, §27)
  // -------------------------------------------------------------------------

  describe("disconnectChannel", () => {
    it("revokes at Google, erases credentials, and keeps the row", async () => {
      const { connectChannel, disconnectChannel, listChannels } = await import(
        "@/lib/channels/service"
      );
      const { db } = await import("@/lib/db");
      const { channels } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const user = await createUser();

      const { channelId } = await connectChannel({
        userId: user.id,
        tokens: tokenSet(),
        channel: channelPayload(),
      });
      google.revokeToken.mockResolvedValue(true);

      await disconnectChannel(user.id, channelId);

      // Revoked with the real refresh token, decrypted for the call only.
      expect(google.revokeToken).toHaveBeenCalledWith("1//refresh-token");

      const rows = await db
        .select()
        .from(channels)
        .where(eq(channels.id, channelId));
      const row = rows[0];

      // Soft delete: `published_videos` and `analytics_snapshots` reference this
      // row, and unlinking an account must not erase publishing history.
      expect(row).toBeDefined();
      expect(row?.disconnectedAt).toBeInstanceOf(Date);
      expect(row?.accessTokenEnc).toBeNull();
      expect(row?.refreshTokenEnc).toBeNull();
      expect(row?.grantedScopes).toBeNull();

      // Gone from the user's list all the same.
      await expect(listChannels(user.id)).resolves.toHaveLength(0);
    });

    it("frees the plan's channel slot", async () => {
      const { connectChannel, disconnectChannel } = await import(
        "@/lib/channels/service"
      );
      const { assertCanConnectChannel } = await import("@/lib/plans/enforce");
      const user = await createUser();

      const { channelId } = await connectChannel({
        userId: user.id,
        tokens: tokenSet(),
        channel: channelPayload(),
      });

      // Starter includes one channel, so a second is refused.
      await expect(
        assertCanConnectChannel(user.id, "starter"),
      ).rejects.toMatchObject({ code: "plan_limit_reached" });

      google.revokeToken.mockResolvedValue(true);
      await disconnectChannel(user.id, channelId);

      // The slot is free again — a disconnected channel must not count.
      await expect(
        assertCanConnectChannel(user.id, "starter"),
      ).resolves.toBeUndefined();
    });

    it("does not disconnect another user's channel", async () => {
      const { disconnectChannel } = await import("@/lib/channels/service");
      const owner = await createUser({ email: "owner@vidxir.test" });
      const other = await createUser({ email: "other@vidxir.test" });
      const channelId = await createChannel(owner.id);

      await expect(
        disconnectChannel(other.id, channelId),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(google.revokeToken).not.toHaveBeenCalled();
    });

    it("still disconnects when the credential cannot be decrypted", async () => {
      const { disconnectChannel } = await import("@/lib/channels/service");
      const { db } = await import("@/lib/db");
      const { channels } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const user = await createUser();
      const channelId = await createChannel(user.id);

      await db
        .update(channels)
        .set({ accessTokenEnc: "not-a-ciphertext", refreshTokenEnc: null })
        .where(eq(channels.id, channelId));

      // A key rotation must not trap the user with a channel they cannot remove.
      await expect(disconnectChannel(user.id, channelId)).resolves.toBeUndefined();
      expect(google.revokeToken).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Plan limits (§23)
  // -------------------------------------------------------------------------

  describe("plan channel limits", () => {
    it("raises the limit when the subscriptions table says so", async () => {
      const { connectChannel } = await import("@/lib/channels/service");
      const { assertCanConnectChannel } = await import("@/lib/plans/enforce");
      const user = await createUser();

      await connectChannel({
        userId: user.id,
        tokens: tokenSet(),
        channel: channelPayload(),
      });

      await expect(
        assertCanConnectChannel(user.id, "starter"),
      ).rejects.toMatchObject({ code: "plan_limit_reached" });

      // §24: the tier is written to the database, standing in for a confirmed
      // Stripe webhook. Nothing here trusts a caller-supplied tier.
      await setTier(user.id, "studio");
      await expect(
        assertCanConnectChannel(user.id, "studio"),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Analytics ingestion (§26)
  // -------------------------------------------------------------------------

  describe("ingestChannelAnalytics", () => {
    const channelDaily = [
      {
        date: "2026-08-10",
        views: 1200,
        likes: 84,
        comments: 12,
        shares: 6,
        subscribersGained: 31,
        subscribersLost: 4,
        watchTimeMinutes: 3400,
        averageViewDurationSeconds: 170,
        averageViewPercentage: 41.2,
      },
      {
        date: "2026-08-11",
        views: 1500,
        likes: 96,
        comments: 18,
        shares: 9,
        subscribersGained: 40,
        subscribersLost: 3,
        watchTimeMinutes: 4100,
        averageViewDurationSeconds: 164,
        averageViewPercentage: 39.8,
      },
    ];

    it("writes a row per day and leaves unmeasurable metrics null", async () => {
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      const { db } = await import("@/lib/db");
      const { analyticsSnapshots } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const user = await createUser();
      const channelId = await createChannel(user.id);

      google.fetchAnalytics.mockImplementation(
        async (_token: string, query: { byVideo?: boolean }) =>
          query.byVideo ? [] : channelDaily,
      );

      const result = await ingestChannelAnalytics(user.id, channelId, {
        startDate: "2026-08-10",
        endDate: "2026-08-11",
      });

      expect(result.channelRows).toBe(2);

      const rows = await db
        .select()
        .from(analyticsSnapshots)
        .where(eq(analyticsSnapshots.channelId, channelId));
      expect(rows).toHaveLength(2);
      expect(rows[0]?.views).toBe(1200);

      // §42: the Analytics API does not expose impressions or impression CTR —
      // those are Studio-only — and Vidxir AI does not request the monetary scope.
      // Deriving a plausible figure would poison the §8 scoring loop.
      expect(rows[0]?.ctr).toBeNull();
      expect(rows[0]?.impressions).toBeNull();
      expect(rows[0]?.estimatedRevenueCents).toBeNull();
    });

    it("is idempotent: re-ingesting the same window does not duplicate rows", async () => {
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      const { db } = await import("@/lib/db");
      const { analyticsSnapshots } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const user = await createUser();
      const channelId = await createChannel(user.id);

      google.fetchAnalytics.mockImplementation(
        async (_token: string, query: { byVideo?: boolean }) =>
          query.byVideo ? [] : channelDaily,
      );

      const window = { startDate: "2026-08-10", endDate: "2026-08-11" };
      await ingestChannelAnalytics(user.id, channelId, window);
      await ingestChannelAnalytics(user.id, channelId, window);

      // Channel-level rows have a null published_video_id, and Postgres treats
      // NULLs as distinct in a unique index — so ON CONFLICT never matches and a
      // naive upsert would double the rows on every scheduler pass.
      const rows = await db
        .select()
        .from(analyticsSnapshots)
        .where(eq(analyticsSnapshots.channelId, channelId));
      expect(rows).toHaveLength(2);
    });

    it("converges on revised figures rather than accumulating them", async () => {
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      const { db } = await import("@/lib/db");
      const { analyticsSnapshots } = await import("@/lib/db/schema");
      const { and, eq } = await import("drizzle-orm");
      const user = await createUser();
      const channelId = await createChannel(user.id);

      const window = { startDate: "2026-08-10", endDate: "2026-08-10" };
      const firstPull = [channelDaily[0]];
      google.fetchAnalytics.mockImplementation(
        async (_token: string, query: { byVideo?: boolean }) =>
          query.byVideo ? [] : firstPull,
      );
      await ingestChannelAnalytics(user.id, channelId, window);

      // YouTube finalises numbers over several days; the second pull is higher.
      const revised = [{ ...channelDaily[0], views: 1650 }];
      google.fetchAnalytics.mockImplementation(
        async (_token: string, query: { byVideo?: boolean }) =>
          query.byVideo ? [] : revised,
      );
      await ingestChannelAnalytics(user.id, channelId, window);

      const rows = await db
        .select({ views: analyticsSnapshots.views })
        .from(analyticsSnapshots)
        .where(
          and(
            eq(analyticsSnapshots.channelId, channelId),
            eq(analyticsSnapshots.date, new Date("2026-08-10T00:00:00.000Z")),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.views).toBe(1650);
    });

    it("reports videos it has no publish record for instead of inventing one", async () => {
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      const user = await createUser();
      const channelId = await createChannel(user.id);

      google.fetchAnalytics.mockImplementation(
        async (_token: string, query: { byVideo?: boolean }) =>
          query.byVideo
            ? [{ ...channelDaily[0], videoId: "vid-not-published-by-vidxir" }]
            : channelDaily,
      );

      const result = await ingestChannelAnalytics(user.id, channelId, {
        startDate: "2026-08-10",
        endDate: "2026-08-11",
      });

      // §42: a `published_videos` row is the record that Vidxir AI really uploaded
      // something. Creating one to satisfy a foreign key would claim it did.
      expect(result.videoRows).toBe(0);
      expect(result.unmatchedVideoIds).toEqual(["vid-not-published-by-vidxir"]);
    });

    it("records an ingest in api_usage for cost attribution", async () => {
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      const { db } = await import("@/lib/db");
      const { apiUsage } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const user = await createUser();
      const channelId = await createChannel(user.id);

      google.fetchAnalytics.mockImplementation(
        async (_token: string, query: { byVideo?: boolean }) =>
          query.byVideo ? [] : channelDaily,
      );

      await ingestChannelAnalytics(user.id, channelId, {
        startDate: "2026-08-10",
        endDate: "2026-08-11",
      });

      // §41: every provider call is attributable to a user and an operation.
      const usage = await db
        .select()
        .from(apiUsage)
        .where(eq(apiUsage.userId, user.id));
      expect(usage.length).toBeGreaterThanOrEqual(2);
      expect(usage.map((u) => u.operation)).toContain("analytics.channel");
      expect(usage.map((u) => u.operation)).toContain("analytics.byVideo");
      expect(usage.every((u) => u.ok)).toBe(true);
      expect(usage.every((u) => u.provider === "google")).toBe(true);
      // Duration is measured, not assumed — it is what makes a slow provider
      // visible in the logs (§41).
      expect(usage.every((u) => typeof u.durationMs === "number")).toBe(true);
    });

    it("does not ingest into another user's channel", async () => {
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      const owner = await createUser({ email: "owner@vidxir.test" });
      const other = await createUser({ email: "other@vidxir.test" });
      const channelId = await createChannel(owner.id);

      await expect(
        ingestChannelAnalytics(other.id, channelId, {
          startDate: "2026-08-10",
          endDate: "2026-08-11",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(google.fetchAnalytics).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Configuration state (§48)
  // -------------------------------------------------------------------------

  describe("missing Google credentials", () => {
    it("exposes a configuration state rather than degrading to a mock", async () => {
      const {
        isYouTubeConfigured,
        requireGoogleCredentials,
        youtubeMissingEnvVars,
      } = await import("@/lib/providers/youtube");
      const { resetEnvCache } = await import("@/lib/env");

      delete process.env["GOOGLE_CLIENT_ID"];
      delete process.env["GOOGLE_CLIENT_SECRET"];
      resetEnvCache();

      try {
        expect(isYouTubeConfigured()).toBe(false);
        expect(youtubeMissingEnvVars()).toEqual([
          "GOOGLE_CLIENT_ID",
          "GOOGLE_CLIENT_SECRET",
        ]);

        // §42: YouTube is the one capability with no mock. A "published" video
        // Google never received is exactly the lie the spec forbids, so the
        // provider refuses with a 503 naming the credential it needs, and the
        // hint says where to get it.
        let thrown: unknown;
        try {
          requireGoogleCredentials();
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({
          code: "provider_not_configured",
          status: 503,
          missingEnvVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
        });
        // The hint names the redirect URI, which is the setting operators get
        // wrong most often.
        expect((thrown as Error).message).toContain("/api/channels/callback");
      } finally {
        // beforeEach restores the values, but the cache has to be dropped too or
        // every later test in the file would see the unconfigured environment.
        resetEnvCache();
      }
    });

    it("reports the capability as not_configured to the UI", async () => {
      const { capabilityStatus } = await import("@/lib/providers/config");
      const { resetEnvCache } = await import("@/lib/env");

      delete process.env["GOOGLE_CLIENT_ID"];
      delete process.env["GOOGLE_CLIENT_SECRET"];
      resetEnvCache();

      try {
        const status = capabilityStatus("youtube");
        // Never "mock": the registry declares YouTube's provider unconditionally
        // as google, so there is no state in which the UI is told it is working.
        expect(status.state).toBe("not_configured");
        expect(status.provider).toBe("google");
        expect(status.missingEnvVars).toEqual([
          "GOOGLE_CLIENT_ID",
          "GOOGLE_CLIENT_SECRET",
        ]);
      } finally {
        resetEnvCache();
      }
    });
  });
});

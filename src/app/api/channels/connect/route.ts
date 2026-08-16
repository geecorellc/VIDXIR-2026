/**
 * GET /api/channels/connect — start the Google authorisation (§6).
 *
 * A redirect, not a JSON endpoint, and deliberately so. The consent URL carries
 * the client id, the scope list and the signed state nonce; building it here and
 * answering with a 302 keeps all three out of the browser bundle (§34). The user
 * types their password into Google's page, never into Tally (§6).
 *
 * The plan's channel limit is checked *before* consent rather than after. Sending
 * someone through a Google authorisation only to refuse the result would be
 * hostile, and it would leave a live grant we then have to revoke (§23).
 *
 * Failures redirect back to the channels screen with a `?connect=` code instead
 * of returning JSON: this route is reached by navigation, so a JSON error body
 * would render as raw text in the address bar.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertUuid, clientIp, currentTier, requireUser } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { getChannel } from "@/lib/channels/service";
import { issueOAuthState, safeReturnTo } from "@/lib/channels/oauth-state";
import { isAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { assertCanConnectChannel } from "@/lib/plans/enforce";
import { buildConsentUrl, isYouTubeConfigured } from "@/lib/providers/youtube";

const log = logger.child({ component: "api", route: "channels/connect" });

const querySchema = z.object({
  /** Present when re-authorising an existing channel. */
  channel: z.string().optional(),
  /** Where to return afterwards. Validated against open redirect. */
  next: z.string().optional(),
});

/** Codes the channels screen turns into human copy. */
type ConnectOutcome =
  | "not_configured"
  | "plan_limit"
  | "rate_limited"
  | "forbidden"
  | "error";

function back(request: NextRequest, target: string, outcome: ConnectOutcome) {
  const url = new URL(target, request.nextUrl.origin);
  url.searchParams.set("connect", outcome);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const parsed = querySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  const params = parsed.success ? parsed.data : {};
  const returnTo = safeReturnTo(params.next ?? null);

  let userId: string;
  try {
    const ctx = await requireUser();
    userId = ctx.user.id;
  } catch {
    // Not signed in: send them to login and come back here afterwards.
    const login = new URL("/login", request.nextUrl.origin);
    login.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(login);
  }

  try {
    // Starting an OAuth flow is cheap but not free — each one mints a nonce and
    // may prompt Google. Keyed by IP alongside the auth endpoints.
    await enforce(rules().authIp, clientIp(request));

    // §48: no credentials means an explicit configuration state, never a mock
    // consent screen. The channels page already renders the banner; this guards
    // the direct-navigation path.
    if (!isYouTubeConfigured()) {
      return back(request, returnTo, "not_configured");
    }

    let reconnectChannelId: string | null = null;
    if (params.channel) {
      assertUuid(params.channel, "channel");
      // Proves ownership before the id is echoed into the signed state.
      const existing = await getChannel(userId, params.channel);
      if (!existing) return back(request, returnTo, "forbidden");
      reconnectChannelId = existing.id;
    }

    // A reconnect replaces credentials on a row that already counted against the
    // limit, so only a genuinely new connection is checked.
    if (!reconnectChannelId) {
      const tier = await currentTier(userId);
      await assertCanConnectChannel(userId, tier);
    }

    const { state } = await issueOAuthState({
      userId,
      channelId: reconnectChannelId,
      returnTo,
    });

    const consentUrl = buildConsentUrl({
      state,
      // Adding a second channel means picking a different Google account; without
      // the account chooser Google reuses the signed-in one silently.
      forceAccountSelection: !reconnectChannelId,
    });

    log.info("oauth consent started", {
      userId,
      reconnect: Boolean(reconnectChannelId),
      channelId: reconnectChannelId ?? undefined,
    });

    // no-store: the consent URL embeds a single-use state nonce.
    return NextResponse.redirect(consentUrl, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (isAppError(error)) {
      log.warn("could not start oauth consent", {
        userId,
        errorCode: error.code,
        error,
      });
      if (error.code === "plan_limit_reached") {
        return back(request, returnTo, "plan_limit");
      }
      if (error.code === "rate_limited") {
        return back(request, returnTo, "rate_limited");
      }
      if (error.code === "provider_not_configured") {
        return back(request, returnTo, "not_configured");
      }
      if (error.code === "forbidden") {
        return back(request, returnTo, "forbidden");
      }
    } else {
      log.error("unexpected failure starting oauth consent", { userId, error });
    }
    return back(request, returnTo, "error");
  }
}

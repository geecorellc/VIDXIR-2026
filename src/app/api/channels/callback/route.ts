/**
 * GET /api/channels/callback — Google's redirect back from consent (§6).
 *
 * The order of operations here is the security of the whole flow:
 *
 *  1. Require a session. The callback is a top-level GET, so the SameSite=Lax
 *     session cookie is sent — that is exactly why `session.ts` chose Lax.
 *  2. Consume the state, which verifies the HMAC, the paired HttpOnly cookie and
 *     the user binding, then burns the nonce. Only after that is the `code`
 *     touched. Doing it the other way round would let an attacker's code be
 *     exchanged against a victim's session.
 *  3. Exchange the code, read the channel, persist encrypted tokens.
 *
 * The user is redirected back to the channels screen with a `?connect=` code, so
 * every outcome — including "you authorised an account with no YouTube channel" —
 * arrives as visible copy rather than a dead end (§37).
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/api/guard";
import { consume, rules } from "@/lib/api/rate-limit";
import { connectChannel } from "@/lib/channels/service";
import { consumeOAuthState, safeReturnTo } from "@/lib/channels/oauth-state";
import { isAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { exchangeCode, fetchMyChannel } from "@/lib/providers/youtube";

const log = logger.child({ component: "api", route: "channels/callback" });

type CallbackOutcome =
  | "connected"
  | "reconnected"
  | "partial_scopes"
  | "denied"
  | "no_channel"
  | "invalid_state"
  | "wrong_account"
  | "not_configured"
  | "rate_limited"
  | "error";

function finish(
  request: NextRequest,
  target: string,
  outcome: CallbackOutcome,
  extra?: Record<string, string>,
) {
  const url = new URL(safeReturnTo(target), request.nextUrl.origin);
  url.searchParams.set("connect", outcome);
  for (const [key, value] of Object.entries(extra ?? {})) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url, { headers: { "cache-control": "no-store" } });
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const fallback = "/dashboard/channels";

  let userId: string;
  try {
    const ctx = await requireUser();
    userId = ctx.user.id;
  } catch {
    const login = new URL("/login", request.nextUrl.origin);
    login.searchParams.set("next", fallback);
    return NextResponse.redirect(login);
  }

  // The state is consumed even when Google reported an error, so a cancelled
  // flow cannot leave a live nonce behind to be replayed.
  let intent: Awaited<ReturnType<typeof consumeOAuthState>>;
  try {
    intent = await consumeOAuthState(params.get("state"), userId);
  } catch (error) {
    log.warn("oauth callback rejected", {
      userId,
      reason: isAppError(error) ? error.code : "unknown",
    });
    return finish(request, fallback, "invalid_state");
  }

  /**
   * Bounded *after* the state is consumed, not before.
   *
   * The nonce must burn on every reachable path — that is what makes the state
   * single-use — so a refusal here must not be able to skip it. And a request that
   * gets this far already carried a valid HMAC and a matching cookie, so the
   * cheap-to-reject cases are behind us; what remains is the token exchange and a
   * YouTube read, which is the cost worth limiting.
   *
   * `consume` rather than `enforce`: this route answers with redirects, and a
   * thrown RateLimitedError would render as a JSON body in the address bar.
   */
  const limit = await consume(rules().oauth, `oauth:${userId}`);
  if (!limit.allowed) {
    log.warn("oauth callback rate limited", { userId });
    return finish(request, intent.returnTo, "rate_limited");
  }

  const googleError = params.get("error");
  if (googleError) {
    // `access_denied` is the user clicking Cancel. Not an error worth alarming
    // anyone about, but it must not look like a success (§37).
    log.info("user declined google consent", { userId, reason: googleError });
    return finish(request, intent.returnTo, "denied");
  }

  const code = params.get("code");
  if (!code) return finish(request, intent.returnTo, "invalid_state");

  try {
    const tokens = await exchangeCode(code);
    const channel = await fetchMyChannel(tokens.accessToken);

    if (!channel || !channel.channelId) {
      // A Google account without a YouTube channel. Real and common; the user
      // has to create one before Tally can do anything.
      log.info("authorised account has no youtube channel", { userId });
      return finish(request, intent.returnTo, "no_channel");
    }

    const result = await connectChannel({
      userId,
      tokens,
      channel,
      expectedChannelId: intent.channelId,
    });

    // A partial grant is a distinct state: the channel is saved, but publishing
    // will not work until the missing scopes are granted. Saying "connected"
    // here would be the kind of half-truth §42 rules out.
    const outcome: CallbackOutcome =
      result.missingScopes.length > 0
        ? "partial_scopes"
        : result.created
          ? "connected"
          : "reconnected";

    return finish(request, intent.returnTo, outcome, { channel: result.channelId });
  } catch (error) {
    if (isAppError(error)) {
      log.warn("oauth callback failed", { userId, errorCode: error.code, error });
      if (error.code === "provider_not_configured") {
        return finish(request, intent.returnTo, "not_configured");
      }
      if (error.code === "conflict") {
        return finish(request, intent.returnTo, "wrong_account");
      }
    } else {
      log.error("unexpected oauth callback failure", { userId, error });
    }
    return finish(request, intent.returnTo, "error");
  }
}

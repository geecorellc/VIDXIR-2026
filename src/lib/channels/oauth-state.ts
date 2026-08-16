/**
 * OAuth `state` handling for the Google consent round-trip (§6, §34).
 *
 * The threat this closes is login-CSRF on the connect flow: an attacker
 * completes consent with *their* Google account and tricks a signed-in Tally
 * user into loading the resulting callback URL, which would attach the
 * attacker's channel to the victim's account.
 *
 * Three independent checks, so defeating one is not enough:
 *
 *  1. **Signature.** The state is HMAC'd with a key derived from SESSION_SECRET
 *     under its own purpose string, so it cannot be forged and cannot be replayed
 *     as any other signed value.
 *  2. **Session binding.** The signed payload names the user id that started the
 *     flow. A callback arriving on a different session is refused.
 *  3. **Cookie pairing.** A short-lived HttpOnly cookie holds the same nonce.
 *     A state value captured from a URL (browser history, a referrer log, a
 *     shared link) is useless without the cookie, and the cookie is cleared as
 *     soon as it is consumed — so the state is single-use.
 *
 * The state is deliberately *not* stored in the database. It has a five-minute
 * life, it is per-browser, and a table would need pruning for no security gain.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { sign, verifySignature } from "@/lib/crypto";
import { isProduction } from "@/lib/env";
import { ValidationError } from "@/lib/errors";

const PURPOSE = "youtube-oauth-state";
export const OAUTH_STATE_COOKIE = "tally_oauth_state";
/** Long enough to read a consent screen, short enough to limit replay. */
const STATE_TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  /** Random nonce, mirrored in the cookie. */
  n: string;
  /** User who started the flow. */
  u: string;
  /** Channel being re-authorised, when this is a reconnect rather than an add. */
  c?: string;
  /** Where to send the user afterwards. Path-only, validated on the way out. */
  r?: string;
  /** Issued-at, epoch ms. */
  t: number;
}

export interface IssuedState {
  /** Value to put in the `state` query parameter. */
  state: string;
}

export interface StateIntent {
  userId: string;
  channelId: string | null;
  returnTo: string;
}

/** Default landing page after a successful connect. */
const DEFAULT_RETURN_TO = "/dashboard/channels";

/**
 * Mint a state value and set its paired cookie.
 *
 * `SameSite=lax` matches the session cookie: the callback is a cross-site
 * top-level GET, and `strict` would withhold the cookie exactly when it is
 * needed.
 */
export async function issueOAuthState(intent: {
  userId: string;
  channelId?: string | null;
  returnTo?: string | null;
}): Promise<IssuedState> {
  const nonce = randomBytes(24).toString("base64url");
  const payload: StatePayload = {
    n: nonce,
    u: intent.userId,
    t: Date.now(),
    ...(intent.channelId ? { c: intent.channelId } : {}),
    ...(intent.returnTo ? { r: intent.returnTo } : {}),
  };

  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const state = `${body}.${sign(PURPOSE, body)}`;

  const store = await cookies();
  store.set(OAUTH_STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    maxAge: Math.floor(STATE_TTL_MS / 1000),
  });

  return { state };
}

/**
 * Validate a returning state and consume the cookie.
 *
 * Throws ValidationError for every failure mode with a deliberately vague
 * message: the distinction between "expired", "forged" and "wrong session" is
 * useful to an attacker and not to a user, whose only remedy is to start again.
 */
export async function consumeOAuthState(
  rawState: string | null,
  sessionUserId: string,
): Promise<StateIntent> {
  const store = await cookies();
  const cookieNonce = store.get(OAUTH_STATE_COOKIE)?.value ?? null;
  // Clear first, so any outcome — success or failure — burns the nonce and a
  // replayed callback cannot succeed on a second attempt.
  store.delete(OAUTH_STATE_COOKIE);

  // `throw invalid()` rather than a `never`-returning call, so TypeScript
  // narrows `rawState` and the tuple destructure below needs no casts.
  const invalid = () =>
    new ValidationError(
      "This connection link is no longer valid. Start the connection again.",
    );

  if (!rawState || !cookieNonce) throw invalid();

  const [body, signature, ...rest] = rawState.split(".");
  if (!body || !signature || rest.length > 0) throw invalid();

  if (!verifySignature(PURPOSE, body, signature)) throw invalid();

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
  } catch {
    throw invalid();
  }

  if (typeof payload.n !== "string" || typeof payload.u !== "string") throw invalid();
  if (payload.n !== cookieNonce) throw invalid();
  if (payload.u !== sessionUserId) throw invalid();
  if (typeof payload.t !== "number" || Date.now() - payload.t > STATE_TTL_MS) {
    throw invalid();
  }

  return {
    userId: payload.u,
    channelId: payload.c ?? null,
    returnTo: safeReturnTo(payload.r),
  };
}

/**
 * Only same-site absolute paths are accepted as a redirect target — an
 * attacker-supplied `returnTo` is otherwise an open redirect.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value) return DEFAULT_RETURN_TO;
  // Reject protocol-relative (`//evil.com`) and absolute URLs outright.
  if (!value.startsWith("/") || value.startsWith("//")) return DEFAULT_RETURN_TO;
  if (value.includes("\\")) return DEFAULT_RETURN_TO;
  return value;
}

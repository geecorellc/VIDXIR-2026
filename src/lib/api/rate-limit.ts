/**
 * Rate limiting (§34).
 *
 * Redis-backed fixed-window counters. Redis is already a hard dependency for the
 * job queue, so this adds no new infrastructure and works across multiple web
 * instances — an in-process map would not.
 *
 * If Redis is unreachable the limiter fails open and logs. Rejecting all logins
 * because a cache is down would convert a degraded cache into an outage; the
 * account lockout in the auth service still bounds credential stuffing.
 */
import "server-only";
import { RateLimitedError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { coordinate } from "@/lib/cloudflare/coordination";

export interface RateLimitRule {
  /** Stable identifier, e.g. `auth:login`. */
  name: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * The window counter, incremented and expired in one atomic step.
 *
 * An `INCR` followed by a separate `EXPIRE` is two round trips, and a process
 * that dies between them (or a Redis failover that loses the second command)
 * leaves a counter with no TTL. That key never resets, so the subject it belongs
 * to is rate-limited permanently — on the auth rules, that is an account locked
 * out of its own login by a cache hiccup.
 *
 * The script also returns the TTL, so the exhausted path no longer needs a third
 * round trip, and `retryAfterSeconds` is read from the same atomic view of the
 * key that produced the count.
 *
 * `PEXPIRE`/`PTTL` in milliseconds internally, converted at the boundary, so a
 * request arriving in the final fractional second of a window reports 1 rather
 * than 0 and never advertises a retry the window will still reject.
 */
/** Consume one unit against `key`, atomically. */
export async function consume(
  rule: RateLimitRule,
  key: string,
): Promise<RateLimitResult> {
  const redisKey = `${env().QUEUE_PREFIX}:ratelimit:${rule.name}:${key}`;

  try {
    const { count, ttlMs } = await coordinate<{ count: number; ttlMs: number }>(redisKey, "consume", { windowMs: rule.windowSeconds * 1000 });
    const retryAfterSeconds =
      Number.isFinite(ttlMs) && ttlMs > 0
        ? Math.max(1, Math.ceil(ttlMs / 1000))
        : rule.windowSeconds;

    if (count > rule.limit) {
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    return {
      allowed: true,
      remaining: Math.max(0, rule.limit - count),
      retryAfterSeconds: 0,
    };
  } catch (error) {
    logger.error("rate limiter unavailable, failing open", {
      component: "rate-limit",
      rule: rule.name,
      error,
    });
    return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0 };
  }
}

/** Consume and throw RateLimitedError when the window is exhausted. */
export async function enforce(
  rule: RateLimitRule,
  key: string,
): Promise<void> {
  const result = await consume(rule, key);
  if (!result.allowed) {
    throw new RateLimitedError(
      result.retryAfterSeconds,
      "Too many requests. Please wait a moment and try again.",
    );
  }
}

/** Rules used across the app. Limits come from env so operators can tune them. */
export function rules() {
  const e = env();
  return {
    /** Unauthenticated auth endpoints, keyed by IP. */
    authIp: {
      name: "auth:ip",
      limit: e.RATE_LIMIT_AUTH_PER_MINUTE,
      windowSeconds: 60,
    },
    /** Login attempts keyed by email, so one account cannot be sprayed. */
    loginEmail: { name: "auth:email", limit: 10, windowSeconds: 15 * 60 },
    /** Password reset requests keyed by email — limits mailbox spamming. */
    passwordReset: { name: "auth:reset", limit: 5, windowSeconds: 60 * 60 },
    /** Verification resends. */
    verifyResend: { name: "auth:verify", limit: 5, windowSeconds: 60 * 60 },
    /** Any endpoint that spends provider credits, keyed by user. */
    generation: {
      name: "generation",
      limit: e.RATE_LIMIT_GENERATION_PER_MINUTE,
      windowSeconds: 60,
    },
    /** Research runs are expensive; a tighter window than generation. */
    research: { name: "research", limit: 10, windowSeconds: 10 * 60 },
    /** Read-heavy dashboard endpoints, keyed by user. */
    read: { name: "read", limit: 240, windowSeconds: 60 },
    /**
     * Authenticated writes that are not generation: settings, onboarding, channel
     * mutations. Loose enough that no real UI interaction reaches it, tight enough
     * that a scripted loop cannot hammer Postgres through an authenticated route.
     */
    mutation: { name: "mutation", limit: 60, windowSeconds: 60 },
    /**
     * OAuth connect and callback, keyed by user. Each round trip issues a signed
     * state and a nonce cookie; a loop through it is both a Google-quota cost and
     * a way to churn state cookies.
     */
    oauth: { name: "oauth", limit: 20, windowSeconds: 10 * 60 },
    /**
     * Stripe checkout and portal session creation, keyed by user. Every call is a
     * live request to Stripe, so this rule bounds our own outbound spend as much
     * as it bounds the caller.
     */
    billing: { name: "billing", limit: 10, windowSeconds: 10 * 60 },
  } satisfies Record<string, RateLimitRule>;
}

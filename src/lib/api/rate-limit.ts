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
import { getRedis } from "@/lib/queue/redis";

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
 * Consume one unit against `key`. Uses INCR + EXPIRE, which is atomic enough for
 * a fixed window: the first request in a window creates the key and sets the TTL.
 */
export async function consume(
  rule: RateLimitRule,
  key: string,
): Promise<RateLimitResult> {
  const redisKey = `${env().QUEUE_PREFIX}:ratelimit:${rule.name}:${key}`;

  try {
    const redis = getRedis();
    const count = await redis.incr(redisKey);
    if (count === 1) {
      await redis.expire(redisKey, rule.windowSeconds);
    }

    if (count > rule.limit) {
      const ttl = await redis.ttl(redisKey);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: ttl > 0 ? ttl : rule.windowSeconds,
      };
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
  } satisfies Record<string, RateLimitRule>;
}

/**
 * Shared Redis connections (§31).
 *
 * Three separate connections, because BullMQ requires dedicated blocking
 * connections for workers and rejects `maxRetriesPerRequest` on them:
 *  - `getRedis()`  — general commands (rate limiting, SSE pub/sub publishing)
 *  - `queueConnection()` — for Queue instances
 *  - `workerConnection()` — for Worker instances (blocking, must not retry-cap)
 *
 * Connections are cached on globalThis so Next.js hot reload does not exhaust
 * Redis client slots.
 */
import "server-only";
import Redis, { type RedisOptions } from "ioredis";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

const globalForRedis = globalThis as unknown as {
  __tallyRedis?: Redis;
  __tallyQueueRedis?: Redis;
  __tallySubscriber?: Redis;
};

function baseOptions(): RedisOptions {
  return {
    // Exponential-ish backoff, capped, so a Redis restart reconnects promptly
    // without hammering it.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    enableOfflineQueue: true,
    lazyConnect: false,
  };
}

function attachLogging(client: Redis, label: string): Redis {
  client.on("error", (error) => {
    logger.error("redis error", { component: "redis", label, error });
  });
  client.on("reconnecting", () => {
    logger.warn("redis reconnecting", { component: "redis", label });
  });
  return client;
}

/** General-purpose client for non-blocking commands. */
export function getRedis(): Redis {
  if (!globalForRedis.__tallyRedis) {
    globalForRedis.__tallyRedis = attachLogging(
      new Redis(env().REDIS_URL, {
        ...baseOptions(),
        maxRetriesPerRequest: 3,
      }),
      "general",
    );
  }
  return globalForRedis.__tallyRedis;
}

/**
 * Connection for BullMQ Queue/QueueEvents instances. BullMQ requires
 * `maxRetriesPerRequest: null` so a command is never abandoned mid-operation.
 */
export function queueConnection(): Redis {
  if (!globalForRedis.__tallyQueueRedis) {
    globalForRedis.__tallyQueueRedis = attachLogging(
      new Redis(env().REDIS_URL, {
        ...baseOptions(),
        maxRetriesPerRequest: null,
      }),
      "queue",
    );
  }
  return globalForRedis.__tallyQueueRedis;
}

/**
 * A NEW connection for each Worker. Workers block on BRPOPLPUSH, so they cannot
 * share a connection with anything else — hence no caching here.
 */
export function workerConnection(): Redis {
  return attachLogging(
    new Redis(env().REDIS_URL, {
      ...baseOptions(),
      maxRetriesPerRequest: null,
    }),
    "worker",
  );
}

/** Dedicated subscriber connection — a subscribed client cannot issue commands. */
export function subscriberConnection(): Redis {
  if (!globalForRedis.__tallySubscriber) {
    globalForRedis.__tallySubscriber = attachLogging(
      new Redis(env().REDIS_URL, { ...baseOptions(), maxRetriesPerRequest: null }),
      "subscriber",
    );
  }
  return globalForRedis.__tallySubscriber;
}

/** Close cached connections. Used by worker shutdown and tests. */
export async function closeRedis(): Promise<void> {
  const clients = [
    globalForRedis.__tallyRedis,
    globalForRedis.__tallyQueueRedis,
    globalForRedis.__tallySubscriber,
  ].filter((c): c is Redis => Boolean(c));

  await Promise.allSettled(clients.map((c) => c.quit()));
  globalForRedis.__tallyRedis = undefined;
  globalForRedis.__tallyQueueRedis = undefined;
  globalForRedis.__tallySubscriber = undefined;
}

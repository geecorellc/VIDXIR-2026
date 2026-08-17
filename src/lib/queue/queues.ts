/**
 * BullMQ queue definitions (§31, §10).
 *
 * §10 is explicit: "Do not perform long video-generation jobs inside a normal
 * HTTP request." Everything slow is enqueued here and executed by the worker
 * process, so a run survives a refresh, a browser close, and a web-process
 * restart.
 *
 * Queues are split by *resource*, not by feature, because each has a different
 * failure profile and a different sensible concurrency:
 *
 *  - `research`   — YouTube quota bound. A handful of concurrent runs at most.
 *  - `pipeline`   — CPU/provider bound, the long stages.
 *  - `publish`    — must be serialised carefully; a duplicate upload is not
 *                   recoverable, so it never shares a queue with retry-happy work.
 *  - `analytics`  — cheap, periodic, safe to run behind everything else.
 *  - `maintenance`— scheduler chores.
 *
 * A single mixed queue would let ten renders starve a publish that is only
 * waiting on one API call.
 */
import { Queue, type JobsOptions } from "bullmq";
import { env } from "@/lib/env";
import { queueConnection } from "@/lib/queue/redis";

export const QUEUE_NAMES = [
  "research",
  "pipeline",
  "publish",
  "analytics",
  "maintenance",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/**
 * Default retry policy.
 *
 * Exponential from 15s, so a provider blip recovers without a stampede.
 * `removeOnComplete`/`removeOnFail` keep Redis bounded — the durable record of
 * every job lives in the `jobs` table, so Redis only needs enough history for
 * debugging in flight, not forever.
 */
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 15_000 },
  removeOnComplete: { age: 3_600, count: 500 },
  removeOnFail: { age: 86_400 * 3, count: 1_000 },
};

const cache = new Map<QueueName, Queue>();

/**
 * The queue by name, cached per process.
 *
 * Prefixed with `QUEUE_PREFIX` so a staging deployment sharing a Redis instance
 * cannot consume production jobs.
 */
export function getQueue(name: QueueName): Queue {
  const existing = cache.get(name);
  if (existing) return existing;

  const queue = new Queue(name, {
    connection: queueConnection(),
    prefix: env().QUEUE_PREFIX,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  cache.set(name, queue);
  return queue;
}

/** Shared BullMQ options for a Worker on this queue. Used by `src/worker`. */
export function workerQueueOptions(): { prefix: string } {
  return { prefix: env().QUEUE_PREFIX };
}

/** Close cached queues. Used by worker shutdown and tests. */
export async function closeQueues(): Promise<void> {
  const queues = [...cache.values()];
  cache.clear();
  await Promise.allSettled(queues.map((q) => q.close()));
}

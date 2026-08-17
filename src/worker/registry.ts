/**
 * Which handler runs which job, and at what concurrency (§10, §31).
 *
 * Separate from `worker/index.ts` because that module starts BullMQ consumers as
 * an import side effect. A test — or the scheduler, or anything else that wants
 * to know whether a job name has a handler — must be able to ask without
 * connecting to Redis and beginning to drain the queue.
 */
import { RESEARCH_JOB_NAME } from "@/lib/research/service";
import { SCRIPT_JOB_NAME } from "@/lib/scripts/service";
import type { QueueName } from "@/lib/queue/queues";
import { researchHandler } from "@/worker/handlers/research";
import { scriptHandler } from "@/worker/handlers/script";
import { videoHandlers } from "@/worker/handlers/video";
import type { JobHandler } from "@/worker/types";

/** Handlers by queue, then by job name. */
export const HANDLERS: Partial<Record<QueueName, Record<string, JobHandler>>> = {
  research: {
    [RESEARCH_JOB_NAME]: researchHandler,
  },
  pipeline: {
    [SCRIPT_JOB_NAME]: scriptHandler,
    // Scene plan through render. Each stage enqueues the next, so all seven land
    // on this queue rather than on one queue per stage.
    ...videoHandlers,
  },
};

/**
 * Concurrency per queue.
 *
 * `research` is low because it is YouTube-quota bound, not CPU bound — running
 * twenty concurrent runs would exhaust a day's quota in a minute. `publish` is 1
 * deliberately: a duplicated upload cannot be undone.
 */
export const CONCURRENCY: Record<QueueName, number> = {
  research: 3,
  pipeline: 4,
  publish: 1,
  analytics: 2,
  maintenance: 2,
};

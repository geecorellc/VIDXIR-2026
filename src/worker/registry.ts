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
import { analyticsHandlers } from "@/worker/handlers/analytics";
import { publishHandlers } from "@/worker/handlers/publish";
import { researchHandler } from "@/worker/handlers/research";
import { scriptHandler } from "@/worker/handlers/script";
import { thumbnailHandlers } from "@/worker/handlers/thumbnail";
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
    // Thumbnails share the pipeline queue rather than getting their own: a
    // generation is one AI call and four short composites, and a separate queue
    // would mean a separate worker's concurrency to tune for a job that runs
    // once per video.
    ...thumbnailHandlers,
  },
  /**
   * Its own queue, not `pipeline`. `CONCURRENCY.publish` is 1, and that only
   * serialises uploads if uploads are the only thing on the queue — sharing it
   * with the pipeline would either starve renders or let two uploads overlap.
   */
  publish: {
    ...publishHandlers,
  },
  /**
   * The `analytics` queue existed from Phase 5 with `CONCURRENCY.analytics = 2`
   * and no handlers; Phase 9 fills it rather than adding a queue. Kept off
   * `pipeline` because these jobs are quota-bound and must not queue behind a
   * render, and off `publish` because that queue is deliberately serialised.
   */
  analytics: {
    ...analyticsHandlers,
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

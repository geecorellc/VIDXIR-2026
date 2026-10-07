import { nativeBindings, type NativeBindings } from "@/lib/cloudflare/bindings";
import { env } from "@/lib/env";

export const QUEUE_NAMES = ["research", "pipeline", "publish", "analytics", "maintenance"] as const;
export type QueueName = typeof QUEUE_NAMES[number];
const bindings = { research: "RESEARCH_QUEUE", pipeline: "PIPELINE_QUEUE", publish: "PUBLISH_QUEUE", analytics: "ANALYTICS_QUEUE", maintenance: "MAINTENANCE_QUEUE" } as const;

export interface NativeJobMessage {
  jobId: string;
  name: string;
  queue: QueueName;
  attempts: number;
  /** Long delays are checked against the durable jobs row before execution. */
  eligibleAt: number;
}

export function getQueue(queue: QueueName) {
  return {
    name: queue,
    async waitUntilReady() { throw new Error("Legacy BullMQ verification is not supported; use test:cloudflare."); },
    async obliterate(_options: { force?: boolean } = {}) { throw new Error("Native queues cannot be obliterated by legacy scripts."); },
    async getJobCountByTypes(..._types: string[]): Promise<number> { throw new Error("Read native job counts from D1."); },
    async getJob(_id: string): Promise<{ id: string; remove(): Promise<void> } | undefined> { throw new Error("Read native job state from D1."); },
    async remove(_id: string) { throw new Error("Native cancellation must update the durable job row."); },
    async add(name: string, data: Record<string, unknown>, options: { jobId: string; attempts?: number; delay?: number; priority?: number }) {
      const binding = nativeBindings()[bindings[queue] as keyof NativeBindings] as NativeBindings["PIPELINE_QUEUE"];
      const delaySeconds = Math.ceil((options.delay ?? 0) / 1000);
      await binding.send({ jobId: options.jobId, name, queue, attempts: options.attempts ?? 3, eligibleAt: Date.now() + (options.delay ?? 0) } satisfies NativeJobMessage,
        { delaySeconds: Math.min(delaySeconds, 43200) });
      return { id: options.jobId };
    },
  };
}
/** Only retained for the obsolete standalone BullMQ entry point. */
export function workerQueueOptions() { return { prefix: env().QUEUE_PREFIX }; }
export async function closeQueues(): Promise<void> { /* No connections to close. */ }

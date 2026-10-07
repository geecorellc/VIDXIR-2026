import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { D1Database, R2Bucket, Queue, DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";

export interface NativeBindings {
  DB: D1Database;
  MEDIA: R2Bucket;
  COORDINATION: DurableObjectNamespace;
  RESEARCH_QUEUE: Queue;
  PIPELINE_QUEUE: Queue;
  PUBLISH_QUEUE: Queue;
  ANALYTICS_QUEUE: Queue;
  MAINTENANCE_QUEUE: Queue;
  BACKEND: Fetcher;
}

let injected: NativeBindings | undefined;
/** The standalone Container explicitly supplies its authenticated bridge client. */
export function setNativeBindings(bindings: NativeBindings): void { injected = bindings; }
export function nativeBindings(): NativeBindings {
  if (injected) return injected;
  return getCloudflareContext().env as unknown as NativeBindings;
}

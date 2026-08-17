/**
 * Pipeline stage handlers (§10, §31, §34).
 *
 * One factory, seven registrations. Every stage has the same job contract — a
 * project id and a tier — so the differences between them belong in the service
 * layer, not in seven near-identical handler files.
 *
 * The pattern is the same as the script handler and matters for the same reason:
 * the payload arrives over Redis and is treated as data, while the **owning user
 * comes from the `jobs` row**. A worker that trusted a `userId` in a payload would
 * let anyone who can write to Redis render into another tenant's storage.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import {
  CAPTIONS_JOB,
  MUSIC_JOB,
  RENDER_JOB,
  SCENE_PLAN_JOB,
  TIMELINE_JOB,
  VISUALS_JOB,
  VOICEOVER_JOB,
  executeCaptions,
  executeMusic,
  executeRender,
  executeScenePlan,
  executeTimeline,
  executeVisuals,
  executeVoiceover,
  type StageInput,
} from "@/lib/video/service";
import type { JobHandler } from "@/worker/types";

const PayloadSchema = z.object({
  projectId: z.string().uuid(),
  tier: z.enum(["starter", "studio", "scale"]).default("starter"),
});

/**
 * Wrap a stage function as a handler.
 *
 * The tier defaults rather than failing when absent: a job enqueued by an older
 * build would otherwise be stuck permanently, and the tier only affects queue
 * priority at this point — the plan limit was already enforced at the request
 * that started the build.
 */
function stageHandler(
  execute: (input: StageInput) => Promise<Record<string, unknown>>,
): JobHandler {
  return async ({ jobId, payload, traceId }) => {
    const parsed = PayloadSchema.safeParse(payload);
    if (!parsed.success) {
      // Not retryable: a malformed payload is malformed on every attempt.
      throw new Error(
        `Invalid pipeline payload: ${parsed.error.issues
          .map((i) => `${i.path.join(".")} ${i.message}`)
          .join("; ")}`,
      );
    }

    const rows = await db
      .select({ userId: jobs.userId, projectId: jobs.projectId })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);

    const row = rows[0];
    if (!row) throw new Error(`Job row ${jobId} not found.`);

    if (row.projectId && row.projectId !== parsed.data.projectId) {
      throw new Error("Job payload project does not match the job record.");
    }

    return execute({
      userId: row.userId,
      projectId: parsed.data.projectId,
      jobId,
      tier: parsed.data.tier,
      traceId,
    });
  };
}

export const videoHandlers: Record<string, JobHandler> = {
  [SCENE_PLAN_JOB]: stageHandler(async (input) => ({ ...(await executeScenePlan(input)) })),
  [VOICEOVER_JOB]: stageHandler(async (input) => ({ ...(await executeVoiceover(input)) })),
  [VISUALS_JOB]: stageHandler(async (input) => ({ ...(await executeVisuals(input)) })),
  [MUSIC_JOB]: stageHandler(async (input) => ({ ...(await executeMusic(input)) })),
  [CAPTIONS_JOB]: stageHandler(async (input) => ({ ...(await executeCaptions(input)) })),
  [TIMELINE_JOB]: stageHandler(async (input) => ({ ...(await executeTimeline(input)) })),
  [RENDER_JOB]: stageHandler(async (input) => ({ ...(await executeRender(input)) })),
};

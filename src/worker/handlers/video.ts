/**
 * Pipeline stage handlers (§10, §31, §34).
 *
 * Two factories, nine registrations. Almost every stage has the same job contract —
 * a project id and a tier — so the differences between them belong in the service
 * layer, not in nine near-identical handler files. Scene regeneration is the one
 * exception: it also needs to know which scene.
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
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  CAPTIONS_JOB,
  CONTINUITY_JOB,
  MUSIC_JOB,
  REFERENCE_IMAGES_JOB,
  RENDER_JOB,
  SCENE_PLAN_JOB,
  SCENE_REGEN_JOB,
  TIMELINE_JOB,
  VISUALS_JOB,
  VOICEOVER_JOB,
  executeCaptions,
  executeContinuityCheck,
  executeMusic,
  executeReferenceImages,
  executeRender,
  executeSceneRegeneration,
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
 * A regeneration also carries which scene.
 *
 * Required, not defaulted: a regeneration job with no scene index has nothing to
 * regenerate, and defaulting to zero would rebuild the wrong scene at full price.
 */
const RegenPayloadSchema = PayloadSchema.extend({
  sceneIndex: z.number().int().min(0).max(10_000),
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
      // Typed so `shouldRetry` reads `retryable: false` off it. A malformed
      // payload is malformed on every attempt, and a bare `Error` is treated as
      // a possible transient fault — three render attempts for nothing.
      throw new ValidationError(
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
    /**
     * Discarded, not retried: `NotFoundError` is `retryable: false`, and a row
     * that is missing now cannot appear fifteen seconds later. This matters more
     * on the pipeline queue than anywhere else — a retried render stage is
     * minutes of encoding, and the usual cause of a missing row is a queued
     * message that outlived it (a truncated database, a manual deletion).
     */
    if (!row) throw new NotFoundError(`Job row ${jobId} not found.`);

    if (row.projectId && row.projectId !== parsed.data.projectId) {
      // The payload is not describing this job. Refusing is a tenant-isolation
      // guarantee (§34): a mismatched id is how one user's render would write
      // into another's project. No retry changes the comparison.
      throw new ForbiddenError("Job payload project does not match the job record.");
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

/**
 * The same wrapper for the one stage that takes an extra argument.
 *
 * Kept as a second small factory rather than by widening `stageHandler`'s payload
 * schema: a required `sceneIndex` on the shared schema would reject every one of the
 * seven pipeline stages, and an optional one would let a regeneration run with no
 * scene. The owner still comes from the `jobs` row, and the project id is still
 * cross-checked against it.
 */
function sceneStageHandler(
  execute: (
    input: StageInput & { sceneIndex: number },
  ) => Promise<Record<string, unknown>>,
): JobHandler {
  return async ({ jobId, payload, traceId }) => {
    const parsed = RegenPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ValidationError(
        `Invalid scene regeneration payload: ${parsed.error.issues
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
    if (!row) throw new NotFoundError(`Job row ${jobId} not found.`);

    if (row.projectId && row.projectId !== parsed.data.projectId) {
      throw new ForbiddenError("Job payload project does not match the job record.");
    }

    return execute({
      userId: row.userId,
      projectId: parsed.data.projectId,
      jobId,
      tier: parsed.data.tier,
      traceId,
      sceneIndex: parsed.data.sceneIndex,
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
  // The continuity layer's two stages. Both are `QUALITY_CHECK`, both run after
  // `VIDEO_READY`, and neither can fail the project — see the service layer.
  [CONTINUITY_JOB]: stageHandler(async (input) => ({
    ...(await executeContinuityCheck(input)),
  })),
  [SCENE_REGEN_JOB]: sceneStageHandler(async (input) => ({
    ...(await executeSceneRegeneration(input)),
  })),
  /**
   * The bible's reference stills. Off the critical path, like the two above.
   *
   * Registered with the ordinary `stageHandler` because the payload is the ordinary
   * one — a project and a tier. Which entities need drawing is read from the bible and
   * the stored assets inside the stage, never taken from the payload: a job message is
   * data, and an entity list arriving over Redis would be a way to bill a tenant for
   * generations they never asked for.
   */
  [REFERENCE_IMAGES_JOB]: stageHandler(async (input) => ({
    ...(await executeReferenceImages(input)),
  })),
};

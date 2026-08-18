/**
 * Thumbnail stage handler (§16, §34).
 *
 * Same contract as the video stage handlers, and same reason for it: the payload
 * arrives over Redis and is treated as data, while the **owning user comes from
 * the `jobs` row**. A worker that trusted a `userId` in a payload would let
 * anyone who can write to Redis composite into another tenant's storage.
 *
 * Not folded into `videoHandlers`. That factory's payload schema is
 * `{projectId, tier}` and every stage it wraps chains to the next one; this stage
 * carries a `returnTo` and chains to nothing, so sharing the factory would mean
 * widening it for one caller.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  THUMBNAIL_JOB,
  executeThumbnails,
  parseReturnTo,
} from "@/lib/thumbnails/service";
import type { JobHandler } from "@/worker/types";

const PayloadSchema = z.object({
  projectId: z.string().uuid(),
  tier: z.enum(["starter", "studio", "scale"]).default("starter"),
  /**
   * Validated by `parseReturnTo` rather than by the schema, so an unrecognised
   * value falls back to VIDEO_READY instead of failing a job that could otherwise
   * complete. The two legal values are the only states this stage runs from; a
   * third would mean the payload came from a different build.
   */
  returnTo: z.unknown().optional(),
});

export const thumbnailHandler: JobHandler = async ({ jobId, payload, traceId }) => {
  const parsed = PayloadSchema.safeParse(payload);
  if (!parsed.success) {
    // Typed so `shouldRetry` reads `retryable: false` off it: a malformed payload
    // is malformed on every attempt, and a bare `Error` would buy three AI calls
    // for nothing.
    throw new ValidationError(
      `Invalid thumbnail payload: ${parsed.error.issues
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
  // Discarded, not retried: a row missing now cannot appear fifteen seconds later.
  if (!row) throw new NotFoundError(`Job row ${jobId} not found.`);

  if (row.projectId && row.projectId !== parsed.data.projectId) {
    // A mismatched id is how one user's generation would write into another's
    // project. No retry changes the comparison (§34).
    throw new ForbiddenError("Job payload project does not match the job record.");
  }

  return executeThumbnails({
    userId: row.userId,
    projectId: parsed.data.projectId,
    jobId,
    tier: parsed.data.tier,
    returnTo: parseReturnTo(parsed.data.returnTo),
    traceId,
  });
};

export const thumbnailHandlers: Record<string, JobHandler> = {
  [THUMBNAIL_JOB]: thumbnailHandler,
};

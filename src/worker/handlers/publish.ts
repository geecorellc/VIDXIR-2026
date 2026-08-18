/**
 * Publish stage handler (§18, §34, §42).
 *
 * Same contract as the thumbnail and video handlers, and for the same reason: the
 * payload arrives over Redis and is treated as untrusted data, while the **owning
 * user comes from the `jobs` row**. That matters more here than anywhere else in
 * the system — a worker that trusted a `userId` in a payload would let anyone who
 * can write to Redis upload a video to another tenant's YouTube channel using that
 * tenant's OAuth token, which is not a bug that can be undone afterwards.
 *
 * On its own queue rather than folded into `pipeline`, because `CONCURRENCY.publish`
 * is 1: uploads are serialised so that two attempts at the same video cannot be
 * in flight at once.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  PUBLISH_JOB,
  executePublish,
  forgetUploadProgress,
} from "@/lib/publish/service";
import type { JobHandler } from "@/worker/types";

const PayloadSchema = z.object({
  projectId: z.string().uuid(),
  publishJobId: z.string().uuid(),
  /**
   * Null means "use the project's stored metadata", which is the normal case. It
   * is nullable rather than optional because `enqueue` serialises an explicit
   * null and a round trip through JSON should not change the meaning.
   */
  madeForKids: z.boolean().nullish(),
});

export const publishHandler: JobHandler = async ({ jobId, payload, traceId }) => {
  const parsed = PayloadSchema.safeParse(payload);
  if (!parsed.success) {
    // Typed so `shouldRetry` reads `retryable: false` off it. A malformed payload
    // is malformed on every attempt, and retrying an upload is expensive.
    throw new ValidationError(
      `Invalid publish payload: ${parsed.error.issues
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
    // A mismatched id is how one user's video would be uploaded to another's
    // channel. No retry changes the comparison (§34).
    throw new ForbiddenError("Job payload project does not match the job record.");
  }

  try {
    return await executePublish({
      userId: row.userId,
      projectId: parsed.data.projectId,
      publishJobId: parsed.data.publishJobId,
      jobId,
      madeForKids: parsed.data.madeForKids ?? null,
      traceId,
    });
  } finally {
    // The progress throttle is per publish job; a long-lived worker would
    // otherwise accumulate one entry per video it ever uploaded.
    forgetUploadProgress(parsed.data.publishJobId);
  }
};

export const publishHandlers: Record<string, JobHandler> = {
  [PUBLISH_JOB]: publishHandler,
};

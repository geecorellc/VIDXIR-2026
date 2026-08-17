/**
 * Script generation job handler (§9, §10).
 *
 * Same shape as the research handler, and for the same reason: the payload is
 * validated, the owning user comes from the `jobs` row rather than the payload,
 * and everything else is delegated so the logic stays testable without a queue.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { executeScriptGeneration } from "@/lib/scripts/service";
import type { JobHandler } from "@/worker/types";

const PayloadSchema = z.object({
  projectId: z.string().uuid(),
  feedback: z.string().max(1_000).optional(),
});

export const scriptHandler: JobHandler = async ({ jobId, payload, traceId }) => {
  const parsed = PayloadSchema.safeParse(payload);
  if (!parsed.success) {
    // A `ValidationError` rather than a bare `Error`, because `shouldRetry`
    // treats an unrecognised error as a possible network blip and retries it.
    // A malformed payload is malformed on every attempt, so the retry budget
    // would be spent for nothing.
    throw new ValidationError(
      `Invalid script payload: ${parsed.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    );
  }

  // Authority comes from the row the API wrote, not from Redis (§34).
  const rows = await db
    .select({ userId: jobs.userId, projectId: jobs.projectId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);

  const row = rows[0];
  /**
   * A row that is absent now will still be absent in fifteen seconds, so this is
   * a `NotFoundError` (retryable: false) and BullMQ discards the message instead
   * of replaying it three times. The normal cause is a message that outlived its
   * row — a truncated test database, or a manual deletion.
   */
  if (!row) throw new NotFoundError(`Job row ${jobId} not found.`);

  if (row.projectId && row.projectId !== parsed.data.projectId) {
    // Mismatched ids mean the payload is not describing this job. Refusing is a
    // tenant-isolation guarantee (§34), and no retry can change the comparison.
    throw new ForbiddenError("Job payload project does not match the job record.");
  }

  const result = await executeScriptGeneration({
    userId: row.userId,
    projectId: parsed.data.projectId,
    jobId,
    feedback: parsed.data.feedback ?? null,
    traceId,
  });

  return {
    scriptId: result.scriptId,
    versionId: result.versionId,
    version: result.version,
    wordCount: result.wordCount,
    estimatedDurationSeconds: result.estimatedDurationSeconds,
  };
};

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
import { executeScriptGeneration } from "@/lib/scripts/service";
import type { JobHandler } from "@/worker/types";

const PayloadSchema = z.object({
  projectId: z.string().uuid(),
  feedback: z.string().max(1_000).optional(),
});

export const scriptHandler: JobHandler = async ({ jobId, payload, traceId }) => {
  const parsed = PayloadSchema.safeParse(payload);
  if (!parsed.success) {
    // Not retryable: a malformed payload is malformed on every attempt.
    throw new Error(
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
  if (!row) throw new Error(`Job row ${jobId} not found.`);

  if (row.projectId && row.projectId !== parsed.data.projectId) {
    throw new Error("Job payload project does not match the job record.");
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

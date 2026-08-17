/**
 * Research job handler (§7, §10).
 *
 * Thin by design. The payload is validated, the owner is resolved from the `jobs`
 * row rather than trusted from the payload, and the work is delegated to
 * `executeResearchRun`. Keeping the handler this small is what lets the run logic
 * be exercised by integration tests without a live queue.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { executeResearchRun } from "@/lib/research/service";
import type { JobHandler } from "@/worker/types";

const PayloadSchema = z.object({
  runId: z.string().uuid(),
  channelId: z.string().uuid(),
});

export const researchHandler: JobHandler = async ({
  jobId,
  payload,
  traceId,
}) => {
  const parsed = PayloadSchema.safeParse(payload);
  if (!parsed.success) {
    // A typed error so `shouldRetry` sees `retryable: false`. A malformed
    // payload will be malformed on every attempt; a bare `Error` would be read
    // as a possible transient fault and replayed for the full retry budget.
    throw new ValidationError(
      `Invalid research payload: ${parsed.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    );
  }

  // The user id comes from the job row, which only the API can write. A payload
  // arriving over Redis is data, not an authorisation (§34).
  const rows = await db
    .select({ userId: jobs.userId, channelId: jobs.channelId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);

  const row = rows[0];
  /**
   * `NotFoundError` is `retryable: false`, so BullMQ discards this rather than
   * replaying it three times with exponential backoff: a row that is missing now
   * cannot appear later. The usual cause is a queued message that outlived its
   * row — a truncated database, or a manual deletion.
   */
  if (!row) throw new NotFoundError(`Job row ${jobId} not found.`);

  if (row.channelId && row.channelId !== parsed.data.channelId) {
    // The payload is not describing this job. Refusing is a tenant-isolation
    // guarantee (§34), and no retry changes the comparison.
    throw new ForbiddenError("Job payload channel does not match the job record.");
  }

  const result = await executeResearchRun({
    userId: row.userId,
    channelId: parsed.data.channelId,
    runId: parsed.data.runId,
    jobId,
    traceId,
  });

  return {
    runId: parsed.data.runId,
    resultCount: result.resultCount,
    ideaCount: result.ideaCount,
    sources: result.sources,
  };
};

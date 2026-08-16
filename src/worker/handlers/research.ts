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
    // Not retryable: a malformed payload will be malformed on every attempt.
    throw new Error(
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
  if (!row) throw new Error(`Job row ${jobId} not found.`);

  if (row.channelId && row.channelId !== parsed.data.channelId) {
    throw new Error("Job payload channel does not match the job record.");
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

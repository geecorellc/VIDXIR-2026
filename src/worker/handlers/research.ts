/**
 * Research job handler (§7, §10; Phase 11 §4).
 *
 * Thin by design. The payload is validated, the owner is resolved from the `jobs`
 * row rather than trusted from the payload, and the work is delegated to
 * `executeResearchRun`. Keeping the handler this small is what lets the run logic
 * be exercised by integration tests without a live queue.
 *
 * Since Phase 11 a payload may carry a `sourceVideoId` instead of a `channelId`
 * (§4: researching a pasted link requires no connected channel), and since §1C it
 * may carry neither and set `mode: "description"` instead. All three fields are
 * optional in the schema and the *combination* is what is validated, so a payload
 * that identifies no seed at all is refused rather than silently researching
 * nothing.
 *
 * `mode` says which seed to expect; it does not carry the seed. The description
 * itself lives on the run row, because it is user prose that reaches a model and the
 * copy that gets used must be the one the authorising request wrote (§34).
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { executeResearchRun } from "@/lib/research/service";
import { isValidVideoId } from "@/lib/youtube/url";
import type { JobHandler } from "@/worker/types";

/** The link forms `parseYouTubeLink` produces. Mirrored so the payload is typed. */
const LINK_FORMS = [
  "watch",
  "short_link",
  "shorts",
  "embed",
  "live",
  "legacy_v",
  "bare_id",
] as const;

const PayloadSchema = z.object({
  runId: z.string().uuid(),
  channelId: z.string().uuid().optional(),
  /**
   * Re-validated against YouTube's id shape here, not merely length-checked.
   *
   * The id was validated in the request that created this job, but a payload
   * arriving over Redis is data and not an authorisation (§34) — and this id is
   * about to be interpolated into a Google API call.
   */
  sourceVideoId: z
    .string()
    .refine(isValidVideoId, "not a YouTube video id")
    .optional(),
  linkForm: z.enum(LINK_FORMS).optional(),
  /**
   * Which entry path created this run (§1C).
   *
   * Only `"description"` is meaningful — the other two identify themselves by
   * carrying a `channelId` or a `sourceVideoId`. This exists so a description run,
   * whose payload carries no seed of its own, is still a payload that *says* what it
   * is instead of one recognised by the absence of everything else.
   */
  mode: z.literal("description").optional(),
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

  const { runId, channelId, sourceVideoId, linkForm, mode } = parsed.data;

  if (!channelId && !sourceVideoId && mode !== "description") {
    throw new ValidationError(
      "Invalid research payload: needs a channelId, a sourceVideoId or " +
        'mode "description".',
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

  if (row.channelId && row.channelId !== channelId) {
    // The payload is not describing this job. Refusing is a tenant-isolation
    // guarantee (§34), and no retry changes the comparison. This also refuses a
    // payload that claims to be channel-less on a job row that has a channel,
    // which would otherwise be a way to research a channel's niche through the
    // public credential path.
    throw new ForbiddenError("Job payload channel does not match the job record.");
  }

  const result = await executeResearchRun({
    userId: row.userId,
    // Only the job row's channel is passed on. The payload's was checked against
    // it above; using the row means the authorisation and the scope are the same
    // value rather than two that agree.
    channelId: row.channelId,
    runId,
    sourceVideoId: sourceVideoId ?? null,
    linkForm,
    jobId,
    traceId,
  });

  return {
    runId,
    resultCount: result.resultCount,
    ideaCount: result.ideaCount,
    sources: result.sources,
  };
};

/**
 * POST /api/experiments/:id/observations — record per-arm figures (Phase 9 §8).
 *
 * This endpoint exists because **YouTube does not give Tally the data.** The
 * Analytics API v2 exposes no thumbnail impressions and no impression CTR — those
 * live only in Studio's own A/B feature — so there is no provider ingest that can
 * fill these rows. Rather than derive a plausible number (§6 forbids it) or leave
 * the feature inert, the measurement is accepted from the operator with its source
 * recorded on every row, so a reader can always tell where a figure came from.
 *
 * `source` cannot be `provider`: nothing arriving through this route came from
 * YouTube, and allowing a client to label it that way would let a request
 * launder a hand-typed number into what the UI presents as provider data.
 *
 * Idempotent: each `(arm, date)` upserts, and the arms' totals are recomputed
 * from the observation rows rather than incremented, so posting the same day
 * twice converges (§5).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { assertUuid, handle, parseJson, requireUser } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import {
  decide,
  getExperiment,
  recordObservations,
} from "@/lib/analytics/experiments";

interface RouteParams {
  params: Promise<{ experimentId: string }>;
}

/**
 * A figure is nullable, and null means "not measured" rather than zero.
 *
 * `.nullish()` rather than `.optional()`: a JSON round-trip that turns an explicit
 * null into an absent key should not change the meaning of the row.
 */
const Count = z.number().int().min(0).max(1_000_000_000).nullish();

const BodySchema = z.object({
  observations: z
    .array(
      z.object({
        armId: z.string().uuid(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
          .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`)), {
            message: "must be a real date",
          }),
        impressions: Count,
        clicks: Count,
        views: Count,
      }),
    )
    .min(1)
    .max(400),
  /**
   * How the figures were obtained. `provider` is absent by construction — see the
   * module comment.
   */
  source: z.enum(["derived_views_impressions", "provider_unsupported"]),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  return handle(request, async () => {
    const { user, log } = await requireUser();
    const { experimentId } = await params;
    assertUuid(experimentId, "experimentId");

    const body = await parseJson(request, BodySchema);
    await enforce(rules().read, `experiments:${user.id}`);

    const experiment = await getExperiment(user.id, experimentId);
    if (!experiment) throw new ForbiddenError("Test not found or not accessible.");
    if (experiment.status !== "running") {
      throw new ValidationError(
        `Observations can only be recorded while a test is running; this one is ${experiment.status}.`,
      );
    }

    /**
     * Clicks above impressions is impossible and would produce a CTR over 100%,
     * which the winner policy would then rank as a leader. Rejected at the edge
     * rather than stored and rationalised later.
     */
    for (const observation of body.observations) {
      if (
        observation.impressions !== null &&
        observation.impressions !== undefined &&
        observation.clicks !== null &&
        observation.clicks !== undefined &&
        observation.clicks > observation.impressions
      ) {
        throw new ValidationError(
          "Clicks cannot exceed impressions for the same day.",
        );
      }
    }

    const result = await recordObservations(
      user.id,
      experimentId,
      body.observations.map((observation) => ({
        armId: observation.armId,
        date: new Date(`${observation.date}T00:00:00.000Z`),
        impressions: observation.impressions ?? null,
        clicks: observation.clicks ?? null,
        views: observation.views ?? null,
        source: body.source,
      })),
    );

    log.info("experiment observations recorded", {
      experimentId,
      written: result.written,
      // Non-zero means arm ids from outside this experiment were posted; the
      // service dropped them rather than storing them.
      skipped: result.skipped,
    });

    const updated = await getExperiment(user.id, experimentId);
    return {
      ...result,
      // The standing after the write, so a caller sees whether the test is now
      // decidable without a second request — and sees `insufficient_data` when it
      // is not.
      standing: updated ? decide(updated) : null,
    };
  });
}

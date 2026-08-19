/**
 * GET   /api/experiments/:id — a test and its current standing (Phase 9 §10)
 * PATCH /api/experiments/:id — start it, or stop it
 *
 * The GET returns the arms' figures *and* the decision the policy would reach
 * right now, including `insufficient_data`. Showing the numbers without showing
 * that they are not yet conclusive is how a UI ends up implying a winner the data
 * does not support (§10).
 *
 * The PATCH accepts `start` and `cancel`. It deliberately does **not** accept a
 * winner: `outcome` and `winningArmId` are written only by the server-side policy
 * in `concludeExperiment`, so a client cannot select itself into the winning
 * thumbnail (§9).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { handle, assertUuid, parseJson, requireUser } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { ForbiddenError } from "@/lib/errors";
import {
  cancelExperiment,
  decide,
  getExperiment,
  startExperiment,
} from "@/lib/analytics/experiments";

interface RouteParams {
  params: Promise<{ experimentId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  return handle(request, async () => {
    const { user } = await requireUser();
    const { experimentId } = await params;
    assertUuid(experimentId, "experimentId");

    await enforce(rules().read, `experiments:${user.id}`);

    const experiment = await getExperiment(user.id, experimentId);
    // 403 rather than 404 for a foreign id: a split would reveal which ids exist.
    if (!experiment) throw new ForbiddenError("Test not found or not accessible.");

    return {
      experiment,
      /**
       * Computed, not stored — this is the standing *now*, which for a running
       * test is usually `insufficient_data`. The stored `outcome` on the
       * experiment is the concluded one, and the two are returned separately so
       * the UI never presents a provisional read as a final result.
       */
      standing: decide(experiment),
    };
  });
}

const PatchSchema = z.object({
  action: z.enum(["start", "cancel"]),
});

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  return handle(request, async () => {
    const { user, log } = await requireUser();
    const { experimentId } = await params;
    assertUuid(experimentId, "experimentId");

    const body = await parseJson(request, PatchSchema);
    await enforce(rules().mutation, `experiments:${user.id}`);

    const experiment =
      body.action === "start"
        ? await startExperiment(user.id, experimentId)
        : await cancelExperiment(user.id, experimentId);

    log.info("thumbnail experiment updated", {
      experimentId,
      action: body.action,
      status: experiment.status,
    });

    return experiment;
  });
}

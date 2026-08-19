/**
 * GET  /api/experiments — thumbnail tests for a channel (Phase 9 §8)
 * POST /api/experiments — start a test on an already-published video
 *
 * Gated on the `thumbnailAbTest` feature, read from the persisted subscription
 * rather than from anything the client sent (§12). The gate is **read-only**: this
 * route resolves a tier, it never writes one, and Phase 9 changes no part of the
 * Phase 8 subscription architecture (§7).
 *
 * Creating a test does not touch YouTube and does not change the video's live
 * thumbnail. It records which existing variants are being compared; the winner is
 * derived server-side from stored observations, and applying one is a separate,
 * explicit act (§8, §9).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  currentTier,
  handle,
  parseJson,
  parseQuery,
  requireChannelAccess,
  requireOnboarded,
  requireUser,
} from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { requireFeature } from "@/lib/plans/enforce";
import { createExperiment, listExperiments } from "@/lib/analytics/experiments";

const GetSchema = z.object({
  channelId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export async function GET(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireUser();
    const { channelId, limit } = parseQuery(request, GetSchema);

    const access = await requireChannelAccess(user.id, channelId);
    await enforce(rules().read, `experiments:${user.id}`);

    const experiments = await listExperiments(user.id, access.id, limit);
    return { channelId: access.id, experiments };
  });
}

/**
 * The body carries which variants to compare and which is currently live.
 *
 * Note what it cannot carry: no CTR, no impressions, no winner, no tier, no
 * channel id. Every one of those is derived server-side, because a client that
 * could supply them could declare itself the winner (§9, §12).
 */
const PostSchema = z.object({
  publishedVideoId: z.string().uuid(),
  variantIds: z.array(z.string().uuid()).min(2).max(4),
  controlVariantId: z.string().uuid(),
  /**
   * Optional threshold overrides. Only ever *raise* the bar in practice —
   * `createExperiment` validates them, and the frozen copy on the row is what the
   * decision is made against so a later change cannot rewrite a past conclusion.
   */
  policy: z
    .object({
      minImpressionsPerArm: z.number().int().min(1).max(10_000_000).optional(),
      minObservationDays: z.number().int().min(1).max(365).optional(),
      minRelativeLift: z.number().min(0).max(10).optional(),
    })
    .optional(),
});

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { user, log } = await requireOnboarded();
    const body = await parseJson(request, PostSchema);

    // Read from the database, never from the request (§12).
    const tier = await currentTier(user.id);
    requireFeature(tier, "thumbnailAbTest");

    await enforce(rules().mutation, `experiments:${user.id}`);

    // Ownership of the video and of every variant is enforced inside
    // `createExperiment`, in SQL, with the tenant predicate on each query.
    const experiment = await createExperiment({
      userId: user.id,
      publishedVideoId: body.publishedVideoId,
      variantIds: body.variantIds,
      controlVariantId: body.controlVariantId,
      policy: body.policy,
    });

    log.info("thumbnail experiment created", {
      experimentId: experiment.id,
      channelId: experiment.channelId,
      arms: experiment.arms.length,
    });

    return experiment;
  });
}

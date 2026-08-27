/**
 * POST /api/video/build — build the video for a project (§10, §23, §42).
 *
 * Returns once the first stage is queued. The response carries a job id and the
 * number of scenes the plan will produce, and nothing else — there is no video
 * yet, and the studio screen re-reads the project's own status from the server
 * while a build is in flight.
 *
 * Three checks happen here rather than in the worker, all for the same reason:
 * the user is present to be told. A missing voice key, a Starter plan, or an
 * unapproved script would each move the project to ASSETS_GENERATING and then
 * straight to FAILED, which reads as a bug rather than as the configuration or
 * plan state it actually is (§37, §48).
 *
 * Since Phase 11 all three depend on *how* the video is being made. A project set
 * to AI video never calls the stock library, so demanding `brollLibrary` and
 * `PEXELS_API_KEY` of it would refuse a build that would have worked — and a stock
 * project must keep working on exactly the entitlements it needed in Phase 10. The
 * mode comes from the project row, resolved by the same function the worker uses,
 * so the request and the render agree about what is about to happen (§9, §19).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  currentTier,
  handle,
  parseJson,
  requireOnboarded,
  requireProjectAccess,
} from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { NotConfiguredError } from "@/lib/errors";
import { requireFeature } from "@/lib/plans/enforce";
import { capabilityStatus } from "@/lib/providers/config";
import { getProject } from "@/lib/projects/service";
import { generationPlanFor } from "@/lib/video/generation-plan";
import { startVideoBuild, videoReadiness } from "@/lib/video/service";

const BodySchema = z.object({
  projectId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  return handle(request, async ({ traceId }) => {
    const { user } = await requireOnboarded();
    const body = await parseJson(request, BodySchema);

    await requireProjectAccess(user.id, body.projectId);

    const tier = await currentTier(user.id);

    /**
     * The stored generation choice, re-resolved (§10 over time).
     *
     * This throws for a stored model whose provider has been disabled or whose
     * credential has been rotated away, and throwing is right: the alternative is
     * queueing a build that will fail in the visuals stage minutes later, having
     * already spent a voiceover. The error names what happened.
     */
    const project = await getProject(user.id, body.projectId);
    const plan = generationPlanFor(project);

    // §23, §19: paid features, read from the persisted subscription and never
    // from anything the client sent (§34). Narration is needed either way; the
    // visual entitlement is the one that depends on the mode.
    requireFeature(tier, "aiVoiceover");
    if (plan.mode === "AI_VIDEO") {
      requireFeature(tier, "aiVideoGeneration");
      if (plan.model?.premium) requireFeature(tier, "premiumVideoModels");
    } else {
      requireFeature(tier, "brollLibrary");
    }

    const readiness = videoReadiness(plan.mode);
    if (!readiness.ready) {
      throw new NotConfiguredError(
        ...blockedProvider(readiness.blocked),
        "A video needs narration audio and footage for every scene; neither can " +
          "be substituted.",
      );
    }

    // Keyed by user: a build spends real provider credit, and the spend follows
    // the account rather than the machine that asked for it.
    await enforce(rules().generation, `video:${user.id}`);

    const { jobId, sceneCount } = await startVideoBuild({
      userId: user.id,
      projectId: body.projectId,
      tier,
      traceId,
    });

    return {
      jobId,
      sceneCount,
      generationMode: plan.mode,
      generationModel: plan.model?.id ?? null,
      videoFormat: plan.format,
      status: "queued" as const,
    };
  });
}

/**
 * Name the unconfigured provider and its variables for the 503 (§48).
 *
 * The variable names come from the capability registry rather than from literals:
 * which ones are missing depends on which visual provider this deployment selected,
 * and naming the wrong one sends the operator to the wrong console. Never a value —
 * `missingEnvVars` is a list of names by construction (§20, §21).
 */
function blockedProvider(blocked: string[]): [string, string[]] {
  if (blocked.includes("voice")) {
    const voice = capabilityStatus("voice");
    return [voice.label, voice.missingEnvVars];
  }
  if (blocked.includes("video_gen")) {
    const gen = capabilityStatus("video_gen");
    return [gen.label, gen.missingEnvVars];
  }
  const visuals = capabilityStatus("visuals");
  return [visuals.label, visuals.missingEnvVars];
}

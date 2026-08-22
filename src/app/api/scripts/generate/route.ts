/**
 * POST /api/scripts/generate — write (or rewrite) the script for a project (§9).
 *
 * Returns once the job is queued, like every other stage. The response carries a
 * job id and the version number the run will produce; it never carries a script,
 * because none exists yet (§42).
 *
 * The AI capability is checked here rather than only in the worker. Without a key
 * the run would move the project to SCRIPT_GENERATING and then immediately to
 * FAILED, which reads as a bug; refusing up front with the variable's name is the
 * honest configuration state §48 asks for.
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
import { aiProviderLabel } from "@/lib/providers/ai";
import { capabilityStatus, isCapabilityAvailable } from "@/lib/providers/config";
import { startScriptGeneration } from "@/lib/scripts/service";

const BodySchema = z.object({
  projectId: z.string().uuid(),
  /** Optional steer for a rewrite. Bounded again in the service. */
  feedback: z.string().max(1_000).optional(),
});

export async function POST(request: NextRequest) {
  return handle(request, async ({ traceId }) => {
    const { user } = await requireOnboarded();
    const body = await parseJson(request, BodySchema);

    await requireProjectAccess(user.id, body.projectId);

    if (!isCapabilityAvailable("ai")) {
      // The variables come from the capability registry rather than a literal:
      // which one is missing depends on whether AI_PROVIDER selects the
      // first-party API or Bedrock, and naming the wrong one sends the operator
      // to the wrong console (§48).
      const ai = capabilityStatus("ai");
      throw new NotConfiguredError(
        aiProviderLabel(),
        ai.missingEnvVars,
        "Scripts are written by Claude; nothing else can stand in for it." +
          (ai.hint ? ` ${ai.hint}` : ""),
      );
    }

    // Keyed by user: a script costs real tokens, and the cost follows the
    // account rather than the machine it was requested from.
    await enforce(rules().generation, `script:${user.id}`);

    const tier = await currentTier(user.id);

    const { jobId, nextVersion } = await startScriptGeneration({
      userId: user.id,
      projectId: body.projectId,
      tier,
      feedback: body.feedback ?? null,
      traceId,
    });

    return {
      jobId,
      version: nextVersion,
      status: "queued" as const,
    };
  });
}

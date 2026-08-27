/**
 * PATCH /api/projects/configure — choose the angle and the generation method
 * (Phase 11 §7, §9, §10, §16, §19).
 *
 * The step between research and scripting. §7 has the user pick one of the proposed
 * original angles; §9 and §10 have them pick stock footage or a specific AI model
 * and a frame. Both choices land on the project row, so they survive a refresh and
 * the visuals stage reads the same values the user saw (§18, §45).
 *
 * Every validation that matters happens server-side, and each is somebody else's
 * job on purpose:
 *
 *  - the *selection* — mode exists, model is configured, plan includes it — is
 *    `validateSelection`, against the tier read from `subscriptions` (§10, §19).
 *  - the *ownership* — the angle is this user's and belongs to the same channel as
 *    the project — is `configureProject`, inside the transaction that writes it (§34).
 *
 * So a client that posts a model id it saw in a screenshot of somebody's Scale plan
 * gets 402, one that posts a provider this deployment never configured gets 503, and
 * one that posts another tenant's idea id gets 403. None of the three stores
 * anything.
 *
 * PATCH rather than POST: this modifies one existing project and is idempotent —
 * sending the same body twice leaves the same row.
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
import { ValidationError } from "@/lib/errors";
import { configureProject } from "@/lib/projects/service";
import { validateSelection } from "@/lib/video/generation-plan";

const BodySchema = z.object({
  projectId: z.string().uuid(),
  /** The chosen angle. Optional: the generation method can be changed alone. */
  ideaId: z.string().uuid().optional(),
  /**
   * `STOCK` or `AI_VIDEO`, as a plain bounded string.
   *
   * Not a `z.enum` of the mode union, deliberately: `validateSelection` owns that
   * decision and produces the message that names both options, and duplicating the
   * enum here would mean two places to update and a less useful 400 from this one.
   */
  mode: z.string().max(32).optional(),
  model: z.string().max(64).nullable().optional(),
  format: z.string().max(16).optional(),
});

export async function PATCH(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    await enforce(rules().mutation, `configure:${user.id}`);
    const body = await parseJson(request, BodySchema);

    // Ownership before anything else reads the row (§34). `configureProject`
    // re-queries with the same predicate — this is the early, cheap refusal.
    await requireProjectAccess(user.id, body.projectId);

    if (
      body.ideaId === undefined &&
      body.mode === undefined &&
      body.format === undefined
    ) {
      throw new ValidationError(
        "Choose an angle or a generation method to save.",
      );
    }

    /**
     * A format change on its own is refused rather than half-applied.
     *
     * The frame is not independent of the model — a model that generates only
     * landscape cannot serve a portrait project — and `validateSelection` is what
     * checks the pair. Accepting a bare format would write a combination nothing had
     * validated, which `generationPlanFor` would then reject at render time (§16).
     */
    if (body.mode === undefined && body.format !== undefined) {
      throw new ValidationError(
        "Choose the generation method along with the video format.",
        { field: "mode" },
      );
    }

    const tier = await currentTier(user.id);

    const selection =
      body.mode === undefined
        ? null
        : validateSelection({
            mode: body.mode,
            model: body.model ?? null,
            format: body.format ?? null,
            tier,
          });

    const project = await configureProject({
      userId: user.id,
      projectId: body.projectId,
      ideaId: body.ideaId,
      // Spread rather than `?? undefined`: undefined means "leave it", and null is a
      // real value for `generationModel` (stock mode clears it).
      ...(selection === null
        ? {}
        : {
            generationMode: selection.generationMode,
            generationModel: selection.generationModel,
            videoFormat: selection.videoFormat,
          }),
    });

    return { project };
  });
}

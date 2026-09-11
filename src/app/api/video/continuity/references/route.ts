/**
 * Continuity reference stills (Phase 12 §5, §6).
 *
 *  - `GET  /api/video/continuity/references?projectId=…` — what is stored, and what
 *    generating would produce, with a signed URL per stored still.
 *  - `POST /api/video/continuity/references` — queue the generation of the missing ones.
 *
 * **Why this is a user action rather than a pipeline step.** Every branded model can
 * draw a still, so the pipeline *could* generate the whole cast during the scene plan.
 * It deliberately does not, and still does not now that some models can consume a still.
 * Only Tal 3.0 and Tal 3.1 declare `capabilities.referenceImages`, so on every other
 * model a still's only consumer is the human who reviews the cast before eighty scenes
 * are paid for — and spending up to thirty generations per build on something the
 * project's own backend cannot be handed would be cost with no output, which §21 forbids.
 * Even on those two the review is the point: a still nobody approved is a wrong coat
 * propagated into eighty scenes instead of one. `executeReferenceImages` is the stage
 * either path runs, so the seam stays the enqueue rather than the work.
 *
 * Three properties, each a rule the mandate names:
 *
 *  1. **The GET spends nothing.** It reads the bible, the stored assets and the plan.
 *     Signing a URL is a local HMAC, not a request. A page that generated on view would
 *     let a refresh bill the tenant (§21).
 *  2. **The POST never generates inline.** It queues, and the worker spends. A request
 *     handler that waited on thirty image generations would hold a connection for
 *     minutes and time out somewhere with the money already gone.
 *  3. **Which entities are drawn is decided server-side, from the stored bible.** The
 *     body carries a project id and nothing else. An entity list from a client would be
 *     a way to bill a workspace for generations nobody selected.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  currentTier,
  handle,
  parseJson,
  parseQuery,
  requireOnboarded,
  requireProjectAccess,
} from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { referenceImagePlan } from "@/lib/continuity/service";
import { imagePriceFor } from "@/lib/credits/pricing";
import { ConflictError, ValidationError } from "@/lib/errors";
import { getProject } from "@/lib/projects/service";
import { assertImageQuality, isGenerationMode } from "@/lib/providers/video-gen";
import { signedReadUrl } from "@/lib/storage";
import {
  generationPlanFor,
  type GenerationChoice,
} from "@/lib/video/generation-plan";
import { enqueueReferenceImages } from "@/lib/video/service";

const QuerySchema = z.object({ projectId: z.string().uuid() });
const BodySchema = z.object({ projectId: z.string().uuid() });

export async function GET(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    const { projectId } = parseQuery(request, QuerySchema);

    await requireProjectAccess(user.id, projectId);
    await enforce(rules().read, `continuity-references:${user.id}`);

    const project = await getProject(user.id, projectId);
    const plan = await referenceImagePlan({
      userId: user.id,
      project: {
        projectId,
        channelId: project.channelId,
        generationMode: isGenerationMode(project.generationMode)
          ? project.generationMode
          : null,
        tier: await currentTier(user.id),
      },
    });

    /**
     * Signed per still, in parallel.
     *
     * The bucket is private, so a stored key is not viewable on its own — the same
     * arrangement every other asset in Tally is served under. A failure to sign one
     * URL leaves that still without a preview rather than failing the whole panel.
     */
    const stored = await Promise.all(
      plan.existing.map(async (reference) => ({
        assetId: reference.assetId,
        kind: reference.kind,
        entityId: reference.entityId,
        name: reference.entityName,
        width: reference.width,
        height: reference.height,
        createdAt: reference.createdAt.toISOString(),
        url: await signedReadUrl(reference.storageKey).catch(() => null),
      })),
    );

    return {
      projectId,
      level: plan.context.plan.level,
      active: plan.context.active,
      reason: plan.reason || plan.context.plan.reason,
      references: stored,
      /**
       * What a POST would draw. The prompt is included because it is the honest
       * answer to "why does she look like that" — and because a user who can read it
       * before spending can fix the bible instead of paying for a wrong reference.
       */
      pending: plan.wanted.map((entry) => ({
        kind: entry.kind,
        entityId: entry.entityId,
        name: entry.name,
        prompt: entry.prompt,
      })),
      /**
       * What the POST would cost, before it is pressed (§20).
       *
       * A *total*, unlike the scene picker's per-unit figure, and honestly so: the
       * entity count is known here — it is `pending.length` — where a scene count is not
       * known until the script exists. So this is the one place a total is exact rather
       * than a guess presented as a price.
       *
       * Null when the project cannot be quoted at all: stock mode, an unconfigured
       * model, or a legacy model that draws no stills. A zero would read as "free", and
       * the panel needs to distinguish "nothing to draw" from "no price to quote".
       */
      cost: referenceCost(project, plan.wanted.length),
    };
  });
}

/**
 * The credit cost of drawing this project's outstanding references (§5, §20).
 *
 * Resolves the model and the image resolution exactly as `executeReferenceImages` does —
 * `generationPlanFor`, then `assertImageQuality` against the project's video quality —
 * so the quote is the figure the stage will charge rather than a parallel calculation
 * that could drift from it. `imagePriceFor` is the same pure function the charge path
 * calls (§9).
 *
 * Synchronous and pure, taking the project row the GET has already read: everything it
 * needs is on that row plus the model registry, so a second `getProject` would be a
 * query for data already in hand.
 *
 * Returns null rather than throwing, because a GET that reads the panel must not fail
 * for a reason the panel is already reporting: `plan.reason` and the `pending` list
 * already say a stock-footage project has nothing to draw, and a 400 here would replace
 * that readable answer with an error.
 */
function referenceCost(
  choice: GenerationChoice,
  entities: number,
): {
  perImage: number;
  total: number;
  quality: string;
  entities: number;
} | null {
  try {
    const plan = generationPlanFor(choice);
    if (plan.mode !== "AI_VIDEO" || !plan.model) return null;
    if (!plan.model.capabilities.imageGeneration) return null;

    // The same preference-not-assertion the stage uses: a project at 2K whose model
    // draws stills only to 1080p is quoted 1080p, which is what it will be charged.
    const quality = assertImageQuality(
      plan.model,
      plan.model.capabilities.imageQualities.includes(plan.quality)
        ? plan.quality
        : null,
    );
    const perImage = imagePriceFor(plan.model.id, quality);

    return { perImage, total: perImage * entities, quality, entities };
  } catch {
    /**
     * A model whose credential was rotated away throws `NotConfiguredError` here. The
     * POST refuses that project with the message an operator needs; the GET's job is to
     * render the panel, and a missing price is a smaller loss than a blank screen.
     */
    return null;
  }
}

export async function POST(request: NextRequest) {
  return handle(request, async ({ traceId }) => {
    const { user } = await requireOnboarded();
    const body = await parseJson(request, BodySchema);

    await requireProjectAccess(user.id, body.projectId);

    const tier = await currentTier(user.id);
    const project = await getProject(user.id, body.projectId);

    /**
     * The mode and model are re-resolved here, before the rate limit is spent and
     * before anything is queued.
     *
     * `generationPlanFor` throws when the project asked for AI video and its model is
     * no longer configured, which is the message the user needs — a queued job that
     * failed for the same reason would say the same thing four minutes later.
     */
    const plan = generationPlanFor(project);
    if (plan.mode !== "AI_VIDEO" || !plan.model) {
      throw new ValidationError(
        "This video uses stock footage. Reference images illustrate a story bible, " +
          "which only AI-generated video has.",
        { field: "projectId" },
      );
    }

    if (!plan.model.capabilities.imageGeneration) {
      // Reachable only for a legacy model a project stored before it was retired
      // (§17). Named with the model's own label, which is the customer-facing one.
      throw new ValidationError(
        `${plan.model.label} does not generate still images. Switch this video to ` +
          `another model to draw its reference images.`,
        { field: "generationModel" },
      );
    }

    const wanted = await referenceImagePlan({
      userId: user.id,
      project: {
        projectId: body.projectId,
        channelId: project.channelId,
        generationMode: isGenerationMode(project.generationMode)
          ? project.generationMode
          : null,
        tier,
      },
    });

    /**
     * Refused rather than queued as a no-op.
     *
     * A job that generates nothing still shows up in the studio's job list as work
     * that happened, and "queued" would be the wrong answer to a request that will
     * produce no image. The reason from the plan says which of the several nothings
     * this is — no bible, no visual facts, or everything already drawn.
     */
    if (wanted.wanted.length === 0) {
      throw new ConflictError(
        wanted.reason || wanted.context.plan.reason,
      );
    }

    // `generation`, not `mutation`: this queues paid provider calls, one per entity.
    await enforce(rules().generation, `continuity-references:${user.id}`);

    const queued = await enqueueReferenceImages({
      userId: user.id,
      projectId: body.projectId,
      tier,
      traceId,
    });

    if (!queued) {
      throw new ConflictError(
        "Reference images are already being drawn for this video. Wait for that to " +
          "finish.",
      );
    }

    return {
      projectId: body.projectId,
      status: "queued" as const,
      /** How many stills the queued job will draw. Not a promise that all succeed. */
      pending: wanted.wanted.length,
    };
  });
}

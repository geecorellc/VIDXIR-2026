/**
 * POST /api/projects/from-youtube — start a video from a pasted link
 * (Phase 11 §4, §6, §9, §10, §16, §19).
 *
 * The one route that makes link mode a mode. It creates a **channel-less** project
 * and enqueues research seeded by the pasted video, which is what §4 means by "must
 * NOT require connecting a YouTube channel to research or generate": nothing here
 * touches `channels`, and `requireChannelAccess` is deliberately absent.
 *
 * Ordering is the substance of this handler:
 *
 *  1. Parse the URL server-side. §4: an id from a client is not an id.
 *  2. Validate the generation selection against the tier read from the database.
 *     `validateSelection` refuses an unknown model, a model this deployment has
 *     not configured, and a model above the caller's plan — before any row exists,
 *     so a refused request costs nothing and stores nothing (§10, §19, §21).
 *  3. Charge the monthly video allowance, atomically, inside `createProject`.
 *  4. Enqueue the research run scoped to the new project.
 *
 * The project is created *before* the angles exist, which is the shape link mode
 * requires: the project is what scopes the research job's duplicate guard, since
 * there is no channel to scope it by. The user picks an angle afterwards through
 * `/api/projects/configure`.
 *
 * §22: the pasted video is stored as `sourceVideoId` for provenance and read by
 * nothing that generates. No download, no transcript copy, no title copy.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  currentTier,
  handle,
  parseJson,
  requireOnboarded,
} from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { assertCanStartVideo } from "@/lib/plans/enforce";
import { planByTier } from "@/lib/plans";
import { createProject } from "@/lib/projects/service";
import { startLinkResearchRun } from "@/lib/research/service";
import { validateSelection } from "@/lib/video/generation-plan";
import { parseYouTubeLink } from "@/lib/youtube/url";

/**
 * Shortest and longest script target accepted.
 *
 * The same 60-1,200s band `contextFromSource` clamps a source's own duration to, so
 * a user-chosen target and a source-derived one cannot disagree about what the
 * pipeline can render.
 */
const MIN_TARGET_SECONDS = 60;
const MAX_TARGET_SECONDS = 1_200;

const BodySchema = z.object({
  /** The pasted link. Shape-validated by `parseYouTubeLink`, not by `.url()`. */
  url: z.string().trim().min(1).max(2_048),
  /**
   * The generation method, optional at this point.
   *
   * Omitted means "decide later": the project stores no mode, `generationPlanFor`
   * resolves that to stock in landscape, and the user can still change it through
   * `/api/projects/configure` while the project is in a configurable state. Sending
   * it here is the shortcut for a user who already picked in the paste screen.
   */
  mode: z.string().max(32).optional(),
  model: z.string().max(64).nullable().optional(),
  format: z.string().max(16).optional(),
  /**
   * The resolution tier (Phase 12 §4). Null or omitted means "the model's default".
   *
   * Ignored unless `mode` is present, since `validateSelection` is the only thing
   * that decides whether a tier is one the chosen model actually offers.
   */
  quality: z.string().max(16).nullable().optional(),
  targetDurationSeconds: z.coerce
    .number()
    .int()
    .min(MIN_TARGET_SECONDS)
    .max(MAX_TARGET_SECONDS)
    .optional(),
});

export async function POST(request: NextRequest) {
  return handle(request, async ({ traceId }) => {
    const { user } = await requireOnboarded();
    const body = await parseJson(request, BodySchema);

    // Server-side, before anything else can use it (§4, §21).
    const link = parseYouTubeLink(body.url);

    // Starting a video consumes the month's allowance and enqueues real YouTube
    // quota spend. Bounded on the mutation rule; the research rule then bounds the
    // run itself inside `startLinkResearchRun`'s own path.
    await enforce(rules().mutation, `from-youtube:${user.id}`);

    const tier = await currentTier(user.id);

    /**
     * §19, and note which entitlement is *not* checked.
     *
     * Pasting a link is research, and research is included on every tier — Starter
     * lists "research + script tools" — so there is no new feature flag for link
     * mode. What the plan gates is the expensive part: `validateSelection` refuses
     * AI video and premium models against the tier below, and the monthly video
     * allowance is charged in `createProject`. Inventing a `youtubeLinkResearch`
     * entitlement would have paywalled a capability the existing plans already
     * grant, which §19 asks be designed consistently rather than added by reflex.
     */
    const selection =
      body.mode === undefined
        ? null
        : validateSelection({
            mode: body.mode,
            model: body.model ?? null,
            format: body.format ?? null,
            quality: body.quality ?? null,
            tier,
          });

    // The good error before any work happens. The atomic guarantee is the
    // conditional counter increment inside `createProject` (§13).
    await assertCanStartVideo(user.id, tier);

    const project = await createProject({
      userId: user.id,
      // §4. The whole point: no channel, and none required.
      channelId: null,
      /**
       * A placeholder, replaced by the chosen angle's title in `configureProject`.
       *
       * Not the source video's title. Naming a new project after somebody else's
       * video is the first step of the copying §22 forbids, and it would be wrong
       * on screen the moment an original angle is selected.
       */
      title: `New video from a YouTube link (${link.videoId})`,
      origin: "youtube_link",
      targetDurationSeconds: body.targetDurationSeconds ?? null,
      generationMode: selection?.generationMode ?? null,
      generationModel: selection?.generationModel ?? null,
      videoFormat: selection?.videoFormat ?? null,
      videoQuality: selection?.videoQuality ?? null,
      sourceVideoId: link.videoId,
      maxVideosPerMonth: planByTier(tier).maxVideosPerMonth,
    });

    /**
     * Enqueue, and let a queue failure surface as a failed request.
     *
     * The project row survives a failed enqueue on purpose: the allowance has been
     * charged, and silently deleting the row would hide that. The user retries
     * research on the project that exists rather than starting a second one.
     */
    const { runId, jobId } = await startLinkResearchRun({
      userId: user.id,
      videoId: link.videoId,
      tier,
      projectId: project.id,
      linkForm: link.form,
      traceId,
    });

    return {
      project,
      runId,
      jobId,
      sourceVideoId: link.videoId,
      canonicalUrl: link.canonicalUrl,
      status: "queued" as const,
    };
  });
}

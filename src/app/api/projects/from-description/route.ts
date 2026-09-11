/**
 * POST /api/projects/from-description — start a video from a described idea (§1C).
 *
 * The third entry path, and the sibling of `/api/projects/from-youtube`. Same shape,
 * different seed: the user types what they want to make instead of pasting somebody
 * else's video, and research is then performed to inform it rather than to imitate
 * anything. Like link mode it creates a **channel-less** project and requires no
 * connected YouTube channel — a user who has not connected one can still describe an
 * idea, research it and generate.
 *
 * Ordering is the substance of this handler, and it is deliberately the link route's:
 *
 *  1. Bound the description's length and normalise its whitespace. It reaches a model
 *     later, so its size is capped here rather than wherever it is read.
 *  2. Validate the generation selection against the tier read from the database.
 *     `validateSelection` refuses an unknown model, a model this deployment has not
 *     configured, and a model above the caller's plan — before any row exists, so a
 *     refused request costs nothing and stores nothing (§10, §19, §21).
 *  3. Charge the monthly video allowance, atomically, inside `createProject`.
 *  4. Enqueue the research run scoped to the new project.
 *
 * What this route notably does *not* do is interpret the description. That is a
 * Claude call of unbounded latency and §10 keeps those out of request handlers; the
 * worker does it as the run's first step, so a slow or unconfigured provider shows up
 * as a job the user can watch rather than a request that hangs.
 *
 * The description is stored verbatim on the research run and is never treated as
 * instructions — `interpretDescription` frames it as the subject to classify, and no
 * generation stage receives it as direction.
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
import {
  MAX_DESCRIPTION_CHARS,
  MIN_DESCRIPTION_CHARS,
} from "@/lib/research/description";
import { startDescriptionResearchRun } from "@/lib/research/service";
import { validateSelection } from "@/lib/video/generation-plan";

/**
 * Shortest and longest script target accepted.
 *
 * The same 60-1,200s band the link route accepts and `description.ts` clamps to, so a
 * user-chosen target and an interpreted one cannot disagree about what the pipeline
 * can render.
 */
const MIN_TARGET_SECONDS = 60;
const MAX_TARGET_SECONDS = 1_200;

/** How long a project title taken from a description may be before it is cut. */
const TITLE_PREVIEW_CHARS = 80;

const BodySchema = z.object({
  /**
   * What the user wants to make, in their own words.
   *
   * Whitespace-collapsed before the length check so a paste full of newlines is
   * measured as the prose it is. The minimum exists because "cars" cannot be
   * researched as an idea; the maximum because this string reaches a model, and an
   * unbounded one is an unbounded bill and a prompt of unbounded shape.
   */
  description: z
    .string()
    .transform((value) => value.trim().replace(/\s+/g, " "))
    .pipe(
      z.string().min(MIN_DESCRIPTION_CHARS).max(MAX_DESCRIPTION_CHARS),
    ),
  /**
   * The generation method, optional at this point.
   *
   * Omitted means "decide later": the project stores no mode, `generationPlanFor`
   * resolves that to stock in landscape, and the user can still change it through
   * `/api/projects/configure` while the project is in a configurable state. Sending
   * it here is the shortcut for a user who already picked in the description screen.
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

    // Starting a video consumes the month's allowance and enqueues real YouTube
    // quota spend. Bounded on the mutation rule; the research rule then bounds the
    // run itself inside the research path.
    await enforce(rules().mutation, `from-description:${user.id}`);

    const tier = await currentTier(user.id);

    /**
     * §19, and note which entitlement is *not* checked — the same reasoning as the
     * link route. Describing an idea is research, and research is included on every
     * tier, so there is no new feature flag for this path. What the plan gates is the
     * expensive part: `validateSelection` refuses AI video and premium models against
     * the tier below, and the monthly video allowance is charged in `createProject`.
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
      // §1C, as §4: no channel, and none required.
      channelId: null,
      /**
       * The description, trimmed to a line — replaced by the chosen angle's title in
       * `configureProject`.
       *
       * Unlike link mode there is nothing questionable about using it: these are the
       * user's own words about their own video. It is a placeholder all the same,
       * because a description is not a title and the point of the research is to
       * produce a better one from evidence.
       */
      title: descriptionTitle(body.description),
      origin: "description",
      targetDurationSeconds: body.targetDurationSeconds ?? null,
      generationMode: selection?.generationMode ?? null,
      generationModel: selection?.generationModel ?? null,
      videoFormat: selection?.videoFormat ?? null,
      videoQuality: selection?.videoQuality ?? null,
      // No source video: nothing was pasted, and nothing is being derived from
      // anyone else's upload.
      sourceVideoId: null,
      maxVideosPerMonth: planByTier(tier).maxVideosPerMonth,
    });

    /**
     * Enqueue, and let a queue failure surface as a failed request.
     *
     * The project row survives a failed enqueue on purpose: the allowance has been
     * charged, and silently deleting the row would hide that. The user retries
     * research on the project that exists rather than starting a second one.
     */
    const { runId, jobId } = await startDescriptionResearchRun({
      userId: user.id,
      description: body.description,
      tier,
      projectId: project.id,
      traceId,
    });

    return {
      project,
      runId,
      jobId,
      description: body.description,
      status: "queued" as const,
    };
  });
}

/**
 * A one-line project title from a description.
 *
 * Cut on a word boundary where there is one within range, so the placeholder reads as
 * a truncated sentence rather than a truncated word.
 */
function descriptionTitle(description: string): string {
  if (description.length <= TITLE_PREVIEW_CHARS) return description;

  const cut = description.slice(0, TITLE_PREVIEW_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace > TITLE_PREVIEW_CHARS / 2 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()}…`;
}

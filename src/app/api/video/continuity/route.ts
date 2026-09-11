/**
 * The continuity layer's read/write endpoint (§18, §19, §20).
 *
 *  - `GET  /api/video/continuity?projectId=…` — the resolved level, the story bible,
 *    each scene's committed state, and the latest continuity verdict.
 *  - `PUT  /api/video/continuity` — replace the bible with an operator-edited one.
 *
 * Three properties are worth stating explicitly, because each one is a rule the
 * mandate names:
 *
 *  1. **Nothing here calls a provider or an AI.** A GET is three indexed reads; a PUT
 *     is a validate and an upsert. Planning a bible happens once, inside the scene
 *     plan stage. An endpoint that re-planned on view would let a page refresh spend
 *     provider credit (§21).
 *  2. **Every read and write is owner-scoped in the query.** `requireProjectAccess`
 *     runs first and gives a foreign project id the same 403 as a nonexistent one, and
 *     `lib/continuity/store` then puts the `userId` in every WHERE clause regardless
 *     (§20). Neither is redundant: the guard stops probing, the store is the guarantee.
 *  3. **A PUT marks the bible as human-edited**, which is what stops the next scene
 *     plan overwriting it. Same mechanism as `video_metadata.edited_by_user`.
 *
 * A project with no bible is not an error — it is every project built before this
 * layer existed, plus every stock-footage project. The GET says so in `level` and
 * `reason` rather than 404ing (§25).
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
import { StoryBibleSchema, isEmptyBible } from "@/lib/continuity/bible";
import type { ContinuityLevel } from "@/lib/continuity/config";
import { continuityView } from "@/lib/continuity/read";
import { getBible, saveUserBible } from "@/lib/continuity/store";
import { ValidationError } from "@/lib/errors";

const QuerySchema = z.object({
  projectId: z.string().uuid(),
});

/**
 * The edit body.
 *
 * `StoryBibleSchema` is applied here rather than accepting `unknown` and validating
 * in the store, because this is the only path by which a client-authored bible
 * enters the system — the planner's output is normalised before it is stored. The
 * schema's own bounds (eight characters, eight traits each, 120 characters per trait)
 * are what stop a hand-written bible from becoming an unbounded per-scene prompt cost.
 */
const SaveSchema = z.object({
  projectId: z.string().uuid(),
  bible: StoryBibleSchema,
});

export async function GET(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    const query = parseQuery(request, QuerySchema);

    await requireProjectAccess(user.id, query.projectId);
    await enforce(rules().read, `video-continuity:${user.id}`);

    /**
     * The same reader the video page's server component uses.
     *
     * It re-resolves the level through `resolveFor` — the feature flag, the generation
     * mode, the plan entitlement and the channel's style settings, in that order — so
     * the panel shows the level the *next build* will actually use, including `off` and
     * the reason why, rather than the level this endpoint would prefer.
     */
    const view = await continuityView(
      user.id,
      query.projectId,
      await currentTier(user.id),
    );

    return {
      ...view,
      // Dates cross the wire as ISO strings; the reader keeps them as `Date` for the
      // server component, which formats them itself.
      bibleUpdatedAt: view.bibleUpdatedAt?.toISOString() ?? null,
      check: view.check
        ? { ...view.check, createdAt: view.check.createdAt.toISOString() }
        : null,
    };
  });
}

export async function PUT(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    const body = await parseJson(request, SaveSchema);

    await requireProjectAccess(user.id, body.projectId);
    // `mutation`, not `generation`: this spends a row update, not provider credit.
    await enforce(rules().mutation, `video-continuity-save:${user.id}`);

    /**
     * An empty bible is refused rather than stored.
     *
     * `isEmptyBible` is the gate the whole layer branches on — a stored empty bible
     * would read as "continuity is configured" while constraining nothing, and its
     * `editedByUser` flag would then permanently stop the planner from filling it in.
     * Deleting the bible is a different operation and this endpoint does not offer it.
     */
    if (isEmptyBible(body.bible)) {
      throw new ValidationError(
        "A story bible needs at least one character, place, object or style " +
          "decision. Nothing here would constrain any scene.",
        { field: "bible" },
      );
    }

    const existing = await getBible(user.id, body.projectId);

    /**
     * The level is preserved, not re-resolved.
     *
     * An operator editing the cast must not have the level change underneath them
     * because the channel's content style was adjusted since the bible was planned.
     * When there is no existing row the bible is being authored by hand for a project
     * that has not been planned yet, and `character` is the level that renders every
     * field they can fill in — a narrower one would silently drop their work.
     */
    const level: ContinuityLevel = existing?.level ?? "character";

    /**
     * `saveUserBible`, not `saveBible`.
     *
     * `saveBible` refuses to overwrite a row already flagged as user-edited, which is
     * the protection against a rebuild recasting a corrected video. That refusal is
     * aimed at the planner, so the owner's own edits go through the unconditional
     * write, which sets the flag in the same statement.
     */
    await saveUserBible({
      userId: user.id,
      projectId: body.projectId,
      bible: body.bible,
      level,
    });

    const stored = await getBible(user.id, body.projectId);

    return {
      projectId: body.projectId,
      bible: stored?.bible ?? body.bible,
      editedByUser: true,
      level,
      updatedAt: stored?.updatedAt.toISOString() ?? null,
    };
  });
}

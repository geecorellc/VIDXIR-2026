/**
 * Reading and writing continuity data.
 *
 * Every function here takes a `userId` and puts it in the WHERE clause. Not as
 * defence in depth over some other check — as *the* check. §20's requirement is
 * that a bible, a scene state and a continuity check are never visible to another
 * tenant, and the way this codebase achieves that is by making the owner part of
 * every query rather than by filtering afterwards. A missing row and a row
 * belonging to someone else are therefore indistinguishable here, which is the
 * property `publish/service.ts` documents and relies on.
 *
 * There is no `getBible(projectId)` overload without a user. Adding one is how the
 * guarantee gets lost two refactors later.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { qualityChecks, scenes as scenesTable, storyBibles } from "@/lib/db/schema";
import {
  safeParseStoryBible,
  STORY_BIBLE_VERSION,
  type StoryBible,
} from "@/lib/continuity/bible";
import {
  isContinuityLevel,
  type ContinuityLevel,
} from "@/lib/continuity/config";
import {
  safeParseSceneState,
  type IndexedSceneState,
  type SceneState,
} from "@/lib/continuity/scene-state";
import {
  toQualityFindings,
  type ContinuityReport,
} from "@/lib/continuity/validate";

export interface StoredBible {
  bible: StoryBible;
  level: ContinuityLevel;
  editedByUser: boolean;
  updatedAt: Date;
}

/**
 * Load a project's bible.
 *
 * Returns null when there is none, and **also** when the stored document no longer
 * parses. That second case is deliberate: a bible written by a future schema
 * version must not fail a render (§22), and "no continuity" is a correct, working
 * state that every project had before this layer existed.
 */
export async function getBible(
  userId: string,
  projectId: string,
): Promise<StoredBible | null> {
  const rows = await db
    .select({
      document: storyBibles.document,
      level: storyBibles.level,
      editedByUser: storyBibles.editedByUser,
      updatedAt: storyBibles.updatedAt,
    })
    .from(storyBibles)
    .where(
      and(eq(storyBibles.projectId, projectId), eq(storyBibles.userId, userId)),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const bible = safeParseStoryBible(row.document);
  if (!bible) return null;

  return {
    bible,
    level: isContinuityLevel(row.level) ? row.level : "off",
    editedByUser: row.editedByUser,
    updatedAt: row.updatedAt,
  };
}

/**
 * Write a project's bible, replacing any existing one.
 *
 * Upsert on the unique `project_id` index. `editedByUser` is never set by this
 * path — a generated bible does not claim a human approved it — and a row already
 * marked as user-edited is left alone, so a rebuild cannot silently recast a video
 * someone has already corrected. That mirrors `video_metadata.edited_by_user`.
 *
 * Returns false when an existing user-edited bible was preserved, so the caller can
 * say so rather than reporting a write that did not happen.
 */
export async function saveBible(args: {
  userId: string;
  projectId: string;
  bible: StoryBible;
  level: ContinuityLevel;
  generatedBy: string;
}): Promise<boolean> {
  const existing = await db
    .select({ editedByUser: storyBibles.editedByUser })
    .from(storyBibles)
    .where(
      and(
        eq(storyBibles.projectId, args.projectId),
        eq(storyBibles.userId, args.userId),
      ),
    )
    .limit(1);

  if (existing[0]?.editedByUser) return false;

  await db
    .insert(storyBibles)
    .values({
      projectId: args.projectId,
      userId: args.userId,
      schemaVersion: STORY_BIBLE_VERSION,
      level: args.level,
      document: args.bible,
      generatedBy: args.generatedBy,
    })
    .onConflictDoUpdate({
      target: storyBibles.projectId,
      set: {
        level: args.level,
        document: args.bible,
        schemaVersion: STORY_BIBLE_VERSION,
        generatedBy: args.generatedBy,
        updatedAt: new Date(),
      },
      /**
       * The tenant check on the update half of the upsert.
       *
       * `onConflictDoUpdate` matches on `project_id` alone, because that is the
       * unique index. Without this predicate a caller who knew another tenant's
       * project id could overwrite their bible — the conflict would match and the
       * `userId` in `values` would be ignored. With it, the update touches nothing.
       */
      setWhere: eq(storyBibles.userId, args.userId),
    });

  return true;
}

/** Mark a bible as human-edited, so rebuilds stop overwriting it. */
export async function markBibleEdited(
  userId: string,
  projectId: string,
): Promise<void> {
  await db
    .update(storyBibles)
    .set({ editedByUser: true, updatedAt: new Date() })
    .where(
      and(eq(storyBibles.projectId, projectId), eq(storyBibles.userId, userId)),
    );
}

/**
 * Write a bible the owner authored, unconditionally.
 *
 * The counterpart to `saveBible`, and the only path that may overwrite a row already
 * flagged as user-edited. The flag exists to stop the *planner* recasting a video a
 * human has corrected; it was never meant to stop the human from correcting it twice.
 *
 * Sets `editedByUser` in the same statement rather than in a follow-up update, so
 * there is no window in which an edited bible is stored unflagged and a concurrent
 * scene plan could overwrite it.
 *
 * Tenant-scoped identically to `saveBible`: `setWhere` is what stops a caller who
 * knows another tenant's project id from writing through the unique index.
 */
export async function saveUserBible(args: {
  userId: string;
  projectId: string;
  bible: StoryBible;
  level: ContinuityLevel;
}): Promise<void> {
  await db
    .insert(storyBibles)
    .values({
      projectId: args.projectId,
      userId: args.userId,
      schemaVersion: STORY_BIBLE_VERSION,
      level: args.level,
      document: args.bible,
      generatedBy: "user",
      editedByUser: true,
    })
    .onConflictDoUpdate({
      target: storyBibles.projectId,
      set: {
        level: args.level,
        document: args.bible,
        schemaVersion: STORY_BIBLE_VERSION,
        generatedBy: "user",
        editedByUser: true,
        updatedAt: new Date(),
      },
      setWhere: eq(storyBibles.userId, args.userId),
    });
}

// ---------------------------------------------------------------------------
// Scene state
// ---------------------------------------------------------------------------

/**
 * Every scene's continuity state, ascending by index.
 *
 * Scenes with no state are skipped rather than defaulted, so the graph is built
 * over the scenes that actually have commitments. A partially-planned project
 * therefore validates the part that was planned instead of failing on the rest.
 */
export async function getSceneStates(
  userId: string,
  projectId: string,
): Promise<IndexedSceneState[]> {
  const rows = await db
    .select({
      index: scenesTable.index,
      state: scenesTable.continuityState,
    })
    .from(scenesTable)
    .where(
      and(eq(scenesTable.projectId, projectId), eq(scenesTable.userId, userId)),
    )
    .orderBy(asc(scenesTable.index));

  const out: IndexedSceneState[] = [];
  for (const row of rows) {
    const state = safeParseSceneState(row.state);
    if (state) out.push({ sceneIndex: row.index, state });
  }
  return out;
}

/**
 * Write one scene's continuity state and the prompt block it was built with.
 *
 * Scoped by `(project, user, index)` — the same triple `executeVisuals` already
 * uses to write `visualAssetId`, so a continuity write cannot reach a scene the
 * visuals stage could not.
 */
export async function saveSceneContinuity(args: {
  userId: string;
  projectId: string;
  sceneIndex: number;
  state: SceneState | null;
  continuityPrompt: string | null;
}): Promise<void> {
  await db
    .update(scenesTable)
    .set({
      continuityState: args.state,
      continuityPrompt: args.continuityPrompt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(scenesTable.projectId, args.projectId),
        eq(scenesTable.userId, args.userId),
        eq(scenesTable.index, args.sceneIndex),
      ),
    );
}

/**
 * Increment a scene's regeneration count and return the new value.
 *
 * Read-modify-write in one statement rather than two, because two continuity
 * passes on the same project would otherwise both read 0 and both write 1, and the
 * ceiling that stops a scene being regenerated forever would never be reached.
 */
export async function countRegeneration(args: {
  userId: string;
  projectId: string;
  sceneIndex: number;
}): Promise<number> {
  const rows = await db
    .update(scenesTable)
    .set({
      continuityRegenerations: sql`${scenesTable.continuityRegenerations} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(scenesTable.projectId, args.projectId),
        eq(scenesTable.userId, args.userId),
        eq(scenesTable.index, args.sceneIndex),
      ),
    )
    .returning({ count: scenesTable.continuityRegenerations });

  return rows[0]?.count ?? 0;
}

/** Regeneration counts by scene index, for the ceiling check before spending. */
export async function regenerationCounts(
  userId: string,
  projectId: string,
): Promise<Map<number, number>> {
  const rows = await db
    .select({
      index: scenesTable.index,
      count: scenesTable.continuityRegenerations,
    })
    .from(scenesTable)
    .where(
      and(eq(scenesTable.projectId, projectId), eq(scenesTable.userId, userId)),
    );

  return new Map(rows.map((row) => [row.index, row.count]));
}

// ---------------------------------------------------------------------------
// Continuity checks — the existing quality_checks table
// ---------------------------------------------------------------------------

/**
 * Record a continuity report as a quality check.
 *
 * The existing table, deliberately. `quality_checks` already holds a
 * `pass|warn|fail` verdict and a `{code, severity, message, detail}` findings
 * array, is already indexed by `(project, created_at)`, and is already read by the
 * studio screen — a `continuity_checks` table would have been the same columns
 * under a different name, plus a second thing for the UI to merge.
 *
 * `assetLicenses` is left at its default: continuity says nothing about licensing,
 * and inventing entries would corrupt the roll-up the column exists for.
 */
export async function recordContinuityCheck(args: {
  userId: string;
  projectId: string;
  report: ContinuityReport;
}): Promise<void> {
  await db.insert(qualityChecks).values({
    projectId: args.projectId,
    userId: args.userId,
    verdict: args.report.status,
    findings: toQualityFindings(args.report),
  });
}

/** The most recent continuity check for a project, or null. */
export async function latestContinuityCheck(
  userId: string,
  projectId: string,
): Promise<{
  verdict: string;
  findings: Array<{
    code: string;
    severity: "info" | "warn" | "fail";
    message: string;
    detail?: string;
  }>;
  createdAt: Date;
} | null> {
  const rows = await db
    .select({
      verdict: qualityChecks.verdict,
      findings: qualityChecks.findings,
      createdAt: qualityChecks.createdAt,
    })
    .from(qualityChecks)
    .where(
      and(
        eq(qualityChecks.projectId, projectId),
        eq(qualityChecks.userId, userId),
      ),
    )
    .orderBy(desc(qualityChecks.createdAt))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * The active script for a channel-less studio screen (§1C, Phase 11 §8).
 *
 * A focused two-query read rather than `getStageContext`, which would run nine queries
 * for renders, thumbnails, metadata, publish jobs and quality checks that these screens
 * do not show — the build and publish stages have their own pages for those.
 *
 * Lives here rather than in either screen because both the link path and the
 * description path need exactly this, and a copy in each would be two chances to
 * disagree about which draft is current.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { scriptVersions, scripts } from "@/lib/db/schema";
import type { LinkScriptView } from "@/components/youtube/LinkStudio";

export async function loadStudioScript(
  userId: string,
  projectId: string,
): Promise<LinkScriptView | null> {
  const scriptRows = await db
    .select({
      id: scripts.id,
      activeVersionId: scripts.activeVersionId,
      approvedAt: scripts.approvedAt,
    })
    .from(scripts)
    .where(and(eq(scripts.projectId, projectId), eq(scripts.userId, userId)))
    .limit(1);

  const scriptRow = scriptRows[0];
  if (!scriptRow) return null;

  const versions = await db
    .select({
      id: scriptVersions.id,
      version: scriptVersions.version,
      title: scriptVersions.title,
      wordCount: scriptVersions.wordCount,
      estimatedDurationSeconds: scriptVersions.estimatedDurationSeconds,
    })
    .from(scriptVersions)
    .where(
      and(
        eq(scriptVersions.scriptId, scriptRow.id),
        eq(scriptVersions.userId, userId),
      ),
    )
    .orderBy(desc(scriptVersions.version))
    .limit(5);

  // Prefer the version the script row points at, falling back to the newest — the same
  // rule `getStageContext` uses, so no two screens disagree about which draft is
  // current.
  const active =
    versions.find((v) => v.id === scriptRow.activeVersionId) ?? versions[0];
  if (!active) return null;

  return {
    title: active.title,
    version: active.version,
    approved: scriptRow.approvedAt !== null,
    wordCount: active.wordCount,
    estimatedDurationSeconds: active.estimatedDurationSeconds,
  };
}

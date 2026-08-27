/**
 * "Create from YouTube" (Phase 11 §2, §4, §18).
 *
 * The link-mode entry point. Paste any public YouTube URL — with no channel
 * connected, in a niche you have never touched, someone else's video — and this
 * screen carries it through source analysis, trend research, an original angle, a
 * generation method and a script into the existing video pipeline.
 *
 * Deliberately *not* built on `getStageContext`. That loader resolves the active
 * project through `getActiveProject`, which would happily hand back a channel-mode
 * project and render it here as though it came from a link. `latestLinkProjectId`
 * asks the narrower question this screen actually means: which project did a pasted
 * link create?
 *
 * Like the other stage screens, the whole state is server-loaded from persisted
 * rows (§45), so a refresh mid-research resumes exactly where the worker is.
 */
import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { LinkStudio, type LinkScriptView } from "@/components/youtube/LinkStudio";
import { getSession } from "@/lib/auth/session";
import { getLinkStudioData, latestLinkProjectId } from "@/lib/dashboard/link-studio";
import { db } from "@/lib/db";
import { scriptVersions, scripts } from "@/lib/db/schema";
import { capabilityStatus } from "@/lib/providers/config";

export const metadata = { title: "Create from YouTube — Tally" };

export default async function YouTubePage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login?next=%2Fdashboard%2Fyoutube");
  const userId = session.user.id;

  const params = await searchParams;
  // `?project=` wins so the flow is linkable; otherwise pick up the most recent
  // unpublished link-mode project, which is what the user was last working on.
  const projectId = params.project ?? (await latestLinkProjectId(userId));

  /**
   * `getLinkStudioData` throws `ForbiddenError` for someone else's project id, and
   * the error boundary renders that as a refusal (§34). Nothing here needs to
   * pre-check ownership.
   */
  const data = projectId ? await getLinkStudioData(userId, projectId) : null;

  const script = data ? await loadScript(userId, data.project.id) : null;

  // §48: whether the AI provider is configured is a server fact. The client gets
  // the boolean, never the credential (§21).
  const ai = capabilityStatus("ai");

  return (
    <div>
      <SectionHeader
        eyebrow="Any video"
        title="Create from a YouTube link"
        sub="Paste a link to any public video. Tally researches the topic and writes something original — no channel connection needed."
      />
      <LinkStudio
        data={data}
        script={script}
        aiConfigured={ai.state !== "not_configured"}
      />
    </div>
  );
}

/**
 * The project's active script, summarised.
 *
 * A focused two-query read rather than `getStageContext`, which would run nine
 * queries for renders, thumbnails, metadata, publish jobs and quality checks that
 * this screen does not show — the build and publish stages have their own pages
 * for those.
 */
async function loadScript(
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

  // Prefer the version the script row points at, falling back to the newest — the
  // same rule `getStageContext` uses, so the two screens never disagree about
  // which draft is current.
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

/**
 * Video — ported from the prototype's `Video` (STAGE 03, §10).
 *
 * Preserved: the "Build the video" header, the `Building from “{title}.”` subtitle,
 * the gate that sends the user back to Script when there is none, and the whole
 * preview / asset-cards / render-bar layout.
 *
 * Changed: every progress figure is a real `jobs` or `renders` row, and the
 * preview plays the actual rendered file through a short-lived signed URL rather
 * than a styled title card standing in for output.
 */
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { VideoStudio } from "@/components/video/VideoStudio";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { assets } from "@/lib/db/schema";
import { getStageContext } from "@/lib/dashboard/stage";
import { capabilityStatus } from "@/lib/providers/config";
import { signedReadUrl } from "@/lib/storage";
import { logger } from "@/lib/logger";

export const metadata = { title: "Video — Tally" };

export default async function VideoPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login?next=%2Fdashboard%2Fvideo");
  const userId = session.user.id;

  const params = await searchParams;
  const context = await getStageContext(userId, params.project);
  const project = context.project;

  const capabilities = [
    capabilityStatus("voice"),
    capabilityStatus("visuals"),
    capabilityStatus("music"),
    capabilityStatus("transcription"),
    capabilityStatus("render"),
  ];

  const videoUrl = await resolveVideoUrl(userId, context.render?.outputAssetId ?? null);

  return (
    <div>
      <SectionHeader
        eyebrow="Stage 03"
        title="Build the video"
        sub={
          context.script
            ? `Building from “${context.script.title}.”`
            : "Every asset generated and cut together automatically."
        }
      />
      <VideoStudio
        projectId={project?.id ?? null}
        status={project?.status ?? null}
        scriptTitle={context.script?.title ?? null}
        scriptApproved={context.script?.approvedAt !== null && context.script !== null}
        sceneCount={context.scenes.length}
        stageJobs={context.stageJobs}
        render={context.render}
        videoUrl={videoUrl}
        capabilities={capabilities}
        error={
          project?.errorMessage
            ? { message: project.errorMessage, code: project.errorCode }
            : null
        }
      />
    </div>
  );
}

/**
 * Sign the rendered file for playback. Storage is private, so the URL is
 * short-lived; a signing failure degrades to "no preview" rather than taking the
 * whole page down, because the render itself is still real and still listed.
 */
async function resolveVideoUrl(
  userId: string,
  assetId: string | null,
): Promise<string | null> {
  if (!assetId) return null;

  const rows = await db
    .select({ storageKey: assets.storageKey })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.userId, userId)))
    .limit(1);

  const key = rows[0]?.storageKey;
  if (!key) return null;

  try {
    return await signedReadUrl(key);
  } catch (error) {
    logger.child({ component: "video-page", userId }).warn("sign_preview_failed", {
      error,
    });
    return null;
  }
}

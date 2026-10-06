/**
 * Publish — ported from the prototype's `Publish` (STAGE 05, §17, §18).
 *
 * Preserved: the "Publish everything" header and copy, and the two-column card.
 *
 * Changed: "Published" now depends on a `published_videos` row, which the worker
 * writes only after YouTube returns a video id (§42). Development mode's publish
 * block is surfaced here as an explicit reason rather than a disabled button with
 * no explanation (§40).
 */
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { PublishPanel } from "@/components/publish/PublishPanel";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { getSession } from "@/lib/auth/session";
import { currentTier } from "@/lib/api/guard";
import { db } from "@/lib/db";
import { assets, thumbnailVariants } from "@/lib/db/schema";
import { getStageContext, hasRenderedVideo } from "@/lib/dashboard/stage";
import { hasFeature } from "@/lib/plans/enforce";
import { capabilityStatus } from "@/lib/providers/config";
import { realPublishBlocked } from "@/lib/env";
import { signedReadUrl } from "@/lib/storage";
import { logger } from "@/lib/logger";

export const metadata = { title: "Publish — Vidxir AI" };

export default async function PublishPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login?next=%2Fdashboard%2Fpublish");
  const userId = session.user.id;

  const params = await searchParams;
  const [context, tier] = await Promise.all([
    getStageContext(userId, params.project),
    currentTier(userId),
  ]);

  const youtube = capabilityStatus("youtube");
  const thumbnailUrl = await resolveThumbnailUrl(
    userId,
    context.selectedThumbnailVariantId,
  );

  return (
    <div>
      <SectionHeader
        eyebrow="Stage 05"
        title="Publish everything"
        sub="Title, description, tags, and chapters — filled in and shipped."
      />
      <PublishPanel
        projectId={context.project?.id ?? null}
        status={context.project?.status ?? null}
        hasVideo={
          context.project !== null && hasRenderedVideo(context.project.status)
        }
        metadata={context.metadata}
        thumbnailUrl={thumbnailUrl}
        qualityCheck={context.qualityCheck}
        publishJob={context.publishJob}
        published={context.published}
        schedulingAvailable={hasFeature(tier, "scheduling")}
        youtubeReady={youtube.state === "ready"}
        publishBlockedByDevMode={realPublishBlocked()}
        error={
          context.project?.errorMessage
            ? {
                message: context.project.errorMessage,
                code: context.project.errorCode,
              }
            : null
        }
      />
    </div>
  );
}

/** Signed URL for the chosen thumbnail, or null when none has been rendered. */
async function resolveThumbnailUrl(
  userId: string,
  variantId: string | null,
): Promise<string | null> {
  if (!variantId) return null;

  const rows = await db
    .select({ storageKey: assets.storageKey })
    .from(thumbnailVariants)
    .innerJoin(assets, eq(thumbnailVariants.imageAssetId, assets.id))
    .where(
      and(
        eq(thumbnailVariants.id, variantId),
        eq(thumbnailVariants.userId, userId),
      ),
    )
    .limit(1);

  const key = rows[0]?.storageKey;
  if (!key) return null;

  try {
    return await signedReadUrl(key);
  } catch (error) {
    logger
      .child({ component: "publish-page", userId })
      .warn("sign_thumbnail_failed", { error });
    return null;
  }
}

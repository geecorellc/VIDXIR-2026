/**
 * Thumbnail — ported from the prototype's `Thumbnail` (STAGE 04, §16).
 *
 * Preserved: the "Design the thumbnail" header and copy, the hero + four-variant
 * select workflow, and the footer hint row.
 *
 * Changed: variants are `thumbnail_variants` rows with real composited images, and
 * the selection is persisted on the `thumbnails` row so the publish step uploads
 * the file the user actually chose.
 */
import { redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { ThumbnailStudio, type ThumbnailVariantWithUrl } from "@/components/thumbnail/ThumbnailStudio";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { getSession } from "@/lib/auth/session";
import { currentTier } from "@/lib/api/guard";
import { db } from "@/lib/db";
import { assets } from "@/lib/db/schema";
import { getStageContext } from "@/lib/dashboard/stage";
import { hasFeature } from "@/lib/plans/enforce";
import { capabilityStatus } from "@/lib/providers/config";
import { signedReadUrl } from "@/lib/storage";
import { logger } from "@/lib/logger";

export const metadata = { title: "Thumbnail — Tally" };

export default async function ThumbnailPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login?next=%2Fdashboard%2Fthumbnail");
  const userId = session.user.id;

  const params = await searchParams;
  const [context, tier] = await Promise.all([
    getStageContext(userId, params.project),
    currentTier(userId),
  ]);

  const ai = capabilityStatus("ai");
  const visuals = capabilityStatus("visuals");
  const variants = await withImageUrls(userId, context.thumbnailVariants);

  return (
    <div>
      <SectionHeader
        eyebrow="Stage 04"
        title="Design the thumbnail"
        sub="High-CTR variations, generated and tested."
      />
      <ThumbnailStudio
        projectId={context.project?.id ?? null}
        status={context.project?.status ?? null}
        baseTitle={context.script?.title ?? context.project?.title ?? null}
        variants={variants}
        selectedVariantId={context.selectedThumbnailVariantId}
        abTestingAvailable={hasFeature(tier, "thumbnailAbTest")}
        canGenerate={ai.state !== "not_configured" && visuals.state !== "not_configured"}
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

/**
 * Sign each variant's composited image in one round trip.
 *
 * A variant with no `imageAssetId` keeps `imageUrl: null` — the component then
 * says the image has not been rendered rather than drawing a lookalike (§42).
 */
async function withImageUrls(
  userId: string,
  variants: Array<Omit<ThumbnailVariantWithUrl, "imageUrl">>,
): Promise<ThumbnailVariantWithUrl[]> {
  const assetIds = variants
    .map((v) => v.imageAssetId)
    .filter((id): id is string => id !== null);

  if (assetIds.length === 0) {
    return variants.map((v) => ({ ...v, imageUrl: null }));
  }

  const rows = await db
    .select({ id: assets.id, storageKey: assets.storageKey })
    .from(assets)
    .where(and(inArray(assets.id, assetIds), eq(assets.userId, userId)));

  const keyById = new Map(
    rows
      .filter((r): r is { id: string; storageKey: string } => r.storageKey !== null)
      .map((r) => [r.id, r.storageKey]),
  );

  return Promise.all(
    variants.map(async (variant) => {
      const key = variant.imageAssetId ? keyById.get(variant.imageAssetId) : undefined;
      if (!key) return { ...variant, imageUrl: null };
      try {
        return { ...variant, imageUrl: await signedReadUrl(key) };
      } catch (error) {
        logger
          .child({ component: "thumbnail-page", userId })
          .warn("sign_thumbnail_failed", { error });
        return { ...variant, imageUrl: null };
      }
    }),
  );
}

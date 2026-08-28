/**
 * GET /api/video/export/status?projectId=… — how the export is going (§37, §42).
 *
 * The editor polls this while a render is in flight. Every figure is read from a real
 * row: `progress` is what the provider or ffmpeg reported, and a render that has not
 * reported yet returns 0 rather than an invented number — the editor draws that as an
 * indeterminate bar rather than as "0%", the same way the studio screen does.
 *
 * Also returns whether the finished file is *current*, by comparing the cut's
 * `updatedAt` against its `lastRenderedAt`. That is the question a user actually has
 * after editing — "is the video I can download the one I am looking at?" — and it cannot
 * be answered from the render row alone.
 *
 * The output URL is signed here rather than the key being returned, for the same reason
 * the document route signs its assets: storage is private and the browser must never be
 * handed a key it could turn into a URL itself.
 */
import type { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  handle,
  parseQuery,
  requireOnboarded,
  requireProjectAccess,
} from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { db } from "@/lib/db";
import { assets, renders } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { signedReadUrl } from "@/lib/storage";
import { loadEditDocument } from "@/lib/video/edit-service";

const log = logger.child({ component: "api-video-export-status" });

/** Long enough to watch the result, short enough not to be a lasting grant. */
const OUTPUT_URL_TTL_SECONDS = 20 * 60;

const QuerySchema = z.object({
  projectId: z.string().uuid(),
});

export async function GET(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    const query = parseQuery(request, QuerySchema);

    await requireProjectAccess(user.id, query.projectId);
    await enforce(rules().read, `video-export-status:${user.id}`);

    const [rows, stored] = await Promise.all([
      db
        .select({
          id: renders.id,
          status: renders.status,
          progress: renders.progress,
          provider: renders.provider,
          durationMs: renders.durationMs,
          error: renders.error,
          outputAssetId: renders.outputAssetId,
          createdAt: renders.createdAt,
          completedAt: renders.completedAt,
        })
        .from(renders)
        .where(
          and(eq(renders.projectId, query.projectId), eq(renders.userId, user.id)),
        )
        .orderBy(desc(renders.createdAt))
        .limit(1),
      loadEditDocument(user.id, query.projectId),
    ]);

    const render = rows[0] ?? null;

    /**
     * Whether the rendered file reflects the cut as it stands.
     *
     * False when the cut has never been exported, and false when it was saved after the
     * last export. Strict `>` rather than `>=`: `markEditRendered` stamps
     * `lastRenderedAt` after the save that produced it, so equal timestamps mean the
     * export is current.
     */
    const upToDate =
      stored?.lastRenderedAt != null &&
      stored.updatedAt.getTime() <= stored.lastRenderedAt.getTime();

    return {
      render: render
        ? {
            id: render.id,
            status: render.status,
            progress: render.progress,
            provider: render.provider,
            durationMs: render.durationMs,
            error: render.error,
            createdAt: render.createdAt.toISOString(),
            completedAt: render.completedAt?.toISOString() ?? null,
            url: await resolveOutputUrl(user.id, render.outputAssetId),
          }
        : null,
      edit: stored
        ? {
            version: stored.version,
            updatedAt: stored.updatedAt.toISOString(),
            lastRenderedAt: stored.lastRenderedAt?.toISOString() ?? null,
            upToDate,
          }
        : null,
    };
  });
}

/**
 * Sign the finished file for playback.
 *
 * Re-queried with `userId` in the predicate rather than trusted from the render row:
 * `renders.outputAssetId` is ours to begin with, but signing anything reachable from a
 * request is exactly where a missing tenant predicate becomes a data leak, so the
 * ownership check is in the query that fetches the key (§34).
 *
 * A signing failure degrades to "no URL" rather than failing the poll — the render still
 * succeeded and the editor can say so.
 */
async function resolveOutputUrl(
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
    return await signedReadUrl(key, { expiresInSeconds: OUTPUT_URL_TTL_SECONDS });
  } catch (error) {
    log.warn("could not sign the export output", { userId, error });
    return null;
  }
}

/**
 * GET /api/channels/:channelId/videos — the channel's recent uploads (§7).
 *
 * Feeds two things: the research engine's "how does my own catalogue perform"
 * signal, and the channels screen. Read-only, and read-only by design — §29 is
 * explicit that Tally does not download or repost other people's videos, and this
 * endpoint returns metadata about the user's *own* uploads, never media.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  handle,
  parseQuery,
  requireChannelAccess,
  requireUser,
} from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { withChannelToken } from "@/lib/channels/service";
import { NotFoundError } from "@/lib/errors";
import { fetchChannelById, listRecentVideos } from "@/lib/providers/youtube";
import { db } from "@/lib/db";
import { channels } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

interface RouteParams {
  params: Promise<{ channelId: string }>;
}

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

export async function GET(request: NextRequest, { params }: RouteParams) {
  return handle(request, async () => {
    const { user } = await requireUser();
    const { channelId } = await params;
    const access = await requireChannelAccess(user.id, channelId);
    const { limit } = parseQuery(request, querySchema);

    await enforce(rules().read, user.id);

    const rows = await db
      .select({ youtubeChannelId: channels.youtubeChannelId })
      .from(channels)
      .where(and(eq(channels.id, access.id), eq(channels.userId, user.id)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError("Channel not found.");

    const videos = await withChannelToken(user.id, access.id, async (token) => {
      // The uploads playlist id is needed to enumerate videos, and it is a
      // property of the channel rather than something worth caching separately.
      const channel = await fetchChannelById(token, row.youtubeChannelId);
      if (!channel?.uploadsPlaylistId) return [];
      return listRecentVideos(token, channel.uploadsPlaylistId, limit);
    });

    return { videos, count: videos.length };
  });
}

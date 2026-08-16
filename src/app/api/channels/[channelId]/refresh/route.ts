/**
 * POST /api/channels/:channelId/refresh — re-read stats from YouTube (§25).
 *
 * Statistics are cached on the `channels` row and refreshed on demand or by the
 * scheduler, not on every page render: the Data API bills quota per call and the
 * dashboard renders on every navigation.
 *
 * Rate-limited per user, because this is the one read endpoint a client can use
 * to spend someone else's YouTube quota by holding down a refresh button.
 */
import type { NextRequest } from "next/server";
import { handle, requireChannelAccess, requireUser } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { refreshChannelStats } from "@/lib/channels/service";

interface RouteParams {
  params: Promise<{ channelId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  return handle(request, async () => {
    const { user, log } = await requireUser();
    const { channelId } = await params;
    const access = await requireChannelAccess(user.id, channelId);

    await enforce(rules().read, user.id);

    const channel = await refreshChannelStats(user.id, access.id);
    log.info("channel stats refreshed", {
      channelId: access.id,
      status: "ok",
    });

    return { channel };
  });
}

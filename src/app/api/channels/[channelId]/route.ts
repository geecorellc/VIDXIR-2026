/**
 * GET    /api/channels/:channelId — one channel, no credentials in the payload
 * DELETE /api/channels/:channelId — disconnect (§6, §27)
 *
 * Disconnect revokes the grant at Google and erases the stored tokens, but keeps
 * the row: `published_videos` and `analytics_snapshots` reference it, and those
 * are the record that real uploads happened. A hard delete would erase a user's
 * publishing history as a side effect of unlinking an account.
 */
import type { NextRequest } from "next/server";
import { handle, requireChannelAccess, requireUser } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { disconnectChannel, getChannel } from "@/lib/channels/service";
import { NotFoundError } from "@/lib/errors";

interface RouteParams {
  params: Promise<{ channelId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  return handle(request, async () => {
    const { user } = await requireUser();
    await enforce(rules().read, `channel:${user.id}`);
    const { channelId } = await params;
    const access = await requireChannelAccess(user.id, channelId);
    const channel = await getChannel(user.id, access.id);
    if (!channel) throw new NotFoundError("Channel not found.");
    return { channel };
  });
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  return handle(request, async () => {
    const { user, log } = await requireUser();
    // Disconnect revokes a grant at Google and erases stored tokens. Bounded so a
    // loop cannot churn revocations against Google's API through one session.
    await enforce(rules().mutation, `channel:${user.id}`);
    const { channelId } = await params;
    const access = await requireChannelAccess(user.id, channelId);

    await disconnectChannel(user.id, access.id);
    log.info("channel disconnected", { channelId: access.id });

    return { disconnected: true, channelId: access.id };
  });
}

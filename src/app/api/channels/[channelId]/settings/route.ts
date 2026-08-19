/**
 * GET   /api/channels/:channelId/settings — strategy, brand kit and automation
 * PATCH /api/channels/:channelId/settings — update any subset of the three
 *
 * `requireChannelAccess` re-queries the channel with the user id in the
 * predicate, so a request naming someone else's channel is refused before any
 * settings row is touched (§34).
 */
import type { NextRequest } from "next/server";
import {
  currentTier,
  handle,
  parseJson,
  requireChannelAccess,
  requireUser,
} from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { channelUpdateSchema } from "@/lib/settings/config";
import {
  getChannelConfig,
  updateAutomation,
  updateBrandKit,
  updateChannelSettings,
} from "@/lib/settings/service";

interface RouteParams {
  params: Promise<{ channelId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  return handle(request, async () => {
    const { user } = await requireUser();
    await enforce(rules().read, `settings:${user.id}`);
    const { channelId } = await params;
    const channel = await requireChannelAccess(user.id, channelId);
    const config = await getChannelConfig(user.id, channel.id);
    return config;
  });
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  return handle(request, async () => {
    const { user, log } = await requireUser();
    // Up to three writes plus a re-read per call, and `updateAutomation` clears
    // `next_run_at` — a loop here would keep resetting the automation schedule.
    await enforce(rules().mutation, `settings:${user.id}`);
    const { channelId } = await params;
    const channel = await requireChannelAccess(user.id, channelId);
    const body = await parseJson(request, channelUpdateSchema);

    if (body.settings) {
      await updateChannelSettings(user.id, channel.id, body.settings);
    }
    if (body.brand) {
      await updateBrandKit(user.id, channel.id, body.brand);
    }
    if (body.automation) {
      // The tier comes from the subscriptions table, never from the request (§24).
      const tier = await currentTier(user.id);
      await updateAutomation(user.id, channel.id, tier, body.automation);
    }

    log.info("channel settings patched", {
      channelId: channel.id,
      sections: Object.keys(body),
    });

    return getChannelConfig(user.id, channel.id);
  });
}

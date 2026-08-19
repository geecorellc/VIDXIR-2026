/**
 * GET /api/channels — the user's connected channels (§27, §36).
 *
 * Returns `ChannelView`, which has no token fields at all — not even the
 * ciphertext (§6). The plan allowance is included so the UI can render "2 of 3
 * connected" without re-deriving a limit the client must not be trusted with
 * (§23).
 */
import type { NextRequest } from "next/server";
import { currentTier, handle, requireUser } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { listChannels } from "@/lib/channels/service";
import { planByTier } from "@/lib/plans";
import { capabilityStatus } from "@/lib/providers/config";

export async function GET(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireUser();
    await enforce(rules().read, `channels:${user.id}`);
    const [channels, tier] = await Promise.all([
      listChannels(user.id),
      currentTier(user.id),
    ]);
    const plan = planByTier(tier);

    return {
      channels,
      limits: {
        tier: plan.tier,
        planName: plan.name,
        maxChannels: plan.maxChannels,
        connected: channels.length,
        canConnectMore:
          plan.maxChannels === null || channels.length < plan.maxChannels,
      },
      // Lets the client show the configuration banner without a second request.
      youtube: capabilityStatus("youtube"),
    };
  });
}

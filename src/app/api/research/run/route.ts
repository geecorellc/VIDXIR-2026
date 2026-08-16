/**
 * POST /api/research/run — start a research run (§7, §36).
 *
 * Returns as soon as the job is enqueued. The response carries the run and job
 * ids so the client can poll real status; it never carries results, because the
 * work has not happened yet. §42: nothing here reports progress that does not
 * exist.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  currentTier,
  handle,
  parseJson,
  requireChannelAccess,
  requireOnboarded,
} from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { ReauthRequiredError } from "@/lib/errors";
import { capabilityStatus } from "@/lib/providers/config";
import { startResearchRun } from "@/lib/research/service";

const BodySchema = z.object({
  channelId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  return handle(request, async ({ traceId }) => {
    const { user } = await requireOnboarded();
    const { channelId } = await parseJson(request, BodySchema);

    const channel = await requireChannelAccess(user.id, channelId);

    // A run costs ~600 YouTube quota units and a Claude call. Rate limited per
    // user rather than per IP so one account cannot exhaust a shared project's
    // quota from many machines.
    await enforce(rules().research, `research:${user.id}`);

    if (channel.reauthRequiredAt) {
      throw new ReauthRequiredError(
        channelId,
        "Reconnect this channel before running research — its YouTube " +
          "authorisation has expired.",
      );
    }

    const tier = await currentTier(user.id);
    const { runId, jobId } = await startResearchRun({
      userId: user.id,
      channelId,
      tier,
      trigger: "manual",
      traceId,
    });

    return {
      runId,
      jobId,
      status: "queued" as const,
      // Surfaced so the UI can warn before the run reaches the idea stage that
      // it will stop there without a key (§48), rather than after.
      ai: capabilityStatus("ai"),
    };
  });
}

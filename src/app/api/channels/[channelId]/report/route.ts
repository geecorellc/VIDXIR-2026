/**
 * GET /api/channels/:channelId/report — performance, CTR and revenue (Phase 9 §6).
 *
 * A read over `analytics_snapshots`. No YouTube call, so it costs no quota and
 * renders instantly; the ingest that fills the table is the existing
 * `POST /api/channels/:channelId/analytics`, and Phase 9 does not add a second one.
 *
 * Every metric comes back as `{state, value}` rather than a bare number, because
 * the client has to be able to tell "not measured" from "measured zero" — see
 * `lib/analytics/report.ts`. Collapsing that here would defeat the point of
 * storing it.
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
import {
  channelPerformance,
  dailySeries,
  lastIngestedAt,
  videoRevenueAttribution,
} from "@/lib/analytics/report";

interface RouteParams {
  params: Promise<{ channelId: string }>;
}

const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(28),
  /** Whether to include the per-video breakdown, which is a heavier query. */
  videos: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export async function GET(request: NextRequest, { params }: RouteParams) {
  return handle(request, async () => {
    const { user } = await requireUser();
    const { channelId } = await params;
    // Re-queried with the tenant predicate; a channel id from another account
    // never resolves (§12).
    const access = await requireChannelAccess(user.id, channelId);
    const { days, videos } = parseQuery(request, QuerySchema);

    await enforce(rules().read, `analytics:${user.id}`);

    const end = new Date();
    const start = new Date(end.getTime() - days * 86_400_000);
    const range = { start, end };

    const [performance, series, attribution, ingestedAt] = await Promise.all([
      channelPerformance(user.id, access.id, range),
      dailySeries(user.id, access.id, range),
      videos
        ? videoRevenueAttribution(user.id, access.id, range)
        : Promise.resolve([]),
      lastIngestedAt(user.id, access.id),
    ]);

    return {
      channelId: access.id,
      channelTitle: access.title,
      days,
      /**
       * Always `stored` on this route. The field exists so the UI can label the
       * provenance §14 asks for without having to infer it, and so a future live
       * read is distinguishable rather than silently mixed in.
       */
      source: "stored" as const,
      lastIngestedAt: ingestedAt,
      /** True when the channel needs reconnecting — why metrics may be stale. */
      reauthRequired: access.reauthRequiredAt !== null,
      performance,
      series,
      videos: attribution,
    };
  });
}

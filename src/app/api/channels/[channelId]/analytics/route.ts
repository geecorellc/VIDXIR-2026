/**
 * GET  /api/channels/:channelId/analytics — stored snapshots (§26)
 * POST /api/channels/:channelId/analytics — pull a window from YouTube
 *
 * The GET reads Postgres, not YouTube: the dashboard must render instantly and
 * without spending quota. The POST is the ingest, which the scheduler also calls;
 * exposing it lets a user force a refresh after publishing.
 *
 * A channel with no snapshots returns an empty series rather than zeroes. "No
 * data yet" and "measured zero views" are different facts and the UI renders them
 * differently (§42).
 */
import type { NextRequest } from "next/server";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  handle,
  parseQuery,
  requireChannelAccess,
  requireUser,
} from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import {
  analyticsDate,
  defaultWindow,
  ingestChannelAnalytics,
} from "@/lib/channels/analytics";
import { db } from "@/lib/db";
import { analyticsSnapshots } from "@/lib/db/schema";

interface RouteParams {
  params: Promise<{ channelId: string }>;
}

const getSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(28),
});

export async function GET(request: NextRequest, { params }: RouteParams) {
  return handle(request, async () => {
    const { user } = await requireUser();
    const { channelId } = await params;
    const access = await requireChannelAccess(user.id, channelId);
    const { days } = parseQuery(request, getSchema);

    const since = new Date(Date.now() - days * 86_400_000);

    const rows = await db
      .select({
        date: analyticsSnapshots.date,
        views: analyticsSnapshots.views,
        likes: analyticsSnapshots.likes,
        comments: analyticsSnapshots.comments,
        subscribersGained: analyticsSnapshots.subscribersGained,
        subscribersLost: analyticsSnapshots.subscribersLost,
        watchTimeMinutes: analyticsSnapshots.watchTimeMinutes,
        averageViewDurationSeconds: analyticsSnapshots.averageViewDurationSeconds,
        averageViewPercentage: analyticsSnapshots.averageViewPercentage,
      })
      .from(analyticsSnapshots)
      .where(
        and(
          eq(analyticsSnapshots.userId, user.id),
          eq(analyticsSnapshots.channelId, access.id),
          // Channel-level rows only; the per-video breakdown is its own view.
          isNull(analyticsSnapshots.publishedVideoId),
          gte(analyticsSnapshots.date, since),
        ),
      )
      .orderBy(desc(analyticsSnapshots.date));

    return {
      channelId: access.id,
      days,
      // Empty when nothing has been ingested. Not zero-filled.
      series: rows,
      measured: rows.length > 0,
    };
  });
}

const postSchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  return handle(request, async () => {
    const { user, log } = await requireUser();
    const { channelId } = await params;
    const access = await requireChannelAccess(user.id, channelId);
    const { days } = parseQuery(request, postSchema);

    // An ingest is two Analytics API calls; keyed by user so one account cannot
    // exhaust the project's shared quota.
    await enforce(rules().research, user.id);

    const now = new Date();
    const window = days
      ? {
          startDate: analyticsDate(new Date(now.getTime() - days * 86_400_000)),
          endDate: analyticsDate(now),
        }
      : defaultWindow(now);

    const result = await ingestChannelAnalytics(user.id, access.id, window);
    log.info("analytics ingest requested", {
      channelId: access.id,
      ...window,
      channelRows: result.channelRows,
      videoRows: result.videoRows,
    });

    return result;
  });
}

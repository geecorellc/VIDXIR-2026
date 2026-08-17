/**
 * YouTube Analytics ingestion (§26).
 *
 * Pulls daily metrics for a connected channel and persists them to
 * `analytics_snapshots`, which is the table the scoring loop in §8 reads back
 * from. Two properties matter more than the shape of the query:
 *
 *  - **Idempotence.** The scheduler re-pulls overlapping windows (yesterday's
 *    numbers move for days as YouTube finalises them), so ingesting the same
 *    range twice must converge rather than accumulate.
 *  - **Absence is recorded as absence.** YouTube Analytics v2 does not expose
 *    thumbnail impressions or impression CTR — those live only in Studio — so
 *    `ctr` and `impressions` stay null. §42 forbids deriving a plausible number
 *    to fill the column, and §8's scoring would silently inherit the fiction.
 */
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { analyticsSnapshots, publishedVideos } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { withChannelToken } from "@/lib/channels/service";
import { fetchAnalytics, type AnalyticsRow } from "@/lib/providers/youtube";
import { withUsage } from "@/lib/providers/usage";

const log = logger.child({ component: "analytics" });

/** YouTube finalises metrics over roughly three days; re-pull that far back. */
export const ANALYTICS_RESETTLE_DAYS = 4;

export interface IngestResult {
  channelId: string;
  startDate: string;
  endDate: string;
  /** Channel-level daily rows written. */
  channelRows: number;
  /** Per-video daily rows written. */
  videoRows: number;
  /** Video ids YouTube reported that Tally has no `published_videos` row for. */
  unmatchedVideoIds: string[];
}

/**
 * Ingest a date window for one channel.
 *
 * Two queries rather than one: the channel totals (dimension `day`) and the
 * per-video breakdown (`day,video`). They are not derivable from each other —
 * channel totals include traffic to videos Tally did not publish, which is
 * exactly the baseline §26 needs in order to say whether Tally is helping.
 */
export async function ingestChannelAnalytics(
  userId: string,
  channelId: string,
  window: { startDate: string; endDate: string },
): Promise<IngestResult> {
  const { startDate, endDate } = window;

  const [channelDaily, perVideo] = await withChannelToken(
    userId,
    channelId,
    async (token) =>
      Promise.all([
        withUsage(
          { provider: "google", operation: "analytics.channel", userId },
          () => fetchAnalytics(token, { startDate, endDate }),
          (rows) => ({ quantity: rows.length, unit: "rows" }),
        ),
        withUsage(
          { provider: "google", operation: "analytics.byVideo", userId },
          () => fetchAnalytics(token, { startDate, endDate, byVideo: true }),
          (rows) => ({ quantity: rows.length, unit: "rows" }),
        ),
      ]),
  );

  const channelRows = await writeChannelRows(
    userId,
    channelId,
    channelDaily,
    window,
  );
  const { written: videoRows, unmatched } = await writeVideoRows(
    userId,
    channelId,
    perVideo,
  );

  log.info("analytics ingested", {
    userId,
    channelId,
    startDate,
    endDate,
    channelRows,
    videoRows,
    unmatched: unmatched.length,
  });

  return {
    channelId,
    startDate,
    endDate,
    channelRows,
    videoRows,
    unmatchedVideoIds: unmatched,
  };
}

/**
 * Channel-level rows have a null `published_video_id`, and Postgres treats NULLs
 * as distinct in a unique index — so `ON CONFLICT` would never match and every
 * re-pull would duplicate. Deleting the window first is what makes the ingest
 * idempotent.
 */
async function writeChannelRows(
  userId: string,
  channelId: string,
  rows: AnalyticsRow[],
  window: { startDate: string; endDate: string },
): Promise<number> {
  const valid = rows.filter((r) => r.date);
  if (valid.length === 0) return 0;

  await db
    .delete(analyticsSnapshots)
    .where(
      and(
        eq(analyticsSnapshots.userId, userId),
        eq(analyticsSnapshots.channelId, channelId),
        isNull(analyticsSnapshots.publishedVideoId),
        gte(analyticsSnapshots.date, dateOf(window.startDate)),
        lte(analyticsSnapshots.date, dateOf(window.endDate)),
      ),
    );

  await db.insert(analyticsSnapshots).values(
    valid.map((row) => ({
      userId,
      channelId,
      publishedVideoId: null,
      date: dateOf(row.date),
      ...metrics(row),
    })),
  );

  return valid.length;
}

/**
 * Per-video rows are keyed to a `published_videos` row, so the unique index does
 * apply and an upsert is both correct and cheaper.
 *
 * Videos Tally did not publish are reported back rather than stored: the table's
 * foreign key requires a `published_videos` row, and inventing one would claim
 * Tally uploaded something it did not.
 */
async function writeVideoRows(
  userId: string,
  channelId: string,
  rows: AnalyticsRow[],
): Promise<{ written: number; unmatched: string[] }> {
  const withVideo = rows.filter(
    (r): r is AnalyticsRow & { videoId: string } => Boolean(r.videoId && r.date),
  );
  if (withVideo.length === 0) return { written: 0, unmatched: [] };

  const known = await db
    .select({
      id: publishedVideos.id,
      youtubeVideoId: publishedVideos.youtubeVideoId,
    })
    .from(publishedVideos)
    .where(
      and(
        eq(publishedVideos.userId, userId),
        eq(publishedVideos.channelId, channelId),
      ),
    );

  const idByYoutubeId = new Map(known.map((v) => [v.youtubeVideoId, v.id]));
  const unmatched = new Set<string>();
  let written = 0;

  for (const row of withVideo) {
    const publishedVideoId = idByYoutubeId.get(row.videoId);
    if (!publishedVideoId) {
      unmatched.add(row.videoId);
      continue;
    }

    await db
      .insert(analyticsSnapshots)
      .values({
        userId,
        channelId,
        publishedVideoId,
        date: dateOf(row.date),
        ...metrics(row),
      })
      .onConflictDoUpdate({
        target: [
          analyticsSnapshots.channelId,
          analyticsSnapshots.publishedVideoId,
          analyticsSnapshots.date,
        ],
        set: metrics(row),
      });
    written += 1;
  }

  return { written, unmatched: [...unmatched] };
}

/**
 * Map a provider row onto columns.
 *
 * `ctr`, `impressions`, `estimatedRevenueCents` are absent on purpose. The first
 * two are not in the Analytics API at all; revenue would need the monetary scope,
 * which Tally does not request. Leaving them null is what keeps the dashboard
 * honest about what has actually been measured (§42).
 */
function metrics(row: AnalyticsRow) {
  return {
    views: row.views,
    likes: row.likes,
    comments: row.comments,
    shares: row.shares,
    subscribersGained: row.subscribersGained,
    subscribersLost: row.subscribersLost,
    watchTimeMinutes: row.watchTimeMinutes,
    averageViewDurationSeconds: row.averageViewDurationSeconds,
    averageViewPercentage: row.averageViewPercentage,
    raw: { source: "youtube-analytics-v2" } as Record<string, unknown>,
  };
}

/** `YYYY-MM-DD` at UTC midnight, so a snapshot's date is unambiguous. */
function dateOf(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

/** `YYYY-MM-DD` for a date, in UTC — the format the Analytics API expects. */
export function analyticsDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The default ingest window: the resettle period plus today.
 *
 * `now` is a parameter rather than `Date.now()` so tests and the scheduler can
 * both pin it.
 */
export function defaultWindow(now: Date): { startDate: string; endDate: string } {
  const start = new Date(now.getTime() - ANALYTICS_RESETTLE_DAYS * 86_400_000);
  return { startDate: analyticsDate(start), endDate: analyticsDate(now) };
}

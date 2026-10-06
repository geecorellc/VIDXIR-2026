/**
 * YouTube Analytics ingestion (§26, Phase 9 §3-§6).
 *
 * Pulls daily metrics for a connected channel and persists them to
 * `analytics_snapshots`, which is the table the scoring loop in §8 and every
 * analytics surface read from. Four properties matter more than the shape of the
 * query:
 *
 *  - **Idempotence, enforced by the database.** The scheduler re-pulls
 *    overlapping windows (yesterday's numbers move for days as YouTube finalises
 *    them), so ingesting the same range twice must converge rather than
 *    accumulate. Both scopes now upsert on a partial unique index. Before Phase 9
 *    the channel-level path could not: its index was
 *    `(channel_id, published_video_id, date)` unconditionally, and because
 *    Postgres treats NULLs as distinct, `(channel, NULL, date)` never conflicted
 *    with itself — so `ON CONFLICT` could not match and the code compensated by
 *    deleting the window first. That delete-then-insert was a read-then-write
 *    race: two concurrent ingests could both delete, then both insert.
 *    `0004_closed_jetstream.sql` splits the index in two partial indexes and the
 *    delete is gone.
 *
 *  - **Absence is recorded as absence, and distinguished from zero.** YouTube
 *    Analytics v2 does not expose thumbnail impressions or impression CTR — those
 *    live only in Studio — so `ctr` stays null with `ctr_source =
 *    'provider_unsupported'`. A reader can therefore tell "the provider does not
 *    offer this" from "measured, and it was zero" from "never ingested"
 *    (`ctr_source is null`). §42 forbids deriving a plausible number to fill the
 *    column, and §8's scoring would silently inherit the fiction.
 *
 *  - **Revenue is exact, or explicitly unavailable.** Earnings need the
 *    `yt-analytics-monetary.readonly` scope. Vidxir AI does not request it at
 *    consent, so the honest state for nearly every channel is
 *    `revenue_state = 'scope_missing'` — a permission fact, not $0.00. When it
 *    *is* granted, the figure is carried from the API to a `numeric` column as a
 *    decimal string, with its currency, and is never routed through float
 *    arithmetic.
 *
 *  - **One ingest, one scheduler, one queue.** This module is called by the
 *    existing `ingest-analytics` scheduler task and the existing `analytics`
 *    BullMQ queue. Phase 9 adds no second path.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { analyticsSnapshots, publishedVideos } from "@/lib/db/schema";
import { isAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { channelGrant, withChannelToken } from "@/lib/channels/service";
import {
  ANALYTICS_REVENUE_CURRENCY,
  fetchAnalytics,
  type AnalyticsRow,
} from "@/lib/providers/youtube";
import { withUsage } from "@/lib/providers/usage";

const log = logger.child({ component: "analytics" });

/** YouTube finalises metrics over roughly three days; re-pull that far back. */
export const ANALYTICS_RESETTLE_DAYS = 4;

/**
 * How many days back a figure is still considered provisional.
 *
 * YouTube revises recent revenue as it reconciles; anything inside this window is
 * marked `revenue_final = false` so the UI can label it an estimate (§7). It is
 * wider than the metric resettle window because payouts settle more slowly than
 * view counts.
 */
export const REVENUE_FINALISE_DAYS = 35;

/** How `ctr`/`impressions` on a row were obtained. Mirrors the DB enum. */
export type MetricSource =
  | "provider"
  | "derived_views_impressions"
  | "provider_unsupported"
  | "provider_null";

/** Why revenue is or is not on a row. Mirrors the DB enum. */
export type RevenueState =
  | "reported"
  | "reported_zero"
  | "scope_missing"
  | "not_monetized"
  | "unavailable"
  | "not_requested";

export interface IngestResult {
  channelId: string;
  startDate: string;
  endDate: string;
  /** Channel-level daily rows written. */
  channelRows: number;
  /** Per-video daily rows written. */
  videoRows: number;
  /** Video ids YouTube reported that Vidxir AI has no `published_videos` row for. */
  unmatchedVideoIds: string[];
  /**
   * Whether earnings were requested at all, and if not, why. Surfaced so a
   * caller (and `scripts/verify-analytics.ts`) can assert that a missing revenue
   * figure is explained rather than merely absent.
   */
  revenue: {
    requested: boolean;
    state: RevenueState;
    currency: string | null;
  };
}

/**
 * Ingest a date window for one channel.
 *
 * Two queries rather than one: the channel totals (dimension `day`) and the
 * per-video breakdown (`day,video`). They are not derivable from each other —
 * channel totals include traffic to videos Vidxir AI did not publish, which is
 * exactly the baseline §26 needs in order to say whether Vidxir AI is helping.
 *
 * `userId` and `channelId` are the caller's already-authorised pair. The grant is
 * re-read from the database here rather than passed in, because whether to ask
 * YouTube for money must never be decided by a caller's argument (Phase 9 §12).
 */
export async function ingestChannelAnalytics(
  userId: string,
  channelId: string,
  window: { startDate: string; endDate: string },
): Promise<IngestResult> {
  const { startDate, endDate } = window;

  const grant = await channelGrant(userId, channelId);
  /**
   * A missing grant row means the channel is not this user's. `withChannelToken`
   * would refuse too, but reporting `scope_missing` for a channel that is not
   * yours would be a small information leak, so the state is `not_requested`.
   */
  const includeRevenue = grant?.canReadRevenue === true;

  const [channelDaily, perVideo] = await withChannelToken(
    userId,
    channelId,
    async (token) =>
      Promise.all([
        withUsage(
          { provider: "google", operation: "analytics.channel", userId },
          () => fetchAnalytics(token, { startDate, endDate, includeRevenue }),
          (rows) => ({ quantity: rows.length, unit: "rows" }),
        ),
        withUsage(
          { provider: "google", operation: "analytics.byVideo", userId },
          () =>
            fetchAnalytics(token, {
              startDate,
              endDate,
              byVideo: true,
              includeRevenue,
            }),
          (rows) => ({ quantity: rows.length, unit: "rows" }),
        ),
      ]),
  );

  const now = new Date();
  const channelRows = await writeChannelRows(userId, channelId, channelDaily, now);
  const { written: videoRows, unmatched } = await writeVideoRows(
    userId,
    channelId,
    perVideo,
    now,
  );

  const revenueState: RevenueState = includeRevenue
    ? "reported"
    : grant
      ? "scope_missing"
      : "not_requested";

  log.info("analytics ingested", {
    userId,
    channelId,
    startDate,
    endDate,
    channelRows,
    videoRows,
    unmatched: unmatched.length,
    revenueRequested: includeRevenue,
  });

  return {
    channelId,
    startDate,
    endDate,
    channelRows,
    videoRows,
    unmatchedVideoIds: unmatched,
    revenue: {
      requested: includeRevenue,
      state: revenueState,
      currency: includeRevenue ? ANALYTICS_REVENUE_CURRENCY : null,
    },
  };
}

/**
 * Channel-level rows, upserted on `analytics_snapshots_channel_date_key`.
 *
 * The conflict target is expressed as the index's columns *plus* its predicate:
 * Postgres only uses a partial index for `ON CONFLICT` when the statement's
 * `WHERE` matches, and drizzle passes `targetWhere` through for exactly this.
 * Without the predicate the statement fails to find an arbiter index rather than
 * silently inserting a duplicate — a loud failure, but a failure.
 */
async function writeChannelRows(
  userId: string,
  channelId: string,
  rows: AnalyticsRow[],
  now: Date,
): Promise<number> {
  const valid = rows.filter((r) => r.date);
  if (valid.length === 0) return 0;

  let written = 0;
  for (const row of valid) {
    const values = metrics(row, now);
    await db
      .insert(analyticsSnapshots)
      .values({
        userId,
        channelId,
        publishedVideoId: null,
        date: dateOf(row.date),
        ...values,
      })
      .onConflictDoUpdate({
        target: [analyticsSnapshots.channelId, analyticsSnapshots.date],
        targetWhere: sql`${analyticsSnapshots.publishedVideoId} is null`,
        set: values,
      });
    written += 1;
  }

  return written;
}

/**
 * Per-video rows, upserted on `analytics_snapshots_video_date_key`.
 *
 * Videos Vidxir AI did not publish are reported back rather than stored: the table's
 * foreign key requires a `published_videos` row, and inventing one would claim
 * Vidxir AI uploaded something it did not.
 */
async function writeVideoRows(
  userId: string,
  channelId: string,
  rows: AnalyticsRow[],
  now: Date,
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

    const values = metrics(row, now);
    await db
      .insert(analyticsSnapshots)
      .values({
        userId,
        channelId,
        publishedVideoId,
        date: dateOf(row.date),
        ...values,
      })
      .onConflictDoUpdate({
        target: [
          analyticsSnapshots.channelId,
          analyticsSnapshots.publishedVideoId,
          analyticsSnapshots.date,
        ],
        targetWhere: sql`${analyticsSnapshots.publishedVideoId} is not null`,
        set: values,
      });
    written += 1;
  }

  return { written, unmatched: [...unmatched] };
}

/**
 * Map a provider row onto columns.
 *
 * The two interesting columns are the ones that are *not* simply copied:
 *
 *  - `ctr`/`impressions` stay null, but `ctrSource` records
 *    `provider_unsupported` — the API was asked and genuinely does not offer
 *    impression CTR. That is materially different from `null` source, which means
 *    nothing was ever ingested for the row, and from a stored 0, which would mean
 *    a measured zero. §6 requires all three to be tellable apart.
 *  - revenue is written as a decimal string with its currency and a
 *    `revenue_state` that says why it is or is not there.
 */
function metrics(row: AnalyticsRow, now: Date) {
  const revenue = revenueColumns(row, now);
  return {
    views: row.views,
    likes: row.likes,
    comments: row.comments,
    shares: row.shares,
    subscribersGained: row.subscribersGained,
    subscribersLost: row.subscribersLost,
    /**
     * Not available from Analytics v2 at any scope. Left null deliberately, with
     * the reason recorded rather than implied.
     */
    impressions: null,
    ctr: null,
    ctrSource: "provider_unsupported" as const,
    watchTimeMinutes: row.watchTimeMinutes,
    averageViewDurationSeconds: row.averageViewDurationSeconds,
    averageViewPercentage: row.averageViewPercentage,
    ...revenue,
    raw: { source: "youtube-analytics-v2" } as Record<string, unknown>,
    updatedAt: now,
  };
}

/**
 * The revenue columns for one row.
 *
 * Split out because the state machine is the substance of §7 and reads badly
 * inlined. The cases, in order:
 *
 *  - revenue was not requested → `not_requested`, nothing stored. This is the
 *    normal path: Vidxir AI does not hold the monetary scope.
 *  - requested but the provider returned no cell → `unavailable`. YouTube omits
 *    the metric for days below its reporting threshold, and for non-monetised
 *    channels. Absent, not zero.
 *  - requested and exactly zero → `reported_zero`, with `0` stored. A monetised
 *    channel that genuinely earned nothing that day.
 *  - requested and non-zero → `reported`.
 *
 * `estimatedRevenueCents` is populated alongside for the pre-Phase-9 readers, by
 * rounding — the `numeric` column stays authoritative, and nothing sums the
 * cents. Rounding is done on the decimal string, so it does not go through a
 * float first.
 */
function revenueColumns(
  row: AnalyticsRow,
  now: Date,
): {
  estimatedRevenue: string | null;
  estimatedRevenueCents: number | null;
  revenueCurrency: string | null;
  revenueState: RevenueState;
  revenueFinal: boolean | null;
} {
  if (!row.revenueRequested) {
    return {
      estimatedRevenue: null,
      estimatedRevenueCents: null,
      revenueCurrency: null,
      revenueState: "not_requested",
      revenueFinal: null,
    };
  }

  const currency = row.currency ?? ANALYTICS_REVENUE_CURRENCY;
  const final = isRevenueFinal(row.date, now);

  if (row.estimatedRevenue === null) {
    return {
      estimatedRevenue: null,
      estimatedRevenueCents: null,
      revenueCurrency: currency,
      revenueState: "unavailable",
      revenueFinal: final,
    };
  }

  const zero = isDecimalZero(row.estimatedRevenue);
  return {
    estimatedRevenue: row.estimatedRevenue,
    estimatedRevenueCents: decimalToCents(row.estimatedRevenue),
    revenueCurrency: currency,
    revenueState: zero ? "reported_zero" : "reported",
    revenueFinal: final,
  };
}

/** True once the figure is old enough that YouTube no longer revises it. */
export function isRevenueFinal(isoDate: string, now: Date): boolean {
  const rowDate = dateOf(isoDate).getTime();
  if (Number.isNaN(rowDate)) return false;
  return now.getTime() - rowDate > REVENUE_FINALISE_DAYS * 86_400_000;
}

/**
 * Whether a decimal string is zero, without parsing it as a float.
 *
 * `Number("0.00") === 0` would work here, but the same habit applied to a
 * comparison or a sum is how float money bugs start, so the whole module avoids
 * it: strip sign, separator and zeroes, and see whether anything is left.
 */
export function isDecimalZero(value: string): boolean {
  return /^[+-]?0*(\.0*)?$/.test(value.trim());
}

/**
 * A decimal string in whole minor units, rounded half-up on the string.
 *
 * Only for the legacy `estimated_revenue_cents` column. Returns null when the
 * input is not a plain decimal, rather than guessing.
 */
export function decimalToCents(value: string): number | null {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) return null;
  const [, signRaw, wholeRaw, fracRaw] = match;
  const whole = wholeRaw ?? "";
  const frac = fracRaw ?? "";
  if (whole === "" && frac === "") return null;

  // Two digits of minor unit, plus one more to decide the rounding.
  const padded = (frac + "000").slice(0, 3);
  const minor = Number(`${whole || "0"}${padded.slice(0, 2)}`);
  if (!Number.isFinite(minor)) return null;
  const rounded = Number(padded[2]) >= 5 ? minor + 1 : minor;
  return signRaw === "-" ? -rounded : rounded;
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

/**
 * Whether an ingest failure should be retried.
 *
 * Wraps `isRetryable` with one addition Phase 9 §13 asks for: a missing scope is
 * permanent. Retrying it burns quota against a grant that will not change until
 * the user reconnects, and it would keep the channel in a "pending" state instead
 * of the reconnect prompt that would actually resolve it.
 */
export function isRetryableIngestError(error: unknown): boolean {
  if (isAppError(error)) {
    if (error.code === "provider_scope_missing") return false;
    return error.retryable;
  }
  return true;
}

/**
 * Analytics reads: performance, CTR and revenue attribution (Phase 9 §4-§6).
 *
 * The ingest writes; this reads. Everything in here is a query over
 * `analytics_snapshots` plus `published_videos`, and the whole module exists to
 * enforce one rule that is easy to state and easy to violate accidentally:
 *
 *   **A metric has three possible states, not two.** Unavailable, measured-zero,
 *   and measured-non-zero. `sum(views)` over an empty set returns NULL in
 *   Postgres, and `Number(null)` is 0 — so the naive read turns "we have never
 *   collected analytics" into a confident "0 views". Every aggregate here
 *   therefore carries its row count, and every returned figure is
 *   `MetricValue<T>` with an explicit `state`.
 *
 * Revenue additionally distinguishes *why* it is absent, because "you have not
 * granted the monetary scope" and "you earned nothing" are different facts and
 * §7 forbids collapsing them. It also distinguishes estimated from final: YouTube
 * revises recent earnings, and presenting a provisional figure as settled is the
 * same class of error as inventing one.
 *
 * Sums are done in Postgres with `numeric` arithmetic and returned as decimal
 * strings. Money never passes through a JS float in this module (§4).
 */
import { and, desc, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { analyticsSnapshots, publishedVideos } from "@/lib/db/schema";
import type { MetricSource, RevenueState } from "@/lib/channels/analytics";

/**
 * A metric and the reason it looks the way it does.
 *
 * `available` — a real measurement, which may legitimately be zero.
 * `unavailable` — nothing has been measured; render a dash, never a zero.
 * `unsupported` — the provider does not offer this metric at all, which is a
 * permanent state worth wording differently from "not yet collected".
 */
export type MetricState = "available" | "unavailable" | "unsupported";

export interface MetricValue<T> {
  state: MetricState;
  /** Null whenever `state` is not `available`. */
  value: T | null;
  /** Machine-readable reason, for UI copy. Never a user-facing sentence. */
  reason?: string;
}

function available<T>(value: T): MetricValue<T> {
  return { state: "available", value };
}

function unavailable<T>(reason: string): MetricValue<T> {
  return { state: "unavailable", value: null, reason };
}

function unsupported<T>(reason: string): MetricValue<T> {
  return { state: "unsupported", value: null, reason };
}

// ---------------------------------------------------------------------------
// Channel performance
// ---------------------------------------------------------------------------

export interface ChannelPerformance {
  channelId: string;
  startDate: string;
  endDate: string;
  /** Days in the range that actually have a snapshot. Zero means never ingested. */
  measuredDays: number;
  views: MetricValue<number>;
  likes: MetricValue<number>;
  comments: MetricValue<number>;
  shares: MetricValue<number>;
  subscribersNet: MetricValue<number>;
  watchTimeMinutes: MetricValue<number>;
  averageViewPercentage: MetricValue<number>;
  /**
   * Impression click-through rate, as a fraction.
   *
   * Effectively always `unsupported`: YouTube Analytics v2 does not expose
   * impressions or impression CTR (they exist only in Studio). The state is read
   * from `ctr_source` rather than assumed, so if a future provider does supply
   * it, this reports it without a code change — and until then the UI says "not
   * offered by the API" rather than showing 0.0%.
   */
  ctr: MetricValue<number>;
  revenue: RevenueSummary;
}

/**
 * Aggregate one channel's channel-level snapshots over a date range.
 *
 * Reads only the channel-level rows (`published_video_id is null`). Summing those
 * together with the per-video rows would double-count: the channel totals already
 * include every video's traffic (§7's "must not double count").
 */
export async function channelPerformance(
  userId: string,
  channelId: string,
  range: { start: Date; end: Date },
): Promise<ChannelPerformance> {
  const [row] = await db
    .select({
      days: sql<string>`count(*)`,
      views: sql<string | null>`sum(${analyticsSnapshots.views})`,
      viewDays: sql<string>`count(${analyticsSnapshots.views})`,
      likes: sql<string | null>`sum(${analyticsSnapshots.likes})`,
      likeDays: sql<string>`count(${analyticsSnapshots.likes})`,
      comments: sql<string | null>`sum(${analyticsSnapshots.comments})`,
      commentDays: sql<string>`count(${analyticsSnapshots.comments})`,
      shares: sql<string | null>`sum(${analyticsSnapshots.shares})`,
      shareDays: sql<string>`count(${analyticsSnapshots.shares})`,
      subsGained: sql<string | null>`sum(${analyticsSnapshots.subscribersGained})`,
      subsLost: sql<string | null>`sum(${analyticsSnapshots.subscribersLost})`,
      subsDays: sql<string>`count(${analyticsSnapshots.subscribersGained})`,
      watch: sql<string | null>`sum(${analyticsSnapshots.watchTimeMinutes})`,
      watchDays: sql<string>`count(${analyticsSnapshots.watchTimeMinutes})`,
      /**
       * View-weighted rather than a mean of means: averaging daily percentages
       * treats a day with 3 views the same as a day with 30,000.
       */
      avgPctWeighted: sql<string | null>`
        sum(${analyticsSnapshots.averageViewPercentage} * ${analyticsSnapshots.views})
      `,
      avgPctWeight: sql<string | null>`
        sum(case
          when ${analyticsSnapshots.averageViewPercentage} is not null
          then ${analyticsSnapshots.views}
          else 0
        end)
      `,
      ctrWeighted: sql<string | null>`
        sum(${analyticsSnapshots.ctr} * ${analyticsSnapshots.impressions})
      `,
      ctrWeight: sql<string | null>`
        sum(case
          when ${analyticsSnapshots.ctr} is not null
          then ${analyticsSnapshots.impressions}
          else 0
        end)
      `,
      /** Any non-null `ctr_source` in range, so the reason can be reported. */
      ctrSource: sql<MetricSource | null>`max(${analyticsSnapshots.ctrSource})`,
    })
    .from(analyticsSnapshots)
    .where(channelScope(userId, channelId, range));

  const revenue = await revenueSummary(userId, { channelId, range });

  const days = Number(row?.days ?? 0);
  return {
    channelId,
    startDate: isoDate(range.start),
    endDate: isoDate(range.end),
    measuredDays: days,
    views: countedSum(row?.views, row?.viewDays),
    likes: countedSum(row?.likes, row?.likeDays),
    comments: countedSum(row?.comments, row?.commentDays),
    shares: countedSum(row?.shares, row?.shareDays),
    subscribersNet: netSubscribers(row?.subsGained, row?.subsLost, row?.subsDays),
    watchTimeMinutes: countedSum(row?.watch, row?.watchDays),
    averageViewPercentage: weighted(row?.avgPctWeighted, row?.avgPctWeight),
    ctr: ctrValue(row?.ctrWeighted, row?.ctrWeight, row?.ctrSource),
    revenue,
  };
}

/** The tenant + scope predicate every channel-level read shares. */
function channelScope(
  userId: string,
  channelId: string,
  range: { start: Date; end: Date },
) {
  return and(
    eq(analyticsSnapshots.userId, userId),
    eq(analyticsSnapshots.channelId, channelId),
    isNull(analyticsSnapshots.publishedVideoId),
    gte(analyticsSnapshots.date, range.start),
    lte(analyticsSnapshots.date, range.end),
  );
}

/**
 * A sum plus the count of non-null contributors.
 *
 * The count is what makes a zero honest: `sum` over zero rows is NULL, and over
 * rows that genuinely recorded 0 it is 0. Without the count both read as 0 and
 * "no data" becomes "no views".
 */
function countedSum(
  sum: string | null | undefined,
  count: string | null | undefined,
): MetricValue<number> {
  const n = Number(count ?? 0);
  if (!Number.isFinite(n) || n === 0) {
    return unavailable("no_measurement");
  }
  return available(Number(sum ?? 0));
}

function netSubscribers(
  gained: string | null | undefined,
  lost: string | null | undefined,
  count: string | null | undefined,
): MetricValue<number> {
  const n = Number(count ?? 0);
  if (!Number.isFinite(n) || n === 0) return unavailable("no_measurement");
  return available(Number(gained ?? 0) - Number(lost ?? 0));
}

/** A weighted average, or unavailable when the total weight is zero. */
function weighted(
  weightedSum: string | null | undefined,
  weight: string | null | undefined,
): MetricValue<number> {
  const w = Number(weight ?? 0);
  if (!Number.isFinite(w) || w <= 0) return unavailable("no_measurement");
  return available(Number(weightedSum ?? 0) / w);
}

/**
 * CTR, with its absence explained.
 *
 * `provider_unsupported` is reported as `unsupported` rather than `unavailable`
 * so the UI can say "YouTube's API does not expose impression CTR" instead of
 * "not collected yet", which would imply it eventually will be.
 */
function ctrValue(
  weightedSum: string | null | undefined,
  weight: string | null | undefined,
  source: MetricSource | null | undefined,
): MetricValue<number> {
  const w = Number(weight ?? 0);
  if (Number.isFinite(w) && w > 0) {
    return available(Number(weightedSum ?? 0) / w);
  }
  if (source === "provider_unsupported") {
    return unsupported("provider_unsupported");
  }
  if (source === "provider_null") return unavailable("provider_returned_null");
  return unavailable("no_measurement");
}

// ---------------------------------------------------------------------------
// Revenue attribution
// ---------------------------------------------------------------------------

export interface RevenueSummary {
  /**
   * Exact total as a decimal string, summed in Postgres. Null unless `state` is
   * `available`. A string so no caller can accidentally reduce it with `+`.
   */
  total: MetricValue<string>;
  currency: string | null;
  /**
   * Whether every contributing day is settled. False means at least one figure
   * is still being revised by YouTube and the UI must label the total an
   * estimate (§7).
   */
  final: boolean;
  /** Days with a stored figure. */
  measuredDays: number;
  /**
   * Why revenue is absent, when it is. `scope_missing` is the expected value for
   * a Vidxir AI channel: the monetary scope is not requested at consent.
   */
  state: RevenueState | "mixed";
  /** Per-state day counts, so the UI can explain a partial period. */
  breakdown: Partial<Record<RevenueState, number>>;
}

/**
 * Revenue over a range, per channel or across every channel.
 *
 * Attribution rule: only channel-level rows are summed. A video-level row's
 * revenue is a *component* of its channel's, so adding both would report roughly
 * double. The per-video figures are still available through
 * `videoRevenueAttribution` for "which video earned this", where the comparison
 * is between videos rather than a total.
 */
export async function revenueSummary(
  userId: string,
  options: { channelId?: string; range: { start: Date; end: Date } },
): Promise<RevenueSummary> {
  const { range, channelId } = options;

  const rows = await db
    .select({
      state: analyticsSnapshots.revenueState,
      currency: analyticsSnapshots.revenueCurrency,
      days: sql<string>`count(*)`,
      /** `numeric` addition in Postgres — never float arithmetic (§4). */
      total: sql<string | null>`sum(${analyticsSnapshots.estimatedRevenue})`,
      /** True only when every day in the group is settled. */
      allFinal: sql<boolean>`bool_and(coalesce(${analyticsSnapshots.revenueFinal}, false))`,
    })
    .from(analyticsSnapshots)
    .where(
      and(
        eq(analyticsSnapshots.userId, userId),
        ...(channelId ? [eq(analyticsSnapshots.channelId, channelId)] : []),
        isNull(analyticsSnapshots.publishedVideoId),
        gte(analyticsSnapshots.date, range.start),
        lte(analyticsSnapshots.date, range.end),
      ),
    )
    .groupBy(analyticsSnapshots.revenueState, analyticsSnapshots.revenueCurrency);

  const breakdown: Partial<Record<RevenueState, number>> = {};
  for (const row of rows) {
    if (!row.state) continue;
    breakdown[row.state] = (breakdown[row.state] ?? 0) + Number(row.days);
  }

  /** Only these two states carry a figure. */
  const reporting = rows.filter(
    (r) => r.state === "reported" || r.state === "reported_zero",
  );

  if (reporting.length === 0) {
    // Nothing measured. Report the dominant explanation rather than a bare null,
    // so the UI can say *why* — the whole point of §7.
    const state = dominantState(breakdown);
    return {
      total: unavailable(state),
      currency: rows.find((r) => r.currency)?.currency ?? null,
      final: false,
      measuredDays: 0,
      state,
      breakdown,
    };
  }

  /**
   * Mixed currencies cannot be added. Rather than convert — which would need a
   * rate Vidxir AI does not have and would produce a figure YouTube never reported —
   * this refuses to total and says so.
   */
  const currencies = new Set(reporting.map((r) => r.currency ?? "").filter(Boolean));
  if (currencies.size > 1) {
    return {
      total: unavailable("mixed_currency"),
      currency: null,
      final: reporting.every((r) => r.allFinal),
      measuredDays: reporting.reduce((n, r) => n + Number(r.days), 0),
      state: "mixed",
      breakdown,
    };
  }

  const total = addDecimalStrings(reporting.map((r) => r.total ?? "0"));
  const measuredDays = reporting.reduce((n, r) => n + Number(r.days), 0);
  const anyNonZero = reporting.some((r) => r.state === "reported");

  return {
    total: available(total),
    currency: [...currencies][0] ?? null,
    final: reporting.every((r) => r.allFinal),
    measuredDays,
    state: anyNonZero ? "reported" : "reported_zero",
    breakdown,
  };
}

/**
 * The explanation to show when no revenue figure exists.
 *
 * Ordered by how actionable it is: a missing scope is something the user can fix
 * by reconnecting, so it wins over "unavailable" if any day says so.
 */
function dominantState(
  breakdown: Partial<Record<RevenueState, number>>,
): RevenueState {
  const order: RevenueState[] = [
    "scope_missing",
    "not_monetized",
    "unavailable",
    "not_requested",
  ];
  for (const state of order) {
    if ((breakdown[state] ?? 0) > 0) return state;
  }
  return "not_requested";
}

/**
 * Sum decimal strings exactly, without floats.
 *
 * Postgres has already summed within each group; this adds the handful of group
 * totals. Done as scaled integer arithmetic on the digits so a six-decimal
 * `numeric` round-trips exactly — `0.1 + 0.2` must not become `0.30000000000000004`
 * in a figure the product calls revenue (§4).
 */
export function addDecimalStrings(values: string[], scale = 6): string {
  let acc = 0n;
  const factor = 10n ** BigInt(scale);
  for (const raw of values) {
    const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(raw.trim());
    // A non-decimal here would mean the column held something impossible.
    if (!match) continue;
    const [, sign, whole, frac = ""] = match;
    const scaled =
      BigInt(whole || "0") * factor +
      BigInt((frac + "0".repeat(scale)).slice(0, scale) || "0");
    acc += sign === "-" ? -scaled : scaled;
  }

  const negative = acc < 0n;
  const abs = negative ? -acc : acc;
  const whole = abs / factor;
  const frac = (abs % factor).toString().padStart(scale, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * Format an exact decimal string as money.
 *
 * Truncates to two places on the *string* rather than converting to a number
 * first: the stored value is authoritative, and a float round-trip is how a
 * displayed total starts disagreeing with the report it came from (§4).
 *
 * Lives here, next to the values it formats, so the overview tile and the
 * analytics page cannot drift apart on how a figure is rendered.
 */
export function formatMoney(amount: string, currency: string | null): string {
  const negative = amount.startsWith("-");
  const [whole = "0", frac = ""] = amount.replace(/^[+-]/, "").split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const symbol = currency === "USD" || currency === null ? "$" : `${currency} `;
  return `${negative ? "-" : ""}${symbol}${grouped}.${frac.padEnd(2, "0").slice(0, 2)}`;
}

// ---------------------------------------------------------------------------
// Per-video attribution
// ---------------------------------------------------------------------------

export interface VideoAttribution {
  publishedVideoId: string;
  youtubeVideoId: string;
  title: string | null;
  url: string;
  publishedAt: Date | null;
  views: MetricValue<number>;
  watchTimeMinutes: MetricValue<number>;
  ctr: MetricValue<number>;
  /** Exact revenue attributed to this video, as a decimal string. */
  revenue: MetricValue<string>;
  revenueCurrency: string | null;
  revenueState: RevenueState | null;
  revenueFinal: boolean;
  measuredDays: number;
}

/**
 * Per-video performance and revenue for a channel.
 *
 * This is the "which video made the money" view. Its figures are not summed with
 * the channel total anywhere — see `revenueSummary` on double counting.
 */
export async function videoRevenueAttribution(
  userId: string,
  channelId: string,
  range: { start: Date; end: Date },
  limit = 50,
): Promise<VideoAttribution[]> {
  const rows = await db
    .select({
      publishedVideoId: publishedVideos.id,
      youtubeVideoId: publishedVideos.youtubeVideoId,
      title: publishedVideos.titleUsed,
      url: publishedVideos.url,
      publishedAt: publishedVideos.publishedAt,
      days: sql<string>`count(${analyticsSnapshots.id})`,
      views: sql<string | null>`sum(${analyticsSnapshots.views})`,
      viewDays: sql<string>`count(${analyticsSnapshots.views})`,
      watch: sql<string | null>`sum(${analyticsSnapshots.watchTimeMinutes})`,
      watchDays: sql<string>`count(${analyticsSnapshots.watchTimeMinutes})`,
      ctrWeighted: sql<string | null>`
        sum(${analyticsSnapshots.ctr} * ${analyticsSnapshots.impressions})
      `,
      ctrWeight: sql<string | null>`
        sum(case
          when ${analyticsSnapshots.ctr} is not null
          then ${analyticsSnapshots.impressions}
          else 0
        end)
      `,
      ctrSource: sql<MetricSource | null>`max(${analyticsSnapshots.ctrSource})`,
      revenue: sql<string | null>`sum(${analyticsSnapshots.estimatedRevenue})`,
      revenueDays: sql<string>`count(${analyticsSnapshots.estimatedRevenue})`,
      revenueCurrency: sql<string | null>`max(${analyticsSnapshots.revenueCurrency})`,
      revenueState: sql<RevenueState | null>`max(${analyticsSnapshots.revenueState})`,
      revenueFinal: sql<boolean>`bool_and(coalesce(${analyticsSnapshots.revenueFinal}, false))`,
    })
    .from(publishedVideos)
    /**
     * A left join, so a published video with no analytics yet still appears —
     * with `unavailable` metrics. Dropping it would make the list silently
     * shorter than the channel's real output.
     */
    .leftJoin(
      analyticsSnapshots,
      and(
        eq(analyticsSnapshots.publishedVideoId, publishedVideos.id),
        gte(analyticsSnapshots.date, range.start),
        lte(analyticsSnapshots.date, range.end),
      ),
    )
    .where(
      and(
        eq(publishedVideos.userId, userId),
        eq(publishedVideos.channelId, channelId),
      ),
    )
    .groupBy(
      publishedVideos.id,
      publishedVideos.youtubeVideoId,
      publishedVideos.titleUsed,
      publishedVideos.url,
      publishedVideos.publishedAt,
    )
    .orderBy(desc(publishedVideos.publishedAt))
    .limit(limit);

  return rows.map((row) => {
    const revenueDays = Number(row.revenueDays ?? 0);
    return {
      publishedVideoId: row.publishedVideoId,
      youtubeVideoId: row.youtubeVideoId,
      title: row.title,
      url: row.url,
      publishedAt: row.publishedAt,
      views: countedSum(row.views, row.viewDays),
      watchTimeMinutes: countedSum(row.watch, row.watchDays),
      ctr: ctrValue(row.ctrWeighted, row.ctrWeight, row.ctrSource),
      revenue:
        revenueDays > 0
          ? available(addDecimalStrings([row.revenue ?? "0"]))
          : unavailable(row.revenueState ?? "no_measurement"),
      revenueCurrency: row.revenueCurrency,
      revenueState: row.revenueState,
      revenueFinal: row.revenueFinal,
      measuredDays: Number(row.days ?? 0),
    };
  });
}

// ---------------------------------------------------------------------------
// Daily series
// ---------------------------------------------------------------------------

export interface DailyPoint {
  date: string;
  views: number | null;
  watchTimeMinutes: number | null;
  ctr: number | null;
  revenue: string | null;
  revenueState: RevenueState | null;
}

/**
 * The per-day series behind the channel chart.
 *
 * Nulls are preserved rather than filled with zeroes: a gap in the series is a
 * day that was not measured, and a chart that draws it as 0 tells the user their
 * channel died that day.
 */
export async function dailySeries(
  userId: string,
  channelId: string,
  range: { start: Date; end: Date },
): Promise<DailyPoint[]> {
  const rows = await db
    .select({
      date: analyticsSnapshots.date,
      views: analyticsSnapshots.views,
      watchTimeMinutes: analyticsSnapshots.watchTimeMinutes,
      ctr: analyticsSnapshots.ctr,
      revenue: analyticsSnapshots.estimatedRevenue,
      revenueState: analyticsSnapshots.revenueState,
    })
    .from(analyticsSnapshots)
    .where(channelScope(userId, channelId, range))
    .orderBy(analyticsSnapshots.date);

  return rows.map((row) => ({
    date: isoDate(row.date),
    views: row.views,
    watchTimeMinutes: row.watchTimeMinutes,
    // `numeric` arrives as a string; a rate is safe to render as a number, and
    // unlike money it is never summed.
    ctr: row.ctr === null ? null : Number(row.ctr),
    revenue: row.revenue,
    revenueState: row.revenueState,
  }));
}

/** Latest date any snapshot exists for, so the UI can show data freshness. */
export async function lastIngestedAt(
  userId: string,
  channelId: string,
): Promise<Date | null> {
  const [row] = await db
    .select({ latest: sql<Date | null>`max(${analyticsSnapshots.date})` })
    .from(analyticsSnapshots)
    .where(
      and(
        eq(analyticsSnapshots.userId, userId),
        eq(analyticsSnapshots.channelId, channelId),
        isNotNull(analyticsSnapshots.date),
      ),
    );
  return row?.latest ?? null;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

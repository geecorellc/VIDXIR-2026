/**
 * Real research signals (§7).
 *
 * This replaces the prototype's four static constants (`trending`,
 * `searchDemand`, `competitors`, `ideaVault`) with observed public YouTube data.
 * §42 forbids shipping those arrays as though they were live, so if this module
 * cannot reach YouTube the run fails visibly and the Research screen says so.
 *
 * **Quota is the design constraint.** `search.list` costs 100 units against a
 * 10,000/day default project quota; `videos.list` and `channels.list` cost 1.
 * A naive implementation that searched once per keyword would spend a day's quota
 * on a single run. So the shape here is fixed and deliberate:
 *
 *   1. A small, bounded number of searches (`MAX_SEARCHES`, default 6) — each
 *      niche/keyword probe run twice, once by `viewCount` (what is already big)
 *      and once by `date` (what is breaking out). Those are different signals.
 *   2. One `mostPopular` chart read for broad, out-of-niche movement. 1 unit.
 *   3. One batched `videos.list` for the statistics of everything found, 50 ids
 *      per request. Search results carry no view counts, so this step is what
 *      turns hits into signals.
 *   4. One batched `channels.list` for the channels that actually ranked — the
 *      competitor set is derived from who shows up, not from a list someone typed.
 *
 * Worst case that is ~600 + 1 + 3 + 1 units, so roughly a dozen runs a day on a
 * fresh Google project. `researchRuns.sources` records which of these actually
 * responded, so a partially-degraded run is legible rather than silently thin.
 *
 * §29: nothing here downloads a video. It reads public metadata and statistics,
 * stores the source ids for provenance, and hands them to the idea generator so
 * an original angle can be traced back to the evidence it came from.
 */
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  analyticsSnapshots,
  channelSettings,
  channels,
  publishedVideos,
  researchResults,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { withChannelToken } from "@/lib/channels/service";
import {
  fetchChannelsByIds,
  fetchMostPopular,
  fetchVideosByIds,
  searchVideos,
  watchUrl,
  type CompetitorChannel,
  type SearchHit,
  type YouTubeVideoSummary,
} from "@/lib/providers/youtube";
import { engagementRate, viewsPerHour } from "@/lib/research/scoring";

const log = logger.child({ component: "research-signals" });

/**
 * Search budget per run. Six searches = 600 quota units, which leaves room for
 * a publish (~1,600) on the same day within the default 10,000.
 */
const MAX_SEARCHES = 6;

/** How far back a "breaking out" search looks. */
const RECENT_WINDOW_DAYS = 21;

/** How much evidence to keep per run. Enough to score; not enough to bloat. */
const MAX_RESULTS_PERSISTED = 90;

/** Where a signal came from. Persisted on each row for provenance (§29). */
export type SignalSource =
  | "youtube_search_top"
  | "youtube_search_recent"
  | "youtube_most_popular"
  | "youtube_competitor"
  | "own_channel";

/** One observed source video, ready to persist and to score. */
export interface CollectedSignal {
  source: SignalSource;
  youtubeVideoId: string | null;
  youtubeChannelId: string | null;
  channelTitle: string | null;
  title: string;
  url: string | null;
  publishedAt: Date | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  viewsPerHour: number | null;
  engagementRate: number | null;
  /** The keyword cluster that surfaced it. */
  topic: string | null;
  /** Subscriber count of the publishing channel, when known. Not persisted
   *  directly — it feeds the competition component of the score. */
  channelSubscriberCount: number | null;
  raw: Record<string, unknown> | null;
}

export interface ChannelResearchContext {
  channelId: string;
  youtubeChannelId: string;
  niche: string | null;
  keywords: string[];
  competitorChannelIds: string[];
  contentLanguage: string;
  regionCode: string;
  preferredLengthSeconds: number;
  scoreWeights: Record<string, number> | null;
}

export interface CollectedSignals {
  signals: CollectedSignal[];
  competitors: CompetitorChannel[];
  /** Which sources actually returned data. */
  sources: SignalSource[];
  /** Aggregate interest over time, for the Research screen's chart. */
  demandSeries: Array<{ label: string; value: number }>;
  /** The channel's own recent performance, used to bias audience fit. */
  ownTopPerformers: Array<{ title: string; views: number | null }>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Load what the channel has told us about itself (§5, §27).
 *
 * Settings are per-channel, never shared: two channels on one account can be in
 * unrelated niches and must research independently.
 */
export async function loadResearchContext(
  userId: string,
  channelId: string,
): Promise<ChannelResearchContext | null> {
  const rows = await db
    .select({
      channelId: channels.id,
      youtubeChannelId: channels.youtubeChannelId,
      niche: channelSettings.niche,
      keywords: channelSettings.keywords,
      competitorChannelIds: channelSettings.competitorChannelIds,
      contentLanguage: channelSettings.contentLanguage,
      preferredLengthSeconds: channelSettings.preferredLengthSeconds,
      scoreWeights: channelSettings.scoreWeights,
    })
    .from(channels)
    .leftJoin(channelSettings, eq(channelSettings.channelId, channels.id))
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const contentLanguage = row.contentLanguage ?? "en-US";

  return {
    channelId: row.channelId,
    youtubeChannelId: row.youtubeChannelId,
    niche: row.niche,
    keywords: row.keywords ?? [],
    competitorChannelIds: row.competitorChannelIds ?? [],
    contentLanguage,
    regionCode: regionFromLanguage(contentLanguage),
    preferredLengthSeconds: row.preferredLengthSeconds ?? 480,
    scoreWeights: row.scoreWeights,
  };
}

/**
 * Region code for search, taken from the content language's region subtag.
 *
 * Search results are region-sensitive, and the onboarding language ("en-US",
 * "de-DE", "pt-BR") is the only geographic signal Tally actually collects. A
 * language with no region subtag ("en") falls back to US rather than guessing —
 * `regionCode` must be a real ISO-3166 code or the API rejects the request.
 */
export function regionFromLanguage(language: string): string {
  const region = language.split("-")[1];
  if (!region) return "US";
  const upper = region.toUpperCase();
  return /^[A-Z]{2}$/.test(upper) ? upper : "US";
}

/** Primary language subtag ("en-US" → "en"), for `relevanceLanguage`. */
function primaryLanguage(language: string): string {
  return language.split("-")[0] || "en";
}

/**
 * The search probes for this run.
 *
 * The niche itself always leads — it is the one term guaranteed to be on-topic.
 * Keywords follow in declared order, and the whole list is truncated to the
 * quota budget rather than sampled randomly, so two consecutive runs are
 * comparable instead of drifting.
 */
export function buildProbes(context: ChannelResearchContext): string[] {
  const seen = new Set<string>();
  const probes: string[] = [];

  for (const candidate of [context.niche ?? "", ...context.keywords]) {
    const term = candidate.trim();
    if (term.length < 2) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    probes.push(term);
  }

  // Each probe consumes two searches (top + recent).
  return probes.slice(0, Math.max(1, Math.floor(MAX_SEARCHES / 2)));
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * Collect every signal for one run.
 *
 * Each source is attempted independently and a failure in one does not abort the
 * run — a search that 403s while the chart succeeds should still produce
 * research. What is *not* tolerated is every source failing: that is returned as
 * an empty signal set, and the caller fails the run rather than persisting an
 * empty result that looks like "no opportunities found".
 */
export async function collectSignals(
  userId: string,
  context: ChannelResearchContext,
  options: { now?: Date; traceId?: string } = {},
): Promise<CollectedSignals> {
  const now = options.now ?? new Date();
  const probes = buildProbes(context);
  const publishedAfter = new Date(
    now.getTime() - RECENT_WINDOW_DAYS * 86_400_000,
  );

  const sources = new Set<SignalSource>();
  /** videoId → the probe/source that found it. First finder wins. */
  const discovered = new Map<
    string,
    { source: SignalSource; topic: string | null; hit?: SearchHit }
  >();

  /**
   * Per-call accumulator. Local, not module-scope: two channels researching
   * concurrently in the same worker process would otherwise write into each
   * other's results — a tenant isolation failure, not merely a bug.
   */
  const collected: {
    signals: CollectedSignal[];
    competitors: CompetitorChannel[];
  } = { signals: [], competitors: [] };

  await withChannelToken(userId, context.channelId, async (token) => {
    for (const probe of probes) {
      // "What is already big here" — established demand.
      try {
        const top = await searchVideos(token, {
          query: probe,
          order: "viewCount",
          maxResults: 15,
          regionCode: context.regionCode,
          relevanceLanguage: primaryLanguage(context.contentLanguage),
        });
        if (top.length > 0) sources.add("youtube_search_top");
        for (const hit of top) {
          if (!discovered.has(hit.videoId)) {
            discovered.set(hit.videoId, {
              source: "youtube_search_top",
              topic: probe,
              hit,
            });
          }
        }
      } catch (error) {
        log.warn("search failed", {
          userId,
          channelId: context.channelId,
          traceId: options.traceId,
          probe,
          order: "viewCount",
          error,
        });
      }

      // "What is breaking out" — recency-bounded, which is where a genuinely
      // new opportunity shows up before it is saturated.
      try {
        const recent = await searchVideos(token, {
          query: probe,
          order: "date",
          publishedAfter,
          maxResults: 15,
          regionCode: context.regionCode,
          relevanceLanguage: primaryLanguage(context.contentLanguage),
        });
        if (recent.length > 0) sources.add("youtube_search_recent");
        for (const hit of recent) {
          if (!discovered.has(hit.videoId)) {
            discovered.set(hit.videoId, {
              source: "youtube_search_recent",
              topic: probe,
              hit,
            });
          }
        }
      } catch (error) {
        log.warn("search failed", {
          userId,
          channelId: context.channelId,
          traceId: options.traceId,
          probe,
          order: "date",
          error,
        });
      }
    }

    // Broad movement outside the niche. Cheap (1 unit) and occasionally the only
    // way to notice a format spreading across all of YouTube.
    const chartSignals: CollectedSignal[] = [];
    try {
      const popular = await fetchMostPopular(token, {
        regionCode: context.regionCode,
        maxResults: 20,
      });
      if (popular.length > 0) sources.add("youtube_most_popular");
      for (const video of popular) {
        chartSignals.push(
          fromSummary(video, "youtube_most_popular", null, null, now),
        );
      }
    } catch (error) {
      log.warn("most-popular chart failed", {
        userId,
        channelId: context.channelId,
        traceId: options.traceId,
        error,
      });
    }

    // Statistics for everything search found. `search.list` returns no counts,
    // so without this step there is no velocity and no engagement — i.e. no
    // scoring inputs at all.
    const searchSignals: CollectedSignal[] = [];
    const ids = [...discovered.keys()];
    if (ids.length > 0) {
      try {
        const detailed = await fetchVideosByIds(token, ids);
        for (const video of detailed) {
          const origin = discovered.get(video.videoId);
          if (!origin) continue;
          searchSignals.push(
            fromSummary(
              video,
              origin.source,
              origin.topic,
              origin.hit?.channelId ?? null,
              now,
              origin.hit?.channelTitle ?? null,
            ),
          );
        }
      } catch (error) {
        log.warn("statistics lookup failed", {
          userId,
          channelId: context.channelId,
          traceId: options.traceId,
          count: ids.length,
          error,
        });
      }
    }

    collected.signals = [...searchSignals, ...chartSignals];

    // Competitors: the channels that actually ranked, plus any the user named.
    const channelIds = new Set<string>();
    for (const signal of collected.signals) {
      if (signal.youtubeChannelId && signal.youtubeChannelId !== context.youtubeChannelId) {
        channelIds.add(signal.youtubeChannelId);
      }
    }
    for (const id of context.competitorChannelIds) channelIds.add(id);
    channelIds.delete(context.youtubeChannelId);

    if (channelIds.size > 0) {
      try {
        // Bounded: 50 ids per request, and the interesting competitors are the
        // ones that ranked most often, not an exhaustive census.
        const ranked = rankChannelsByAppearance(collected.signals, channelIds);
        collected.competitors = await fetchChannelsByIds(token, ranked.slice(0, 50));
        if (collected.competitors.length > 0) sources.add("youtube_competitor");
      } catch (error) {
        log.warn("competitor lookup failed", {
          userId,
          channelId: context.channelId,
          traceId: options.traceId,
          error,
        });
      }
    }
  });

  // Attach subscriber counts so the competition component has real incumbent
  // data instead of falling back to view concentration alone.
  const subsByChannel = new Map(
    collected.competitors.map((c) => [c.channelId, c.subscriberCount]),
  );
  for (const signal of collected.signals) {
    if (signal.youtubeChannelId) {
      signal.channelSubscriberCount =
        subsByChannel.get(signal.youtubeChannelId) ?? null;
    }
  }

  // Own past performance (§7, §26). Read from stored analytics rather than the
  // API: it is already ingested, costs no quota, and is the same data the
  // analytics feedback loop uses.
  const own = await loadOwnPerformance(userId, context.channelId);
  if (own.length > 0) sources.add("own_channel");

  const signals = collected.signals
    .sort((a, b) => (b.viewsPerHour ?? 0) - (a.viewsPerHour ?? 0))
    .slice(0, MAX_RESULTS_PERSISTED);

  return {
    signals,
    competitors: collected.competitors,
    sources: [...sources],
    demandSeries: buildDemandSeries(signals, now),
    ownTopPerformers: own,
  };
}

/** Map a YouTube video summary onto a signal, deriving velocity and engagement. */
function fromSummary(
  video: YouTubeVideoSummary,
  source: SignalSource,
  topic: string | null,
  channelId: string | null,
  now: Date,
  channelTitle: string | null = null,
): CollectedSignal {
  return {
    source,
    youtubeVideoId: video.videoId,
    youtubeChannelId: channelId,
    channelTitle,
    title: video.title,
    url: video.videoId ? watchUrl(video.videoId) : null,
    publishedAt: video.publishedAt,
    viewCount: video.viewCount,
    likeCount: video.likeCount,
    commentCount: video.commentCount,
    viewsPerHour: viewsPerHour(video.viewCount, video.publishedAt, now),
    engagementRate: engagementRate(
      video.viewCount,
      video.likeCount,
      video.commentCount,
    ),
    topic,
    channelSubscriberCount: null,
    raw: {
      durationIso: video.durationIso,
      tags: video.tags.slice(0, 20),
    },
  };
}

/** Channel ids ordered by how often they appear in the evidence. */
function rankChannelsByAppearance(
  signals: readonly CollectedSignal[],
  allowed: ReadonlySet<string>,
): string[] {
  const counts = new Map<string, number>();
  for (const signal of signals) {
    const id = signal.youtubeChannelId;
    if (!id || !allowed.has(id)) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  // Ids the user named explicitly may not appear in the evidence at all; they
  // still belong in the competitor set.
  for (const id of allowed) {
    if (!counts.has(id)) counts.set(id, 0);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

/**
 * The channel's own strongest recent videos.
 *
 * Feeds the idea generator: "what has worked for this specific audience" is a
 * better guide to an original angle than the niche average. Ranked by stored
 * view totals, which come from the Analytics API ingestion.
 *
 * Exported because the scriptwriter needs the same list for the same reason, and
 * a second copy of this query would drift from this one.
 */
export async function loadOwnPerformance(
  userId: string,
  channelId: string,
): Promise<Array<{ title: string; views: number | null }>> {
  const since = new Date(Date.now() - 180 * 86_400_000);

  const rows = await db
    .select({
      // `titleUsed` is the title YouTube actually received, which may differ
      // from the project's title if the user edited it before publishing.
      title: publishedVideos.titleUsed,
      views: analyticsSnapshots.views,
      date: analyticsSnapshots.date,
    })
    .from(analyticsSnapshots)
    .innerJoin(
      publishedVideos,
      eq(publishedVideos.id, analyticsSnapshots.publishedVideoId),
    )
    .where(
      and(
        eq(analyticsSnapshots.userId, userId),
        eq(analyticsSnapshots.channelId, channelId),
        gte(analyticsSnapshots.date, since),
      ),
    )
    .orderBy(desc(analyticsSnapshots.date))
    .limit(400);

  // Snapshots are daily per video; sum them per title for a total.
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!row.title) continue;
    totals.set(row.title, (totals.get(row.title) ?? 0) + (row.views ?? 0));
  }

  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([title, views]) => ({ title, views: views > 0 ? views : null }));
}

/**
 * Search-demand series for the Research chart (§25 layout, real data).
 *
 * The prototype had a hardcoded `searchDemand` array. There is no public YouTube
 * search-volume API, so inventing one would be exactly the fake §42 forbids.
 * What *is* measurable is how much attention the evidence itself attracted per
 * week — publication-week totals of observed views. The chart is labelled as
 * observed interest, not as search volume.
 */
export function buildDemandSeries(
  signals: readonly CollectedSignal[],
  now: Date,
): Array<{ label: string; value: number }> {
  const WEEKS = 8;
  const buckets = new Array<number>(WEEKS).fill(0);

  for (const signal of signals) {
    if (!signal.publishedAt || signal.viewCount === null) continue;
    const weeksAgo = Math.floor(
      (now.getTime() - signal.publishedAt.getTime()) / (7 * 86_400_000),
    );
    if (weeksAgo < 0 || weeksAgo >= WEEKS) continue;
    // Index 0 is the oldest bucket so the chart reads left-to-right in time.
    const index = WEEKS - 1 - weeksAgo;
    buckets[index] = (buckets[index] ?? 0) + signal.viewCount;
  }

  return buckets.map((value, index) => ({
    label: index === WEEKS - 1 ? "This week" : `${WEEKS - 1 - index}w ago`,
    value,
  }));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Persist the evidence for a run (§7: "Persist research + history").
 *
 * Returns the inserted rows' ids in input order, because the idea generator
 * records `sourceResultIds` against them — that mapping is the §29 provenance
 * trail from a generated idea back to the public data it was reasoned from.
 */
export async function persistSignals(
  userId: string,
  channelId: string,
  runId: string,
  signals: readonly CollectedSignal[],
): Promise<Array<{ id: string; signal: CollectedSignal }>> {
  if (signals.length === 0) return [];

  const inserted = await db
    .insert(researchResults)
    .values(
      signals.map((signal) => ({
        runId,
        userId,
        channelId,
        source: signal.source,
        youtubeVideoId: signal.youtubeVideoId,
        youtubeChannelId: signal.youtubeChannelId,
        channelTitle: signal.channelTitle,
        title: signal.title,
        url: signal.url,
        publishedAt: signal.publishedAt,
        // `numeric` maps to a string in Drizzle; view counts exceed 2^31 on
        // popular videos, so this column is deliberately not an integer.
        viewCount: signal.viewCount === null ? null : String(signal.viewCount),
        likeCount: signal.likeCount,
        commentCount: signal.commentCount,
        viewsPerHour: signal.viewsPerHour,
        engagementRate: signal.engagementRate,
        topic: signal.topic,
        raw: signal.raw,
      })),
    )
    .returning({ id: researchResults.id });

  // Postgres returns RETURNING rows in insertion order for a single-statement
  // INSERT ... VALUES, which is what makes this zip safe.
  return inserted.flatMap((row, index) => {
    const signal = signals[index];
    return signal ? [{ id: row.id, signal }] : [];
  });
}

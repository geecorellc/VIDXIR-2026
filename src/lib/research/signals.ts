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
 *
 * **Phase 11 §6** adds a second way in without adding a second implementation. A
 * pasted link is a research *seed*: its topic and tags become the probes, the
 * project API key replaces the channel's OAuth token, and everything after that —
 * the search shape, the batching, the quota budget, the scoring inputs, the
 * provenance rows — is this same code. Two things differ, and both are parameters
 * rather than branches:
 *
 *  - **The credential.** `SignalReader` is the seam. Channel mode reads as the
 *    channel; link mode reads as the Tally project, which can see public data and
 *    nothing else. That is exactly what §2B needs, because it means researching a
 *    link requires no connected channel.
 *  - **The seed exclusion.** §6 is explicit that research must not simply return
 *    the source video, so a run seeded from a link drops that id from its own
 *    results.
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
  fetchChannelsByIdsAs,
  fetchMostPopular,
  fetchMostPopularAs,
  fetchVideosByIds,
  fetchVideosByIdsAs,
  requirePublicReadCredential,
  searchVideos,
  searchVideosAs,
  watchUrl,
  type CompetitorChannel,
  type SearchHit,
  type SearchVideosQuery,
  type YouTubeVideoSummary,
} from "@/lib/providers/youtube";
import { engagementRate, viewsPerHour } from "@/lib/research/scoring";
import type { SourceAnalysis } from "@/lib/youtube/source-analysis";

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

/**
 * What a run is researching, and on whose behalf.
 *
 * `channelId` and `youtubeChannelId` are null in link mode (Phase 11 §4): there is
 * no channel, and there is therefore no own-channel id to exclude from the
 * competitor set. Everything else is filled in identically either way — the niche
 * and keywords come from channel settings in one mode and from the source video's
 * own metadata in the other, which is precisely why the collection code below did
 * not have to change.
 */
export interface ResearchContext {
  channelId: string | null;
  youtubeChannelId: string | null;
  niche: string | null;
  keywords: string[];
  competitorChannelIds: string[];
  contentLanguage: string;
  regionCode: string;
  preferredLengthSeconds: number;
  scoreWeights: Record<string, number> | null;
  /**
   * The pasted video this run was seeded from, excluded from its own results.
   *
   * §6: *"must NOT simply return the exact source video."* Dropping the id is the
   * mechanical guarantee behind that — the seed's own topic is what the probes
   * search for, so it would otherwise rank first in its own research.
   */
  seedVideoId: string | null;
}

/**
 * A context that definitely has a channel.
 *
 * Kept as a distinct name because the channel-mode callers genuinely require one
 * and the type is what says so at the call site rather than a comment.
 */
export type ChannelResearchContext = ResearchContext & {
  channelId: string;
  youtubeChannelId: string;
};

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
 * How this run reads YouTube (Phase 11 §6).
 *
 * The four reads `collectSignals` performs, as an interface, so the collection
 * logic is written once and the credential is supplied by the caller. Channel mode
 * passes an implementation that borrows the channel's OAuth token (with the
 * refresh-and-retry behaviour `withChannelToken` provides); link mode passes one
 * bound to the project API key.
 *
 * `search`/`videos`/`channels`/`chart` rather than one `run(token)` callback,
 * because the OAuth path needs the whole collection to happen *inside* a single
 * `withChannelToken` scope — one refresh covering every call — while the API-key
 * path has no scope at all. Per-read methods let both be true.
 */
export interface SignalReader {
  search(query: SearchVideosQuery): Promise<SearchHit[]>;
  videos(ids: string[]): Promise<YouTubeVideoSummary[]>;
  channels(ids: string[]): Promise<CompetitorChannel[]>;
  chart(options: {
    regionCode: string;
    maxResults: number;
  }): Promise<YouTubeVideoSummary[]>;
}

/**
 * Reader bound to one connected channel's OAuth token.
 *
 * Each read acquires the token through `withChannelToken`, so a token that expires
 * mid-run is refreshed once and the read retried — the behaviour Phases 1-10
 * already depended on. Acquiring per read rather than once for the whole run costs
 * nothing (the token is cached and only refreshed when stale) and means a run
 * spanning several minutes cannot fail on its last call with a token that was
 * fresh at the start.
 */
export function channelSignalReader(
  userId: string,
  channelId: string,
): SignalReader {
  return {
    search: (query) =>
      withChannelToken(userId, channelId, (token) => searchVideos(token, query)),
    videos: (ids) =>
      withChannelToken(userId, channelId, (token) => fetchVideosByIds(token, ids)),
    channels: (ids) =>
      withChannelToken(userId, channelId, (token) =>
        fetchChannelsByIds(token, ids),
      ),
    chart: (options) =>
      withChannelToken(userId, channelId, (token) =>
        fetchMostPopular(token, options),
      ),
  };
}

/**
 * Reader bound to the project API key (Phase 11 §2B, §6).
 *
 * Throws `NotConfiguredError` on construction when `YOUTUBE_API_KEY` is unset,
 * which the worker turns into `blocked_not_configured` — a run that names the
 * missing variable rather than one that silently returns nothing (§42, §48).
 *
 * An API key cannot read a channel's own analytics or captions, and nothing here
 * asks it to: these four reads are public data.
 */
export function publicSignalReader(): SignalReader {
  const credential = requirePublicReadCredential();
  return {
    search: (query) => searchVideosAs(credential, query),
    videos: (ids) => fetchVideosByIdsAs(credential, ids),
    channels: (ids) => fetchChannelsByIdsAs(credential, ids),
    chart: (options) => fetchMostPopularAs(credential, options),
  };
}

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
    // Channel mode has no pasted seed to exclude.
    seedVideoId: null,
  };
}

/**
 * Build a research context from a pasted video (Phase 11 §5 → §6).
 *
 * This is the whole of "the link becomes a research seed". The source's inferred
 * topics become the probes, its declared audio language decides the region and the
 * relevance language, and its duration becomes the default target length — a
 * 40-second Short and a 20-minute documentary should not research or script the
 * same way, and the source is the only signal available about which one the user
 * has in mind.
 *
 * `competitorChannelIds` deliberately includes the source's own channel. That
 * channel demonstrably serves this topic, so its subscriber count belongs in the
 * competition component — and reading its *public statistics* is the opposite of
 * copying it (§22).
 */
export function contextFromSource(
  analysis: SourceAnalysis,
  options: { fallbackLanguage?: string } = {},
): ResearchContext {
  // The uploader's declared language, then the caller's fallback, then en-US. A
  // wrong language here produces off-language search results, so the source's own
  // declaration wins over any default.
  const contentLanguage =
    normaliseLanguage(analysis.language) ??
    options.fallbackLanguage ??
    "en-US";

  return {
    channelId: null,
    youtubeChannelId: null,
    niche: analysis.niche,
    // `topics` is already ranked tags-then-title-then-category and deduplicated,
    // which is the order `buildProbes` wants.
    keywords: analysis.topics,
    competitorChannelIds: analysis.channelId ? [analysis.channelId] : [],
    contentLanguage,
    regionCode: regionFromLanguage(contentLanguage),
    // Clamped so a 4-hour livestream does not become a 4-hour script target.
    preferredLengthSeconds: clampTargetLength(analysis.durationSeconds),
    // Weights are per-channel configuration; a link-mode run has no channel, so it
    // scores on the documented defaults.
    scoreWeights: null,
    seedVideoId: analysis.videoId,
  };
}

/**
 * A BCP-47 tag, or null.
 *
 * YouTube returns things like `en`, `en-US` and occasionally `zxx` ("no linguistic
 * content", used on music videos). `zxx` and `und` are real codes that say nothing
 * about what language to write in, so they are treated as absent rather than
 * passed to `relevanceLanguage`, which would return nothing.
 */
function normaliseLanguage(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(trimmed)) return null;
  const primary = trimmed.split("-")[0]?.toLowerCase();
  if (primary === "zxx" || primary === "und" || primary === "mul") return null;
  return trimmed;
}

/** Shortest and longest video Tally will target from a source's duration. */
const MIN_TARGET_SECONDS = 60;
const MAX_TARGET_SECONDS = 1_200;

/**
 * A sane script target derived from the source's length.
 *
 * Bounded rather than copied: matching a 3-second clip or a 6-hour stream exactly
 * would produce a script the pipeline cannot render. 480s is the same default
 * channel mode uses when a channel has set no preference.
 */
function clampTargetLength(durationSeconds: number | null): number {
  if (durationSeconds === null) return 480;
  return Math.min(
    MAX_TARGET_SECONDS,
    Math.max(MIN_TARGET_SECONDS, Math.round(durationSeconds)),
  );
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
export function buildProbes(context: ResearchContext): string[] {
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
 *
 * The `reader` argument is the whole of Phase 11 §6 in this function: channel mode
 * passes `channelSignalReader`, link mode passes `publicSignalReader`, and every
 * line below — the probes, the two search orders, the chart, the statistics
 * backfill, the competitor ranking, the scoring inputs — is shared. Two other
 * things follow from `context`: a null `channelId` skips the own-performance step
 * (there is no channel to have performed), and a non-null `seedVideoId` is dropped
 * from the results so a pasted link cannot be researched into a recommendation to
 * make the video it came from.
 */
export async function collectSignals(
  reader: SignalReader,
  userId: string,
  context: ResearchContext,
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

  for (const probe of probes) {
    // "What is already big here" — established demand.
    try {
      const top = await reader.search({
        query: probe,
        order: "viewCount",
        maxResults: 15,
        regionCode: context.regionCode,
        relevanceLanguage: primaryLanguage(context.contentLanguage),
      });
      if (top.length > 0) sources.add("youtube_search_top");
      for (const hit of top) {
        if (hit.videoId === context.seedVideoId) continue;
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
        channelId: context.channelId ?? undefined,
        traceId: options.traceId,
        probe,
        order: "viewCount",
        error,
      });
    }

    // "What is breaking out" — recency-bounded, which is where a genuinely
    // new opportunity shows up before it is saturated.
    try {
      const recent = await reader.search({
        query: probe,
        order: "date",
        publishedAfter,
        maxResults: 15,
        regionCode: context.regionCode,
        relevanceLanguage: primaryLanguage(context.contentLanguage),
      });
      if (recent.length > 0) sources.add("youtube_search_recent");
      for (const hit of recent) {
        if (hit.videoId === context.seedVideoId) continue;
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
        channelId: context.channelId ?? undefined,
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
    const popular = await reader.chart({
      regionCode: context.regionCode,
      maxResults: 20,
    });
    if (popular.length > 0) sources.add("youtube_most_popular");
    for (const video of popular) {
      if (video.videoId === context.seedVideoId) continue;
      chartSignals.push(
        fromSummary(video, "youtube_most_popular", null, null, now),
      );
    }
  } catch (error) {
    log.warn("most-popular chart failed", {
      userId,
      channelId: context.channelId ?? undefined,
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
      const detailed = await reader.videos(ids);
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
        channelId: context.channelId ?? undefined,
        traceId: options.traceId,
        count: ids.length,
        error,
      });
    }
  }

  collected.signals = [...searchSignals, ...chartSignals];

  // Competitors: the channels that actually ranked, plus any the user named.
  // In link mode `competitorChannelIds` holds the source video's channel, so the
  // creator whose link was pasted is analysed as an incumbent — which is what a
  // competitor already is here.
  const channelIds = new Set<string>();
  for (const signal of collected.signals) {
    if (
      signal.youtubeChannelId &&
      signal.youtubeChannelId !== context.youtubeChannelId
    ) {
      channelIds.add(signal.youtubeChannelId);
    }
  }
  for (const id of context.competitorChannelIds) channelIds.add(id);
  // Only in channel mode is there an own channel to exclude.
  if (context.youtubeChannelId) channelIds.delete(context.youtubeChannelId);

  if (channelIds.size > 0) {
    try {
      // Bounded: 50 ids per request, and the interesting competitors are the
      // ones that ranked most often, not an exhaustive census.
      const ranked = rankChannelsByAppearance(collected.signals, channelIds);
      collected.competitors = await reader.channels(ranked.slice(0, 50));
      if (collected.competitors.length > 0) sources.add("youtube_competitor");
    } catch (error) {
      log.warn("competitor lookup failed", {
        userId,
        channelId: context.channelId ?? undefined,
        traceId: options.traceId,
        error,
      });
    }
  }

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
  // analytics feedback loop uses. Link mode has no channel and therefore no own
  // performance — an empty array, not a failure.
  const own = context.channelId
    ? await loadOwnPerformance(userId, context.channelId)
    : [];
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
 *
 * `channelId` is null for a link-mode run (Phase 11 §4). `userId` is written
 * either way, so every row still has an owner and the tenant filter on every read
 * path is unchanged.
 */
export async function persistSignals(
  userId: string,
  channelId: string | null,
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

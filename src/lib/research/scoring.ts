/**
 * The Tally Opportunity Score (§8).
 *
 * Six components, each 0-100, combined into one weighted figure. Deliberately
 * pure functions over a plain input struct: scoring is the part of the product
 * most likely to be argued about, and an argument you can settle with a unit test
 * is cheaper than one you settle by reading a database.
 *
 * **This is Tally's own score, not a YouTube metric.** §8 is explicit about that,
 * and the UI says so wherever the number appears. Nothing here comes from a
 * YouTube ranking signal; it is our own read of observable public data.
 *
 * What each component answers:
 *
 *  - **Trend** — how much attention is the topic getting right now, relative to
 *    the rest of what we sampled?
 *  - **Velocity** — how fast is it accumulating views? A 100k-view video from
 *    2019 and a 100k-view video from yesterday are not the same signal.
 *  - **Freshness** — how recent is the evidence? Old evidence for a live topic
 *    is weak evidence.
 *  - **Competition** — how hard is it to be seen? *Inverted*: a high score means
 *    LOW competition, i.e. a better opportunity. Big incumbent channels
 *    dominating a topic lowers it.
 *  - **Audience fit** — does this match the channel's declared niche and
 *    keywords?
 *  - **Opportunity** — engagement per view. A topic people argue about in the
 *    comments has room for a better take; one people watch passively does not.
 */

/** One observed source video, reduced to the fields scoring needs. */
export interface SignalInput {
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  /** Views per hour since publication. */
  viewsPerHour: number | null;
  publishedAt: Date | null;
  /** Subscriber count of the channel that published it, when known. */
  channelSubscriberCount?: number | null;
}

export interface ScoreWeights {
  trend: number;
  opportunity: number;
  competition: number;
  audienceFit: number;
  velocity: number;
  freshness: number;
}

/**
 * Default weights (§8: "configurable formula").
 *
 * Velocity and trend lead because they are the two signals that actually
 * distinguish "rising now" from "was big once", which is the whole point of
 * researching rather than copying. Freshness is the smallest because it is partly
 * already inside velocity — double-counting recency would make week-old topics
 * unbeatable.
 *
 * Per-channel overrides live in `channel_settings.score_weights`.
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  trend: 0.22,
  velocity: 0.22,
  competition: 0.18,
  audienceFit: 0.18,
  opportunity: 0.12,
  freshness: 0.08,
};

export interface ComponentScores {
  trend: number;
  opportunity: number;
  competition: number;
  audienceFit: number;
  velocity: number;
  freshness: number;
}

export interface ScoredOpportunity extends ComponentScores {
  /** The weighted composite, 0-100. */
  tallyScore: number;
  /** Weights actually used, stored so a historical score stays explainable. */
  weights: ScoreWeights;
}

/** Clamp to the 0-100 range every component is defined on. */
function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Map an unbounded positive quantity onto 0-100.
 *
 * A logarithmic curve, because view counts span six orders of magnitude and a
 * linear scale would put every video except the single biggest at ~0. `midpoint`
 * is the value that scores 50, which makes the curve tunable in units an operator
 * understands ("50 means about 5,000 views/hour") rather than by fiddling with a
 * coefficient.
 */
export function logScale(value: number | null, midpoint: number): number {
  if (value === null || !Number.isFinite(value) || value <= 0) return 0;
  if (midpoint <= 1) return 0;
  const score = 50 * (Math.log(1 + value) / Math.log(1 + midpoint));
  return clamp(score);
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * Attention the topic is getting, from the median views across its evidence.
 *
 * Median rather than mean: one freak 10M-view outlier should not make an
 * otherwise-quiet topic look hot, and topic samples are small enough that a
 * single outlier would dominate a mean.
 */
export function trendScore(signals: readonly SignalInput[]): number {
  const views = signals
    .map((s) => s.viewCount)
    .filter((v): v is number => v !== null && v > 0);
  if (views.length === 0) return 0;
  // 100k views is a solid mid-tier performer in most niches.
  return round1(logScale(median(views), 100_000));
}

/**
 * How fast the topic's evidence is accumulating views.
 *
 * Uses the **best** performer rather than the median: velocity asks "is anything
 * here taking off", and one breakout is the signal. A topic where nine videos
 * are flat and one is exploding is interesting; the median would hide that.
 */
export function velocityScore(signals: readonly SignalInput[]): number {
  const rates = signals
    .map((s) => s.viewsPerHour)
    .filter((v): v is number => v !== null && v > 0);
  if (rates.length === 0) return 0;
  // ~5k views/hour is a genuinely fast-moving video.
  return round1(logScale(Math.max(...rates), 5_000));
}

/**
 * Recency of the evidence, decaying over 30 days.
 *
 * Linear rather than exponential: an exponential curve makes anything past a
 * week worthless, and plenty of real opportunities are three weeks old. Evidence
 * with no publication date scores 0 rather than being assumed fresh — §42 applies
 * to inferred values as much as displayed ones.
 */
export function freshnessScore(
  signals: readonly SignalInput[],
  now = new Date(),
): number {
  const ages = signals
    .map((s) => s.publishedAt)
    .filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()))
    .map((d) => (now.getTime() - d.getTime()) / 86_400_000);
  if (ages.length === 0) return 0;

  const newest = Math.min(...ages);
  if (newest < 0) return 100; // scheduled/clock skew; treat as brand new
  const WINDOW_DAYS = 30;
  return round1(clamp(100 * (1 - newest / WINDOW_DAYS)));
}

/**
 * Engagement relative to reach: likes + comments per view.
 *
 * Comments are weighted 3x likes. A like is a reflex; a comment is someone
 * caring enough to type, which is the better indicator that a topic has an
 * unresolved argument in it — and an unresolved argument is where an original
 * angle comes from.
 */
export function opportunityScore(signals: readonly SignalInput[]): number {
  const rates: number[] = [];
  for (const s of signals) {
    if (s.viewCount === null || s.viewCount <= 0) continue;
    const likes = s.likeCount ?? 0;
    const comments = s.commentCount ?? 0;
    if (s.likeCount === null && s.commentCount === null) continue;
    rates.push((likes + comments * 3) / s.viewCount);
  }
  if (rates.length === 0) return 0;
  // 4% weighted engagement is strong on YouTube.
  return round1(clamp((median(rates) / 0.04) * 50));
}

/**
 * How contested the topic is. **Inverted: higher means easier to win.**
 *
 * Two inputs, because they are different obstacles:
 *  - The size of the channels already ranking. Competing with 5M-subscriber
 *    incumbents is materially harder than with 20k ones.
 *  - How concentrated the views are. If one video owns 90% of the attention on a
 *    topic, the slot is taken; if ten videos share it, the topic has appetite for
 *    another.
 *
 * With no subscriber data this falls back to concentration alone rather than
 * assuming the field is empty.
 */
export function competitionScore(signals: readonly SignalInput[]): number {
  if (signals.length === 0) return 0;

  const subs = signals
    .map((s) => s.channelSubscriberCount)
    .filter((v): v is number => typeof v === "number" && v > 0);

  // 200k subscribers is a strong incumbent; bigger than that and the score falls.
  const incumbentPressure =
    subs.length === 0 ? null : logScale(median(subs), 200_000);

  const views = signals
    .map((s) => s.viewCount ?? 0)
    .filter((v) => v > 0)
    .sort((a, b) => b - a);

  let concentration = 50;
  if (views.length > 0) {
    const total = views.reduce((sum, v) => sum + v, 0);
    const topShare = total > 0 ? (views[0] ?? 0) / total : 1;
    // One video owning everything → 0. An even spread → 100.
    concentration = clamp(100 * (1 - topShare));
  }

  const difficulty =
    incumbentPressure === null
      ? 100 - concentration
      : (incumbentPressure + (100 - concentration)) / 2;

  return round1(clamp(100 - difficulty));
}

export interface AudienceFitInput {
  /** The channel's declared niche. */
  niche: string | null;
  /** Seed keywords from channel settings. */
  keywords: readonly string[];
  /** The candidate topic/title being scored. */
  topic: string;
  /** Supporting text — the angle, or the source titles. */
  context?: string;
}

/**
 * Overlap between the topic and what this channel is actually about (§27).
 *
 * Token overlap rather than embeddings: it is explainable, has no provider
 * dependency, and at this granularity ("is this topic in my niche") it is
 * sufficient. It is also honest about its limits — a channel with no declared
 * niche and no keywords scores 50, i.e. "no information", rather than a
 * confident-looking number derived from nothing.
 */
export function audienceFitScore(input: AudienceFitInput): number {
  const haystack = tokenize(`${input.topic} ${input.context ?? ""}`);
  if (haystack.size === 0) return 0;

  const nicheTokens = tokenize(input.niche ?? "");
  const keywordTokens = tokenize(input.keywords.join(" "));

  if (nicheTokens.size === 0 && keywordTokens.size === 0) {
    // Nothing to compare against. Neutral, and deliberately not 0 — an
    // un-onboarded channel should not have every idea scored as a bad fit.
    return 50;
  }

  const nicheHits = countHits(nicheTokens, haystack);
  const keywordHits = countHits(keywordTokens, haystack);

  // Niche match is worth more than an incidental keyword match.
  const nicheRatio = nicheTokens.size === 0 ? null : nicheHits / nicheTokens.size;
  const keywordRatio =
    keywordTokens.size === 0 ? null : Math.min(1, keywordHits / 3);

  const parts: Array<{ value: number; weight: number }> = [];
  if (nicheRatio !== null) parts.push({ value: nicheRatio, weight: 0.65 });
  if (keywordRatio !== null) parts.push({ value: keywordRatio, weight: 0.35 });

  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  const weighted =
    parts.reduce((sum, p) => sum + p.value * p.weight, 0) / totalWeight;

  // A partial match is still a match: rescale so a half-overlap is a passing
  // score rather than a failing one.
  return round1(clamp(30 + weighted * 70));
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

export interface ScoreInput {
  signals: readonly SignalInput[];
  fit: AudienceFitInput;
  /** Per-channel overrides from `channel_settings.score_weights`. */
  weightOverrides?: Partial<ScoreWeights> | null;
  now?: Date;
}

/**
 * Score one opportunity.
 *
 * Weights are normalised so an operator who sets partial overrides — or weights
 * summing to 3 — still gets a 0-100 result rather than a number that silently
 * leaves the scale.
 */
export function scoreOpportunity(input: ScoreInput): ScoredOpportunity {
  const weights = normaliseWeights({
    ...DEFAULT_WEIGHTS,
    ...(input.weightOverrides ?? {}),
  });

  const components: ComponentScores = {
    trend: trendScore(input.signals),
    velocity: velocityScore(input.signals),
    freshness: freshnessScore(input.signals, input.now),
    opportunity: opportunityScore(input.signals),
    competition: competitionScore(input.signals),
    audienceFit: audienceFitScore(input.fit),
  };

  const tallyScore = round1(
    clamp(
      components.trend * weights.trend +
        components.velocity * weights.velocity +
        components.freshness * weights.freshness +
        components.opportunity * weights.opportunity +
        components.competition * weights.competition +
        components.audienceFit * weights.audienceFit,
    ),
  );

  return { ...components, tallyScore, weights };
}

/**
 * Scale weights to sum to 1.
 *
 * A negative weight is treated as 0: inverting a component's meaning through
 * configuration would make the score incomprehensible, and `competition` is
 * already the inverted one by design.
 */
export function normaliseWeights(weights: ScoreWeights): ScoreWeights {
  const safe: ScoreWeights = {
    trend: Math.max(0, weights.trend),
    opportunity: Math.max(0, weights.opportunity),
    competition: Math.max(0, weights.competition),
    audienceFit: Math.max(0, weights.audienceFit),
    velocity: Math.max(0, weights.velocity),
    freshness: Math.max(0, weights.freshness),
  };
  const total =
    safe.trend +
    safe.opportunity +
    safe.competition +
    safe.audienceFit +
    safe.velocity +
    safe.freshness;

  // All-zero overrides would divide by zero; fall back to the defaults rather
  // than returning NaN scores.
  if (total <= 0) return { ...DEFAULT_WEIGHTS };

  return {
    trend: safe.trend / total,
    opportunity: safe.opportunity / total,
    competition: safe.competition / total,
    audienceFit: safe.audienceFit / total,
    velocity: safe.velocity / total,
    freshness: safe.freshness / total,
  };
}

/**
 * Read stored per-channel weights.
 *
 * The column is untyped JSON, so a value written by an older build (or by hand)
 * has to be filtered rather than trusted. Unknown keys are dropped and
 * non-finite values ignored.
 */
export function parseWeightOverrides(
  raw: Record<string, number> | null | undefined,
): Partial<ScoreWeights> | null {
  if (!raw || typeof raw !== "object") return null;
  const keys: Array<keyof ScoreWeights> = [
    "trend",
    "opportunity",
    "competition",
    "audienceFit",
    "velocity",
    "freshness",
  ];
  const out: Partial<ScoreWeights> = {};
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Derived signal helpers
// ---------------------------------------------------------------------------

/**
 * Views per hour since publication (§7).
 *
 * The first hours of a video's life are not representative — a burst from
 * subscriber notifications inflates the rate — so the denominator has a floor of
 * six hours. Without it, a two-hour-old video with 500 views would post 250
 * views/hour and outrank a genuine breakout.
 */
export function viewsPerHour(
  viewCount: number | null,
  publishedAt: Date | null,
  now = new Date(),
): number | null {
  if (viewCount === null || viewCount < 0) return null;
  if (!publishedAt || Number.isNaN(publishedAt.getTime())) return null;
  const hours = (now.getTime() - publishedAt.getTime()) / 3_600_000;
  if (hours <= 0) return null;
  return viewCount / Math.max(hours, 6);
}

/** Weighted engagement rate, or null when neither figure was reported. */
export function engagementRate(
  viewCount: number | null,
  likeCount: number | null,
  commentCount: number | null,
): number | null {
  if (viewCount === null || viewCount <= 0) return null;
  if (likeCount === null && commentCount === null) return null;
  return ((likeCount ?? 0) + (commentCount ?? 0) * 3) / viewCount;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * English stopwords plus the words every YouTube title contains.
 *
 * "video", "youtube", "best" and friends match everything, so leaving them in
 * would make audience fit look high for any topic at all.
 */
const STOPWORDS = new Set([
  "a", "the", "and", "or", "of", "to", "in", "on", "for", "with", "at",
  "by", "from", "up", "about", "into", "over", "after", "is", "are", "was",
  "were", "be", "been", "being", "have", "has", "had", "do", "does", "did",
  "will", "would", "should", "could", "can", "may", "might", "must", "shall",
  "this", "that", "these", "those", "i", "you", "he", "she", "it", "we", "they",
  "my", "your", "his", "her", "its", "our", "their", "what", "which", "who",
  "whom", "how", "when", "where", "why", "all", "any", "both", "each", "few",
  "more", "most", "other", "some", "such", "no", "nor", "not", "only", "own",
  "same", "so", "than", "too", "very", "just", "now", "video", "videos",
  "youtube", "channel", "best", "top", "new", "vs", "ep", "part", "full",
  "official", "watch", "tutorial", "guide", "review",
]);

/** Lowercase word set, stopwords and one/two-character tokens removed. */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/** Tokens of `needles` present in `haystack`, counting stems loosely. */
function countHits(needles: Set<string>, haystack: Set<string>): number {
  let hits = 0;
  for (const needle of needles) {
    if (haystack.has(needle)) {
      hits += 1;
      continue;
    }
    // "investing" should match "investment": accept a shared 5-char prefix so
    // simple morphology does not read as a miss.
    if (needle.length >= 5) {
      const stem = needle.slice(0, 5);
      for (const token of haystack) {
        if (token.startsWith(stem)) {
          hits += 1;
          break;
        }
      }
    }
  }
  return hits;
}

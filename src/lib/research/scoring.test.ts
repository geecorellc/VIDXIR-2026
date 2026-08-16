/**
 * Scoring tests (§8, §39).
 *
 * These assert the *properties* the score has to hold rather than pinning exact
 * numbers, because the constants are meant to be tuned. Pinning `tallyScore` to
 * 63.4 would make every future adjustment look like a regression. What must not
 * change without a deliberate decision:
 *
 *  - the output stays in 0-100 whatever the input, including missing data
 *  - competition is inverted (high = easy), and stays inverted
 *  - a faster/fresher/more-engaging topic never scores lower than a slower one
 *  - absent data reads as absent, not as zero-and-therefore-bad
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEIGHTS,
  audienceFitScore,
  competitionScore,
  engagementRate,
  freshnessScore,
  logScale,
  median,
  normaliseWeights,
  opportunityScore,
  parseWeightOverrides,
  scoreOpportunity,
  tokenize,
  trendScore,
  velocityScore,
  viewsPerHour,
  type SignalInput,
} from "@/lib/research/scoring";

const NOW = new Date("2026-06-01T12:00:00.000Z");

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

function signal(overrides: Partial<SignalInput> = {}): SignalInput {
  return {
    viewCount: 50_000,
    likeCount: 1_200,
    commentCount: 90,
    viewsPerHour: 400,
    publishedAt: hoursAgo(120),
    ...overrides,
  };
}

describe("logScale", () => {
  it("puts the midpoint at 50", () => {
    expect(logScale(1_000, 1_000)).toBeCloseTo(50, 5);
  });

  it("is monotonic", () => {
    const points = [10, 100, 1_000, 10_000, 100_000].map((v) =>
      logScale(v, 1_000),
    );
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]!).toBeGreaterThan(points[i - 1]!);
    }
  });

  it("stays inside 0-100 for absurd inputs", () => {
    expect(logScale(Number.MAX_SAFE_INTEGER, 1_000)).toBeLessThanOrEqual(100);
    expect(logScale(-5, 1_000)).toBe(0);
    expect(logScale(null, 1_000)).toBe(0);
    expect(logScale(Number.NaN, 1_000)).toBe(0);
  });
});

describe("median", () => {
  it("handles odd and even lengths", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("returns 0 for an empty set rather than NaN", () => {
    expect(median([])).toBe(0);
  });

  it("does not mutate its input", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("trendScore", () => {
  it("ranks a bigger topic higher", () => {
    const small = trendScore([signal({ viewCount: 2_000 })]);
    const large = trendScore([signal({ viewCount: 2_000_000 })]);
    expect(large).toBeGreaterThan(small);
  });

  it("is not swung by a single outlier", () => {
    const steady = [10_000, 12_000, 9_000, 11_000].map((viewCount) =>
      signal({ viewCount }),
    );
    const withOutlier = [...steady, signal({ viewCount: 40_000_000 })];
    // Median moves a little as the set grows, but nothing like a mean would.
    expect(
      Math.abs(trendScore(withOutlier) - trendScore(steady)),
    ).toBeLessThan(5);
  });

  it("is 0 when no view counts were reported", () => {
    expect(trendScore([signal({ viewCount: null })])).toBe(0);
    expect(trendScore([])).toBe(0);
  });
});

describe("velocityScore", () => {
  it("follows the fastest performer, not the median", () => {
    const flat = Array.from({ length: 5 }, () => signal({ viewsPerHour: 10 }));
    const withBreakout = [...flat, signal({ viewsPerHour: 20_000 })];
    expect(velocityScore(withBreakout)).toBeGreaterThan(velocityScore(flat) + 20);
  });

  it("is 0 with no rate data", () => {
    expect(velocityScore([signal({ viewsPerHour: null })])).toBe(0);
  });
});

describe("freshnessScore", () => {
  it("scores today's evidence near 100", () => {
    expect(
      freshnessScore([signal({ publishedAt: hoursAgo(1) })], NOW),
    ).toBeGreaterThan(99);
  });

  it("decays to 0 at the edge of the window", () => {
    expect(freshnessScore([signal({ publishedAt: hoursAgo(24 * 30) })], NOW)).toBe(
      0,
    );
    expect(freshnessScore([signal({ publishedAt: hoursAgo(24 * 90) })], NOW)).toBe(
      0,
    );
  });

  it("uses the newest item, since one recent video makes a topic live", () => {
    const mixed = [
      signal({ publishedAt: hoursAgo(24 * 60) }),
      signal({ publishedAt: hoursAgo(24 * 2) }),
    ];
    expect(freshnessScore(mixed, NOW)).toBeGreaterThan(85);
  });

  it("treats a missing date as unknown rather than fresh", () => {
    expect(freshnessScore([signal({ publishedAt: null })], NOW)).toBe(0);
  });

  it("does not exceed 100 for a scheduled future date", () => {
    expect(
      freshnessScore([signal({ publishedAt: hoursAgo(-48) })], NOW),
    ).toBe(100);
  });
});

describe("opportunityScore", () => {
  it("rewards engagement per view, not raw counts", () => {
    const bigButQuiet = opportunityScore([
      signal({ viewCount: 5_000_000, likeCount: 2_000, commentCount: 50 }),
    ]);
    const smallButLoud = opportunityScore([
      signal({ viewCount: 40_000, likeCount: 3_000, commentCount: 900 }),
    ]);
    expect(smallButLoud).toBeGreaterThan(bigButQuiet);
  });

  it("weights comments above likes", () => {
    const likes = opportunityScore([
      signal({ viewCount: 100_000, likeCount: 4_000, commentCount: 0 }),
    ]);
    const comments = opportunityScore([
      signal({ viewCount: 100_000, likeCount: 0, commentCount: 4_000 }),
    ]);
    expect(comments).toBeGreaterThan(likes);
  });

  it("skips rows where neither figure was reported", () => {
    expect(
      opportunityScore([signal({ likeCount: null, commentCount: null })]),
    ).toBe(0);
  });

  it("caps at 100 for implausibly high engagement", () => {
    expect(
      opportunityScore([
        signal({ viewCount: 100, likeCount: 500, commentCount: 500 }),
      ]),
    ).toBe(100);
  });
});

describe("competitionScore", () => {
  it("is inverted: small incumbents score higher than large ones", () => {
    const build = (subs: number) => [
      signal({ viewCount: 100_000, channelSubscriberCount: subs }),
      signal({ viewCount: 90_000, channelSubscriberCount: subs }),
      signal({ viewCount: 80_000, channelSubscriberCount: subs }),
    ];
    expect(competitionScore(build(8_000))).toBeGreaterThan(
      competitionScore(build(9_000_000)),
    );
  });

  it("penalises a topic where one video owns the attention", () => {
    const spread = [200_000, 180_000, 160_000, 150_000].map((viewCount) =>
      signal({ viewCount, channelSubscriberCount: 50_000 }),
    );
    const dominated = [2_000_000, 4_000, 3_000, 1_000].map((viewCount) =>
      signal({ viewCount, channelSubscriberCount: 50_000 }),
    );
    expect(competitionScore(spread)).toBeGreaterThan(
      competitionScore(dominated),
    );
  });

  it("falls back to concentration when subscriber counts are hidden", () => {
    const hidden = [100_000, 95_000, 90_000].map((viewCount) =>
      signal({ viewCount, channelSubscriberCount: null }),
    );
    const score = competitionScore(hidden);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("is 0 with no evidence at all", () => {
    expect(competitionScore([])).toBe(0);
  });
});

describe("audienceFitScore", () => {
  const finance = {
    niche: "personal finance investing",
    keywords: ["index funds", "retirement", "budgeting"],
  };

  it("scores an on-niche topic above an off-niche one", () => {
    const onNiche = audienceFitScore({
      ...finance,
      topic: "How index fund investing beats stock picking for retirement",
    });
    const offNiche = audienceFitScore({
      ...finance,
      topic: "Restoring a vintage motorcycle carburettor",
    });
    expect(onNiche).toBeGreaterThan(offNiche);
  });

  it("matches simple morphological variants", () => {
    const score = audienceFitScore({
      niche: "investing",
      keywords: [],
      topic: "Three investment mistakes that cost people thousands",
    });
    expect(score).toBeGreaterThan(60);
  });

  it("returns a neutral 50 when the channel has declared nothing", () => {
    expect(
      audienceFitScore({ niche: null, keywords: [], topic: "Anything at all" }),
    ).toBe(50);
  });

  it("ignores filler words that appear in every title", () => {
    // "best", "video" and "youtube" are stopwords, so this shares no real token.
    const score = audienceFitScore({
      niche: "woodworking hand tools",
      keywords: [],
      topic: "The best video on YouTube",
    });
    expect(score).toBeLessThan(40);
  });

  it("uses the supporting context as well as the topic", () => {
    const withContext = audienceFitScore({
      ...finance,
      topic: "The 4% rule, revisited",
      context: "A retirement withdrawal strategy for index fund portfolios",
    });
    const without = audienceFitScore({
      ...finance,
      topic: "The 4% rule, revisited",
    });
    expect(withContext).toBeGreaterThan(without);
  });

  it("stays in range for an empty topic", () => {
    const score = audienceFitScore({ ...finance, topic: "" });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe("normaliseWeights", () => {
  it("scales any positive set to sum to 1", () => {
    const w = normaliseWeights({
      trend: 3,
      opportunity: 3,
      competition: 3,
      audienceFit: 3,
      velocity: 3,
      freshness: 3,
    });
    const total = Object.values(w).reduce((sum, v) => sum + v, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(w.trend).toBeCloseTo(1 / 6, 10);
  });

  it("clamps negatives to zero instead of inverting a component", () => {
    const w = normaliseWeights({ ...DEFAULT_WEIGHTS, competition: -5 });
    expect(w.competition).toBe(0);
    expect(Object.values(w).reduce((sum, v) => sum + v, 0)).toBeCloseTo(1, 10);
  });

  it("falls back to the defaults rather than dividing by zero", () => {
    const w = normaliseWeights({
      trend: 0,
      opportunity: 0,
      competition: 0,
      audienceFit: 0,
      velocity: 0,
      freshness: 0,
    });
    expect(w).toEqual(DEFAULT_WEIGHTS);
  });

  it("the shipped defaults already sum to 1", () => {
    const total = Object.values(DEFAULT_WEIGHTS).reduce((sum, v) => sum + v, 0);
    expect(total).toBeCloseTo(1, 10);
  });
});

describe("parseWeightOverrides", () => {
  it("keeps known numeric keys", () => {
    expect(parseWeightOverrides({ trend: 0.5, velocity: 0.5 })).toEqual({
      trend: 0.5,
      velocity: 0.5,
    });
  });

  it("drops unknown keys and junk values", () => {
    const parsed = parseWeightOverrides({
      trend: 0.4,
      nonsense: 9,
      velocity: Number.NaN,
      freshness: -1,
    } as Record<string, number>);
    expect(parsed).toEqual({ trend: 0.4 });
  });

  it("returns null for nothing usable", () => {
    expect(parseWeightOverrides(null)).toBeNull();
    expect(parseWeightOverrides({})).toBeNull();
    expect(parseWeightOverrides({ bogus: 1 } as Record<string, number>)).toBeNull();
  });
});

describe("scoreOpportunity", () => {
  const fit = {
    niche: "personal finance",
    keywords: ["investing"],
    topic: "A personal finance investing breakdown",
  };

  it("returns every component plus a composite in range", () => {
    const result = scoreOpportunity({
      signals: [signal(), signal({ viewCount: 80_000 })],
      fit,
      now: NOW,
    });
    for (const key of [
      "trend",
      "opportunity",
      "competition",
      "audienceFit",
      "velocity",
      "freshness",
      "tallyScore",
    ] as const) {
      expect(result[key]).toBeGreaterThanOrEqual(0);
      expect(result[key]).toBeLessThanOrEqual(100);
    }
  });

  it("records the weights used, so an old score stays explainable", () => {
    const result = scoreOpportunity({ signals: [signal()], fit, now: NOW });
    expect(Object.values(result.weights).reduce((s, v) => s + v, 0)).toBeCloseTo(
      1,
      10,
    );
  });

  it("honours a per-channel override", () => {
    const signals = [
      signal({ viewsPerHour: 50_000, publishedAt: hoursAgo(24 * 29) }),
    ];
    const velocityHeavy = scoreOpportunity({
      signals,
      fit,
      now: NOW,
      weightOverrides: { velocity: 100 },
    });
    const freshnessHeavy = scoreOpportunity({
      signals,
      fit,
      now: NOW,
      weightOverrides: { freshness: 100 },
    });
    // Same evidence, opposite emphasis: a fast but nearly-stale topic.
    expect(velocityHeavy.tallyScore).toBeGreaterThan(freshnessHeavy.tallyScore);
    expect(velocityHeavy.velocity).toBe(freshnessHeavy.velocity);
  });

  it("survives a run where YouTube reported almost nothing", () => {
    const result = scoreOpportunity({
      signals: [
        {
          viewCount: null,
          likeCount: null,
          commentCount: null,
          viewsPerHour: null,
          publishedAt: null,
        },
      ],
      fit,
      now: NOW,
    });
    expect(Number.isFinite(result.tallyScore)).toBe(true);
    expect(result.tallyScore).toBeGreaterThanOrEqual(0);
  });

  it("scores a live, fast, low-competition topic above a stale dominated one", () => {
    const good = scoreOpportunity({
      signals: [
        signal({
          viewCount: 300_000,
          likeCount: 20_000,
          commentCount: 3_000,
          viewsPerHour: 6_000,
          publishedAt: hoursAgo(30),
          channelSubscriberCount: 30_000,
        }),
        signal({
          viewCount: 260_000,
          viewsPerHour: 4_000,
          publishedAt: hoursAgo(50),
          channelSubscriberCount: 42_000,
        }),
      ],
      fit,
      now: NOW,
    });
    const bad = scoreOpportunity({
      signals: [
        signal({
          viewCount: 4_000_000,
          likeCount: 12_000,
          commentCount: 300,
          viewsPerHour: 40,
          publishedAt: hoursAgo(24 * 400),
          channelSubscriberCount: 12_000_000,
        }),
        signal({
          viewCount: 3_000,
          likeCount: 10,
          commentCount: 1,
          viewsPerHour: 1,
          publishedAt: hoursAgo(24 * 380),
          channelSubscriberCount: 9_000_000,
        }),
      ],
      fit,
      now: NOW,
    });
    expect(good.tallyScore).toBeGreaterThan(bad.tallyScore);
  });
});

describe("viewsPerHour", () => {
  it("divides views by hours since publication", () => {
    expect(viewsPerHour(24_000, hoursAgo(24), NOW)).toBeCloseTo(1_000, 6);
  });

  it("floors the denominator at six hours so a new upload cannot spike", () => {
    // 500 views in 2 hours is 250/h unsmoothed; the floor makes it ~83/h.
    expect(viewsPerHour(500, hoursAgo(2), NOW)).toBeCloseTo(500 / 6, 6);
  });

  it("returns null without a usable publication date", () => {
    expect(viewsPerHour(1_000, null, NOW)).toBeNull();
    expect(viewsPerHour(1_000, new Date("nope"), NOW)).toBeNull();
  });

  it("returns null when views were not reported", () => {
    expect(viewsPerHour(null, hoursAgo(10), NOW)).toBeNull();
  });
});

describe("engagementRate", () => {
  it("weights comments 3x", () => {
    expect(engagementRate(1_000, 10, 10)).toBeCloseTo(0.04, 10);
  });

  it("treats one missing figure as zero but both as unknown", () => {
    expect(engagementRate(1_000, 20, null)).toBeCloseTo(0.02, 10);
    expect(engagementRate(1_000, null, null)).toBeNull();
  });

  it("returns null when views are unknown or zero", () => {
    expect(engagementRate(null, 10, 10)).toBeNull();
    expect(engagementRate(0, 10, 10)).toBeNull();
  });
});

describe("tokenize", () => {
  it("lowercases, splits on punctuation and drops short tokens", () => {
    expect(tokenize("Index-Funds, ETFs & you!")).toEqual(
      new Set(["index", "funds", "etfs"]),
    );
  });

  it("removes filler that appears in most titles", () => {
    expect(tokenize("The best new YouTube video tutorial").size).toBe(0);
  });

  it("handles non-ASCII letters", () => {
    expect(tokenize("Sparkasse Zinsänderung")).toEqual(
      new Set(["sparkasse", "zinsänderung"]),
    );
  });
});

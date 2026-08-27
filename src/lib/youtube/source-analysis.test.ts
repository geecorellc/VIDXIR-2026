/**
 * Source video analysis (Phase 11 §5, §21, §22, §23 cases 4–6, 19–20).
 *
 * This is the one module that reads somebody else's video, so the cases here are
 * about restraint as much as about parsing:
 *
 *  - **Metadata is retrieved and derived correctly** (§23 case 4). Title, channel,
 *    category name, tags, duration, statistics, plus the two figures Tally derives
 *    rather than reads — views per hour and engagement rate — and the topic/niche
 *    seed §6 researches from.
 *  - **A missing transcript is a stated reason, never a promise** (§23 case 5).
 *    `captions.download` needs the video *owner's* OAuth credentials, so there is
 *    no `available` state to assert; what is asserted is that all three honest
 *    states are reported and that nothing in the result could carry caption text.
 *  - **Incomplete metadata degrades, it does not fail** (§23 case 6). Comments
 *    disabled reports `null`, not 0, and every absent field is *named* in
 *    `missingFields` so the UI can say the seed is thin instead of rendering
 *    blanks that look like a bug.
 *  - **Every failure is a named state with a message Tally wrote** (§21, §23 cases
 *    19–20). Not configured, quota, refused, unreachable and not-found are
 *    distinguished, retryable is set only where retrying could work, and no
 *    provider message, URL, project id or stack reaches the returned object.
 *  - **§22 holds structurally.** The result has no field a media file could arrive
 *    in — asserted over the full key set, not merely by reading the type.
 *
 * `@/lib/providers/youtube` is replaced wholesale rather than partially: the real
 * module constructs a Google client from `env()`, and §23 forbids spending YouTube
 * quota in tests. Nothing here touches the network, so the "does the key work"
 * question is left to `verify:providers`, which is the only honest place for it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NotConfiguredError,
  ProviderError,
  ProviderRateLimitError,
  ValidationError,
} from "@/lib/errors";

/** What the fake provider is currently configured to do. Reset per test. */
const state = vi.hoisted(() => ({
  configured: true,
  /** The detail to return, or null for YouTube's empty `items` answer. */
  detail: null as Record<string, unknown> | null,
  /** Thrown from `fetchVideoDetailAs` when set. */
  detailError: null as unknown,
  /** Category id → title, or an error to throw from the lookup. */
  categories: new Map<string, string>(),
  categoryError: null as unknown,
  /** Every call the module made, so "one extra unit" claims are checkable. */
  calls: [] as string[],
}));

vi.mock("@/lib/providers/youtube", () => ({
  isYouTubePublicReadConfigured: () => state.configured,
  requirePublicReadCredential: () => {
    if (!state.configured) {
      throw new NotConfiguredError("YouTube public reads", ["YOUTUBE_API_KEY"]);
    }
    // A placeholder, and deliberately obviously not a key: nothing in this file
    // may resemble a credential (§25).
    return { kind: "api_key", apiKey: "unit-placeholder" };
  },
  fetchVideoDetailAs: (_credential: unknown, videoId: string) => {
    state.calls.push(`videos.list:${videoId}`);
    if (state.detailError) return Promise.reject(state.detailError);
    return Promise.resolve(state.detail);
  },
  fetchVideoCategoryTitlesAs: (_credential: unknown, region: string) => {
    state.calls.push(`videoCategories.list:${region}`);
    if (state.categoryError) return Promise.reject(state.categoryError);
    return Promise.resolve(state.categories);
  },
  watchUrl: (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`,
}));

const { analyzeSource, analyzeVideoId, inferTopics, parseIsoDuration, toStoredAnalysis } =
  await import("@/lib/youtube/source-analysis");

const ID = "dQw4w9WgXcQ";
const URL_ = `https://www.youtube.com/watch?v=${ID}`;
const NOW = new Date("2026-03-01T00:00:00.000Z");

/** A fully-populated `YouTubeVideoDetail`, as the happy path returns it. */
function fullDetail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    videoId: ID,
    title: "Smart Home Automation On A Budget",
    description: "  Everything I automated for under $200.  ",
    channelId: "UC_source_channel",
    channelTitle: "Wired Cottage",
    // Exactly 100 hours before NOW, so views/hour is an exact integer.
    publishedAt: new Date("2026-02-24T20:00:00.000Z"),
    categoryId: "28",
    tags: ["smart home automation", "home assistant", "diy", "no"],
    durationIso: "PT12M34S",
    privacyStatus: "public",
    defaultLanguage: "en",
    defaultAudioLanguage: "en-GB",
    viewCount: 250_000,
    likeCount: 12_000,
    commentCount: 900,
    thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
    captionsAvailable: true,
    madeForKids: false,
    ...over,
  };
}

beforeEach(() => {
  state.configured = true;
  state.detail = fullDetail();
  state.detailError = null;
  state.categories = new Map([["28", "Science & Technology"]]);
  state.categoryError = null;
  state.calls = [];
});

// ---------------------------------------------------------------------------
// §23 case 4 — source metadata retrieval
// ---------------------------------------------------------------------------

describe("analyzeSource — metadata retrieval (§23 case 4)", () => {
  it("reads the video and reports what YouTube returned", async () => {
    const result = await analyzeSource(URL_, { now: NOW });
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;

    const a = result.analysis;
    expect(a.videoId).toBe(ID);
    expect(a.url).toBe(URL_);
    expect(a.linkForm).toBe("watch");
    expect(a.title).toBe("Smart Home Automation On A Budget");
    expect(a.channelId).toBe("UC_source_channel");
    expect(a.channelTitle).toBe("Wired Cottage");
    expect(a.publishedAt?.toISOString()).toBe("2026-02-24T20:00:00.000Z");
    // The numeric id resolved to a name — reporting "28" to a user is not
    // reporting a category (§5).
    expect(a.categoryId).toBe("28");
    expect(a.categoryTitle).toBe("Science & Technology");
    expect(a.tags).toEqual(["smart home automation", "home assistant", "diy", "no"]);
    expect(a.durationSeconds).toBe(754);
    expect(a.privacyStatus).toBe("public");
    expect(a.viewCount).toBe(250_000);
    expect(a.likeCount).toBe(12_000);
    expect(a.commentCount).toBe(900);
    expect(a.madeForKids).toBe(false);
    // The description is trimmed but otherwise the uploader's own text.
    expect(a.description).toBe("Everything I automated for under $200.");
    // Spoken language wins over metadata language: it decides what to write in.
    expect(a.language).toBe("en-GB");
    expect(a.missingFields).toEqual([]);
  });

  it("derives views per hour and engagement rather than reading them", async () => {
    const result = await analyzeSource(URL_, { now: NOW });
    if (result.state !== "ok") throw new Error(result.message);

    // 250,000 views over exactly 100 hours.
    expect(result.analysis.viewsPerHour).toBeCloseTo(2_500, 6);
    // (12,000 + 3 x 900) / 250,000 — the same formula the channel-mode research
    // scorer uses, reused rather than reinvented for link mode (§6).
    expect(result.analysis.engagementRate).toBeCloseTo((12_000 + 2_700) / 250_000, 9);
  });

  it("builds the research seed from tags, then title, then category (§6)", async () => {
    const result = await analyzeSource(URL_, { now: NOW });
    if (result.state !== "ok") throw new Error(result.message);
    const { topics, niche } = result.analysis;

    // Whole multi-word tags first: "smart home automation" is a better search
    // probe than any of its words, and the words still follow for fit scoring.
    expect(topics[0]).toBe("smart home automation");
    expect(topics).toContain("home assistant");
    // Below three characters is noise, not a topic.
    expect(topics).not.toContain("no");
    // The category is the broadest signal, so it comes last.
    expect(topics[topics.length - 1]).toBe("Science & Technology");
    expect(topics.length).toBeLessThanOrEqual(12);
    // The niche is the longest multi-word tag — a phrase, not a keyword list.
    expect(niche).toBe("smart home automation");
  });

  it("names the niche from the category when no tag is a phrase", async () => {
    state.detail = fullDetail({ tags: ["diy"] });
    const result = await analyzeSource(URL_, { now: NOW });
    if (result.state !== "ok") throw new Error(result.message);
    expect(result.analysis.niche).toBe("Science & Technology");
  });

  it("leaves the niche null rather than inventing one", async () => {
    // An invented niche propagates into the research probes and the angle prompt,
    // which is where a wrong guess does real damage (§42).
    state.detail = fullDetail({ tags: [], title: "", categoryId: null });
    state.categories = new Map();
    const result = await analyzeSource(URL_, { now: NOW });
    if (result.state !== "ok") throw new Error(result.message);
    expect(result.analysis.niche).toBeNull();
    expect(result.analysis.topics).toEqual([]);
    // A video with no title is identified by its id, not by a placeholder that
    // reads like a real title.
    expect(result.analysis.title).toBe(`YouTube video ${ID}`);
  });

  it("accepts every URL form and a pre-validated id (§4)", async () => {
    for (const [input, form] of [
      [`https://youtu.be/${ID}`, "short_link"],
      [`https://www.youtube.com/shorts/${ID}`, "shorts"],
      [`https://m.youtube.com/watch?v=${ID}&list=PL1`, "watch"],
    ] as const) {
      const result = await analyzeSource(input, { now: NOW });
      if (result.state !== "ok") throw new Error(result.message);
      expect(result.analysis.linkForm).toBe(form);
      expect(result.analysis.videoId).toBe(ID);
    }

    // The worker path: the id arrives in a job payload, so there is no URL left
    // to re-parse.
    const fromWorker = await analyzeVideoId(ID, "bare_id", { now: NOW });
    expect(fromWorker.state).toBe("ok");
  });

  it("throws for input that is not a YouTube video link, rather than returning a state", async () => {
    // A bad paste is the user's input being wrong — a 400 with the specific
    // reason. Every other failure is the world being unavailable, and those are
    // returned states.
    await expect(analyzeSource("https://www.youtube.com/playlist?list=PL1")).rejects
      .toBeInstanceOf(ValidationError);
    expect(state.calls).toEqual([]);
  });

  it("skips the category lookup when asked, spending one unit instead of two", async () => {
    const result = await analyzeSource(URL_, { now: NOW, skipCategoryLookup: true });
    if (result.state !== "ok") throw new Error(result.message);
    expect(state.calls).toEqual([`videos.list:${ID}`]);
    // The id is still reported; only the *name* is unavailable, and that is a
    // missing field rather than a failed read.
    expect(result.analysis.categoryId).toBe("28");
    expect(result.analysis.categoryTitle).toBeNull();
    expect(result.analysis.missingFields).toContain("categoryName");
  });

  it("keeps the analysis when the category lookup fails", async () => {
    state.categoryError = new ProviderError("google", "categories exploded", {
      retryable: true,
    });
    const result = await analyzeSource(URL_, { now: NOW });
    // Presentational and one quota unit: losing the whole read over it would be
    // the wrong trade.
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    expect(result.analysis.categoryTitle).toBeNull();
    expect(result.analysis.missingFields).toContain("categoryName");
  });
});

// ---------------------------------------------------------------------------
// §23 case 5 — missing transcript
// ---------------------------------------------------------------------------

describe("analyzeSource — transcript handling (§23 case 5, §22)", () => {
  it("reports captions as the owner's to read, never as read", async () => {
    state.detail = fullDetail({ captionsAvailable: true });
    const result = await analyzeSource(URL_, { now: NOW });
    if (result.state !== "ok") throw new Error(result.message);
    // Not "available". The captions existing and Tally being able to read them
    // are different facts, and only the first is knowable from metadata.
    expect(result.analysis.transcript).toBe("owner_only");
  });

  it("distinguishes no captions from an unstated answer", async () => {
    state.detail = fullDetail({ captionsAvailable: false });
    const noneResult = await analyzeSource(URL_, { now: NOW });
    if (noneResult.state !== "ok") throw new Error(noneResult.message);
    expect(noneResult.analysis.transcript).toBe("none");

    state.detail = fullDetail({ captionsAvailable: null });
    const unknownResult = await analyzeSource(URL_, { now: NOW });
    if (unknownResult.state !== "ok") throw new Error(unknownResult.message);
    expect(unknownResult.analysis.transcript).toBe("unknown");
  });

  it("succeeds with a full analysis even though no transcript is ever fetched", async () => {
    // §5 "do not assume transcripts are available": the absence of a transcript
    // must not degrade anything else. The seed comes from metadata alone.
    state.detail = fullDetail({ captionsAvailable: false });
    const result = await analyzeSource(URL_, { now: NOW });
    if (result.state !== "ok") throw new Error(result.message);
    expect(result.analysis.topics.length).toBeGreaterThan(0);
    expect(result.analysis.niche).not.toBeNull();
    // A transcript state is not a missing field: it is a reported fact.
    expect(result.analysis.missingFields).not.toContain("transcript");
  });

  it("has nowhere for media or caption text to arrive (§22)", async () => {
    const result = await analyzeSource(URL_, { now: NOW });
    if (result.state !== "ok") throw new Error(result.message);

    // Asserted over the actual key set rather than trusted from the type: this is
    // the structural half of §22, and a field added later that could hold bytes
    // fails here.
    const keys = Object.keys(result.analysis);
    for (const forbidden of [
      "media",
      "bytes",
      "buffer",
      "audio",
      "video",
      "captions",
      "captionText",
      "transcriptText",
      "downloadUrl",
      "streamUrl",
      "filePath",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    // The thumbnail is a URL for display, not a file.
    expect(typeof result.analysis.thumbnailUrl).toBe("string");
    expect(result.analysis.thumbnailUrl).toMatch(/^https:\/\//);
    // Nothing in the analysis is a Buffer, at any depth this shape can nest.
    for (const value of Object.values(result.analysis)) {
      expect(Buffer.isBuffer(value)).toBe(false);
    }
    // Exactly two reads: the video and the category names. No third call that
    // could be a download.
    expect(state.calls).toEqual([`videos.list:${ID}`, "videoCategories.list:US"]);
  });
});

// ---------------------------------------------------------------------------
// §23 case 6 — incomplete metadata
// ---------------------------------------------------------------------------

describe("analyzeSource — incomplete metadata (§23 case 6)", () => {
  it("reports a disabled counter as null, not zero", async () => {
    state.detail = fullDetail({ commentCount: null, likeCount: null });
    const result = await analyzeSource(URL_, { now: NOW });
    if (result.state !== "ok") throw new Error(result.message);
    // Comments disabled and zero comments are different facts, and the second is
    // not measurable here (§42).
    expect(result.analysis.commentCount).toBeNull();
    expect(result.analysis.likeCount).toBeNull();
    expect(result.analysis.missingFields).toContain("commentCount");
    expect(result.analysis.missingFields).toContain("likeCount");
  });

  it("names every absent field so the UI can say the seed is thin", async () => {
    state.detail = fullDetail({
      title: "",
      description: "   ",
      tags: [],
      publishedAt: null,
      durationIso: null,
      viewCount: null,
      likeCount: null,
      commentCount: null,
      categoryId: null,
      channelTitle: null,
    });
    state.categories = new Map();

    const result = await analyzeSource(URL_, { now: NOW });
    // Still `ok`: an almost-empty answer from YouTube is a thin seed, not a
    // failure (§5 "handle incomplete metadata").
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;

    expect(result.analysis.missingFields).toEqual([
      "title",
      "description",
      "tags",
      "publishedAt",
      "duration",
      "viewCount",
      "likeCount",
      "commentCount",
      "category",
      "channelTitle",
    ]);
    // Derived figures cannot be computed from nothing and are not guessed.
    expect(result.analysis.viewsPerHour).toBeNull();
    expect(result.analysis.engagementRate).toBeNull();
  });

  it("truncates a long description instead of carrying it into a prompt whole", async () => {
    state.detail = fullDetail({ description: "x".repeat(9_000) });
    const result = await analyzeSource(URL_, { now: NOW });
    if (result.state !== "ok") throw new Error(result.message);
    expect(result.analysis.description).toHaveLength(2_000);
  });

  it("caps tags so a keyword-stuffed upload cannot flood the seed", async () => {
    state.detail = fullDetail({
      tags: Array.from({ length: 90 }, (_, i) => `tag phrase ${i}`),
    });
    const result = await analyzeSource(URL_, { now: NOW });
    if (result.state !== "ok") throw new Error(result.message);
    expect(result.analysis.tags).toHaveLength(40);
    expect(result.analysis.topics).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------
// §23 cases 19–20 — provider errors, retryable vs permanent
// ---------------------------------------------------------------------------

describe("analyzeSource — failure states (§21, §23 cases 19–20)", () => {
  it("reports not-configured with the variable name and no value (§48)", async () => {
    state.configured = false;
    const result = await analyzeSource(URL_, { now: NOW });
    expect(result.state).toBe("not_configured");
    if (result.state === "ok") return;

    expect(result.missingEnvVars).toEqual(["YOUTUBE_API_KEY"]);
    expect(result.retryable).toBe(false);
    expect(result.videoId).toBe(ID);
    // Named, never valued — and nothing was asked of YouTube.
    expect(result.message).toContain("YOUTUBE_API_KEY");
    expect(state.calls).toEqual([]);
  });

  it("reports an empty items array as not-found without guessing why", async () => {
    state.detail = null;
    const result = await analyzeSource(URL_, { now: NOW });
    expect(result.state).toBe("not_found");
    if (result.state === "ok") return;
    // Deleted, private, unlisted and region-blocked look identical on the wire,
    // so the message says what is verifiable and no more.
    expect(result.message).toMatch(/not available to read/i);
    expect(result.retryable).toBe(false);
    expect(result.missingEnvVars).toEqual([]);
  });

  it("distinguishes quota, refusal and unreachable, and marks only the transient ones retryable", async () => {
    const cases: ReadonlyArray<[unknown, string, boolean]> = [
      // The second argument is `retryAfterSeconds`, which is what makes this
      // error the retryable one.
      [new ProviderRateLimitError("google", 30), "quota_exceeded", true],
      [
        new ProviderError("google", "forbidden", { status: 403, retryable: false }),
        "unavailable",
        false,
      ],
      [
        new ProviderError("google", "bad gateway", { status: 502, retryable: true }),
        "unavailable",
        true,
      ],
      [new Error("socket hang up"), "unavailable", true],
    ];

    for (const [thrown, expected, retryable] of cases) {
      state.detailError = thrown;
      const result = await analyzeSource(URL_, { now: NOW });
      expect(result.state).toBe(expected);
      if (result.state === "ok") throw new Error("expected a failure state");
      // §23 case 20: quota resets and an unreachable API recovers; a refusal and
      // a missing key do not fix themselves.
      expect(result.retryable).toBe(retryable);
    }
  });

  it("never lets a provider message, URL or stack reach the caller (§21)", async () => {
    // The shape of a real Google failure: a project number, an internal URL and a
    // quota table are all things §21 forbids reaching the browser.
    state.detailError = new ProviderError(
      "google",
      "Request to https://youtube.googleapis.com/youtube/v3/videos?key=AIzaLEAKED " +
        "failed for project 1234567890: quotaExceeded at /var/app/src/lib/providers/youtube.ts:812",
      { status: 403, retryable: false, details: { projectId: "1234567890" } },
    );

    const result = await analyzeSource(URL_, { now: NOW });
    if (result.state === "ok") throw new Error("expected a failure state");

    const serialised = JSON.stringify(result);
    for (const leak of [
      "AIzaLEAKED",
      "googleapis.com",
      "1234567890",
      "/var/app",
      "key=",
    ]) {
      expect(serialised).not.toContain(leak);
    }
    // What the user gets instead is a sentence Tally wrote.
    expect(result.message).toMatch(/could not reach youtube|refused/i);
    // The stable code the UI branches on, not the provider's wording.
    expect(result.errorCode).toBe("provider_failed");
  });

  it("classifies a not-configured error raised by the provider itself", async () => {
    // The pre-check and the thrown error must agree: a credential removed between
    // the check and the call still reports the configuration state, not a crash.
    state.detailError = new NotConfiguredError("YouTube public reads", [
      "YOUTUBE_API_KEY",
    ]);
    const result = await analyzeSource(URL_, { now: NOW });
    expect(result.state).toBe("not_configured");
    if (result.state === "ok") return;
    expect(result.missingEnvVars).toEqual(["YOUTUBE_API_KEY"]);
    expect(result.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("parseIsoDuration", () => {
  it("parses the forms YouTube returns", () => {
    expect(parseIsoDuration("PT12M34S")).toBe(754);
    expect(parseIsoDuration("PT1H2M3S")).toBe(3_723);
    expect(parseIsoDuration("PT45S")).toBe(45);
    expect(parseIsoDuration("PT2M")).toBe(120);
    expect(parseIsoDuration("P1DT2H")).toBe(93_600);
    expect(parseIsoDuration("PT1M30.5S")).toBe(91);
  });

  it("returns null for a duration that is not one", () => {
    // `P0D` is what YouTube returns for a live stream or an unprocessed upload:
    // a real value meaning "no duration", not zero seconds.
    expect(parseIsoDuration("P0D")).toBeNull();
    expect(parseIsoDuration(null)).toBeNull();
    expect(parseIsoDuration("")).toBeNull();
    expect(parseIsoDuration("12:34")).toBeNull();
    expect(parseIsoDuration("not a duration")).toBeNull();
  });
});

describe("inferTopics", () => {
  it("deduplicates case-insensitively and keeps the first spelling", () => {
    const topics = inferTopics(
      { title: "Home Assistant tips", tags: ["Home Assistant", "home assistant"] },
      null,
    );
    expect(topics.filter((t) => t.toLowerCase() === "home assistant")).toHaveLength(1);
    expect(topics[0]).toBe("Home Assistant");
  });

  it("is a mechanical function of its input, not a model call", () => {
    // The seed has to be reproducible: §6 turns it into search probes, and an
    // unstable seed would make the same link research differently each time.
    const input = { title: "Budget smart home", tags: ["smart home", "budget"] };
    expect(inferTopics(input, "Technology")).toEqual(inferTopics(input, "Technology"));
  });
});

describe("toStoredAnalysis", () => {
  it("survives a jsonb round trip with no Date and no media field", async () => {
    const result = await analyzeSource(URL_, { now: NOW });
    if (result.state !== "ok") throw new Error(result.message);

    const stored = toStoredAnalysis(result.analysis);
    const round = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;

    // A Date does not survive jsonb as a Date, so timestamps are written as ISO
    // strings and the reader knows to parse them.
    expect(stored["publishedAt"]).toBe("2026-02-24T20:00:00.000Z");
    expect(round).toEqual(stored);
    // Explicit field list, not a spread: the durable record cannot silently grow.
    expect(Object.keys(stored)).not.toContain("linkFormRaw");
    expect(stored["transcript"]).toBe("owner_only");
    expect(JSON.stringify(stored)).not.toContain("unit-placeholder");
  });
});

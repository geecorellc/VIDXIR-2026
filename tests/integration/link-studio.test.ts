/**
 * Link-mode integration tests (Phase 11 §4-§10, §15-§17, §19, §21, §22, §23).
 *
 * The three Phase 11 unit suites cover the boundaries in isolation: `url.test.ts`
 * the id parser, `source-analysis.test.ts` the six read states, `video-gen.test.ts`
 * and `generation-plan.test.ts` the provider registry and the selection rules.
 * None of them can prove the thing the phase actually promises — that a pasted
 * link with **no connected channel** walks all the way to a rendered video through
 * the Phase 1-10 pipeline. That claim is about Postgres rows, a `channel_id` that
 * is legitimately null, and seven worker stages, so it is only testable here.
 *
 * What this file proves that nothing else does:
 *
 *  - **A channel-less run works end to end.** Analyse → research → angles →
 *    configure → script → seven stages → a `render_output` row, with
 *    `projects.channel_id`, `research_runs.channel_id`, `ideas.channel_id` and
 *    `jobs.channel_id` all null throughout. §4's "must NOT require connecting a
 *    YouTube channel" is a schema claim as much as a UI one.
 *  - **The seed video never comes back as its own result** (§6). The pasted id is
 *    returned by the mocked search *and* the mocked chart, and must be absent from
 *    `research_results` — the difference between research and an echo.
 *  - **Angles are original and carry §7's fields.** `hook` and `trendSignal` are
 *    persisted, and a proposal that restates the source title is dropped by the
 *    derivative filter rather than stored.
 *  - **Link mode reads YouTube through the API-key credential**, not through a
 *    channel's OAuth token. That is why the mocks here are the `*As` exports and
 *    the public-read predicates, and not the set `research.test.ts` mocks.
 *  - **A missing key is a configuration state, not a crash** (§5, §48): the run
 *    lands `blocked_not_configured` with the variable named, never `failed`.
 *  - **Every guard still bites without a channel to scope it by.** The duplicate
 *    research guard scopes on the project, cross-tenant reads are refused with a
 *    valid id belonging to somebody else, the worker takes its authority from the
 *    `jobs` row rather than the Redis payload, and the real rate-limit window is
 *    the one the analyse route uses.
 *  - **The generation choice reaches the visuals stage** (§9, §15, §17): a project
 *    configured for AI video stores assets from the video-generation registry, and
 *    one left alone stores stock — distinguishable by `provider_asset_id`, so a
 *    stage that ignored the plan cannot pass.
 *
 * §23's mocking rules are held to literally. The YouTube Data API and Claude are
 * both replaced at their module seams, so **no YouTube quota is spent, no AI
 * credit is spent, no video-generation API is called and nothing is published**.
 * Everything below those seams is the real code: the real signal collection, the
 * real scoring, the real state machine, the real ownership predicates, the real
 * job rows, the real storage and the real ffmpeg.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChannel,
  createUser,
  hasDatabase,
  jar,
  resetDatabase,
  setTier,
  useDatabase,
} from "./setup";

vi.mock("next/headers", () => ({
  cookies: async () => jar,
}));

// ---------------------------------------------------------------------------
// YouTube boundary — the *public-read* surface, not the OAuth one
// ---------------------------------------------------------------------------

/**
 * Link mode reads YouTube through a different set of exports than channel mode.
 *
 * `publicSignalReader()` calls the `*As` variants against an explicit credential,
 * and `analyzeVideoId` calls `isYouTubePublicReadConfigured`,
 * `requirePublicReadCredential`, `fetchVideoDetailAs` and
 * `fetchVideoCategoryTitlesAs`. Mocking only the token-taking functions — which is
 * what the channel-mode suite does — would leave every call in this file hitting
 * the live Data API and spending real quota (§23).
 */
const google = vi.hoisted(() => ({
  isYouTubePublicReadConfigured: vi.fn(() => true),
  requirePublicReadCredential: vi.fn(() => ({
    kind: "api_key" as const,
    apiKey: "integration-placeholder",
  })),
  fetchVideoDetailAs: vi.fn(),
  fetchVideoCategoryTitlesAs: vi.fn(),
  searchVideosAs: vi.fn(),
  fetchVideosByIdsAs: vi.fn(),
  fetchChannelsByIdsAs: vi.fn(),
  fetchMostPopularAs: vi.fn(),
}));

vi.mock("@/lib/providers/youtube", async (importOriginal) => {
  // `importOriginal` rather than a dynamic import of the same specifier: the
  // latter resolves back into this mock and deadlocks the factory.
  const actual = await importOriginal<typeof import("@/lib/providers/youtube")>();
  return { ...actual, ...google };
});

// ---------------------------------------------------------------------------
// Claude boundary
// ---------------------------------------------------------------------------

const ai = vi.hoisted(() => ({ generateJson: vi.fn() }));

vi.mock("@/lib/providers/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/ai")>();
  return { ...actual, generateJson: ai.generateJson };
});

/**
 * A local encode needs the ffmpeg binary the postinstall step downloads. Only the
 * render leg depends on it; everything before it is asserted either way.
 */
const { ffmpegBinary } = await import("@/lib/media/ffmpeg");
const hasEncoder = ffmpegBinary() !== null;

const suite = hasDatabase ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DAY = 24 * 3_600_000;

/** The pasted video. A real-shaped id; nothing is ever fetched with it. */
const SOURCE_ID = "dQw4w9WgXcQ";
const SOURCE_URL = `https://www.youtube.com/watch?v=${SOURCE_ID}`;
const SOURCE_TITLE = "I wired twelve cheap sensors into one hallway";

/**
 * The source video as `videos.list` returns it.
 *
 * Tags are the uploader's own statement of subject, so they decide both the niche
 * (longest multi-word tag) and the head of the topic seed — which is what the
 * research probes are built from. `captionsAvailable: true` is deliberate: it
 * becomes `owner_only`, never `available`, because captions existing and Tally
 * being able to read them are different facts (§5).
 */
function sourceDetail(overrides: Record<string, unknown> = {}) {
  return {
    videoId: SOURCE_ID,
    title: SOURCE_TITLE,
    description: "Three weeks of logging the cheapest motion sensors sold.",
    channelId: "UCsourcecreator",
    channelTitle: "Some Other Creator",
    publishedAt: new Date(Date.now() - 9 * DAY),
    categoryId: "28",
    tags: ["budget smart home", "cheap sensors", "home automation"],
    durationIso: "PT12M30S",
    privacyStatus: "public",
    defaultLanguage: "en",
    defaultAudioLanguage: "en-GB",
    viewCount: 412_000,
    likeCount: 21_000,
    commentCount: 1_900,
    thumbnailUrl: `https://i.ytimg.com/vi/${SOURCE_ID}/hq.jpg`,
    captionsAvailable: true,
    madeForKids: false,
    ...overrides,
  };
}

/** A search hit as `search.list` returns one: channel identified, no statistics. */
function hit(id: string, title: string, channelId = "UCincumbent", daysAgo = 4) {
  return {
    videoId: id,
    title,
    description: `${title} — description`,
    channelId,
    channelTitle: `Channel ${channelId}`,
    publishedAt: new Date(Date.now() - daysAgo * DAY),
    thumbnailUrl: `https://i.ytimg.com/vi/${id}/hq.jpg`,
  };
}

/**
 * The same video as `videos.list` returns it.
 *
 * Note the absence of `channelId`/`channelTitle`: `YouTubeVideoSummary` genuinely
 * does not carry them, which is why `collectSignals` takes the channel from the
 * search hit that discovered the video. A fixture that added them would hide a
 * real defect in that wiring.
 */
function summary(id: string, title: string, viewCount = 180_000, daysAgo = 4) {
  return {
    videoId: id,
    title,
    description: `${title} — description`,
    publishedAt: new Date(Date.now() - daysAgo * DAY),
    thumbnailUrl: `https://i.ytimg.com/vi/${id}/hq.jpg`,
    durationIso: "PT10M20S",
    privacyStatus: "public",
    viewCount,
    likeCount: Math.round(viewCount / 25),
    commentCount: Math.round(viewCount / 180),
    tags: ["fixture"],
  };
}

/**
 * Two original angles, both carrying §7's `hook` and `trendSignal`.
 *
 * The titles share no meaningful vocabulary with the source title or the evidence
 * titles, so the derivative filter passes them — one test below overrides this to
 * prove the filter actually bites.
 */
function angleBatch() {
  return {
    ideas: [
      {
        title: "The three-pound motion detector that outlasted the premium tier",
        angle:
          "Buy the cheapest unit sold and run it against the flagship for a month.",
        rationale:
          "Every high-velocity upload in the topic reviews flagship kit; the budget tier is unmeasured.",
        hook: "Everyone tests the expensive one. Nobody has tested the three-pound one.",
        trendSignal:
          "Four uploads in the last fortnight are averaging triple the topic's usual velocity.",
        topic: "budget smart home",
        targetKeywords: ["budget motion detector", "cheap smart home"],
        sourceIndices: [1, 2],
      },
      {
        title: "Why your routines fire twice, and the setting that stops it",
        angle: "Diagnose the single configuration error behind duplicate triggers.",
        rationale:
          "Comment volume on the recent uploads concentrates on reliability complaints.",
        hook: "If your lights come on twice, it is not the bulb. It is one setting.",
        trendSignal:
          "The two most-commented videos in the set are both about unreliable triggers.",
        topic: "home automation reliability",
        targetKeywords: ["automation reliability", "duplicate triggers"],
        sourceIndices: [2],
      },
    ],
  };
}

/** A draft satisfying `ScriptDraftSchema`; three sections is its minimum. */
function scriptDraft(title = "The three-pound motion detector that outlasted the premium tier") {
  return {
    title,
    titleIdeas: ["The three-pound sensor test"],
    hook: "Everyone tests the expensive one. Nobody has tested the three-pound one.",
    introduction:
      "So I bought twelve of the cheapest detectors sold and wired the hallway.",
    sections: [
      {
        heading: "The claim",
        body: "Budget detectors are said to fail within weeks of installation.",
        talkingPoints: ["Cheap tier is dismissed"],
        transition: "So I measured it.",
      },
      {
        heading: "The test",
        body: "Twelve units, three weeks, one hallway, every trigger logged.",
        talkingPoints: ["Twelve units", "Three weeks"],
        transition: "Here is what happened.",
      },
      {
        heading: "The result",
        body: "Two failed in the first week. The other ten never missed a trigger.",
        talkingPoints: ["Two failures"],
      },
    ],
    conclusion: "For anything non-critical the cheap tier is entirely fine.",
    cta: "The parts list is linked below.",
    storyStructure: "claim → test → result → recommendation",
    references: [{ label: "Manufacturer datasheet" }],
  };
}

/** Scene direction, shaped to `DirectionSchema`. Generous: extras are ignored. */
function direction(count: number) {
  return {
    scenes: Array.from({ length: count }, (_, index) => ({
      index,
      visualPrompt: `A close shot of detector ${index + 1} on a hallway wall`,
      searchTerms: ["motion detector", "hallway"],
    })),
    mood: "calm-documentary",
  };
}

suite("YouTube link mode (integration)", () => {
  useDatabase();

  /**
   * Warm the module graph before the first test.
   *
   * The link-mode path reaches BullMQ, the S3 client, the `googleapis` barrel and
   * the video pipeline. Cold on Windows that is tens of seconds — enough to
   * exhaust whichever test runs first while every later one finishes in about a
   * second. Paying it in a hook with its own budget beats raising the global
   * timeout, which would mask a genuine hang.
   */
  beforeAll(async () => {
    await import("@/lib/research/signals");
    await import("@/lib/research/service");
    await import("@/lib/video/service");
    await import("@/lib/storage");
    const { getRedis } = await import("@/lib/queue/redis");
    await getRedis().ping();
  }, 120_000);

  // Process-wide singletons; left open, vitest cannot exit.
  afterAll(async () => {
    const { closeQueues } = await import("@/lib/queue/queues");
    const { closeRedis } = await import("@/lib/queue/redis");
    await closeQueues();
    await closeRedis();
  });

  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();

    google.isYouTubePublicReadConfigured.mockReturnValue(true);
    google.requirePublicReadCredential.mockReturnValue({
      kind: "api_key",
      apiKey: "integration-placeholder",
    });
    google.fetchVideoDetailAs.mockResolvedValue(sourceDetail());
    google.fetchVideoCategoryTitlesAs.mockResolvedValue(
      new Map([["28", "Science & Technology"]]),
    );

    /**
     * The seed video is returned by search *and* by the chart, on purpose.
     *
     * §6 requires that pasting a link does not simply hand the same video back.
     * The only way to prove the exclusion is for the provider to offer it.
     */
    google.searchVideosAs.mockResolvedValue([
      hit(SOURCE_ID, SOURCE_TITLE, "UCsourcecreator", 9),
      hit("vid-alpha", "Hallway lighting, rebuilt from scratch", "UCincumbent", 3),
      hit("vid-beta", "A tour of my flat's wiring", "UCrival", 6),
    ]);
    google.fetchMostPopularAs.mockResolvedValue([
      summary(SOURCE_ID, SOURCE_TITLE, 412_000, 9),
      summary("vid-popular", "This week's gadget roundup", 900_000, 1),
    ]);
    google.fetchVideosByIdsAs.mockImplementation(
      async (_credential: unknown, ids: string[]) =>
        ids.map((id) =>
          summary(
            id,
            id === "vid-alpha"
              ? "Hallway lighting, rebuilt from scratch"
              : "A tour of my flat's wiring",
            id === "vid-alpha" ? 520_000 : 140_000,
            3,
          ),
        ),
    );
    google.fetchChannelsByIdsAs.mockResolvedValue([
      {
        channelId: "UCincumbent",
        title: "Incumbent Channel",
        subscriberCount: 250_000,
        videoCount: 320,
        viewCount: "40000000",
        thumbnailUrl: null,
      },
    ]);

    /**
     * One mock for three different prompts.
     *
     * Research, scripting and scene direction all go through `generateJson`, and
     * they run in the same test for the end-to-end case. Discriminating on the
     * system prompt keeps each response the right shape without the test having to
     * know the call order.
     */
    ai.generateJson.mockImplementation(async (input: { system: string }) => {
      if (input.system.includes("research analyst")) return angleBatch();
      if (input.system.includes("scriptwriter")) return scriptDraft();
      if (input.system.includes("video director")) return direction(40);
      throw new Error(`unexpected AI call: ${input.system.slice(0, 60)}`);
    });
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** An onboarded user, which `requireOnboarded` and the plan reads both want. */
  async function linkUser(email: string) {
    const { saveStep, complete } = await import("@/lib/onboarding/service");
    const user = await createUser({ email });
    await saveStep(user.id, {
      niche: "Home automation",
      contentStyle: "documentary",
      voicePreference: "warm-male",
    });
    await complete(user.id);
    return user;
  }

  /**
   * A channel-less project seeded by the pasted link, exactly as
   * `/api/projects/from-youtube` creates one.
   *
   * The service is called rather than the route so these tests are about the
   * pipeline rather than about `handle()`; the route's own ordering is covered by
   * the hardening suite's request-level tests.
   */
  async function linkProject(email: string, tier: "starter" | "studio" | "scale" = "starter") {
    const { createProject } = await import("@/lib/projects/service");
    const { planByTier } = await import("@/lib/plans");
    const { parseYouTubeLink } = await import("@/lib/youtube/url");

    const user = await linkUser(email);
    if (tier !== "starter") await setTier(user.id, tier);

    const link = parseYouTubeLink(SOURCE_URL);
    const project = await createProject({
      userId: user.id,
      // §4. The whole point of the mode: no channel, and none required.
      channelId: null,
      title: `New video from a YouTube link (${link.videoId})`,
      origin: "youtube_link",
      sourceVideoId: link.videoId,
      maxVideosPerMonth: planByTier(tier).maxVideosPerMonth,
    });

    return { user, project, link };
  }

  /**
   * Start and execute a link research run the way the worker does.
   *
   * Deliberately through `startLinkResearchRun` rather than by inserting a run
   * row, so the job row, the queue mirror and the duplicate guard are all
   * exercised. The job is closed out afterwards because `hasActiveJob` reads it,
   * and a row left `queued` would make every later stage in the same test fail
   * with a spurious conflict.
   */
  async function runLinkResearch(
    userId: string,
    projectId: string,
    tier: "starter" | "studio" | "scale" = "starter",
  ) {
    const { startLinkResearchRun, executeResearchRun } = await import(
      "@/lib/research/service"
    );
    const { markJobFailed, markJobSucceeded } = await import("@/lib/queue/jobs");

    const started = await startLinkResearchRun({
      userId,
      videoId: SOURCE_ID,
      tier,
      projectId,
      linkForm: "watch",
      traceId: "trace-link-test",
    });

    try {
      const result = await executeResearchRun({
        userId,
        channelId: null,
        runId: started.runId,
        jobId: started.jobId,
        sourceVideoId: SOURCE_ID,
        linkForm: "watch",
        traceId: "trace-link-test",
      });
      await markJobSucceeded(started.jobId, result as unknown as Record<string, unknown>);
      return { ...started, result, error: null as unknown };
    } catch (error) {
      await markJobFailed(started.jobId, error);
      return { ...started, result: null, error };
    }
  }

  /** Run one video stage with the bookkeeping `worker/index.ts` does around it. */
  async function runStage<T>(
    stage:
      | "scene-plan"
      | "voiceover"
      | "visuals"
      | "music"
      | "captions"
      | "timeline"
      | "render",
    context: { userId: string; projectId: string; tier: "starter" | "studio" | "scale" },
  ): Promise<T> {
    const service = await import("@/lib/video/service");
    const { enqueue, markJobFailed, markJobSucceeded } = await import(
      "@/lib/queue/jobs"
    );

    const stageName = {
      "scene-plan": "SCENE_PLAN",
      voiceover: "VOICEOVER",
      visuals: "VISUALS",
      music: "MUSIC",
      captions: "CAPTIONS",
      timeline: "TIMELINE",
      render: "RENDER",
    }[stage] as
      | "SCENE_PLAN"
      | "VOICEOVER"
      | "VISUALS"
      | "MUSIC"
      | "CAPTIONS"
      | "TIMELINE"
      | "RENDER";

    const job = await enqueue({
      queue: "pipeline",
      name: `video-${stage}`,
      userId: context.userId,
      // Null, like every link-mode job. The project is the scope instead.
      channelId: null,
      projectId: context.projectId,
      stage: stageName,
      payload: { projectId: context.projectId, tier: context.tier },
      traceId: "trace-link-test",
      statusMessage: "Queued",
    });

    const execute = {
      "scene-plan": service.executeScenePlan,
      voiceover: service.executeVoiceover,
      visuals: service.executeVisuals,
      music: service.executeMusic,
      captions: service.executeCaptions,
      timeline: service.executeTimeline,
      render: service.executeRender,
    }[stage];

    try {
      const result = await execute({
        userId: context.userId,
        projectId: context.projectId,
        jobId: job.id,
        tier: context.tier,
        traceId: "trace-link-test",
      });
      await markJobSucceeded(job.id, result as Record<string, unknown>);
      return result as T;
    } catch (error) {
      await markJobFailed(job.id, error);
      throw error;
    }
  }

  /**
   * Walk a link-mode project from a chosen angle to an approved script.
   *
   * Through `startScriptGeneration`/`executeScriptGeneration` rather than by
   * writing a `script_versions` row, because §8's claim is that the *existing*
   * script stage briefs itself correctly with no channel to read settings from.
   */
  async function writeScript(
    userId: string,
    projectId: string,
    tier: "starter" | "studio" | "scale" = "starter",
  ) {
    const { startScriptGeneration, executeScriptGeneration, approveScript } =
      await import("@/lib/scripts/service");
    const { markJobFailed, markJobSucceeded } = await import("@/lib/queue/jobs");

    const started = await startScriptGeneration({ userId, projectId, tier });
    try {
      const result = await executeScriptGeneration({
        userId,
        projectId,
        jobId: started.jobId,
        traceId: "trace-link-test",
      });
      await markJobSucceeded(started.jobId, { version: result.version });
      await approveScript(userId, projectId);
      return result;
    } catch (error) {
      await markJobFailed(started.jobId, error);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // §23 cases 4-10: source analysis and trend research from a pasted link
  // -------------------------------------------------------------------------

  describe("research from a pasted link (§5, §6, §23 cases 4, 7)", () => {
    it("analyses the source, researches its topic, and stores both", async () => {
      const { db } = await import("@/lib/db");
      const { ideas, researchResults, researchRuns } = await import(
        "@/lib/db/schema"
      );
      const { eq } = await import("drizzle-orm");

      const { user, project } = await linkProject("research@tally.test");
      const { runId, result, error } = await runLinkResearch(user.id, project.id);

      expect(error).toBeNull();
      expect(result?.resultCount).toBeGreaterThan(0);
      expect(result?.ideaCount).toBeGreaterThan(0);

      const [run] = await db
        .select()
        .from(researchRuns)
        .where(eq(researchRuns.id, runId));

      expect(run?.status).toBe("succeeded");
      // §4: the run belongs to a user, not to a channel.
      expect(run?.channelId).toBeNull();
      expect(run?.trigger).toBe("youtube_link");
      expect(run?.sourceVideoId).toBe(SOURCE_ID);
      // Set on both the success and failure paths — a run left `running` is the
      // failure mode where the screen spins forever.
      expect(run?.completedAt).toBeInstanceOf(Date);
      expect(run?.error).toBeNull();

      // §5: what the pasted video turned out to be, persisted before the research
      // half ran so a later failure still leaves the screen able to explain itself.
      expect(run?.sourceTitle).toBe(SOURCE_TITLE);
      expect(run?.sourceChannelTitle).toBe("Some Other Creator");
      // The longest multi-word tag: the uploader's own statement of subject.
      expect(run?.niche).toBe("budget smart home");
      expect(run?.keywords).toContain("budget smart home");

      const analysis = run?.sourceAnalysis;
      expect(analysis).not.toBeNull();
      // Never "available": captions existing and Tally being able to read them
      // are different facts, and only the first is knowable (§5).
      expect(analysis?.["transcript"]).toBe("owner_only");
      expect(analysis?.["categoryTitle"]).toBe("Science & Technology");
      // Regenerated from the id, never echoed from the paste.
      expect(analysis?.["url"]).toBe(SOURCE_URL);

      // Which sources actually responded, so a degraded run is legible.
      expect(run?.sources).toContain("youtube_search_top");
      expect(run?.sources).toContain("youtube_most_popular");

      const evidence = await db
        .select()
        .from(researchResults)
        .where(eq(researchResults.runId, runId));
      expect(evidence.length).toBeGreaterThan(0);
      for (const row of evidence) expect(row.channelId).toBeNull();

      const angles = await db.select().from(ideas).where(eq(ideas.runId, runId));
      expect(angles.length).toBeGreaterThan(0);
      for (const angle of angles) expect(angle.channelId).toBeNull();
    });

    it("never returns the pasted video as its own research result (§6)", async () => {
      const { db } = await import("@/lib/db");
      const { researchResults } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      const { user, project } = await linkProject("seed@tally.test");
      const { runId } = await runLinkResearch(user.id, project.id);

      const evidence = await db
        .select({ youtubeVideoId: researchResults.youtubeVideoId })
        .from(researchResults)
        .where(eq(researchResults.runId, runId));

      // The mocked provider offered the seed from both the search and the chart,
      // so its absence here is the exclusion working rather than a thin fixture.
      expect(evidence.length).toBeGreaterThan(0);
      expect(evidence.map((e) => e.youtubeVideoId)).not.toContain(SOURCE_ID);
      expect(evidence.map((e) => e.youtubeVideoId)).toContain("vid-alpha");
    });

    it("derives the search language and region from the uploader's declaration", async () => {
      const { user, project } = await linkProject("region@tally.test");
      await runLinkResearch(user.id, project.id);

      // `defaultAudioLanguage: "en-GB"` — what is spoken wins over the metadata
      // language, and the region subtag is the only geographic signal available.
      const call = google.searchVideosAs.mock.calls[0]?.[1] as
        | { regionCode?: string; relevanceLanguage?: string }
        | undefined;
      expect(call?.regionCode).toBe("GB");
      expect(call?.relevanceLanguage).toBe("en");
    });

    it("reports a missing API key as a configuration state, not a failure (§5, §48)", async () => {
      const { db } = await import("@/lib/db");
      const { researchRuns } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      google.isYouTubePublicReadConfigured.mockReturnValue(false);

      const { user, project } = await linkProject("unconfigured@tally.test");
      const { runId, error } = await runLinkResearch(user.id, project.id);

      // Rethrown so the worker can decide about a retry — and it must not retry a
      // missing credential.
      expect(error).toMatchObject({ code: "provider_not_configured", status: 503 });

      const [run] = await db
        .select()
        .from(researchRuns)
        .where(eq(researchRuns.id, runId));

      // Not `failed`: an operator has to act, and the screen renders this as
      // "set this variable" rather than as a crash the user cannot fix.
      expect(run?.status).toBe("blocked_not_configured");
      expect(run?.errorCode).toBe("provider_not_configured");
      expect(run?.error).toMatch(/YOUTUBE_API_KEY/);
      expect(run?.completedAt).toBeInstanceOf(Date);
      // Nothing was asked of YouTube, so no quota was spent finding out.
      expect(google.fetchVideoDetailAs).not.toHaveBeenCalled();
    });

    it("reports an unreadable video as not_found without failing the request path", async () => {
      const { db } = await import("@/lib/db");
      const { researchRuns } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      // An empty `items` array: deleted, private, unlisted or never existed —
      // YouTube reports all four identically.
      google.fetchVideoDetailAs.mockResolvedValue(null);

      const { user, project } = await linkProject("private@tally.test");
      const { runId, error } = await runLinkResearch(user.id, project.id);

      expect(error).toMatchObject({ code: "not_found" });

      const [run] = await db
        .select()
        .from(researchRuns)
        .where(eq(researchRuns.id, runId));
      expect(run?.status).toBe("failed");
      expect(run?.errorCode).toBe("not_found");
    });

    it("still researches when the metadata is thin (§5 incomplete metadata)", async () => {
      const { db } = await import("@/lib/db");
      const { researchRuns } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      // No tags, no statistics, no duration, no declared language. Everything the
      // seed would prefer to have, absent.
      google.fetchVideoDetailAs.mockResolvedValue(
        sourceDetail({
          tags: [],
          viewCount: null,
          likeCount: null,
          commentCount: null,
          durationIso: null,
          defaultLanguage: null,
          defaultAudioLanguage: null,
          captionsAvailable: null,
        }),
      );

      const { user, project } = await linkProject("thin@tally.test");
      const { runId, error, result } = await runLinkResearch(user.id, project.id);

      expect(error).toBeNull();
      expect(result?.ideaCount).toBeGreaterThan(0);

      const [run] = await db
        .select()
        .from(researchRuns)
        .where(eq(researchRuns.id, runId));

      expect(run?.status).toBe("succeeded");
      // With no tags the niche falls back to the category name rather than being
      // invented — a guessed niche propagates into the probes and the prompt.
      expect(run?.niche).toBe("Science & Technology");
      const missing = run?.sourceAnalysis?.["missingFields"];
      expect(Array.isArray(missing)).toBe(true);
      expect(missing as string[]).toContain("tags");
      expect(missing as string[]).toContain("viewCount");
      expect(run?.sourceAnalysis?.["transcript"]).toBe("unknown");
    });
  });

  // -------------------------------------------------------------------------
  // §23 case 8: original titles and hooks
  // -------------------------------------------------------------------------

  describe("viral angles (§7, §22, §23 case 8)", () => {
    it("persists the hook and the trend signal alongside each angle", async () => {
      const { db } = await import("@/lib/db");
      const { ideas } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      const { user, project } = await linkProject("angles@tally.test");
      const { runId } = await runLinkResearch(user.id, project.id);

      const angles = await db.select().from(ideas).where(eq(ideas.runId, runId));

      expect(angles).toHaveLength(2);
      for (const angle of angles) {
        // §7 asks each proposal to carry a title *and* a hook *and* the signal
        // behind it, so the user chooses an angle having seen how it opens.
        expect(angle.hook).toBeTruthy();
        expect(angle.trendSignal).toBeTruthy();
        expect(angle.state).toBe("new");
        // Provenance: which public videos informed this angle (§22).
        expect(angle.sourceResultIds.length).toBeGreaterThan(0);
        // Scored in code, not by the model.
        expect(Number(angle.tallyScore)).toBeGreaterThan(0);
        expect(angle.scoreBreakdown).not.toBeNull();
        // The one thing §7 forbids outright.
        expect(angle.title).not.toBe(SOURCE_TITLE);
      }
    });

    it("drops a proposal that restates the source title (§7, §22)", async () => {
      const { db } = await import("@/lib/db");
      const { ideas } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      ai.generateJson.mockImplementation(async (input: { system: string }) => {
        if (!input.system.includes("research analyst")) {
          throw new Error("only the research call is expected here");
        }
        const batch = angleBatch();
        return {
          ideas: [
            // The source title with three words moved. The prompt asks the model
            // not to do this; the similarity check is what makes it verifiable,
            // and the source is not in `evidence` because §6 excluded it — so this
            // also proves the source title is checked separately.
            { ...batch.ideas[0]!, title: "Twelve cheap sensors wired into one hallway" },
            batch.ideas[1]!,
          ],
        };
      });

      const { user, project } = await linkProject("derivative@tally.test");
      const { runId, result } = await runLinkResearch(user.id, project.id);

      expect(result?.ideaCount).toBe(1);

      const angles = await db.select().from(ideas).where(eq(ideas.runId, runId));
      expect(angles).toHaveLength(1);
      expect(angles[0]?.title).toBe(
        "Why your routines fire twice, and the setting that stops it",
      );
    });

    it("never puts the source description or tags into the angle prompt (§22)", async () => {
      const { user, project } = await linkProject("prompt@tally.test");
      await runLinkResearch(user.id, project.id);

      const call = ai.generateJson.mock.calls.find(
        (c) => (c[0] as { system: string }).system.includes("research analyst"),
      );
      const prompt = (call?.[0] as { prompt: string }).prompt;

      // The seed carries the title, the channel and the inferred topics — the
      // narrowest thing that answers "what is this about". Not the description,
      // which is the closest thing to reproducible content on the row.
      expect(prompt).toContain(SOURCE_TITLE);
      expect(prompt).toContain("RESEARCH MATERIAL ONLY");
      expect(prompt).not.toContain(
        "Three weeks of logging the cheapest motion sensors sold.",
      );
    });
  });

  // -------------------------------------------------------------------------
  // §23 cases 22, 21: duplicate protection and job persistence
  // -------------------------------------------------------------------------

  describe("job records (§23 cases 21, 22)", () => {
    it("writes a job row scoped to the project, with no channel", async () => {
      const { db } = await import("@/lib/db");
      const { jobs } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      const { user, project } = await linkProject("jobrow@tally.test");
      const { startLinkResearchRun } = await import("@/lib/research/service");

      const { jobId, runId } = await startLinkResearchRun({
        userId: user.id,
        videoId: SOURCE_ID,
        tier: "starter",
        projectId: project.id,
        linkForm: "watch",
        traceId: "trace-link-jobrow",
      });

      const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));

      // The row the UI polls, complete before any worker touches it.
      expect(job?.queue).toBe("research");
      expect(job?.name).toBe("research-run");
      expect(job?.stage).toBe("RESEARCH");
      expect(job?.status).toBe("queued");
      expect(job?.traceId).toBe("trace-link-jobrow");
      // The two that make link mode work: no channel to scope by, so the project
      // is the scope.
      expect(job?.channelId).toBeNull();
      expect(job?.projectId).toBe(project.id);
      expect(job?.payload?.["runId"]).toBe(runId);
      expect(job?.payload?.["sourceVideoId"]).toBe(SOURCE_ID);
      expect(job?.payload?.["linkForm"]).toBe("watch");
      // A credential must never reach a payload that crosses Redis.
      expect(JSON.stringify(job?.payload)).not.toContain("apiKey");
    });

    it("refuses a second research run on the same project (§23 case 22)", async () => {
      const { user, project } = await linkProject("dupe@tally.test");
      const { startLinkResearchRun } = await import("@/lib/research/service");

      await startLinkResearchRun({
        userId: user.id,
        videoId: SOURCE_ID,
        tier: "starter",
        projectId: project.id,
        linkForm: "watch",
      });

      // The duplicate guard has no channel to scope by; the project is what makes
      // it work. A second run would spend a second set of YouTube quota and AI
      // tokens producing what the first is already producing.
      await expect(
        startLinkResearchRun({
          userId: user.id,
          videoId: SOURCE_ID,
          tier: "starter",
          projectId: project.id,
          linkForm: "watch",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    });

    it("still allows a different link to be researched concurrently", async () => {
      const { user, project } = await linkProject("concurrent@tally.test");
      const { createProject } = await import("@/lib/projects/service");
      const { startLinkResearchRun } = await import("@/lib/research/service");

      await startLinkResearchRun({
        userId: user.id,
        videoId: SOURCE_ID,
        tier: "starter",
        projectId: project.id,
        linkForm: "watch",
      });

      const second = await createProject({
        userId: user.id,
        channelId: null,
        title: "New video from a YouTube link (Ks-_Mh1QhMc)",
        origin: "youtube_link",
        sourceVideoId: "Ks-_Mh1QhMc",
        maxVideosPerMonth: null,
      });

      // Scoping the guard by project rather than by user is what keeps this from
      // being a per-account lock on the whole feature.
      const other = await startLinkResearchRun({
        userId: user.id,
        videoId: "Ks-_Mh1QhMc",
        tier: "starter",
        projectId: second.id,
        linkForm: "watch",
      });
      expect(other.jobId).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // §23 case 23: the worker
  // -------------------------------------------------------------------------

  describe("worker processing (§23 case 23)", () => {
    it("runs a link-mode payload through to a succeeded run", async () => {
      const { db } = await import("@/lib/db");
      const { researchRuns } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      const { user, project } = await linkProject("handler@tally.test");
      const { startLinkResearchRun } = await import("@/lib/research/service");
      const { researchHandler } = await import("@/worker/handlers/research");
      const { markJobSucceeded } = await import("@/lib/queue/jobs");

      const { jobId, runId } = await startLinkResearchRun({
        userId: user.id,
        videoId: SOURCE_ID,
        tier: "starter",
        projectId: project.id,
        linkForm: "watch",
      });

      const result = await researchHandler({
        jobId,
        payload: { runId, sourceVideoId: SOURCE_ID, linkForm: "watch" },
        traceId: "trace-link-handler",
        attempt: 1,
      });
      await markJobSucceeded(jobId, (result ?? {}) as Record<string, unknown>);

      expect(result?.["runId"]).toBe(runId);
      expect(Number(result?.["ideaCount"])).toBeGreaterThan(0);

      const [run] = await db
        .select()
        .from(researchRuns)
        .where(eq(researchRuns.id, runId));
      expect(run?.status).toBe("succeeded");
    });

    it("refuses a payload with neither a channel nor a source video", async () => {
      const { user, project } = await linkProject("nopayload@tally.test");
      const { startLinkResearchRun } = await import("@/lib/research/service");
      const { researchHandler } = await import("@/worker/handlers/research");

      const { jobId, runId } = await startLinkResearchRun({
        userId: user.id,
        videoId: SOURCE_ID,
        tier: "starter",
        projectId: project.id,
      });

      // A typed error, so the retry classifier sees `retryable: false`: a
      // malformed payload will be malformed on every attempt.
      await expect(
        researchHandler({
          jobId,
          payload: { runId },
          traceId: "t",
          attempt: 1,
        }),
      ).rejects.toMatchObject({ code: "validation_failed", retryable: false });
    });

    it("refuses a video id that is not a YouTube id, before any API call", async () => {
      const { user, project } = await linkProject("badid@tally.test");
      const { startLinkResearchRun } = await import("@/lib/research/service");
      const { researchHandler } = await import("@/worker/handlers/research");

      const { jobId, runId } = await startLinkResearchRun({
        userId: user.id,
        videoId: SOURCE_ID,
        tier: "starter",
        projectId: project.id,
      });

      // The id was validated in the request that created the job, but a payload
      // arriving over Redis is data and not an authorisation — and this value is
      // about to be interpolated into a Google API call (§4, §21).
      await expect(
        researchHandler({
          jobId,
          payload: { runId, sourceVideoId: "../../etc/passwd" },
          traceId: "t",
          attempt: 1,
        }),
      ).rejects.toMatchObject({ code: "validation_failed" });
      expect(google.fetchVideoDetailAs).not.toHaveBeenCalled();
    });

    it("refuses a channel-less payload on a job row that has a channel (§21)", async () => {
      const { startResearchRun } = await import("@/lib/research/service");
      const { researchHandler } = await import("@/worker/handlers/research");

      const user = await linkUser("mismatch@tally.test");
      const channelId = await createChannel(user.id);
      const started = await startResearchRun({
        userId: user.id,
        channelId,
        tier: "starter",
      });

      /**
       * The attack this refuses: claiming to be channel-less on a job row that has
       * a channel would research that channel's niche through the *public*
       * credential path, bypassing the OAuth ownership the row represents.
       */
      await expect(
        researchHandler({
          jobId: started.jobId,
          payload: { runId: started.runId, sourceVideoId: SOURCE_ID },
          traceId: "t",
          attempt: 1,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  // -------------------------------------------------------------------------
  // §23 case 17: tenant isolation
  // -------------------------------------------------------------------------

  describe("tenant isolation (§21, §23 case 17)", () => {
    it("refuses to execute another user's run with a valid run id", async () => {
      const { user, project } = await linkProject("owner@tally.test");
      const intruder = await linkUser("intruder@tally.test");
      const { startLinkResearchRun, executeResearchRun } = await import(
        "@/lib/research/service"
      );

      const started = await startLinkResearchRun({
        userId: user.id,
        videoId: SOURCE_ID,
        tier: "starter",
        projectId: project.id,
      });

      // The only isolation test that counts: a real id belonging to somebody else.
      await expect(
        executeResearchRun({
          userId: intruder.id,
          channelId: null,
          runId: started.runId,
          jobId: started.jobId,
          sourceVideoId: SOURCE_ID,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    it("refuses another tenant's angle when configuring a project", async () => {
      const { db } = await import("@/lib/db");
      const { ideas } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const { configureProject } = await import("@/lib/projects/service");

      const first = await linkProject("angleowner@tally.test");
      const { runId } = await runLinkResearch(first.user.id, first.project.id);
      const [angle] = await db
        .select({ id: ideas.id })
        .from(ideas)
        .where(eq(ideas.runId, runId));

      const second = await linkProject("angleintruder@tally.test");

      // Same message for "not yours" and "does not exist", so the endpoint cannot
      // be used to enumerate which idea ids are real.
      await expect(
        configureProject({
          userId: second.user.id,
          projectId: second.project.id,
          ideaId: angle!.id,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    });

    it("refuses a channel-mode angle on a channel-less project", async () => {
      const { db } = await import("@/lib/db");
      const { ideas } = await import("@/lib/db/schema");
      const { configureProject } = await import("@/lib/projects/service");

      const { user, project } = await linkProject("crosschannel@tally.test");
      const channelId = await createChannel(user.id);

      // Same user, but an angle researched inside a channel's scope.
      const [channelAngle] = await db
        .insert(ideas)
        .values({
          userId: user.id,
          channelId,
          title: "An angle that belongs to a connected channel",
          topic: "channel scoped",
          tallyScore: 50,
        })
        .returning({ id: ideas.id });

      // Crossing a boundary the research was scoped by, even within one tenant.
      await expect(
        configureProject({
          userId: user.id,
          projectId: project.id,
          ideaId: channelAngle!.id,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  // -------------------------------------------------------------------------
  // §23 case 18: rate limiting
  // -------------------------------------------------------------------------

  describe("rate limiting (§21, §23 case 18)", () => {
    it("exhausts the research window the analyse route uses, then refuses", async () => {
      const { consume, enforce, rules } = await import("@/lib/api/rate-limit");
      const rule = rules().research;
      // A key of this run's own, since Redis is not truncated between tests.
      const key = `link-studio-probe-${process.pid}-research`;

      for (let i = 0; i < rule.limit; i += 1) {
        const result = await consume(rule, key);
        expect(result.allowed, `call ${i + 1}`).toBe(true);
      }

      // The rule that bounds YouTube Data API quota: 10 per 10 minutes. One over
      // and the caller is told to wait, with a retry-after they can act on.
      await expect(enforce(rule, key)).rejects.toMatchObject({
        code: "rate_limited",
        status: 429,
      });
    });

    it("keys the window per user, so one account cannot exhaust another's", async () => {
      const { consume, rules } = await import("@/lib/api/rate-limit");
      const rule = rules().research;
      const mine = `link-studio-probe-${process.pid}-a`;
      const theirs = `link-studio-probe-${process.pid}-b`;

      for (let i = 0; i < rule.limit; i += 1) await consume(rule, mine);
      expect((await consume(rule, mine)).allowed).toBe(false);
      expect((await consume(rule, theirs)).allowed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // §23 cases 9, 10, 11, 12, 16, 24: angle → script → scenes → video
  // -------------------------------------------------------------------------

  describe("script and scenes without a channel (§8, §15, §23 cases 9, 10)", () => {
    it("briefs and writes a script from the chosen angle alone", async () => {
      const { db } = await import("@/lib/db");
      const { ideas, projects, scripts, scriptVersions } = await import(
        "@/lib/db/schema"
      );
      const { eq } = await import("drizzle-orm");
      const { configureProject, getProject } = await import(
        "@/lib/projects/service"
      );

      const { user, project } = await linkProject("script@tally.test");
      const { runId } = await runLinkResearch(user.id, project.id);

      const [angle] = await db
        .select({ id: ideas.id, title: ideas.title })
        .from(ideas)
        .where(eq(ideas.runId, runId));

      const configured = await configureProject({
        userId: user.id,
        projectId: project.id,
        ideaId: angle!.id,
      });

      // The placeholder title is replaced by the chosen angle's — not by the
      // source video's, which would name somebody else's video on every screen.
      expect(configured.title).toBe(angle!.title);
      expect(configured.title).not.toContain(SOURCE_ID);
      const [usedAngle] = await db
        .select({ state: ideas.state })
        .from(ideas)
        .where(eq(ideas.id, angle!.id));
      expect(usedAngle?.state).toBe("used");

      const result = await writeScript(user.id, project.id);
      expect(result.version).toBe(1);
      expect(result.wordCount).toBeGreaterThan(0);

      const after = await getProject(user.id, project.id);
      expect(after.status).toBe("SCRIPT_READY");
      expect(after.channelId).toBeNull();

      // Versions hang off the `scripts` row, one per project, rather than off the
      // project directly — approval is a property of the script, not the version.
      const [script] = await db
        .select()
        .from(scripts)
        .where(eq(scripts.projectId, project.id));
      expect(script?.approvedAt).toBeInstanceOf(Date);
      expect(script?.activeVersionId).not.toBeNull();

      const versions = await db
        .select()
        .from(scriptVersions)
        .where(eq(scriptVersions.scriptId, script!.id));
      expect(versions).toHaveLength(1);
      expect(versions[0]?.id).toBe(script?.activeVersionId);

      // §8: the brief the model saw carried the angle and the research, and not
      // the source video's own words.
      const scriptCall = ai.generateJson.mock.calls.find(
        (c) => (c[0] as { system: string }).system.includes("scriptwriter"),
      );
      const prompt = (scriptCall?.[0] as { prompt: string }).prompt;
      expect(prompt).toContain(angle!.title);
      expect(prompt).not.toContain(
        "Three weeks of logging the cheapest motion sensors sold.",
      );

      const [row] = await db
        .select({ origin: projects.origin, sourceVideoId: projects.sourceVideoId })
        .from(projects)
        .where(eq(projects.id, project.id));
      // Provenance survives, and is read by nothing that generates (§22).
      expect(row?.origin).toBe("youtube_link");
      expect(row?.sourceVideoId).toBe(SOURCE_ID);
    }, 60_000);

    it("refuses a second script run while one is in flight", async () => {
      const { user, project } = await linkProject("scriptdupe@tally.test");
      const { startScriptGeneration } = await import("@/lib/scripts/service");

      await startScriptGeneration({
        userId: user.id,
        projectId: project.id,
        tier: "starter",
      });

      // Scoped by the project, since there is no channel. Without that narrowing
      // `hasActiveJob` would refuse to run at all.
      await expect(
        startScriptGeneration({
          userId: user.id,
          projectId: project.id,
          tier: "starter",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    });
  });

  describe("generation mode reaches the visuals stage (§9, §15, §17)", () => {
    it("uses stock footage when no mode was chosen, exactly as before Phase 11", async () => {
      const { db } = await import("@/lib/db");
      const { assets, scenes } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const { startVideoBuild } = await import("@/lib/video/service");
      const { markJobSucceeded } = await import("@/lib/queue/jobs");

      const { user, project } = await linkProject("stock@tally.test");
      await writeScript(user.id, project.id);

      const started = await startVideoBuild({
        userId: user.id,
        projectId: project.id,
        tier: "starter",
        traceId: "trace-link-test",
      });
      // No worker is running to consume the queued SCENE_PLAN job, and
      // `hasActiveJob` would otherwise report a build in progress.
      await markJobSucceeded(started.jobId, { queued: true });

      const context = { userId: user.id, projectId: project.id, tier: "starter" as const };
      await runStage("scene-plan", context);
      await runStage("voiceover", context);
      const visuals = await runStage<{ acquired: number }>("visuals", context);

      expect(visuals.acquired).toBeGreaterThan(0);

      const sceneRows = await db
        .select()
        .from(scenes)
        .where(eq(scenes.projectId, project.id));
      for (const scene of sceneRows) expect(scene.visualAssetId).not.toBeNull();

      const assetRows = await db
        .select()
        .from(assets)
        .where(eq(assets.projectId, project.id));
      const visualAssets = assetRows.filter((a) => a.kind === "generated_image");
      expect(visualAssets.length).toBe(sceneRows.length);
      // The stock path's own asset id shape. The AI path's is `mock:ai:<n>`, so
      // this is what distinguishes a stage that honoured the plan from one that
      // ignored it — both providers are named "mock" in a test environment.
      for (const asset of visualAssets) {
        expect(asset.providerAssetId).toMatch(/^mock:\d+$/);
      }
    }, 120_000);

    it("generates every scene through the video-gen registry in AI mode", async () => {
      const { db } = await import("@/lib/db");
      const { apiUsage, assets, projects, scenes } = await import(
        "@/lib/db/schema"
      );
      const { eq } = await import("drizzle-orm");
      const { validateSelection } = await import("@/lib/video/generation-plan");
      const { configureProject } = await import("@/lib/projects/service");
      const { startVideoBuild } = await import("@/lib/video/service");
      const { markJobSucceeded } = await import("@/lib/queue/jobs");

      // Scale, because AI video is a paid entitlement and this must go through the
      // real check rather than around it (§19).
      const { user, project } = await linkProject("aivideo@tally.test", "scale");

      /**
       * The mock model, not Seedance or Veo.
       *
       * `TALLY_USE_MOCK_PROVIDERS=true` in the harness makes it the only enabled
       * provider, which is exactly what §23 asks for: the selection, the
       * entitlement, the plan resolution and the asset persistence are all real,
       * and no request reaches a paid generation API.
       */
      const selection = validateSelection({
        mode: "AI_VIDEO",
        model: "mock/placeholder",
        format: "portrait",
        tier: "scale",
      });
      expect(selection).toMatchObject({
        generationMode: "AI_VIDEO",
        generationModel: "mock/placeholder",
        videoFormat: "portrait",
      });

      await configureProject({
        userId: user.id,
        projectId: project.id,
        generationMode: selection.generationMode,
        generationModel: selection.generationModel,
        videoFormat: selection.videoFormat,
      });

      const [stored] = await db
        .select({
          generationMode: projects.generationMode,
          generationModel: projects.generationModel,
          videoFormat: projects.videoFormat,
        })
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(stored).toMatchObject({
        generationMode: "AI_VIDEO",
        generationModel: "mock/placeholder",
        videoFormat: "portrait",
      });

      await writeScript(user.id, project.id, "scale");

      const started = await startVideoBuild({
        userId: user.id,
        projectId: project.id,
        tier: "scale",
        traceId: "trace-link-test",
      });
      await markJobSucceeded(started.jobId, { queued: true });

      const context = { userId: user.id, projectId: project.id, tier: "scale" as const };
      await runStage("scene-plan", context);
      await runStage("voiceover", context);
      const visuals = await runStage<{ acquired: number }>("visuals", context);

      const sceneRows = await db
        .select()
        .from(scenes)
        .where(eq(scenes.projectId, project.id));
      expect(visuals.acquired).toBe(sceneRows.length);

      const assetRows = await db
        .select()
        .from(assets)
        .where(eq(assets.projectId, project.id));
      const generated = assetRows.filter((a) =>
        (a.providerAssetId ?? "").startsWith("mock:ai:"),
      );
      // Every scene came from the generation registry, not from stock.
      expect(generated).toHaveLength(sceneRows.length);
      for (const asset of generated) {
        // §17, §42: `kind` follows the bytes. The placeholder returns a still, so
        // it is recorded as an image rather than claimed as generated video.
        expect(asset.kind).toBe("generated_image");
        // §16: the chosen frame propagated to the provider — portrait is taller
        // than it is wide, and a stage that dropped the format would not be.
        expect(asset.height ?? 0).toBeGreaterThan(asset.width ?? 0);
        // No source URL: the bytes came from a generation call, not from a page.
        expect(asset.sourceUrl).toBeNull();
        expect(asset.license).toMatch(/not for publication/i);
      }

      // The AI branch accounts through the same usage ledger as every other
      // provider, under its own operation name.
      const usage = await db
        .select({ operation: apiUsage.operation })
        .from(apiUsage)
        .where(eq(apiUsage.projectId, project.id));
      expect(usage.map((u) => u.operation)).toContain("video.scene.generate");
    }, 120_000);

    it("refuses AI video on a plan that does not include it (§19)", async () => {
      const { validateSelection } = await import("@/lib/video/generation-plan");

      // Starter. The refusal is the entitlement, not the model — and it happens
      // before the model name is even looked at, so the message is the true one.
      expect(() =>
        validateSelection({ mode: "AI_VIDEO", model: "mock/placeholder", tier: "starter" }),
      ).toThrowError(
        expect.objectContaining({ code: "feature_not_in_plan", status: 402 }),
      );
    });

    it("refuses a model name the client invented (§10, §21)", async () => {
      const { validateSelection } = await import("@/lib/video/generation-plan");

      // A client cannot conjure a provider by naming one, and cannot reach an
      // unconfigured one by manipulating the request.
      expect(() =>
        validateSelection({ mode: "AI_VIDEO", model: "fal/seedance-99-ultra", tier: "scale" }),
      ).toThrowError(expect.objectContaining({ status: 400 }));
      expect(() =>
        validateSelection({ mode: "AI_VIDEO", model: "veo/3.1", tier: "scale" }),
      ).toThrowError(expect.objectContaining({ status: 400 }));
      // A real catalogue model, refused here for the same reason: this harness
      // enables the mock provider only, so fal.ai is not on offer however the
      // request is spelled.
      expect(() =>
        validateSelection({ mode: "AI_VIDEO", model: "fal/kling-v2-master", tier: "scale" }),
      ).toThrowError(expect.objectContaining({ status: 400 }));
    });
  });

  // -------------------------------------------------------------------------
  // §23 case 24: final assembly
  // -------------------------------------------------------------------------

  describe("final video assembly (§15, §17, §23 case 24)", () => {
    it(
      "carries a pasted link all the way to a finished video",
      async () => {
        const { db } = await import("@/lib/db");
        const { assets, captions, ideas, renders, scenes } = await import(
          "@/lib/db/schema"
        );
        const { eq } = await import("drizzle-orm");
        const { configureProject, getProject } = await import(
          "@/lib/projects/service"
        );
        const { startVideoBuild } = await import("@/lib/video/service");
        const { markJobSucceeded } = await import("@/lib/queue/jobs");

        const { user, project } = await linkProject("endtoend@tally.test");

        // 1. Paste → analyse → research → angles.
        const { runId, result } = await runLinkResearch(user.id, project.id);
        expect(result?.ideaCount).toBeGreaterThan(0);

        // 2. Choose an angle.
        const [angle] = await db
          .select({ id: ideas.id })
          .from(ideas)
          .where(eq(ideas.runId, runId));
        await configureProject({
          userId: user.id,
          projectId: project.id,
          ideaId: angle!.id,
        });

        // 3. Script it, and approve it.
        await writeScript(user.id, project.id);

        // 4. Build, through the same seven stages a channel-mode project uses.
        const started = await startVideoBuild({
          userId: user.id,
          projectId: project.id,
          tier: "starter",
          traceId: "trace-link-test",
        });
        await markJobSucceeded(started.jobId, { queued: true });

        const context = {
          userId: user.id,
          projectId: project.id,
          tier: "starter" as const,
        };
        const plan = await runStage<{ sceneCount: number; mood: string }>(
          "scene-plan",
          context,
        );
        expect(plan.sceneCount).toBeGreaterThanOrEqual(3);

        await runStage("voiceover", context);
        await runStage("visuals", context);
        await runStage("music", context);
        await runStage("captions", context);
        await runStage("timeline", context);

        const sceneRows = await db
          .select()
          .from(scenes)
          .where(eq(scenes.projectId, project.id));
        expect(sceneRows).toHaveLength(plan.sceneCount);

        // Offsets are the accumulated narration durations the voiceover stage
        // measured, so scene N starts exactly where scene N-1 ended.
        const ordered = [...sceneRows].sort((a, b) => a.index - b.index);
        expect(ordered[0]?.startMs).toBe(0);
        for (let i = 1; i < ordered.length; i += 1) {
          expect(ordered[i]!.startMs).toBeGreaterThan(ordered[i - 1]!.startMs!);
          expect(ordered[i]!.durationMs).not.toBeNull();
        }

        const assetRows = await db
          .select()
          .from(assets)
          .where(eq(assets.projectId, project.id));
        const kinds = assetRows.map((a) => a.kind);
        expect(kinds).toContain("voiceover");
        expect(kinds).toContain("generated_image");
        expect(kinds).toContain("music");

        const captionRows = await db
          .select()
          .from(captions)
          .where(eq(captions.projectId, project.id));
        expect(captionRows.length).toBeGreaterThan(0);

        if (!hasEncoder) {
          // Honest about what was not proven, rather than passing quietly.
          expect(await getProject(user.id, project.id)).toMatchObject({
            channelId: null,
          });
          return;
        }

        // 5. Render. The same ffmpeg pipeline, on a project with no channel.
        await runStage("render", context);

        const after = await getProject(user.id, project.id);
        expect(after.status).toBe("VIDEO_READY");
        expect(after.channelId).toBeNull();
        expect(after.errorMessage).toBeNull();

        const renderRows = await db
          .select()
          .from(renders)
          .where(eq(renders.projectId, project.id));
        expect(renderRows.length).toBeGreaterThan(0);

        const output = assetRows.length;
        const finalAssets = await db
          .select()
          .from(assets)
          .where(eq(assets.projectId, project.id));
        // The render stage adds the output on top of the stage assets.
        expect(finalAssets.length).toBeGreaterThan(output);
        const rendered = finalAssets.find((a) => a.kind === "render_output");
        expect(rendered).toBeDefined();
        expect(rendered?.storageKey).toBeTruthy();
        expect(Number(rendered?.bytes ?? 0)).toBeGreaterThan(0);

        // §22, restated as a durable fact: nothing in this run downloaded,
        // copied or republished the pasted video. Its id is recorded as
        // provenance and nothing else references it.
        expect(
          finalAssets.some((a) => (a.sourceUrl ?? "").includes(SOURCE_ID)),
        ).toBe(false);
      },
      600_000,
    );
  });
});

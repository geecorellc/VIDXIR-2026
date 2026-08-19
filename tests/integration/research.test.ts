/**
 * Research engine integration tests (§39, §7, §8, §29, §42).
 *
 * What these prove, that the unit tests cannot:
 *
 *  - A run **persists**. §45's question is "what should persist if the browser is
 *    closed?", and the answer for research is the run row, its evidence, and its
 *    ideas. That is a claim about Postgres, not about a function's return value.
 *  - The §29 provenance trail actually joins up: every generated idea's
 *    `source_result_ids` resolve to real `research_results` rows from the same
 *    run, so "where did this idea come from" is answerable from the database.
 *  - A missing `ANTHROPIC_API_KEY` produces a `blocked_not_configured` run, not a
 *    crash and not invented ideas (§48, §42).
 *  - Tenant isolation holds on every new read and write path, tested the only way
 *    that counts: with a valid id belonging to somebody else.
 *
 * Both external boundaries are mocked, and only at the provider module:
 * `lib/providers/youtube` because these tests must not spend real quota (§40),
 * and `lib/providers/ai` because they must not spend real credits. Everything
 * below those two seams — scoring, the derivative check, persistence, the
 * ownership predicates, the job mirror — is the real code.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChannel,
  createUser,
  hasDatabase,
  jar,
  resetDatabase,
  useDatabase,
} from "./setup";

vi.mock("next/headers", () => ({
  cookies: async () => jar,
}));

// ---------------------------------------------------------------------------
// YouTube boundary
// ---------------------------------------------------------------------------

const google = vi.hoisted(() => ({
  searchVideos: vi.fn(),
  fetchMostPopular: vi.fn(),
  fetchVideosByIds: vi.fn(),
  fetchChannelsByIds: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

vi.mock("@/lib/providers/youtube", async (importOriginal) => {
  // `importOriginal` rather than a dynamic import of the same path: the latter
  // resolves back to this mock and deadlocks the factory.
  const actual = await importOriginal<typeof import("@/lib/providers/youtube")>();
  return {
    ...actual,
    searchVideos: google.searchVideos,
    fetchMostPopular: google.fetchMostPopular,
    fetchVideosByIds: google.fetchVideosByIds,
    fetchChannelsByIds: google.fetchChannelsByIds,
    refreshAccessToken: google.refreshAccessToken,
  };
});

// ---------------------------------------------------------------------------
// Claude boundary
// ---------------------------------------------------------------------------

const ai = vi.hoisted(() => ({ generateJson: vi.fn() }));

vi.mock("@/lib/providers/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/ai")>();
  return { ...actual, generateJson: ai.generateJson };
});

const suite = hasDatabase ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * A search hit as the Data API returns one: no statistics. That absence is the
 * reason `collectSignals` makes a second, batched `videos.list` call, so the
 * fixture must not shortcut it.
 */
function hit(id: string, title: string, channelId = "UCincumbent", daysAgo = 3) {
  return {
    videoId: id,
    title,
    channelId,
    channelTitle: `Channel ${channelId}`,
    publishedAt: new Date(Date.now() - daysAgo * DAY),
    description: `${title} description`,
    thumbnailUrl: `https://i.ytimg.com/vi/${id}/hq.jpg`,
  };
}

/** The same video with statistics, as `videos.list` returns it. */
function stats(
  id: string,
  title: string,
  overrides: {
    viewCount?: number | null;
    likeCount?: number | null;
    commentCount?: number | null;
    channelId?: string;
    daysAgo?: number;
  } = {},
) {
  const daysAgo = overrides.daysAgo ?? 3;
  return {
    videoId: id,
    title,
    channelId: overrides.channelId ?? "UCincumbent",
    channelTitle: `Channel ${overrides.channelId ?? "UCincumbent"}`,
    publishedAt: new Date(Date.now() - daysAgo * DAY),
    description: `${title} description`,
    thumbnailUrl: `https://i.ytimg.com/vi/${id}/hq.jpg`,
    durationSeconds: 620,
    viewCount: overrides.viewCount === undefined ? 240_000 : overrides.viewCount,
    likeCount: overrides.likeCount === undefined ? 9_800 : overrides.likeCount,
    commentCount:
      overrides.commentCount === undefined ? 1_400 : overrides.commentCount,
    tags: ["fixture"],
    categoryId: "28",
  };
}

/**
 * A plausible model response. Titles are deliberately *unlike* the source titles
 * so the derivative filter passes — one test overrides this to prove the filter
 * bites.
 */
function ideaBatch() {
  return {
    ideas: [
      {
        title: "Why cheap sensors beat expensive ones for a first smart home",
        angle:
          "Test the budget hardware everyone dismisses and publish the failure rate.",
        rationale:
          "The top performers all review flagship kit; nobody has measured the cheap tier.",
        topic: "budget smart home",
        targetKeywords: ["budget smart home", "cheap sensors"],
        sourceIndices: [1, 2],
      },
      {
        title: "The setup mistake that makes automations unreliable",
        angle: "Diagnose the single configuration error behind most flaky routines.",
        rationale:
          "Comment volume on the recent uploads is concentrated on reliability complaints.",
        topic: "home automation reliability",
        targetKeywords: ["automation reliability"],
        sourceIndices: [2],
      },
    ],
  };
}

suite("research engine (integration)", () => {
  useDatabase();

  /**
   * Pay the one-off costs here rather than inside the first test.
   *
   * `enqueue()` opens BullMQ's Redis connection on first use, and the research
   * modules pull in the `googleapis` barrel. Together that is tens of seconds on
   * a cold Windows machine — enough to blow the 30s per-test budget for whichever
   * test happens to run first, while every later test finishes in ~1.5s. A
   * flake that depends on test ordering is worse than a slow hook, and `beforeAll`
   * already has a 60s budget.
   */
  beforeAll(async () => {
    await import("@/lib/research/signals");
    await import("@/lib/research/service");
    const { getRedis } = await import("@/lib/queue/redis");
    await getRedis().ping();
  }, 60_000);

  // The queue connections are process-wide singletons; left open, vitest cannot
  // exit and the run hangs after the last assertion passes.
  afterAll(async () => {
    const { closeQueues } = await import("@/lib/queue/queues");
    const { closeRedis } = await import("@/lib/queue/redis");
    await closeQueues();
    await closeRedis();
  });

  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();

    // Two probes' worth of searches; every call returns the same shape so the
    // number of probes does not change what the test asserts.
    google.searchVideos.mockResolvedValue([
      hit("vid-alpha", "I automated my entire house for $200", "UCincumbent", 2),
      hit("vid-beta", "Smart home tour 2026", "UCrival", 5),
    ]);
    google.fetchMostPopular.mockResolvedValue([
      hit("vid-popular", "Trending gadget roundup", "UCbig", 1),
    ]);
    google.fetchVideosByIds.mockImplementation(async (_token: unknown, ids: string[]) =>
      ids.map((id) =>
        stats(id, `Statistics for ${id}`, {
          viewCount: id === "vid-alpha" ? 480_000 : 120_000,
          daysAgo: 2,
        }),
      ),
    );
    google.fetchChannelsByIds.mockResolvedValue([
      {
        channelId: "UCincumbent",
        title: "Incumbent Channel",
        subscriberCount: 250_000,
        videoCount: 320,
        viewCount: 40_000_000,
        thumbnailUrl: null,
        subscriberCountHidden: false,
      },
    ]);
    ai.generateJson.mockResolvedValue(ideaBatch());
  });

  /** A user with a connected channel and enough settings to build probes from. */
  async function seedChannel(email: string, niche = "smart home automation") {
    const { db } = await import("@/lib/db");
    const { channelSettings } = await import("@/lib/db/schema");

    const user = await createUser({ email });
    const channelId = await createChannel(user.id);

    await db.insert(channelSettings).values({
      channelId,
      userId: user.id,
      niche,
      keywords: ["home automation", "smart lighting"],
      contentLanguage: "en-GB",
      preferredLengthSeconds: 600,
    });

    return { user, channelId };
  }

  /**
   * Run the whole pipeline the way the worker does: create the row and job, then
   * execute. This deliberately goes through `startResearchRun` rather than
   * inserting a run row, so the queue mirror and the duplicate guard are exercised.
   */
  async function runResearch(userId: string, channelId: string) {
    const { startResearchRun, executeResearchRun } = await import(
      "@/lib/research/service"
    );
    const started = await startResearchRun({
      userId,
      channelId,
      tier: "starter",
      traceId: "trace-research-test",
    });

    const result = await executeResearchRun({
      userId,
      channelId,
      runId: started.runId,
      jobId: started.jobId,
      traceId: "trace-research-test",
    }).catch((error: unknown) => ({ error }) as const);

    return { ...started, result };
  }

  // -------------------------------------------------------------------------

  describe("persistence", () => {
    it("records the run, its evidence and its ideas", async () => {
      const { db } = await import("@/lib/db");
      const { ideas, researchResults, researchRuns } = await import(
        "@/lib/db/schema"
      );
      const { eq } = await import("drizzle-orm");

      const { user, channelId } = await seedChannel("persist@tally.test");
      const { runId } = await runResearch(user.id, channelId);

      const runRows = await db
        .select()
        .from(researchRuns)
        .where(eq(researchRuns.id, runId));
      const run = runRows[0];

      expect(run?.status).toBe("succeeded");
      // Set on both the success and failure paths: a run left `running` is the
      // §30 failure mode where the UI spins forever.
      expect(run?.completedAt).toBeInstanceOf(Date);
      expect(run?.error).toBeNull();
      expect(run?.niche).toBe("smart home automation");
      // Only the sources that actually responded are recorded, so a degraded run
      // is legible rather than silently thin.
      expect(run?.sources).toContain("youtube_search_top");
      expect(run?.sources?.length ?? 0).toBeGreaterThan(0);

      const evidence = await db
        .select()
        .from(researchResults)
        .where(eq(researchResults.runId, runId));
      expect(evidence.length).toBeGreaterThan(0);

      const generated = await db
        .select()
        .from(ideas)
        .where(eq(ideas.runId, runId));
      expect(generated).toHaveLength(2);
    });

    it("stores real statistics, not the search hit's empty fields", async () => {
      const { db } = await import("@/lib/db");
      const { researchResults } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      const { user, channelId } = await seedChannel("stats@tally.test");
      const { runId } = await runResearch(user.id, channelId);

      const rows = await db
        .select()
        .from(researchResults)
        .where(eq(researchResults.runId, runId));

      // Without the batched videos.list step there is no velocity and no
      // engagement — i.e. no scoring input at all. This asserts it happened.
      const withViews = rows.filter((row) => row.viewCount !== null);
      expect(withViews.length).toBeGreaterThan(0);
      expect(rows.some((row) => (row.viewsPerHour ?? 0) > 0)).toBe(true);
      expect(rows.some((row) => (row.engagementRate ?? 0) > 0)).toBe(true);
    });

    it("keeps view counts exact above 2^31", async () => {
      const { db } = await import("@/lib/db");
      const { researchResults } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      // 3.1 billion views: real for a music video, and an overflow for an int4
      // column. The column is numeric(20,0) precisely for this.
      const huge = 3_100_000_000;
      google.fetchVideosByIds.mockImplementation(
        async (_token: unknown, ids: string[]) =>
          ids.map((id) => stats(id, `Huge ${id}`, { viewCount: huge })),
      );

      const { user, channelId } = await seedChannel("huge@tally.test");
      const { runId } = await runResearch(user.id, channelId);

      const rows = await db
        .select({ viewCount: researchResults.viewCount })
        .from(researchResults)
        .where(eq(researchResults.runId, runId));

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Number(row.viewCount)).toBe(huge);
      }
    });

    it("mirrors the job into the jobs table so the UI can see a closed-browser run", async () => {
      const { db } = await import("@/lib/db");
      const { jobs } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      const { user, channelId } = await seedChannel("job@tally.test");
      const { jobId } = await runResearch(user.id, channelId);

      const rows = await db.select().from(jobs).where(eq(jobs.id, jobId));
      const job = rows[0];

      expect(job).toBeDefined();
      expect(job?.name).toBe("research-run");
      expect(job?.queue).toBe("research");
      expect(job?.stage).toBe("RESEARCH");
      expect(job?.channelId).toBe(channelId);
      // §41: the request's trace id survives the hand-off into the queue.
      expect(job?.traceId).toBe("trace-research-test");
      // Progress was recorded at real milestones by `reportProgress`, not
      // interpolated on a timer (§42).
      expect(job?.progress ?? 0).toBeGreaterThan(0);
    });

    it("refuses a second concurrent run for the same channel", async () => {
      const { startResearchRun } = await import("@/lib/research/service");
      const { user, channelId } = await seedChannel("dupe@tally.test");

      await startResearchRun({ userId: user.id, channelId, tier: "starter" });

      // The first run is still queued. A second would spend another ~600 quota
      // units and interleave its results into the same view.
      await expect(
        startResearchRun({ userId: user.id, channelId, tier: "starter" }),
      ).rejects.toMatchObject({ code: "conflict" });
    });
  });

  // -------------------------------------------------------------------------

  describe("provenance and originality (§29)", () => {
    it("resolves every idea's sources to real rows from the same run", async () => {
      const { db } = await import("@/lib/db");
      const { ideas, researchResults } = await import("@/lib/db/schema");
      const { eq, inArray } = await import("drizzle-orm");

      const { user, channelId } = await seedChannel("prov@tally.test");
      const { runId } = await runResearch(user.id, channelId);

      const generated = await db
        .select()
        .from(ideas)
        .where(eq(ideas.runId, runId));

      const cited = [
        ...new Set(generated.flatMap((idea) => idea.sourceResultIds)),
      ];
      expect(cited.length).toBeGreaterThan(0);

      const resolved = await db
        .select({ id: researchResults.id, runId: researchResults.runId })
        .from(researchResults)
        .where(inArray(researchResults.id, cited));

      // Every citation resolves, and to evidence from *this* run — a dangling or
      // cross-run id would make the §29 trail unverifiable.
      expect(resolved).toHaveLength(cited.length);
      for (const row of resolved) {
        expect(row.runId).toBe(runId);
      }
    });

    it("records the weights used, so an old score stays explainable", async () => {
      const { db } = await import("@/lib/db");
      const { ideas } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      const { user, channelId } = await seedChannel("weights@tally.test");
      const { runId } = await runResearch(user.id, channelId);

      const rows = await db.select().from(ideas).where(eq(ideas.runId, runId));
      const idea = rows[0];

      expect(idea?.scoreBreakdown).toMatchObject({
        trend: expect.any(Number),
        velocity: expect.any(Number),
        competition: expect.any(Number),
        audienceFit: expect.any(Number),
        opportunity: expect.any(Number),
        freshness: expect.any(Number),
      });
      expect(idea?.generatedBy).toBeTruthy();
    });

    it("scores in code — a model-supplied score is not persisted", async () => {
      const { db } = await import("@/lib/db");
      const { ideas } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      // The model is not asked for scores, but if a response carried them they
      // must be ignored: an unauditable number must never reach the UI as a score.
      const batch = ideaBatch();
      ai.generateJson.mockResolvedValue({
        ideas: batch.ideas.map((idea) => ({ ...idea, tallyScore: 99 })),
      });

      const { user, channelId } = await seedChannel("codescore@tally.test");
      const { runId } = await runResearch(user.id, channelId);

      const rows = await db.select().from(ideas).where(eq(ideas.runId, runId));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.tallyScore).not.toBe(99);
        expect(row.tallyScore ?? -1).toBeGreaterThanOrEqual(0);
        expect(row.tallyScore ?? 101).toBeLessThanOrEqual(100);
      }
    });

    it("rejects an idea that is a source title reworded", async () => {
      const { db } = await import("@/lib/db");
      const { ideas } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      google.fetchVideosByIds.mockImplementation(
        async (_token: unknown, ids: string[]) =>
          ids.map((id) =>
            stats(id, "I automated my entire house for $200", { daysAgo: 2 }),
          ),
      );
      ai.generateJson.mockResolvedValue({
        ideas: [
          {
            // Near-identical to the source: this is a copy, not an angle.
            title: "I automated my entire house for $200",
            angle: "Same video again.",
            rationale: "It did well.",
            topic: "smart home",
            targetKeywords: ["smart home"],
            sourceIndices: [1],
          },
          {
            title: "The hidden running cost nobody mentions in setup videos",
            angle: "Measure standby draw across a year and publish the bill.",
            rationale: "No source covers ongoing cost.",
            topic: "smart home running costs",
            targetKeywords: ["standby power"],
            sourceIndices: [1],
          },
        ],
      });

      const { user, channelId } = await seedChannel("derivative@tally.test");
      const { runId } = await runResearch(user.id, channelId);

      const rows = await db.select().from(ideas).where(eq(ideas.runId, runId));

      // The copy is dropped; the genuine angle survives. Rejecting the batch
      // wholesale would throw away good ideas because of one bad one.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toContain("hidden running cost");
    });
  });

  // -------------------------------------------------------------------------

  describe("failure states (§30, §42, §48)", () => {
    it("records blocked_not_configured when ANTHROPIC_API_KEY is missing", async () => {
      const { db } = await import("@/lib/db");
      const { ideas, researchResults, researchRuns } = await import(
        "@/lib/db/schema"
      );
      const { eq } = await import("drizzle-orm");
      const { NotConfiguredError } = await import("@/lib/errors");

      ai.generateJson.mockRejectedValue(
        new NotConfiguredError("Claude", ["ANTHROPIC_API_KEY"]),
      );

      const { user, channelId } = await seedChannel("nokey@tally.test");
      const { runId } = await runResearch(user.id, channelId);

      const runRows = await db
        .select()
        .from(researchRuns)
        .where(eq(researchRuns.id, runId));
      const run = runRows[0];

      // §48: a configuration state, not a crash and not a fake success.
      expect(run?.status).toBe("blocked_not_configured");
      expect(run?.completedAt).toBeInstanceOf(Date);
      // The message names the variable the operator has to set.
      expect(run?.error).toContain("ANTHROPIC_API_KEY");

      // The signals collected before the failure are kept — they cost quota and
      // are still valid evidence — but no idea was invented from the model's
      // priors (§42).
      const evidence = await db
        .select()
        .from(researchResults)
        .where(eq(researchResults.runId, runId));
      expect(evidence.length).toBeGreaterThan(0);

      const generated = await db
        .select()
        .from(ideas)
        .where(eq(ideas.runId, runId));
      expect(generated).toHaveLength(0);
    });

    it("fails the run, rather than leaving it running, when YouTube returns nothing", async () => {
      const { db } = await import("@/lib/db");
      const { researchRuns } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      google.searchVideos.mockResolvedValue([]);
      google.fetchMostPopular.mockResolvedValue([]);
      google.fetchVideosByIds.mockResolvedValue([]);

      const { user, channelId } = await seedChannel("empty@tally.test");
      const { runId, result } = await runResearch(user.id, channelId);

      expect("error" in result).toBe(true);

      const rows = await db
        .select()
        .from(researchRuns)
        .where(eq(researchRuns.id, runId));

      // An empty run persisted as "succeeded" would read as "no opportunities
      // exist", which is a different and false claim.
      expect(rows[0]?.status).toBe("failed");
      expect(rows[0]?.completedAt).toBeInstanceOf(Date);
      expect(rows[0]?.error).toBeTruthy();
    });

    it("survives one failing search source without losing the run", async () => {
      const { db } = await import("@/lib/db");
      const { researchRuns } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      // First search throws, the rest succeed. Each probe is wrapped
      // individually so a single failure degrades the run instead of aborting it.
      let call = 0;
      google.searchVideos.mockImplementation(async () => {
        call += 1;
        if (call === 1) throw new Error("youtube 503");
        return [hit("vid-late", "Recovered result", "UCincumbent", 4)];
      });

      const { user, channelId } = await seedChannel("degraded@tally.test");
      const { runId } = await runResearch(user.id, channelId);

      const rows = await db
        .select()
        .from(researchRuns)
        .where(eq(researchRuns.id, runId));
      expect(rows[0]?.status).toBe("succeeded");
    });
  });

  // -------------------------------------------------------------------------

  describe("tenant isolation (§27, §34)", () => {
    it("refuses to execute a run against another user's channel", async () => {
      const { executeResearchRun, startResearchRun } = await import(
        "@/lib/research/service"
      );
      const owner = await seedChannel("iso-owner@tally.test");
      const other = await seedChannel("iso-other@tally.test");

      const started = await startResearchRun({
        userId: owner.user.id,
        channelId: owner.channelId,
        tier: "starter",
      });

      // A valid run id, held by the wrong tenant. The worker re-verifies against
      // the database because a payload arriving over Redis is not an authorisation.
      await expect(
        executeResearchRun({
          userId: other.user.id,
          channelId: owner.channelId,
          runId: started.runId,
          jobId: started.jobId,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    it("will not start a run for a channel the user does not own", async () => {
      const { startResearchRun } = await import("@/lib/research/service");
      const owner = await seedChannel("iso-start-owner@tally.test");
      const other = await createUser({ email: "iso-start-other@tally.test" });

      await expect(
        startResearchRun({
          userId: other.id,
          channelId: owner.channelId,
          tier: "starter",
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    it("does not load another user's research context", async () => {
      const { loadResearchContext } = await import("@/lib/research/signals");
      const owner = await seedChannel("iso-ctx-owner@tally.test");
      const other = await createUser({ email: "iso-ctx-other@tally.test" });

      await expect(
        loadResearchContext(owner.user.id, owner.channelId),
      ).resolves.toMatchObject({ channelId: owner.channelId });

      expect(await loadResearchContext(other.id, owner.channelId)).toBeNull();
    });

    it("does not change another user's idea state", async () => {
      const { db } = await import("@/lib/db");
      const { ideas } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const { setIdeaState } = await import("@/lib/research/ideas");

      const owner = await seedChannel("iso-idea-owner@tally.test");
      const other = await createUser({ email: "iso-idea-other@tally.test" });
      const { runId } = await runResearch(owner.user.id, owner.channelId);

      const rows = await db.select().from(ideas).where(eq(ideas.runId, runId));
      const ideaId = rows[0]?.id;
      if (!ideaId) throw new Error("expected a generated idea");

      // Returns false rather than throwing: the UPDATE is scoped by userId, so a
      // foreign id simply matches no row.
      expect(await setIdeaState(other.id, ideaId, "rejected")).toBe(false);
      expect(await setIdeaState(owner.user.id, ideaId, "rejected")).toBe(true);

      const after = await db.select().from(ideas).where(eq(ideas.id, ideaId));
      expect(after[0]?.state).toBe("rejected");
    });

    it("keeps two channels on one account researching independently", async () => {
      const { db } = await import("@/lib/db");
      const { channelSettings, researchRuns } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const { loadResearchContext } = await import("@/lib/research/signals");

      // §27: "Don't assume shared settings."
      const first = await seedChannel("multi@tally.test", "woodworking");
      const secondChannelId = await createChannel(first.user.id, {
        youtubeChannelId: "UCsecondchannel0000000",
        title: "Second Channel",
      });
      await db.insert(channelSettings).values({
        channelId: secondChannelId,
        userId: first.user.id,
        niche: "personal finance",
        keywords: ["index funds"],
        contentLanguage: "de-DE",
      });

      const a = await loadResearchContext(first.user.id, first.channelId);
      const b = await loadResearchContext(first.user.id, secondChannelId);

      expect(a?.niche).toBe("woodworking");
      expect(b?.niche).toBe("personal finance");
      // Region is derived per channel from its own language setting.
      expect(a?.regionCode).toBe("GB");
      expect(b?.regionCode).toBe("DE");

      // A run on one channel does not appear under the other.
      const { runId } = await runResearch(first.user.id, first.channelId);
      const onSecond = await db
        .select()
        .from(researchRuns)
        .where(eq(researchRuns.channelId, secondChannelId));

      expect(onSecond).toHaveLength(0);
      expect(runId).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------

  describe("project creation from an idea", () => {
    it("marks the idea used and carries the channel's preferred length", async () => {
      const { db } = await import("@/lib/db");
      const { ideas } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const { createProject } = await import("@/lib/projects/service");

      const { user, channelId } = await seedChannel("toproject@tally.test");
      const { runId } = await runResearch(user.id, channelId);

      const rows = await db.select().from(ideas).where(eq(ideas.runId, runId));
      const idea = rows[0];
      if (!idea) throw new Error("expected a generated idea");

      const project = await createProject({
        userId: user.id,
        channelId,
        ideaId: idea.id,
        title: idea.title,
        origin: "manual",
        targetDurationSeconds: 600,
        maxVideosPerMonth: null,
      });

      expect(project.status).toBe("IDEA");
      expect(project.ideaId).toBe(idea.id);
      expect(project.targetDurationSeconds).toBe(600);

      // Marked `used` in the same transaction as the project, so research cannot
      // re-offer an idea that is already in production and the route's
      // already-used guard has something real to read.
      const after = await db.select().from(ideas).where(eq(ideas.id, idea.id));
      expect(after[0]?.state).toBe("used");
    });

    it("counts the started video against the month's quota", async () => {
      const { db } = await import("@/lib/db");
      const { usageCounters } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const { createProject, currentPeriod } = await import(
        "@/lib/projects/service"
      );

      const { user, channelId } = await seedChannel("quota@tally.test");
      await createProject({
        userId: user.id,
        channelId,
        title: "Counted",
        maxVideosPerMonth: null,
      });

      const rows = await db
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.userId, user.id));

      expect(rows[0]?.period).toBe(currentPeriod());
      expect(rows[0]?.videosStarted).toBe(1);
    });
  });
});

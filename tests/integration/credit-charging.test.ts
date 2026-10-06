/**
 * Credits charged at the generation call sites (§10, §12, §13).
 *
 * `credits.test.ts` proves the ledger is correct in isolation. This proves the pipeline
 * actually uses it, which is a different claim and the one that decides whether Vidxir AI
 * bills for the work it does. Everything here runs the real stage functions against the
 * real database, with `mock/placeholder` as the model — a generator that produces real
 * PNG bytes and makes no vendor call, so a charge can be observed without spending
 * anything.
 *
 * The properties, and why each is worth a test rather than a comment:
 *
 *  - **A generated scene is charged.** The `spend` rows exist, one per scene, and the
 *    balance moves by exactly their sum.
 *  - **A retried stage is not charged twice.** This is §13, and it is the property most
 *    easily lost: the visuals stage passes `attempt: 1` for every scene precisely so a
 *    BullMQ retry replays the same key. A per-attempt key would look identical in code
 *    review and triple the bill.
 *  - **Stock footage is not charged at all.** It is paid for by the plan's video
 *    allowance; charging credits as well would bill twice for one video.
 *  - **An unaffordable build is refused before it generates.** Not merely refused — a
 *    build that generated scene one at Vidxir AI's expense and then failed would satisfy a
 *    naive "it threw" assertion while still having spent real money.
 *  - **A failed generation is refunded.** Money taken for an asset that does not exist.
 *  - **Reference stills are charged at the image rate, once per entity.**
 *  - **A continuity regeneration is charged again**, because it is a second clip — and
 *    under a *different* key from the original, which the `attempt + 1` offset exists to
 *    guarantee.
 *  - **No vendor name reaches the ledger.** §3 applies to the transaction history as
 *    much as to the model picker.
 *
 * No live provider is called anywhere in this file.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChannel,
  createUser,
  hasDatabase,
  jar,
  resetDatabase,
  setTier,
  signIn,
  useDatabase,
} from "./setup";

vi.mock("next/headers", () => ({
  cookies: async () => jar,
}));

const ai = vi.hoisted(() => ({ generateJson: vi.fn() }));

vi.mock("@/lib/providers/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/ai")>();
  return { ...actual, generateJson: ai.generateJson };
});

const suite = hasDatabase ? describe : describe.skip;

/** The development model: real bytes, no vendor, 1 credit per 1080p scene. */
const MOCK_MODEL = "mock/placeholder";

/** Vendor names that must never appear in anything a customer reads (§3). */
const VENDOR_NAMES =
  /veo|gemini|minimax|wan\b|seedance|dashscope|fal\.ai|runway|bedrock|stripe|pexels|elevenlabs/i;

const scriptDraft = () => ({
  title: "The three-week hallway test",
  titleIdeas: ["Twelve sensors, one hallway"],
  hook: "Every review tests the flagship. Nobody tested the cheap one.",
  introduction: "So I bought twelve of the cheapest sensors sold.",
  sections: [
    {
      heading: "The claim",
      body: "Budget sensors are said to fail within weeks.",
      talkingPoints: ["Cheap tier is dismissed"],
      transition: "So I measured it.",
    },
    {
      heading: "The test",
      body: "Twelve sensors, three weeks, one hallway.",
      talkingPoints: ["Twelve units"],
      transition: "Here is what happened.",
    },
    {
      heading: "The result",
      body: "Two failed early. The other ten never missed.",
      talkingPoints: ["Two failures"],
    },
  ],
  conclusion: "For anything non-critical the cheap tier is fine.",
  cta: "The parts list is linked below.",
  storyStructure: "claim → test → result",
  references: [{ label: "Manufacturer datasheet" }],
});

const direction = (count: number) => ({
  scenes: Array.from({ length: count }, (_, index) => ({
    index,
    visualPrompt: `A close shot of sensor ${index + 1} on a hallway wall`,
    searchTerms: ["smart home sensor", "hallway"],
  })),
  mood: "calm-documentary",
});

/**
 * A story bible with entities to draw, shaped to `PlanSchema`.
 *
 * Needed because the reference-image stage draws what the *bible* names, so a mock that
 * returned scene direction for this call too would leave nothing to charge for — and the
 * charge assertions would pass vacuously. That is exactly what happened on the first run
 * of this file: `planStoryBible` threw on `raw.characters` being undefined, the planner
 * logged "continuing without it", and the reference tests took their empty branch.
 *
 * Two characters, one environment and one prop, so the per-entity charge can be counted
 * against a number greater than one.
 */
const storyBible = (sceneCount: number) => ({
  premise: "A renter tests twelve cheap sensors over three weeks.",
  structure: "claim → test → result",
  tone: "dry, methodical",
  style: {
    medium: "documentary photography",
    palette: ["warm grey", "amber"],
    lighting: "available light",
    camera: "handheld, close",
    notes: ["no captions burned in"],
  },
  characters: [
    {
      id: "the-renter",
      name: "The renter",
      role: "narrator and tester",
      appearance: ["mid-thirties", "cropped dark hair"],
      wardrobe: ["grey work shirt"],
      demeanour: "unhurried",
      arc: "sceptical, then convinced",
    },
    {
      id: "the-landlord",
      name: "The landlord",
      role: "reluctant participant",
      appearance: ["tall", "wire-framed glasses"],
      wardrobe: ["navy quilted jacket"],
      demeanour: "wary",
      arc: "unmoved",
    },
  ],
  environments: [
    {
      id: "the-hallway",
      name: "The hallway",
      description: ["long", "one window at the far end"],
      lighting: "cold daylight from a single window",
      palette: ["grey", "cream"],
    },
  ],
  props: [
    {
      id: "the-sensor",
      name: "The sensor",
      description: ["matte white", "the size of a matchbox"],
      significance: "the thing being tested",
    },
  ],
  scenes: Array.from({ length: sceneCount }, (_, index) => ({
    index,
    characters: ["the-renter"],
    environment: "the-hallway",
    props: ["the-sensor"],
    beat: index === 0 ? "setup" : "development",
    changes: [],
    echoesSceneIndex: null,
  })),
});

suite("credits charged at the generation call sites (integration)", () => {
  useDatabase();

  beforeAll(async () => {
    await import("@/lib/video/service");
    await import("@/lib/storage");
    const { getRedis } = await import("@/lib/queue/redis");
    await getRedis().ping();
  }, 120_000);

  afterAll(async () => {
    const { closeQueues } = await import("@/lib/queue/queues");
    const { closeRedis } = await import("@/lib/queue/redis");
    await closeQueues();
    await closeRedis();
  });

  beforeEach(async () => {
    await resetDatabase();
    ai.generateJson.mockReset();
    /**
     * Dispatched on `usage.operation`, because the pipeline makes two different AI calls
     * and they want different shapes.
     *
     * A single canned reply is what made the reference-image assertions vacuous on the
     * first run: the continuity planner got the scene-direction object, threw on
     * `raw.characters`, degraded to textual continuity as designed, and left no entities
     * to draw. Answering each call with the schema it actually asked for is what makes
     * this file exercise the image charge at all.
     */
    ai.generateJson.mockImplementation(
      async (options: { usage?: { operation?: string } }) =>
        options.usage?.operation === "continuity.plan"
          ? storyBible(24)
          : direction(24),
    );
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /**
   * A Scale-tier project with an approved script, ready for the visuals stage.
   *
   * Scale rather than Studio so the plan's own video allowance is unlimited and cannot
   * refuse a build for a reason this file is not about. `mode` decides whether the
   * project generates or sources stock — the one field every test here varies.
   */
  async function fixture(
    email: string,
    options: { mode?: "AI_VIDEO" | "STOCK"; quality?: string } = {},
  ) {
    const { db } = await import("@/lib/db");
    const { channelSettings, projects } = await import("@/lib/db/schema");
    const { createProject, transition } = await import("@/lib/projects/service");
    const { approveScript, persistScriptVersion } = await import(
      "@/lib/scripts/service"
    );
    const { eq } = await import("drizzle-orm");

    const user = await createUser({ email });
    await setTier(user.id, "scale");
    const channelId = await createChannel(user.id);

    await db.insert(channelSettings).values({
      channelId,
      userId: user.id,
      niche: "home automation",
      targetAudience: "renters setting up a first smart home",
      contentStyle: "storytelling",
      contentLanguage: "en-GB",
      preferredLengthSeconds: 120,
      keywords: ["smart home", "sensors"],
    });

    const project = await createProject({
      userId: user.id,
      channelId,
      title: `Credits fixture ${email}`,
      maxVideosPerMonth: null,
    });

    const mode = options.mode ?? "AI_VIDEO";
    await db
      .update(projects)
      .set({
        generationMode: mode,
        generationModel: mode === "AI_VIDEO" ? MOCK_MODEL : null,
        videoQuality: mode === "AI_VIDEO" ? (options.quality ?? "1080p") : null,
        videoFormat: "landscape",
      })
      .where(eq(projects.id, project.id));

    await persistScriptVersion({
      userId: user.id,
      projectId: project.id,
      draft: scriptDraft(),
      source: "ai",
    });
    await approveScript(user.id, project.id);

    // The path the script stage takes. ASSETS_GENERATING is reachable only from
    // SCRIPT_READY, so a fixture that skips this tests a state production cannot reach.
    await transition(user.id, project.id, "SCRIPT_GENERATING", {
      stage: "SCRIPT",
      message: "Writing the script",
    });
    await transition(user.id, project.id, "SCRIPT_READY", {
      stage: "SCRIPT",
      message: "Script ready",
    });

    return { user, channelId, projectId: project.id };
  }

  /** Run one stage with the bookkeeping the worker does around a handler. */
  async function runStage<T>(
    stage: "scene-plan" | "voiceover" | "visuals",
    context: { userId: string; projectId: string; channelId: string },
  ): Promise<T> {
    const service = await import("@/lib/video/service");
    const { enqueue, markJobFailed, markJobSucceeded } = await import(
      "@/lib/queue/jobs"
    );

    const stageName = {
      "scene-plan": "SCENE_PLAN",
      voiceover: "VOICEOVER",
      visuals: "VISUALS",
    }[stage] as "SCENE_PLAN" | "VOICEOVER" | "VISUALS";

    const job = await enqueue({
      queue: "pipeline",
      name: `video-${stage}`,
      userId: context.userId,
      channelId: context.channelId,
      projectId: context.projectId,
      stage: stageName,
      payload: { projectId: context.projectId, tier: "scale" },
      traceId: "test-trace",
      statusMessage: "Queued",
    });

    const execute = {
      "scene-plan": service.executeScenePlan,
      voiceover: service.executeVoiceover,
      visuals: service.executeVisuals,
    }[stage];

    try {
      const result = await execute({
        userId: context.userId,
        projectId: context.projectId,
        jobId: job.id,
        tier: "scale",
        traceId: "test-trace",
      });
      await markJobSucceeded(job.id, result as Record<string, unknown>);
      return result as T;
    } catch (error) {
      await markJobFailed(job.id, error);
      throw error;
    }
  }

  /** Start the build through the real entry point, then close its queued job out. */
  async function startBuild(context: {
    userId: string;
    projectId: string;
    channelId: string;
  }) {
    const { startVideoBuild } = await import("@/lib/video/service");
    const { markJobSucceeded } = await import("@/lib/queue/jobs");

    const started = await startVideoBuild({
      userId: context.userId,
      projectId: context.projectId,
      tier: "scale",
      traceId: "test-trace",
    });
    await markJobSucceeded(started.jobId, { queued: true });
    return started;
  }

  /** Scene plan and voiceover, so the visuals stage has scenes and durations. */
  async function upToVisuals(context: {
    userId: string;
    projectId: string;
    channelId: string;
  }) {
    await startBuild(context);
    const plan = await runStage<{ sceneCount: number }>("scene-plan", context);
    await runStage("voiceover", context);
    return plan;
  }

  // -------------------------------------------------------------------------
  // Ledger readers
  // -------------------------------------------------------------------------

  async function ledgerRows(userId: string) {
    const { db } = await import("@/lib/db");
    const { creditLedger } = await import("@/lib/db/schema");
    const { asc, eq } = await import("drizzle-orm");
    return db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.userId, userId))
      .orderBy(asc(creditLedger.createdAt));
  }

  async function spendRows(userId: string) {
    return (await ledgerRows(userId)).filter((row) => row.reason === "spend");
  }

  async function balance(userId: string) {
    const { creditBalanceFor } = await import("@/lib/credits/service");
    return creditBalanceFor(userId);
  }

  /**
   * The balance a subscriber actually starts a build with.
   *
   * Read *after* an explicit grant, because that is the production state: the billing
   * webhook grants the period's credits when the subscription is applied, so by the time
   * anyone reaches the visuals stage the row exists. A baseline read before any grant
   * would be zero, and every "the balance moved by exactly the ledger" assertion below
   * would then be comparing against the wrong starting point — which is precisely how
   * these three tests failed on their first run.
   */
  async function baseline(userId: string): Promise<number> {
    const { ensureMonthlyGrant } = await import("@/lib/credits/service");
    await ensureMonthlyGrant(userId, {});
    return (await balance(userId)).available;
  }

  /** Set the balance to an exact figure, as a partly-spent account would read. */
  async function setAvailable(userId: string, available: number): Promise<void> {
    const { db } = await import("@/lib/db");
    const { creditBalances } = await import("@/lib/db/schema");
    const { ensureMonthlyGrant } = await import("@/lib/credits/service");
    const { eq } = await import("drizzle-orm");

    // Granted first, so the row exists and `ensureMonthlyGrant` inside the charge path
    // finds the period already current and does not re-grant over this figure.
    const grant = await ensureMonthlyGrant(userId, {});
    await db
      .update(creditBalances)
      .set({ spent: Math.max(0, grant.credits - available) })
      .where(eq(creditBalances.userId, userId));
  }

  // -------------------------------------------------------------------------
  // Scene generation
  // -------------------------------------------------------------------------

  describe("the visuals stage", () => {
    it(
      "charges once per generated scene and moves the balance by their sum",
      async () => {
        const { user, projectId, channelId } = await fixture("charge@vidxir.test");
        const context = { userId: user.id, projectId, channelId };

        const plan = await upToVisuals(context);
        const before = await baseline(user.id);

        const result = await runStage<{ acquired: number }>("visuals", context);
        expect(result.acquired).toBe(plan.sceneCount);

        const spends = await spendRows(user.id);
        expect(spends).toHaveLength(plan.sceneCount);
        expect(spends.every((row) => row.operation === "video_scene")).toBe(true);
        expect(spends.every((row) => row.modelId === MOCK_MODEL)).toBe(true);
        expect(spends.every((row) => row.projectId === projectId)).toBe(true);

        // The balance moved by exactly what the ledger says, which is the property
        // `reconcile` checks globally and this checks for one build.
        const charged = spends.reduce((sum, row) => sum + Math.abs(row.amount), 0);
        const after = await balance(user.id);
        expect(after.available).toBe(before - charged);

        const { reconcile } = await import("@/lib/credits/service");
        expect((await reconcile(user.id)).consistent).toBe(true);
      },
      180_000,
    );

    it(
      "charges the same total when the stage is retried",
      async () => {
        /**
         * §13, and the reason `attempt: 1` is hard-coded in the visuals stage. A retried
         * BullMQ job replays the same per-scene keys, loses the ledger insert and charges
         * zero — so the customer pays once per scene generated, not once per attempt.
         */
        const { user, projectId, channelId } = await fixture("retry@vidxir.test");
        const context = { userId: user.id, projectId, channelId };

        await upToVisuals(context);
        await runStage("visuals", context);

        const afterFirst = await balance(user.id);
        const firstSpends = await spendRows(user.id);
        expect(firstSpends.length).toBeGreaterThan(0);

        // The same stage again, exactly as a retry would run it.
        await runStage("visuals", context);

        const afterSecond = await balance(user.id);
        expect(afterSecond.available).toBe(afterFirst.available);
        expect(await spendRows(user.id)).toHaveLength(firstSpends.length);
      },
      240_000,
    );

    it(
      "charges nothing for a stock-footage build",
      async () => {
        /**
         * Stock is paid for by the plan's monthly video allowance, which
         * `assertCanStartVideo` enforces at the request that starts the build. Charging
         * credits as well would bill twice for one video.
         */
        const { user, projectId, channelId } = await fixture("stock@vidxir.test", {
          mode: "STOCK",
        });
        const context = { userId: user.id, projectId, channelId };

        await upToVisuals(context);
        const result = await runStage<{ acquired: number }>("visuals", context);

        expect(result.acquired).toBeGreaterThan(0);
        expect(await spendRows(user.id)).toHaveLength(0);
      },
      180_000,
    );

    it(
      "refuses an unaffordable build before generating any of it",
      async () => {
        /**
         * The cost guard, and the assertion that makes it worth having: not just that it
         * threw, but that **no scene was generated**. A stage that refused only at the
         * charge would have produced scene one at Vidxir AI's expense first, and the
         * eighty-scene version of that is eighty vendor calls for a video that could
         * never finish.
         */
        const { user, projectId, channelId } = await fixture("broke@vidxir.test");
        const context = { userId: user.id, projectId, channelId };

        const plan = await upToVisuals(context);
        expect(plan.sceneCount).toBeGreaterThan(1);

        // One credit short of a single scene, so the whole build is unaffordable.
        await setAvailable(user.id, 0);

        const { InsufficientCreditsError } = await import("@/lib/errors");
        await expect(runStage("visuals", context)).rejects.toBeInstanceOf(
          InsufficientCreditsError,
        );

        // Nothing charged, and nothing generated.
        expect(await spendRows(user.id)).toHaveLength(0);

        const { db } = await import("@/lib/db");
        const { scenes } = await import("@/lib/db/schema");
        const { eq, and, isNotNull } = await import("drizzle-orm");
        const filled = await db
          .select({ index: scenes.index })
          .from(scenes)
          .where(
            and(eq(scenes.projectId, projectId), isNotNull(scenes.visualAssetId)),
          );
        expect(filled).toHaveLength(0);
      },
      180_000,
    );

    it(
      "refuses when the balance covers some scenes but not the whole build",
      async () => {
        /**
         * The estimate is for the *build*, not for the next scene. A user who can afford
         * three scenes of a twenty-four-scene video does not want three scenes generated
         * and then a failure — they want to be told before anything is spent, which is
         * what leaves the credits available for a shorter video or a cheaper model.
         */
        const { user, projectId, channelId } = await fixture("partial@vidxir.test");
        const context = { userId: user.id, projectId, channelId };

        const plan = await upToVisuals(context);
        await setAvailable(user.id, 2);
        expect(plan.sceneCount).toBeGreaterThan(2);

        const { InsufficientCreditsError } = await import("@/lib/errors");
        await expect(runStage("visuals", context)).rejects.toBeInstanceOf(
          InsufficientCreditsError,
        );

        expect(await spendRows(user.id)).toHaveLength(0);
        expect((await balance(user.id)).available).toBe(2);
      },
      180_000,
    );

    it(
      "refunds the scene it charged for when the generation fails",
      async () => {
        /**
         * §12. We took money and produced no asset, so the money goes back.
         *
         * The failure is injected at `generateClip`, which is the provider boundary the
         * charge wraps — mocking anything further out would test the mock.
         */
        const { user, projectId, channelId } = await fixture("refund@vidxir.test");
        const context = { userId: user.id, projectId, channelId };

        await upToVisuals(context);
        const before = await baseline(user.id);

        const videoGen = await import("@/lib/providers/video-gen");
        const generateClip = vi
          .spyOn(videoGen, "generateClip")
          .mockRejectedValue(new Error("provider exploded"));

        try {
          await expect(runStage("visuals", context)).rejects.toThrow(
            /provider exploded/,
          );
        } finally {
          generateClip.mockRestore();
        }

        const rows = await ledgerRows(user.id);
        const spends = rows.filter((row) => row.reason === "spend");
        const refunds = rows.filter((row) => row.reason === "refund");

        // Exactly one scene was attempted — the stage is sequential and fails on the
        // first — so exactly one charge and one refund.
        expect(spends).toHaveLength(1);
        expect(refunds).toHaveLength(1);
        expect(refunds[0]?.amount).toBe(Math.abs(spends[0]?.amount ?? 0));

        // Net zero: the customer is where they started.
        expect((await balance(user.id)).available).toBe(before);

        const { reconcile } = await import("@/lib/credits/service");
        expect((await reconcile(user.id)).consistent).toBe(true);
      },
      180_000,
    );

    it(
      "does not charge a second time for a scene whose first attempt was refunded",
      async () => {
        /**
         * The deliberate leak, asserted so it cannot widen without a test failing.
         *
         * The refunded charge keeps its idempotency key, so the retry finds the key used
         * and charges zero — that one generation is free. The alternative would be to
         * clear the key, which would break `refundCredits`' own `refund:{key}` guard on a
         * second failure and could refund twice. One free generation per failure, in the
         * customer's favour, is the smaller and safer error.
         */
        const { user, projectId, channelId } = await fixture("freeretry@vidxir.test");
        const context = { userId: user.id, projectId, channelId };

        await upToVisuals(context);
        const before = await baseline(user.id);

        const videoGen = await import("@/lib/providers/video-gen");
        const generateClip = vi
          .spyOn(videoGen, "generateClip")
          .mockRejectedValue(new Error("provider exploded"));
        try {
          await expect(runStage("visuals", context)).rejects.toThrow();
        } finally {
          generateClip.mockRestore();
        }

        // The retry succeeds. Scene 0 is free; every later scene is charged normally.
        const result = await runStage<{ acquired: number }>("visuals", context);
        expect(result.acquired).toBeGreaterThan(1);

        const spends = await spendRows(user.id);
        // One `spend` row per scene still, including the refunded one.
        expect(spends).toHaveLength(result.acquired);

        const after = await balance(user.id);
        const sceneCost = Math.abs(spends[1]?.amount ?? 0);
        expect(sceneCost).toBeGreaterThan(0);
        // Charged for every scene but the refunded one.
        expect(after.available).toBe(before - sceneCost * (result.acquired - 1));

        const { reconcile } = await import("@/lib/credits/service");
        expect((await reconcile(user.id)).consistent).toBe(true);
      },
      300_000,
    );

    it(
      "describes a spend without naming the vendor behind the model",
      async () => {
        // §3 applies to the transaction history, not only to the picker.
        const { user, projectId, channelId } = await fixture("vendor@vidxir.test");
        const context = { userId: user.id, projectId, channelId };

        await upToVisuals(context);
        await runStage("visuals", context);

        const { creditHistoryFor } = await import("@/lib/credits/service");
        const history = await creditHistoryFor(user.id, {});
        expect(history.length).toBeGreaterThan(0);

        for (const entry of history) {
          expect(entry.description).not.toMatch(VENDOR_NAMES);
        }
      },
      180_000,
    );
  });

  // -------------------------------------------------------------------------
  // Reference stills (§5, §6)
  // -------------------------------------------------------------------------

  describe("the reference-image stage", () => {
    /** Run the reference stage the way the worker does. */
    async function runReferences(context: {
      userId: string;
      projectId: string;
      channelId: string;
    }) {
      const { executeReferenceImages } = await import("@/lib/video/service");
      const { enqueue, markJobFailed, markJobSucceeded } = await import(
        "@/lib/queue/jobs"
      );

      const job = await enqueue({
        queue: "pipeline",
        name: "video-reference-images",
        userId: context.userId,
        channelId: context.channelId,
        projectId: context.projectId,
        stage: "SCENE_PLAN",
        payload: { projectId: context.projectId, tier: "scale" },
        traceId: "test-trace",
        statusMessage: "Queued",
      });

      try {
        const result = await executeReferenceImages({
          userId: context.userId,
          projectId: context.projectId,
          jobId: job.id,
          tier: "scale",
          traceId: "test-trace",
        });
        await markJobSucceeded(job.id, result as unknown as Record<string, unknown>);
        return result;
      } catch (error) {
        await markJobFailed(job.id, error);
        throw error;
      }
    }

    /**
     * The continuity flag, forced on for the duration of a call.
     *
     * `lib/env` caches on first touch, so both the assignment and the reset are needed,
     * and the reset must be in a `finally` — a test that left the flag on would change
     * the behaviour of every test after it.
     */
    async function withContinuity<T>(run: () => Promise<T>): Promise<T> {
      const { resetEnvCache } = await import("@/lib/env");
      const previous = process.env["VIDXIR_CONTINUITY_ENGINE_ENABLED"];
      process.env["VIDXIR_CONTINUITY_ENGINE_ENABLED"] = "true";
      resetEnvCache();
      try {
        return await run();
      } finally {
        if (previous === undefined) {
          delete process.env["VIDXIR_CONTINUITY_ENGINE_ENABLED"];
        } else {
          process.env["VIDXIR_CONTINUITY_ENGINE_ENABLED"] = previous;
        }
        resetEnvCache();
      }
    }

    it(
      "charges the image rate once per entity, and not again on a re-run",
      async () => {
        const { user, projectId, channelId } = await fixture("refs@vidxir.test");
        const context = { userId: user.id, projectId, channelId };

        await withContinuity(async () => {
          // The bible is written by the scene-plan stage, which the reference stage reads.
          await startBuild(context);
          await runStage("scene-plan", context);

          const first = await runReferences(context);

          /**
           * Asserted, not tolerated.
           *
           * The bible the mock returns names four entities, so a run that drew nothing
           * means the stage did not reach the image path — and every charge assertion
           * below would then be true of nothing at all. An earlier version of this test
           * allowed `generated === 0` and passed for exactly that reason.
           */
          expect(first.generated).toBeGreaterThan(0);
          expect(first.reason).toBe("");

          const spends = await spendRows(user.id);
          const images = spends.filter((row) => row.operation === "image");
          expect(images).toHaveLength(first.generated);
          expect(images.every((row) => row.modelId === MOCK_MODEL)).toBe(true);

          const { imagePriceFor } = await import("@/lib/credits/pricing");
          const expected = imagePriceFor(MOCK_MODEL, "1080p");
          expect(images.every((row) => Math.abs(row.amount) === expected)).toBe(true);

          // A second run redraws nothing, so it charges nothing.
          const afterFirst = await balance(user.id);
          const second = await runReferences(context);
          expect(second.generated).toBe(0);
          expect((await balance(user.id)).available).toBe(afterFirst.available);
          expect(
            (await spendRows(user.id)).filter((row) => row.operation === "image"),
          ).toHaveLength(images.length);
        });
      },
      240_000,
    );

    it(
      "stops rather than refusing once per entity when credits run out",
      async () => {
        /**
         * References are optional by design — the video renders without them — so an
         * empty balance stops the run and reports it, rather than failing the project or
         * asking seven more times for an answer already known.
         */
        const { user, projectId, channelId } = await fixture("refsbroke@vidxir.test");
        const context = { userId: user.id, projectId, channelId };

        await withContinuity(async () => {
          await startBuild(context);
          await runStage("scene-plan", context);
          await setAvailable(user.id, 0);

          const result = await runReferences(context);

          expect(result.generated).toBe(0);
          expect(await spendRows(user.id)).toHaveLength(0);

          // The entities it did not attempt are reported as skipped, because that is what
          // happened to them — and the reason says so in words a customer can act on,
          // naming no vendor (§3).
          expect(result.skipped).toBeGreaterThan(0);
          expect(result.reason).toMatch(/credit/i);
          expect(result.reason).not.toMatch(VENDOR_NAMES);
        });
      },
      240_000,
    );
  });

  // -------------------------------------------------------------------------
  // Continuity regeneration (§12)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // The quote
  // -------------------------------------------------------------------------

  /**
   * What the picker is told a scene will cost, against what it actually costs (§20).
   *
   * Every other block here proves the charge is correct. This proves the *quote* is,
   * which is a separate and equally billable claim: `/api/video/providers` computes the
   * figure the customer reads before pressing Generate, and if it disagreed with the
   * ledger row the pipeline writes, Vidxir AI would be quoting one price and taking another.
   *
   * Asserted by crossing the two rather than by calling `scenePriceFor` twice — a test
   * that re-derived the price from the same function would pass just as happily if that
   * function were wrong.
   */
  describe("the cost preview", () => {
    /** The catalogue, as the picker fetches it. */
    async function fetchCatalogue() {
      const { NextRequest } = await import("next/server");
      const { GET } = await import("@/app/api/video/providers/route");

      const response = await GET(
        new NextRequest("http://localhost:3000/api/video/providers", {
          method: "GET",
        }) as never,
      );

      return {
        status: response.status,
        body: (await response.json()) as {
          data?: {
            models?: {
              id: string;
              sceneCredits: number;
              sceneSeconds: number;
              defaultQuality: string;
              qualities: {
                quality: string;
                sceneCredits: number;
                imageCredits: number | null;
              }[];
            }[];
            credits?: { available: number; period: string; canTopUp: boolean };
          };
          error?: { code?: string };
        },
      };
    }

    /** Onboarded, which `requireOnboarded()` demands before the catalogue is readable. */
    async function onboard(userId: string): Promise<void> {
      const { saveStep, complete } = await import("@/lib/onboarding/service");
      await saveStep(userId, {
        niche: "Home automation",
        contentStyle: "documentary",
        voicePreference: "warm-male",
      });
      await complete(userId);
    }

    it(
      "quotes exactly what the visuals stage then charges per scene",
      async () => {
        const { user, projectId, channelId } = await fixture("quote@vidxir.test");
        const context = { userId: user.id, projectId, channelId };
        await onboard(user.id);
        await signIn(user);

        const catalogue = await fetchCatalogue();
        expect(catalogue.status).toBe(200);

        /**
         * The mock model is the only one available under `VIDXIR_USE_MOCK_PROVIDERS`, and
         * it is also the model the fixture generates with — which is what makes this
         * crossing possible at all without a vendor call.
         */
        const quoted = catalogue.body.data?.models?.find((m) => m.id === MOCK_MODEL);
        expect(quoted, "the mock model should be in the catalogue").toBeDefined();

        const at1080p = quoted?.qualities.find((q) => q.quality === "1080p");
        expect(at1080p?.sceneCredits).toBeGreaterThan(0);

        await upToVisuals(context);
        await runStage("visuals", context);

        const spends = await spendRows(user.id);
        expect(spends.length).toBeGreaterThan(0);

        /**
         * The assertion this block exists for.
         *
         * The fixture's project is 1080p, every scene is `BASE_SECONDS` long on the mock
         * model, and so each ledger row must be exactly the figure the catalogue quoted
         * for that resolution. A drift between the two — a display price computed
         * separately, a multiplier applied on one side only — fails here rather than
         * showing up as a customer complaint.
         */
        for (const row of spends) {
          expect(Math.abs(row.amount), `scene ${row.operation}`).toBe(
            at1080p?.sceneCredits,
          );
          expect(row.quality).toBe("1080p");
        }
      },
      180_000,
    );

    it("reports the caller's own balance and grants nothing by reading it", async () => {
      /**
       * The balance travels with the catalogue so the picker can say "you cannot afford
       * this", and `creditBalanceFor` is used rather than `ensureMonthlyGrant` precisely
       * so a page load cannot mint credits. Both halves are asserted: the figure is the
       * real one, and reading it twice does not move it.
       */
      const { user } = await fixture("quote-balance@vidxir.test");
      await onboard(user.id);
      await signIn(user);

      const { ensureMonthlyGrant, creditBalanceFor } = await import(
        "@/lib/credits/service"
      );
      const grant = await ensureMonthlyGrant(user.id, {});
      expect(grant.credits).toBeGreaterThan(0);

      const first = await fetchCatalogue();
      expect(first.body.data?.credits?.available).toBe(grant.credits);

      const second = await fetchCatalogue();
      expect(second.body.data?.credits?.available).toBe(grant.credits);
      // Read from the database rather than from the response, so a route that granted
      // on read is caught even if it reported the pre-grant figure.
      expect((await creditBalanceFor(user.id)).granted).toBe(grant.credits);
    });

    it("does not grant an allowance to a user who has never had one", async () => {
      /**
       * The stricter half of the same claim. A brand-new account reads zero here, which
       * is honest — understating a balance is safe, because the charge path grants
       * before it charges and so nothing is refused for want of a grant this read
       * declined to make. A route that granted would show a non-zero figure and write a
       * `monthly_grant` row on a page view.
       */
      const { user } = await fixture("quote-nogrant@vidxir.test");
      await onboard(user.id);
      await signIn(user);

      const result = await fetchCatalogue();
      expect(result.body.data?.credits?.available).toBe(0);

      expect(await ledgerRows(user.id)).toHaveLength(0);
    });

    it("refuses an unauthenticated read of the catalogue", async () => {
      // The prices are not secret, but which models this deployment configured is
      // operational detail, and the balance is the caller's.
      jar.clear();
      expect((await fetchCatalogue()).status).toBe(401);
    });

    it("prices every listed resolution and names no vendor (§3, §20)", async () => {
      const { user } = await fixture("quote-shape@vidxir.test");
      await onboard(user.id);
      await signIn(user);

      const result = await fetchCatalogue();
      const models = result.body.data?.models ?? [];
      expect(models.length).toBeGreaterThan(0);

      for (const model of models) {
        expect(model.qualities.length).toBeGreaterThan(0);
        // The headline and the row the picker opens on have to agree, or the card quotes
        // one number and the control beneath it another.
        const atDefault = model.qualities.find(
          (q) => q.quality === model.defaultQuality,
        );
        expect(atDefault?.sceneCredits, model.id).toBe(model.sceneCredits);
        expect(model.sceneSeconds).toBe(5);
        for (const quality of model.qualities) {
          expect(quality.sceneCredits, `${model.id}/${quality.quality}`).toBeGreaterThan(
            0,
          );
        }
      }

      /**
       * §3 applies to the priced payload as much as to the model labels: the pricing
       * table is keyed by model id, and leaking those keys would name backends.
       *
       * Scoped to `models` and `credits` — the parts §3 governs and the parts this task
       * added — rather than to the whole response. The response also carries
       * `stock: capabilityStatus("visuals")`, whose `hint` names the stock-library and
       * legacy-video vendors; that field predates the branded-model layer and is a
       * different surface with a different audience, so folding it into this assertion
       * would either fail for a reason unrelated to pricing or force the check to be
       * relaxed until it tested nothing.
       */
      const priced = JSON.stringify({
        models: result.body.data?.models,
        credits: result.body.data?.credits,
      });
      expect(priced).not.toMatch(VENDOR_NAMES);
    });
  });

  describe("scene regeneration", () => {
    it(
      "charges again, under a key the original generation did not use",
      async () => {
        /**
         * A regeneration is a second clip and is charged for. The key must differ from
         * the original's — `attempt + 1` is what guarantees it, because
         * `countRegeneration` returns 1 for the first regeneration while the original
         * charged under `attempt: 1`. Without the offset the keys would collide and
         * every first regeneration would be free, which is the case that costs most:
         * a project failing continuity usually fails it on several scenes.
         */
        const { sceneChargeKey } = await import("@/lib/credits/service");

        const original = sceneChargeKey({
          projectId: "p",
          sceneIndex: 3,
          attempt: 1,
        });
        const firstRegeneration = sceneChargeKey({
          projectId: "p",
          sceneIndex: 3,
          attempt: 2,
        });

        expect(original).not.toBe(firstRegeneration);
      },
    );

    it(
      "charges a regeneration against the ledger with the scene recorded",
      async () => {
        const { user, projectId, channelId } = await fixture("regen@vidxir.test");
        const context = { userId: user.id, projectId, channelId };

        await withRegeneration(context, async (executeSceneRegeneration, jobId) => {
          await upToVisuals(context);
          await runStage("visuals", context);

          const beforeSpends = await spendRows(user.id);
          const before = await balance(user.id);

          const result = await executeSceneRegeneration({
            userId: user.id,
            projectId,
            jobId,
            tier: "scale",
            traceId: "test-trace",
            sceneIndex: 0,
          });

          /**
           * Asserted rather than tolerated, for the reason the reference test is: a
           * declined regeneration charges nothing, so every assertion below would hold
           * vacuously and the test would prove only that the stage can decline.
           */
          expect(result.regenerated).toBe(true);
          expect(result.attempt).toBe(1);

          const spends = await spendRows(user.id);
          expect(spends).toHaveLength(beforeSpends.length + 1);

          const charge = spends[spends.length - 1];
          expect(charge?.operation).toBe("video_scene");
          expect(charge?.projectId).toBe(projectId);
          expect(Math.abs(charge?.amount ?? 0)).toBeGreaterThan(0);
          expect((await balance(user.id)).available).toBeLessThan(before.available);

          const { reconcile } = await import("@/lib/credits/service");
          expect((await reconcile(user.id)).consistent).toBe(true);
        });
      },
      300_000,
    );

    /** The regeneration stage with the continuity flag on and a job row to report to. */
    async function withRegeneration(
      context: { userId: string; projectId: string; channelId: string },
      run: (
        execute: (typeof import("@/lib/video/service"))["executeSceneRegeneration"],
        jobId: string,
      ) => Promise<void>,
    ): Promise<void> {
      const { resetEnvCache } = await import("@/lib/env");
      const previous = process.env["VIDXIR_CONTINUITY_ENGINE_ENABLED"];
      process.env["VIDXIR_CONTINUITY_ENGINE_ENABLED"] = "true";
      resetEnvCache();

      try {
        const { executeSceneRegeneration } = await import("@/lib/video/service");
        const { enqueue, markJobSucceeded } = await import("@/lib/queue/jobs");

        const job = await enqueue({
          queue: "pipeline",
          name: "video-scene-regen",
          userId: context.userId,
          channelId: context.channelId,
          projectId: context.projectId,
          stage: "QUALITY_CHECK",
          payload: {
            projectId: context.projectId,
            tier: "scale",
            sceneIndex: 0,
          },
          traceId: "test-trace",
          statusMessage: "Queued",
        });

        await run(executeSceneRegeneration, job.id);
        await markJobSucceeded(job.id, { done: true });
      } finally {
        if (previous === undefined) {
          delete process.env["VIDXIR_CONTINUITY_ENGINE_ENABLED"];
        } else {
          process.env["VIDXIR_CONTINUITY_ENGINE_ENABLED"] = previous;
        }
        resetEnvCache();
      }
    }
  });
});

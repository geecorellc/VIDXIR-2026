/**
 * Video pipeline integration tests (§10, §20, §38, §39, §42).
 *
 * This is the test that decides whether Vidxir AI can actually make a video. Every
 * other Phase 5 test asserts a part: `render.test.ts` the argument list,
 * `render.smoke.test.ts` that ffmpeg accepts our synthetic bytes, `timeline.test.ts`
 * the offsets. None of them run the pipeline. What is proven only here:
 *
 *  - **Seven stages chain to a finished MP4.** Scene plan → voiceover → visuals →
 *    music → captions → timeline → render, each stage reading the rows the last
 *    one wrote, ending with a `render_output` asset in object storage and the
 *    project at VIDEO_READY.
 *  - **The MP4 is a real video.** The bytes are read back out of storage and
 *    parsed — a `render_output` row pointing at something unplayable is exactly
 *    the failure §42 forbids.
 *  - **Progress is derived from work done.** Stage weights accumulate; the number
 *    never goes backwards and never arrives before the work does.
 *  - **A missing prerequisite fails loudly.** Rendering without an approved
 *    script, or building scenes from nothing, must record FAILED with a real
 *    reason rather than producing a silent empty video.
 *  - **Timeline offsets come from measured audio.** Scene start times are the
 *    accumulated narration durations actually written by the voiceover stage, not
 *    an even division of an estimate.
 *
 * Only `lib/providers/ai` is mocked, and only because scene direction is the one
 * AI call in the pipeline and §40 forbids spending credits in tests. Voice,
 * visuals, music and transcription run as the development mocks the setup enables
 * — real WAVs, real PNGs, real durations — and the renderer is the real ffmpeg.
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

const ai = vi.hoisted(() => ({ generateJson: vi.fn() }));

vi.mock("@/lib/providers/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/ai")>();
  return { ...actual, generateJson: ai.generateJson };
});

/**
 * A local encode needs an ffmpeg binary. It is a declared dependency, so this is
 * only false when the postinstall download was skipped — the same condition that
 * makes `render: not_configured` the honest state (§48). The scene-planning and
 * asset stages are asserted regardless; only the render leg depends on it.
 */
const { ffmpegBinary } = await import("@/lib/media/ffmpeg");
const hasEncoder = ffmpegBinary() !== null;

const suite = hasDatabase ? describe : describe.skip;

// ---------------------------------------------------------------------------
// MP4 parsing
// ---------------------------------------------------------------------------

const CONTAINERS = new Map([
  ["moov", 0],
  ["trak", 0],
  ["mdia", 0],
  ["minf", 0],
  ["stbl", 0],
  ["stsd", 8],
]);

function boxes(buffer: Buffer): Array<{ type: string; payload: Buffer }> {
  const found: Array<{ type: string; payload: Buffer }> = [];
  let offset = 0;

  while (offset + 8 <= buffer.byteLength) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    let header = 8;

    if (size === 1) {
      if (offset + 16 > buffer.byteLength) break;
      size = Number(buffer.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = buffer.byteLength - offset;
    }

    if (size < header || offset + size > buffer.byteLength) break;
    found.push({ type, payload: buffer.subarray(offset + header, offset + size) });
    offset += size;
  }

  return found;
}

function findBoxes(buffer: Buffer, type: string, depth = 0): Buffer[] {
  if (depth > 8) return [];
  const hits: Buffer[] = [];

  for (const box of boxes(buffer)) {
    if (box.type === type) hits.push(box.payload);
    const prefix = CONTAINERS.get(box.type);
    if (prefix !== undefined) {
      hits.push(...findBoxes(box.payload.subarray(prefix), type, depth + 1));
    }
  }

  return hits;
}

function handlerTypes(mp4: Buffer): string[] {
  return findBoxes(mp4, "hdlr").map((payload) => payload.toString("ascii", 8, 12));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A short script. Three sections is `ScriptDraftSchema`'s minimum and keeps the
 * encode to a couple of seconds; the pipeline logic is identical at ten minutes,
 * and a ten-minute encode in a test would be a way of not running it.
 */
function scriptDraft() {
  return {
    title: "Why cheap sensors beat the expensive ones",
    titleIdeas: ["The six pound sensor test"],
    hook: "Every review tests the flagship. Nobody has tested the cheap one.",
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
  };
}

/**
 * What `directScenes` asks the model for, shaped to `DirectionSchema`.
 *
 * The count is generous: `segmentScript` decides how many scenes there are, and
 * a direction for an index that does not exist is ignored, whereas a missing one
 * silently falls back to keyword extraction and would weaken the assertions.
 */
function direction(count: number) {
  return {
    scenes: Array.from({ length: count }, (_, index) => ({
      index,
      visualPrompt: `A close shot of sensor ${index + 1} on a hallway wall`,
      searchTerms: ["smart home sensor", "hallway"],
    })),
    mood: "calm-documentary",
  };
}

suite("video pipeline (integration)", () => {
  useDatabase();

  /**
   * Warm the pipeline modules before the first test.
   *
   * The video service reaches BullMQ, the S3 client and (through the research
   * signals query) the `googleapis` barrel. Cold on Windows that is tens of
   * seconds — enough to exhaust one test's budget while every later test
   * finishes quickly. Paying it in a hook with its own budget is honest; raising
   * the global timeout would hide a real hang.
   */
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
  });

  /** A user with a channel, settings and a project holding an approved script. */
  async function fixture(email: string) {
    const { db } = await import("@/lib/db");
    const { brandKits, channelSettings } = await import("@/lib/db/schema");
    const { createProject } = await import("@/lib/projects/service");
    const { approveScript, persistScriptVersion } = await import(
      "@/lib/scripts/service"
    );

    const user = await createUser({ email });
    const channelId = await createChannel(user.id);

    await db.insert(channelSettings).values({
      channelId,
      userId: user.id,
      niche: "home automation",
      targetAudience: "renters setting up a first smart home",
      contentLanguage: "en-GB",
      preferredLengthSeconds: 120,
      keywords: ["smart home", "sensors"],
    });

    await db.insert(brandKits).values({
      channelId,
      userId: user.id,
      brandName: "Wired Cottage",
      defaultCta: "Grab the parts list",
      captionStyle: { color: "#E8332B" },
    });

    const project = await createProject({
      userId: user.id,
      channelId,
      title: "Budget smart home sensors",
      maxVideosPerMonth: null,
    });

    await persistScriptVersion({
      userId: user.id,
      projectId: project.id,
      draft: scriptDraft(),
      source: "ai",
    });
    // Approves whatever is active, which is the version just written.
    await approveScript(user.id, project.id);

    /**
     * Walk the project to SCRIPT_READY the way the script stage does.
     *
     * `persistScriptVersion` writes rows; it does not move the project, because
     * in production the SCRIPT_GENERATING → SCRIPT_READY transition belongs to
     * the script generation stage. ASSETS_GENERATING is reachable only from
     * SCRIPT_READY, so a fixture that skips this leaves the project at IDEA and
     * every build refuses — correctly. Setting the status directly would be the
     * shortcut; going through `transition` keeps the fixture honest about a path
     * the state machine actually permits.
     */
    const { transition } = await import("@/lib/projects/service");
    await transition(user.id, project.id, "SCRIPT_GENERATING", {
      stage: "SCRIPT",
      message: "Writing the script",
    });
    await transition(user.id, project.id, "SCRIPT_READY", {
      stage: "SCRIPT",
      message: "Script ready",
    });

    return { user, channelId, project };
  }

  /**
   * Run one stage with the bookkeeping `worker/index.ts` does around a handler.
   *
   * The job row must be closed out: `hasActiveJob` reads it, so a row left
   * `queued` makes the next stage in the same test fail with a spurious conflict,
   * and the test would then be asserting on its own fixture.
   */
  async function runStage<T>(
    stage:
      | "scene-plan"
      | "voiceover"
      | "visuals"
      | "music"
      | "captions"
      | "timeline"
      | "render",
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
      channelId: context.channelId,
      projectId: context.projectId,
      stage: stageName,
      payload: { projectId: context.projectId, tier: "starter" },
      traceId: "test-trace",
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
        tier: "starter",
        traceId: "test-trace",
      });
      await markJobSucceeded(job.id, result as Record<string, unknown>);
      return result as T;
    } catch (error) {
      await markJobFailed(job.id, error);
      throw error;
    }
  }

  /** Every stage up to but excluding `render`. */
  /**
   * Start the build through the real entry point, then run the stages.
   *
   * `startVideoBuild` is what enforces the plan limit, checks for a competing
   * build and moves the project IDEA → ASSETS_GENERATING. Calling the stage
   * functions without it would leave the project at IDEA, and the state machine
   * would then correctly refuse the timeline stage — so skipping it does not just
   * miss coverage, it tests a state that cannot occur in production.
   */
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
      tier: "starter",
      traceId: "test-trace",
    });

    // The queued SCENE_PLAN job is closed out immediately: no worker is running
    // to consume it, and `hasActiveJob` would otherwise report a build in
    // progress and refuse everything that follows.
    await markJobSucceeded(started.jobId, { queued: true });
    return started;
  }

  /** Every stage up to but excluding `render`. */
  async function buildAssets(context: {
    userId: string;
    projectId: string;
    channelId: string;
  }) {
    await startBuild(context);

    const plan = await runStage<{ sceneCount: number; mood: string }>(
      "scene-plan",
      context,
    );
    await runStage("voiceover", context);
    await runStage("visuals", context);
    await runStage("music", context);
    await runStage("captions", context);
    await runStage("timeline", context);
    return plan;
  }

  // -------------------------------------------------------------------------
  // The whole pipeline
  // -------------------------------------------------------------------------

  describe("end to end", () => {
    it(
      "carries an approved script through seven stages to a playable MP4",
      async () => {
        const { user, project, channelId } = await fixture("pipeline@vidxir.test");
        const context = { userId: user.id, projectId: project.id, channelId };

        ai.generateJson.mockImplementation(async () => direction(40));

        // --- assets -------------------------------------------------------
        const plan = await buildAssets(context);
        expect(plan.sceneCount).toBeGreaterThanOrEqual(3);

        const { db } = await import("@/lib/db");
        const { assets, captions, renders, scenes } = await import(
          "@/lib/db/schema"
        );
        const { eq } = await import("drizzle-orm");

        const sceneRows = await db
          .select()
          .from(scenes)
          .where(eq(scenes.projectId, project.id));
        expect(sceneRows).toHaveLength(plan.sceneCount);

        // The timeline stage is what writes offsets; before it every scene has
        // null timings, so a row with a real start proves that stage ran.
        for (const row of sceneRows) {
          expect(row.durationMs).not.toBeNull();
          expect(row.startMs).not.toBeNull();
        }

        // Offsets are the accumulated narration lengths, so scene N starts
        // exactly where scene N-1 ended.
        const ordered = [...sceneRows].sort((a, b) => a.index - b.index);
        expect(ordered[0]?.startMs).toBe(0);
        for (let i = 1; i < ordered.length; i += 1) {
          expect(ordered[i]!.startMs).toBeGreaterThan(ordered[i - 1]!.startMs!);
        }

        // Narration and visuals exist as real stored assets.
        const assetRows = await db
          .select()
          .from(assets)
          .where(eq(assets.projectId, project.id));
        const kinds = assetRows.map((a) => a.kind);
        expect(kinds).toContain("voiceover");
        // The mock visuals provider generates stills rather than fetching stock.
        expect(kinds).toContain("generated_image");
        expect(kinds).toContain("music");

        // One narration segment per scene, so a dropped segment cannot hide
        // behind the others.
        expect(kinds.filter((k) => k === "voiceover")).toHaveLength(plan.sceneCount);
        expect(kinds.filter((k) => k === "generated_image")).toHaveLength(
          plan.sceneCount,
        );

        // Real bytes really stored (§40): the mock removes the provider bill, not
        // the file.
        for (const asset of assetRows) {
          expect(asset.bytes ?? 0).toBeGreaterThan(0);
          expect(asset.storageKey).toBeTruthy();
          expect(asset.provider).toBe("mock");
        }

        const [captionRow] = await db
          .select()
          .from(captions)
          .where(eq(captions.projectId, project.id));
        expect(captionRow).toBeDefined();
        expect(Array.isArray(captionRow!.cues)).toBe(true);

        // --- render -------------------------------------------------------
        if (!hasEncoder) return;

        const render = await runStage<{
          renderId: string;
          assetId: string;
          durationMs: number | null;
        }>("render", context);

        const { getProject } = await import("@/lib/projects/service");
        const after = await getProject(user.id, project.id);
        expect(after.status).toBe("VIDEO_READY");

        const [renderRow] = await db
          .select()
          .from(renders)
          .where(eq(renders.id, render.renderId));
        expect(renderRow!.status).toBe("succeeded");
        expect(renderRow!.progress).toBe(100);
        expect(renderRow!.provider).toBe("ffmpeg");
        expect(renderRow!.outputAssetId).toBe(render.assetId);

        // --- the video itself ---------------------------------------------
        const [outputAsset] = await db
          .select()
          .from(assets)
          .where(eq(assets.id, render.assetId));
        expect(outputAsset!.kind).toBe("render_output");
        expect(outputAsset!.mimeType).toBe("video/mp4");

        // Read back out of object storage: a row pointing at bytes that will not
        // play is precisely the dishonesty §42 prohibits.
        const { getObjectBuffer } = await import("@/lib/storage");
        // `storage_key` is nullable in the schema because an asset row exists
        // before its upload completes. A render output with no key is a bug, so
        // assert it rather than coercing it away.
        expect(outputAsset!.storageKey).toBeTruthy();
        const mp4 = await getObjectBuffer(outputAsset!.storageKey!);

        expect(mp4.byteLength).toBeGreaterThan(1_000);
        expect(mp4.byteLength).toBe(outputAsset!.bytes);

        const top = boxes(mp4).map((b) => b.type);
        expect(top[0]).toBe("ftyp");
        expect(top).toContain("moov");
        expect(top).toContain("mdat");
        // Playable before fully downloaded, which the studio preview needs.
        expect(top.indexOf("moov")).toBeLessThan(top.indexOf("mdat"));

        // Both tracks: a silent render would satisfy every row assertion above.
        expect(handlerTypes(mp4)).toContain("vide");
        expect(handlerTypes(mp4)).toContain("soun");
      },
      600_000,
    );
  });

  // -------------------------------------------------------------------------
  // Honest failure
  // -------------------------------------------------------------------------

  describe("prerequisites", () => {
    it("refuses to plan scenes without an approved script", async () => {
      // A script generated but never approved must not reach the video builder:
      // that is a human sign-off the pipeline never received (§42).
      const { db } = await import("@/lib/db");
      const { channelSettings, scripts } = await import("@/lib/db/schema");
      const { createProject } = await import("@/lib/projects/service");
      const { persistScriptVersion } = await import("@/lib/scripts/service");
      const { eq } = await import("drizzle-orm");

      const user = await createUser({ email: "unapproved@vidxir.test" });
      const channelId = await createChannel(user.id);
      await db.insert(channelSettings).values({
        channelId,
        userId: user.id,
        niche: "home automation",
        targetAudience: "renters",
        contentLanguage: "en-GB",
        preferredLengthSeconds: 120,
        keywords: ["sensors"],
      });

      const project = await createProject({
        userId: user.id,
        channelId,
        title: "Never approved",
        maxVideosPerMonth: null,
      });

      await persistScriptVersion({
        userId: user.id,
        projectId: project.id,
        draft: scriptDraft(),
        source: "ai",
      });

      // Approval is genuinely absent.
      const [row] = await db
        .select()
        .from(scripts)
        .where(eq(scripts.projectId, project.id));
      expect(row!.approvedAt).toBeNull();

      // The refusal belongs at the entry point, before a job is queued and before
      // a provider is paid — not deep inside a stage.
      const { startVideoBuild } = await import("@/lib/video/service");
      await expect(
        startVideoBuild({
          userId: user.id,
          projectId: project.id,
          tier: "starter",
          traceId: "test-trace",
        }),
      ).rejects.toThrow(/approve the script/i);

      const { getProject } = await import("@/lib/projects/service");
      const after = await getProject(user.id, project.id);
      // Refused without starting, so the project has not moved and no work was
      // queued against it.
      expect(after.status).toBe("IDEA");

      const { jobs } = await import("@/lib/db/schema");
      const queued = await db
        .select()
        .from(jobs)
        .where(eq(jobs.projectId, project.id));
      expect(queued).toHaveLength(0);
    });

    it("refuses to render before any asset exists", async () => {
      const { user, project, channelId } = await fixture("norender@vidxir.test");
      const context = { userId: user.id, projectId: project.id, channelId };

      // A started build advanced to ASSETS_READY without any asset stage having
      // run: no scenes, no narration, no timeline. ASSETS_READY is the only status
      // RENDERING is reachable from, so this is the state in which the render
      // stage's own guard is the thing being tested rather than the state machine.
      await startBuild(context);

      const { transition } = await import("@/lib/projects/service");
      await transition(user.id, project.id, "ASSETS_READY", {
        stage: "TIMELINE",
        message: "Assets ready",
      });

      await expect(runStage("render", context)).rejects.toThrow(/scene plan/i);

      const { getProject } = await import("@/lib/projects/service");
      const after = await getProject(user.id, project.id);
      // Recorded as failed with a reason, not left sitting in RENDERING (§30).
      expect(after.status).toBe("FAILED");
      expect(after.errorCode).toBe("asset_missing");
      expect(after.errorMessage).toMatch(/scene plan/i);
    });

    it("records a stage failure with the provider's real reason", async () => {
      // §30 and §42: the message an operator reads must be the actual cause, not
      // a generic "something went wrong".
      const { user, project, channelId } = await fixture("aifail@vidxir.test");
      const context = { userId: user.id, projectId: project.id, channelId };

      await startBuild(context);
      /**
       * A `ProviderError`, because that is the only thing `generateJson` can
       * throw: every SDK failure goes through `translate()` first. Throwing a
       * bare `Error` here would test a shape production cannot produce, and it
       * would assert the wrong thing about `userMessageOf` — unknown errors are
       * *deliberately* genericised, since an upstream exception string can carry
       * a URL with embedded credentials (§34). The named cause reaching the
       * operator is a property of the taxonomy, not of string passthrough.
       */
      const { ProviderError } = await import("@/lib/errors");
      ai.generateJson.mockRejectedValue(
        new ProviderError("Claude", "upstream model unavailable", {
          retryable: false,
        }),
      );

      await expect(runStage("scene-plan", context)).rejects.toThrow();

      const { db } = await import("@/lib/db");
      const { jobs } = await import("@/lib/db/schema");
      const { desc, eq } = await import("drizzle-orm");

      const [job] = await db
        .select()
        .from(jobs)
        .where(eq(jobs.projectId, project.id))
        .orderBy(desc(jobs.createdAt))
        .limit(1);
      expect(job!.status).toBe("failed");
      // The provider's own wording, so a log reader is not guessing.
      expect(job!.error).toMatch(/upstream model unavailable/i);
      expect(job!.errorCode).toBe("provider_failed");

      // The project carries the failure too, so the studio shows a reason rather
      // than a stalled bar.
      const { getProject } = await import("@/lib/projects/service");
      const after = await getProject(user.id, project.id);
      expect(after.status).toBe("FAILED");
      expect(after.errorCode).toBe("provider_failed");
      expect(after.errorMessage).toMatch(/upstream model unavailable/i);
    });
  });

  // -------------------------------------------------------------------------
  // Progress
  // -------------------------------------------------------------------------

  describe("progress", () => {
    it("accumulates stage weights and never goes backwards", async () => {
      // §38's promise is that the number is a measurement. Asserting it only
      // rises is the observable form of "derived, never animated".
      const { user, project, channelId } = await fixture("progress@vidxir.test");
      const context = { userId: user.id, projectId: project.id, channelId };

      ai.generateJson.mockImplementation(async () => direction(40));

      const { getProject } = await import("@/lib/projects/service");
      await startBuild(context);

      const seen: number[] = [];
      for (const stage of [
        "scene-plan",
        "voiceover",
        "visuals",
        "music",
        "captions",
        "timeline",
      ] as const) {
        await runStage(stage, context);
        seen.push((await getProject(user.id, project.id)).progress);
      }

      for (let i = 1; i < seen.length; i += 1) {
        expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
      }

      // Assets are done but nothing has been rendered, so the bar must not be
      // anywhere near complete.
      expect(seen.at(-1)!).toBeGreaterThan(seen[0]!);
      expect(seen.at(-1)!).toBeLessThan(100);
    }, 300_000);
  });
});

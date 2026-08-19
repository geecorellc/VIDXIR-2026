/**
 * Thumbnail pipeline integration tests (§16, §20, §34, §39, §42).
 *
 * The unit tests cover the parts in isolation: `compositor.test.ts` the filter
 * graph, `compositor.smoke.test.ts` that ffmpeg really produces a JPEG,
 * `prompt.test.ts` the schema and the brief. What only this file proves:
 *
 *  - **A generation reaches storage.** Four concepts from the model become four
 *    `thumbnail_variants` rows and four `assets` rows whose bytes are read back out
 *    of object storage and parsed as JPEGs. A row pointing at something that is not
 *    an image is the failure §42 forbids.
 *  - **A partial failure stays partial.** One background that cannot be acquired
 *    leaves that variant's `image_asset_id` null and the other three composited —
 *    not a failed job with nothing to show.
 *  - **A total failure is a failure.** All four failing raises `asset_missing` and
 *    the project returns to where it came from rather than to FAILED, because a
 *    rendered video whose thumbnails failed is still a rendered video.
 *  - **Retryable and non-retryable failures are handled differently.** A retryable
 *    error leaves the project in THUMBNAIL_GENERATING for the worker's next
 *    attempt; a non-retryable one records the reason and steps back.
 *  - **Tenant isolation on selection.** A variant id belonging to another user, and
 *    one belonging to another project of the *same* user, both resolve to nothing.
 *  - **Prerequisites are enforced at the entry point,** before a job is queued and
 *    before a provider is paid.
 *
 * Only `lib/providers/ai` is mocked, and only because the concepts are the one AI
 * call in the stage and §40 forbids spending credits in tests. Visuals run as the
 * development mock — real PNG bytes — storage is the real MinIO bucket, and the
 * compositor is the real ffmpeg. There is no mock compositor to fall back to, by
 * design: an image Tally claims to have made is one it made.
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
 * `acquireVisual` is mocked at the module boundary rather than spied on.
 *
 * It is only *replaced* in the failure cases; `beforeEach` points it back at the
 * real implementation, so the happy path acquires genuine bytes from the
 * development visuals mock and composites them. Spying on the live export would
 * have been less code and would not work: the service imports the binding
 * directly, so a spy installed on the namespace object is not what it calls.
 */
const visuals = vi.hoisted(() => ({
  acquireVisual: vi.fn(),
  /** The unmocked implementation, captured as the module is first replaced. */
  real: { fn: null as unknown as typeof import("@/lib/providers/visuals").acquireVisual },
}));

vi.mock("@/lib/providers/visuals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/visuals")>();
  visuals.real.fn = actual.acquireVisual;
  return { ...actual, acquireVisual: visuals.acquireVisual };
});

/**
 * Compositing needs both an ffmpeg binary and a font file on disk. Both are
 * environment facts, not credentials, and `not_configured` is the honest state when
 * either is absent (§48) — so the row-level assertions run regardless and only the
 * assertions about composited *images* are gated.
 */
const { isCompositorConfigured } = await import("@/lib/thumbnails/compositor");
const canComposite = isCompositorConfigured();

const suite = hasDatabase ? describe : describe.skip;

// ---------------------------------------------------------------------------
// JPEG parsing
// ---------------------------------------------------------------------------

/**
 * Read a JPEG's dimensions from its SOF marker.
 *
 * Hand-written for the same reason as in the smoke test: asking ffmpeg whether
 * ffmpeg produced a valid image is circular, and `ffmpeg-static` ships no ffprobe.
 * Returns null when the bytes are not a JPEG a decoder would accept, which is the
 * assertion that matters — `bytes > 0` is satisfied by any garbage.
 */
function jpegSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.byteLength < 4) return null;
  if (buffer.readUInt16BE(0) !== 0xffd8) return null;

  let offset = 2;
  while (offset + 4 <= buffer.byteLength) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1]!;

    // Standalone markers carry no length payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }

    const length = buffer.readUInt16BE(offset + 2);
    // SOF0 (baseline), SOF1, SOF2 (progressive) all carry the frame dimensions.
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    // Entropy-coded data starts here; the dimensions would have come first.
    if (marker === 0xda) return null;
    offset += 2 + length;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Three sections is `ScriptDraftSchema`'s minimum; the brief only reads headings. */
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
 * Four concepts shaped to `ThumbnailConceptsSchema`.
 *
 * Deliberately awkward text: an apostrophe, a colon and a percent sign are exactly
 * the characters that break an inline filter argument, so the happy path composites
 * a headline that would have failed under the escaping approach.
 */
function concepts() {
  return {
    concepts: [
      {
        headline: "It's 40%: the cheap one won",
        subline: "Three weeks, twelve sensors",
        concept:
          "Leads with the measured result, which is the single most surprising " +
          "thing the script contains.",
        emotion: "surprise",
        searchTerms: ["smart home sensor on wall"],
      },
      {
        headline: "Two failed. Ten did not.",
        subline: null,
        concept:
          "The outcome stated flatly, betting that the plain number is more " +
          "credible than a claim.",
        emotion: "confidence",
        searchTerms: ["circuit board close up"],
      },
      {
        headline: "Stop buying the flagship",
        subline: "What the reviews never test",
        concept:
          "The cost-of-getting-it-wrong angle, aimed at someone about to spend " +
          "money this week.",
        emotion: "urgency",
        searchTerms: ["electronics shop shelf"],
      },
      {
        headline: "Nobody tested the cheap one",
        subline: "So I bought twelve",
        concept:
          "The gap in the existing coverage, which is the hook the script opens " +
          "with, framed as a question the viewer wants answered.",
        emotion: "curiosity",
        searchTerms: ["hallway with sensor"],
      },
    ],
  };
}

suite("thumbnail pipeline (integration)", () => {
  useDatabase();

  /**
   * Warm the modules before the first test. Same reason as the video suite: the
   * thumbnail service reaches BullMQ, the S3 client and (via the projects service)
   * the `googleapis` barrel, which is tens of seconds cold on Windows.
   */
  beforeAll(async () => {
    await import("@/lib/thumbnails/service");
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
    ai.generateJson.mockImplementation(async () => concepts());
    // Back to the real provider — which in a test run is the development mock,
    // producing real PNG bytes rather than a fabricated success (§40).
    visuals.acquireVisual.mockReset();
    visuals.acquireVisual.mockImplementation(visuals.real.fn);
  });

  /**
   * A project at VIDEO_READY with a succeeded render, which is the only state a
   * thumbnail generation legally starts from.
   *
   * Walked through `transition` rather than written directly. The state machine is
   * the thing under test in several of these cases, and a fixture that sets
   * `status` by UPDATE would let a test pass from a state production cannot reach.
   */
  async function fixture(
    email: string,
    options: { withRender?: boolean; posterBytes?: Buffer | null } = {},
  ) {
    const { db } = await import("@/lib/db");
    const { assets, brandKits, channelSettings, renders } = await import(
      "@/lib/db/schema"
    );
    const { createProject, transition } = await import("@/lib/projects/service");
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
      primaryColor: "#E8332B",
      defaultCta: "Grab the parts list",
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
    await approveScript(user.id, project.id);

    // IDEA → ... → VIDEO_READY, one legal edge at a time.
    for (const [status, stage] of [
      ["SCRIPT_GENERATING", "SCRIPT"],
      ["SCRIPT_READY", "SCRIPT"],
      ["ASSETS_GENERATING", "SCENE_PLAN"],
      ["ASSETS_READY", "TIMELINE"],
      ["RENDERING", "RENDER"],
      ["VIDEO_READY", "RENDER"],
    ] as const) {
      await transition(user.id, project.id, status, { stage, message: status });
    }

    let posterAssetId: string | null = null;
    if (options.posterBytes) {
      const { putObject, storageKey } = await import("@/lib/storage");
      const key = storageKey({
        userId: user.id,
        folder: "poster",
        projectId: project.id,
        extension: "png",
      });
      const put = await putObject({
        key,
        body: options.posterBytes,
        contentType: "image/png",
      });
      const [asset] = await db
        .insert(assets)
        .values({
          userId: user.id,
          projectId: project.id,
          // `generated_image` is the enum's kind for a frame the pipeline produced
          // rather than licensed. There is no `render_poster` kind, and inventing
          // one for a test fixture would put the test ahead of the schema.
          kind: "generated_image",
          storageKey: put.key,
          mimeType: "image/png",
          bytes: put.bytes,
          provider: "ffmpeg",
        })
        .returning({ id: assets.id });
      posterAssetId = asset!.id;
    }

    // The render row, not the status, is what `startThumbnails` checks (§45).
    if (options.withRender !== false) {
      await db.insert(renders).values({
        projectId: project.id,
        userId: user.id,
        provider: "ffmpeg",
        status: "succeeded",
        progress: 100,
        durationMs: 12_000,
        posterAssetId,
      });
    }

    return { user, channelId, project };
  }

  /**
   * Queue and run a generation with the bookkeeping the worker does around it.
   *
   * Goes through `startThumbnails` rather than calling `executeThumbnails` with a
   * hand-made job id: the entry point is what checks the render, the status and the
   * competing job, and it is what decides `returnTo`. The job row has to be closed
   * out afterwards because `hasActiveJob` reads it, and a row left `queued` would
   * make a second generation in the same test fail on the fixture rather than on
   * the behaviour.
   */
  async function generate(context: {
    userId: string;
    projectId: string;
  }): Promise<{
    result: { thumbnailId: string; variantCount: number; renderedCount: number };
    jobId: string;
  }> {
    const { startThumbnails, executeThumbnails } = await import(
      "@/lib/thumbnails/service"
    );
    const { markJobFailed, markJobSucceeded } = await import("@/lib/queue/jobs");
    const { db } = await import("@/lib/db");
    const { jobs } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");

    const started = await startThumbnails({
      userId: context.userId,
      projectId: context.projectId,
      tier: "starter",
      traceId: "test-trace",
    });

    // `returnTo` as the entry point recorded it, so the handler's view of the
    // payload is the one production would have.
    const [row] = await db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(eq(jobs.id, started.jobId))
      .limit(1);
    const { parseReturnTo } = await import("@/lib/thumbnails/service");

    try {
      const result = await executeThumbnails({
        userId: context.userId,
        projectId: context.projectId,
        jobId: started.jobId,
        tier: "starter",
        returnTo: parseReturnTo(
          (row!.payload as Record<string, unknown> | null)?.["returnTo"],
        ),
        traceId: "test-trace",
      });
      await markJobSucceeded(started.jobId, result as Record<string, unknown>);
      return { result, jobId: started.jobId };
    } catch (error) {
      await markJobFailed(started.jobId, error);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // The whole generation
  // -------------------------------------------------------------------------

  describe("end to end", () => {
    it(
      "turns four concepts into four stored JPEGs and a project ready to publish",
      async () => {
        const { user, project } = await fixture("thumbs@tally.test");
        const context = { userId: user.id, projectId: project.id };

        const { result } = await generate(context);

        expect(result.variantCount).toBe(4);

        const { db } = await import("@/lib/db");
        const { assets, thumbnailVariants, thumbnails } = await import(
          "@/lib/db/schema"
        );
        const { asc, eq } = await import("drizzle-orm");

        // --- rows ---------------------------------------------------------
        const [thumbnailRow] = await db
          .select()
          .from(thumbnails)
          .where(eq(thumbnails.id, result.thumbnailId));
        expect(thumbnailRow!.projectId).toBe(project.id);
        expect(thumbnailRow!.userId).toBe(user.id);
        // Nothing is selected by a generation: the user chooses (§42).
        expect(thumbnailRow!.selectedVariantId).toBeNull();

        const variants = await db
          .select()
          .from(thumbnailVariants)
          .where(eq(thumbnailVariants.thumbnailId, result.thumbnailId))
          .orderBy(asc(thumbnailVariants.index));

        expect(variants).toHaveLength(4);
        expect(variants.map((v) => v.index)).toEqual([0, 1, 2, 3]);
        // The model's own words, stored verbatim — the UI shows these next to the
        // preview and a rewritten concept would be a different product.
        expect(variants[0]!.headline).toBe("It's 40%: the cheap one won");
        expect(variants[1]!.subline).toBeNull();
        expect(variants.map((v) => v.emotion)).toEqual([
          "surprise",
          "confidence",
          "urgency",
          "curiosity",
        ]);

        // --- images -------------------------------------------------------
        if (!canComposite) {
          // Without ffmpeg or a font the rows are still correct and the images
          // genuinely do not exist. Asserting that is the honest form of the
          // `not_configured` state (§48) — not skipping the whole test.
          expect(result.renderedCount).toBe(0);
          return;
        }

        expect(result.renderedCount).toBe(4);
        expect(thumbnailRow!.status).toBe("succeeded");
        expect(thumbnailRow!.error).toBeNull();

        const { getObjectBuffer } = await import("@/lib/storage");

        for (const variant of variants) {
          expect(variant.imageAssetId).not.toBeNull();

          const [asset] = await db
            .select()
            .from(assets)
            .where(eq(assets.id, variant.imageAssetId!));

          expect(asset!.kind).toBe("thumbnail");
          expect(asset!.mimeType).toBe("image/jpeg");
          expect(asset!.userId).toBe(user.id);
          expect(asset!.projectId).toBe(project.id);
          expect(asset!.provider).toBe("ffmpeg");
          expect(asset!.width).toBe(1280);
          expect(asset!.height).toBe(720);
          expect(asset!.storageKey).toBeTruthy();
          // Provenance: which font drew the headline, so a thumbnail that looks
          // wrong can be traced rather than guessed at.
          const meta = asset!.meta as Record<string, unknown>;
          expect(typeof meta["headlineFont"]).toBe("string");

          // Read back out of storage and parsed. A `thumbnail` row pointing at
          // bytes YouTube would reject is precisely what §42 prohibits.
          const bytes = await getObjectBuffer(asset!.storageKey!);
          expect(bytes.byteLength).toBe(asset!.bytes);
          // YouTube's hard ceiling; over it the upload is refused outright.
          expect(bytes.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
          expect(jpegSize(bytes)).toEqual({ width: 1280, height: 720 });
        }

        // --- the project --------------------------------------------------
        const { getProject } = await import("@/lib/projects/service");
        const after = await getProject(user.id, project.id);
        expect(after.status).toBe("READY_TO_PUBLISH");
        expect(after.errorMessage).toBeNull();
      },
      300_000,
    );

    it("prefers a frame from the project's own render for the first variant", async () => {
      if (!canComposite) return;

      // A frame of the actual video is a more honest background than a stock
      // photograph of something similar, and it costs no provider call. Only
      // variant 0 gets it — four cards showing the same poster is one concept.
      const poster = await pngBytes();
      const { user, project } = await fixture("poster@tally.test", {
        posterBytes: poster,
      });

      const { result } = await generate({ userId: user.id, projectId: project.id });

      const { db } = await import("@/lib/db");
      const { assets, thumbnailVariants } = await import("@/lib/db/schema");
      const { asc, eq } = await import("drizzle-orm");

      const variants = await db
        .select()
        .from(thumbnailVariants)
        .where(eq(thumbnailVariants.thumbnailId, result.thumbnailId))
        .orderBy(asc(thumbnailVariants.index));

      const [first] = await db
        .select()
        .from(assets)
        .where(eq(assets.id, variants[0]!.imageAssetId!));
      expect((first!.meta as Record<string, unknown>)["backgroundProvider"]).toBe(
        "render-poster",
      );

      // The rest went to the stock library, which the mock provider stands in for.
      const [second] = await db
        .select()
        .from(assets)
        .where(eq(assets.id, variants[1]!.imageAssetId!));
      expect(
        (second!.meta as Record<string, unknown>)["backgroundProvider"],
      ).not.toBe("render-poster");
    }, 300_000);

    it("replaces the previous set rather than accumulating a fifth card", async () => {
      const { user, project } = await fixture("regen@tally.test");
      const context = { userId: user.id, projectId: project.id };

      const first = await generate(context);

      // A regenerate starts from READY_TO_PUBLISH, which is a legal edge back into
      // THUMBNAIL_GENERATING — and the reason `returnTo` exists.
      const second = await generate(context);
      expect(second.result.thumbnailId).not.toBe(first.result.thumbnailId);

      const { db } = await import("@/lib/db");
      const { thumbnailVariants, thumbnails } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      const rows = await db
        .select()
        .from(thumbnails)
        .where(eq(thumbnails.projectId, project.id));
      // The UI shows exactly four cards; two sets would silently change what "the
      // four concepts" means.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(second.result.thumbnailId);

      const variants = await db
        .select()
        .from(thumbnailVariants)
        .where(eq(thumbnailVariants.thumbnailId, second.result.thumbnailId));
      expect(variants).toHaveLength(4);

      // The second call was told what the first produced, so it can avoid it.
      const prompt = ai.generateJson.mock.calls.at(-1)![0].prompt as string;
      expect(prompt).toContain("ALREADY TRIED");
      expect(prompt).toContain("It's 40%: the cheap one won");
    }, 300_000);
  });

  // -------------------------------------------------------------------------
  // Partial and total failure
  // -------------------------------------------------------------------------

  describe("failure", () => {
    it("leaves one variant unrendered rather than failing the other three", async () => {
      if (!canComposite) return;

      const { user, project } = await fixture("partial@tally.test");

      // One background acquisition fails. The other three must still composite:
      // failing the whole job on one bad stock search throws away three good
      // thumbnails to punish one.
      const { AssetMissingError } = await import("@/lib/errors");
      visuals.acquireVisual.mockImplementation(async (request, options) => {
        // `sceneIndex` labels the concept here — the service passes the variant
        // index through it for accounting and logging.
        if (request.sceneIndex === 2) {
          throw new AssetMissingError("a visual for thumbnail concept 3");
        }
        return visuals.real.fn(request, options);
      });

      const { result } = await generate({
        userId: user.id,
        projectId: project.id,
      });

      expect(result.variantCount).toBe(4);
      expect(result.renderedCount).toBe(3);

      const { db } = await import("@/lib/db");
      const { thumbnailVariants, thumbnails } = await import("@/lib/db/schema");
      const { asc, eq } = await import("drizzle-orm");

      const variants = await db
        .select()
        .from(thumbnailVariants)
        .where(eq(thumbnailVariants.thumbnailId, result.thumbnailId))
        .orderBy(asc(thumbnailVariants.index));

      // Honest, not substituted: the card says "Image not rendered" (§42).
      expect(variants[2]!.imageAssetId).toBeNull();
      // The concept text survives, so the user can still read what it was.
      expect(variants[2]!.headline).toBe("Stop buying the flagship");
      for (const index of [0, 1, 3]) {
        expect(variants[index]!.imageAssetId).not.toBeNull();
      }

      // A partial success is still a success: there are thumbnails to choose
      // between, so the project advances.
      const [row] = await db
        .select()
        .from(thumbnails)
        .where(eq(thumbnails.id, result.thumbnailId));
      expect(row!.status).toBe("succeeded");

      const { getProject } = await import("@/lib/projects/service");
      expect((await getProject(user.id, project.id)).status).toBe(
        "READY_TO_PUBLISH",
      );
    }, 300_000);

    it("fails the job when no concept composited at all", async () => {
      const { user, project } = await fixture("nothing@tally.test");

      const { AssetMissingError } = await import("@/lib/errors");
      visuals.acquireVisual.mockRejectedValue(new AssetMissingError("any visual"));

      // Four "Image not rendered" cards reported as success would be the §42 lie
      // in its purest form.
      await expect(
        generate({ userId: user.id, projectId: project.id }),
      ).rejects.toThrow(/composited image/i);

      const { db } = await import("@/lib/db");
      const { jobs, thumbnails } = await import("@/lib/db/schema");
      const { desc, eq } = await import("drizzle-orm");

      const [thumbnailRow] = await db
        .select()
        .from(thumbnails)
        .where(eq(thumbnails.projectId, project.id));
      // The concepts are stored and readable even though no image exists, and the
      // row carries the reason the thumbnail screen shows.
      expect(thumbnailRow!.status).toBe("failed");
      expect(thumbnailRow!.error).toMatch(/composited image/i);

      const [job] = await db
        .select()
        .from(jobs)
        .where(eq(jobs.projectId, project.id))
        .orderBy(desc(jobs.createdAt))
        .limit(1);
      expect(job!.status).toBe("failed");
      expect(job!.errorCode).toBe("asset_missing");

      /**
       * VIDEO_READY, not FAILED. A rendered video whose thumbnail generation
       * failed is still a rendered video, and FAILED would tell the user their
       * video broke — which is wrong, and would bury the render's own state
       * behind an unrelated error.
       */
      const { getProject } = await import("@/lib/projects/service");
      const after = await getProject(user.id, project.id);
      expect(after.status).toBe("VIDEO_READY");
    }, 300_000);

    it("records a non-retryable failure and steps the project back", async () => {
      const { user, project } = await fixture("nonretry@tally.test");

      /**
       * A `ProviderError` with `retryable: false`, because that is the only shape
       * `generateJson` can throw — every SDK failure goes through `translate()`
       * first. A bare `Error` would test a shape production cannot produce.
       */
      const { ProviderError } = await import("@/lib/errors");
      ai.generateJson.mockRejectedValue(
        new ProviderError("Claude", "prompt exceeds the model's context", {
          retryable: false,
        }),
      );

      await expect(
        generate({ userId: user.id, projectId: project.id }),
      ).rejects.toThrow(/context/i);

      const { getProject } = await import("@/lib/projects/service");
      const after = await getProject(user.id, project.id);
      // Back where it came from, with the reason recorded on the event trail.
      expect(after.status).toBe("VIDEO_READY");

      const { db } = await import("@/lib/db");
      const { jobs, projectEvents } = await import("@/lib/db/schema");
      const { desc, eq } = await import("drizzle-orm");

      const [job] = await db
        .select()
        .from(jobs)
        .where(eq(jobs.projectId, project.id))
        .orderBy(desc(jobs.createdAt))
        .limit(1);
      expect(job!.status).toBe("failed");
      // The provider's own wording, so a log reader is not guessing (§30).
      expect(job!.error).toMatch(/context/i);

      // The attempt survives in the audit trail even though the status returned to
      // where it started (§20).
      const events = await db
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(events.some((e) => (e.message ?? "").includes("Thumbnails failed"))).toBe(
        true,
      );
    }, 300_000);

    it("leaves the project generating when the failure is retryable", async () => {
      const { user, project } = await fixture("retry@tally.test");

      /**
       * A retryable error must NOT move the project. The worker has two attempts
       * left, and flashing FAILED (or VIDEO_READY) between them makes a recoverable
       * blip look like a dead build (§37). The status staying in
       * THUMBNAIL_GENERATING is what keeps the studio polling.
       */
      const { ProviderError } = await import("@/lib/errors");
      ai.generateJson.mockRejectedValue(
        // `retryable: true` is `ProviderError`'s default, and an overloaded model
        // is the canonical case: it is genuinely worth a second attempt.
        new ProviderError("Claude", "overloaded", { retryable: true }),
      );

      await expect(
        generate({ userId: user.id, projectId: project.id }),
      ).rejects.toThrow();

      const { getProject } = await import("@/lib/projects/service");
      const after = await getProject(user.id, project.id);
      expect(after.status).toBe("THUMBNAIL_GENERATING");
      // And no failure was written to the thumbnail row, because nothing has
      // finally failed yet.
      const { db } = await import("@/lib/db");
      const { thumbnails } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db
        .select()
        .from(thumbnails)
        .where(eq(thumbnails.projectId, project.id));
      // The AI call failed before any row was written, so there is nothing to
      // carry an error — the job row is where this attempt is recorded.
      expect(rows).toHaveLength(0);
    }, 300_000);
  });

  // -------------------------------------------------------------------------
  // Prerequisites
  // -------------------------------------------------------------------------

  describe("prerequisites", () => {
    it("refuses to design thumbnails for a video that has not rendered", async () => {
      // The status alone is not enough: a project can be VIDEO_READY by
      // transition and have no render row at all, and generating four images for a
      // video that does not exist is work for nothing.
      const { user, project } = await fixture("norender@tally.test", {
        withRender: false,
      });

      const { startThumbnails } = await import("@/lib/thumbnails/service");
      await expect(
        startThumbnails({
          userId: user.id,
          projectId: project.id,
          tier: "starter",
          traceId: "test-trace",
        }),
      ).rejects.toThrow(/has not finished rendering/i);

      // Refused before anything was queued or moved.
      const { getProject } = await import("@/lib/projects/service");
      expect((await getProject(user.id, project.id)).status).toBe("VIDEO_READY");

      const { db } = await import("@/lib/db");
      const { jobs } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      expect(
        await db.select().from(jobs).where(eq(jobs.projectId, project.id)),
      ).toHaveLength(0);

      expect(ai.generateJson).not.toHaveBeenCalled();
    }, 120_000);

    it("refuses once the video is published, because the thumbnail is live", async () => {
      const { user, project } = await fixture("published@tally.test");
      const { transition } = await import("@/lib/projects/service");

      for (const status of ["READY_TO_PUBLISH", "PUBLISHING", "PUBLISHED"] as const) {
        await transition(user.id, project.id, status, {
          stage: "METADATA",
          message: status,
        });
      }

      const { startThumbnails } = await import("@/lib/thumbnails/service");
      await expect(
        startThumbnails({
          userId: user.id,
          projectId: project.id,
          tier: "starter",
        }),
      ).rejects.toThrow(/already been published/i);
    }, 120_000);

    it("refuses a second generation while one is already running", async () => {
      const { user, project } = await fixture("concurrent@tally.test");

      const { startThumbnails } = await import("@/lib/thumbnails/service");
      // The first leaves a queued job row, which is what `hasActiveJob` reads. A
      // second would spend another AI call and four more downloads to overwrite the
      // first one's rows.
      await startThumbnails({
        userId: user.id,
        projectId: project.id,
        tier: "starter",
      });

      await expect(
        startThumbnails({
          userId: user.id,
          projectId: project.id,
          tier: "starter",
        }),
      ).rejects.toThrow(/already being designed/i);
    }, 120_000);

    it("refuses a project belonging to another user", async () => {
      const { user, project } = await fixture("owner@tally.test");
      const intruder = await createUser({ email: "intruder@tally.test" });

      const { startThumbnails } = await import("@/lib/thumbnails/service");
      // `getProject` is tenant-scoped, so another user's project id is simply not
      // found — there is no path that leaks its existence (§34).
      await expect(
        startThumbnails({
          userId: intruder.id,
          projectId: project.id,
          tier: "starter",
        }),
      ).rejects.toThrow(/not found/i);

      const { getProject } = await import("@/lib/projects/service");
      expect((await getProject(user.id, project.id)).status).toBe("VIDEO_READY");
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  describe("selection", () => {
    it("records the chosen variant and nothing else", async () => {
      if (!canComposite) return;

      const { user, project } = await fixture("select@tally.test");
      const { result } = await generate({
        userId: user.id,
        projectId: project.id,
      });

      const { db } = await import("@/lib/db");
      const { thumbnailVariants, thumbnails } = await import("@/lib/db/schema");
      const { asc, eq } = await import("drizzle-orm");

      const variants = await db
        .select()
        .from(thumbnailVariants)
        .where(eq(thumbnailVariants.thumbnailId, result.thumbnailId))
        .orderBy(asc(thumbnailVariants.index));

      const { selectVariant } = await import("@/lib/thumbnails/service");
      const selected = await selectVariant({
        userId: user.id,
        projectId: project.id,
        variantId: variants[2]!.id,
      });

      expect(selected.variantId).toBe(variants[2]!.id);
      expect(selected.thumbnailId).toBe(result.thumbnailId);

      const [row] = await db
        .select()
        .from(thumbnails)
        .where(eq(thumbnails.id, result.thumbnailId));
      expect(row!.selectedVariantId).toBe(variants[2]!.id);

      // Choosing does not upload anything. The publish stage is where a real
      // YouTube call happens (§42).
      const { publishJobs } = await import("@/lib/db/schema");
      expect(
        await db.select().from(publishJobs).where(eq(publishJobs.projectId, project.id)),
      ).toHaveLength(0);
    }, 300_000);

    it("refuses a variant whose image was never composited", async () => {
      if (!canComposite) return;

      const { user, project } = await fixture("unrendered@tally.test");

      const { AssetMissingError } = await import("@/lib/errors");
      visuals.acquireVisual.mockImplementation(async (request, options) => {
        if (request.sceneIndex === 1) {
          throw new AssetMissingError("a visual for thumbnail concept 2");
        }
        return visuals.real.fn(request, options);
      });

      const {
        result: { thumbnailId },
      } = await generate({ userId: user.id, projectId: project.id });

      const { db } = await import("@/lib/db");
      const { thumbnailVariants, thumbnails } = await import("@/lib/db/schema");
      const { and, eq } = await import("drizzle-orm");

      const [unrendered] = await db
        .select()
        .from(thumbnailVariants)
        .where(
          and(
            eq(thumbnailVariants.thumbnailId, thumbnailId),
            eq(thumbnailVariants.index, 1),
          ),
        );
      expect(unrendered!.imageAssetId).toBeNull();

      /**
       * The publish stage uploads `image_asset_id`. Selecting a concept whose
       * picture does not exist would produce a video published with no thumbnail
       * and a UI that said one was chosen (§42).
       */
      const { selectVariant } = await import("@/lib/thumbnails/service");
      await expect(
        selectVariant({
          userId: user.id,
          projectId: project.id,
          variantId: unrendered!.id,
        }),
      ).rejects.toThrow(/no composited image/i);

      const [row] = await db
        .select()
        .from(thumbnails)
        .where(eq(thumbnails.id, thumbnailId));
      expect(row!.selectedVariantId).toBeNull();
    }, 300_000);

    it("does not resolve a variant belonging to another user", async () => {
      const mine = await fixture("mine@tally.test");
      const theirs = await fixture("theirs@tally.test");

      const first = await generate({
        userId: mine.user.id,
        projectId: mine.project.id,
      });
      const second = await generate({
        userId: theirs.user.id,
        projectId: theirs.project.id,
      });

      const { db } = await import("@/lib/db");
      const { thumbnailVariants, thumbnails } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      const theirVariants = await db
        .select()
        .from(thumbnailVariants)
        .where(eq(thumbnailVariants.thumbnailId, second.result.thumbnailId));

      /**
       * The variant id is real and its image may well exist — the only thing
       * standing between the two tenants is the predicate in the query. That is
       * exactly the property a mock cannot prove (§34, §39).
       */
      const { selectVariant } = await import("@/lib/thumbnails/service");
      await expect(
        selectVariant({
          userId: mine.user.id,
          projectId: mine.project.id,
          variantId: theirVariants[0]!.id,
        }),
      ).rejects.toThrow(/does not exist/i);

      // Neither side moved.
      const [theirRow] = await db
        .select()
        .from(thumbnails)
        .where(eq(thumbnails.id, second.result.thumbnailId));
      expect(theirRow!.selectedVariantId).toBeNull();

      const [myRow] = await db
        .select()
        .from(thumbnails)
        .where(eq(thumbnails.id, first.result.thumbnailId));
      expect(myRow!.selectedVariantId).toBeNull();
    }, 300_000);

    it("does not resolve a variant from another project of the same user", async () => {
      /**
       * The subtler half of the isolation check. `thumbnail_variants.user_id` alone
       * would pass here — the variant really is this user's — so only the parent's
       * `projectId` predicate stops project A's thumbnail being attached to project
       * B, which would publish the wrong image with the right owner.
       */
      const first = await fixture("two-a@tally.test");
      const { db } = await import("@/lib/db");
      const { createProject, transition } = await import("@/lib/projects/service");
      const { persistScriptVersion, approveScript } = await import(
        "@/lib/scripts/service"
      );
      const { renders, thumbnailVariants, thumbnails } = await import(
        "@/lib/db/schema"
      );
      const { eq } = await import("drizzle-orm");

      const other = await createProject({
        userId: first.user.id,
        channelId: first.channelId,
        title: "A second video",
        maxVideosPerMonth: null,
      });
      await persistScriptVersion({
        userId: first.user.id,
        projectId: other.id,
        draft: scriptDraft(),
        source: "ai",
      });
      await approveScript(first.user.id, other.id);
      for (const [status, stage] of [
        ["SCRIPT_GENERATING", "SCRIPT"],
        ["SCRIPT_READY", "SCRIPT"],
        ["ASSETS_GENERATING", "SCENE_PLAN"],
        ["ASSETS_READY", "TIMELINE"],
        ["RENDERING", "RENDER"],
        ["VIDEO_READY", "RENDER"],
      ] as const) {
        await transition(first.user.id, other.id, status, { stage, message: status });
      }
      await db.insert(renders).values({
        projectId: other.id,
        userId: first.user.id,
        provider: "ffmpeg",
        status: "succeeded",
        progress: 100,
      });

      const a = await generate({
        userId: first.user.id,
        projectId: first.project.id,
      });
      await generate({ userId: first.user.id, projectId: other.id });

      const aVariants = await db
        .select()
        .from(thumbnailVariants)
        .where(eq(thumbnailVariants.thumbnailId, a.result.thumbnailId));

      const { selectVariant } = await import("@/lib/thumbnails/service");
      await expect(
        selectVariant({
          userId: first.user.id,
          // Project B, variant from project A. Same owner throughout.
          projectId: other.id,
          variantId: aVariants[0]!.id,
        }),
      ).rejects.toThrow(/does not exist/i);

      const [aRow] = await db
        .select()
        .from(thumbnails)
        .where(eq(thumbnails.id, a.result.thumbnailId));
      expect(aRow!.selectedVariantId).toBeNull();
    }, 300_000);
  });

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  describe("reading a set", () => {
    it("returns null before anything has been generated", async () => {
      const { user, project } = await fixture("empty@tally.test");
      const { getThumbnails } = await import("@/lib/thumbnails/service");
      // Null rather than an empty set: the studio says "No thumbnails yet", and a
      // shell of four blank cards would look like a generation that produced
      // nothing (§37).
      expect(await getThumbnails(user.id, project.id)).toBeNull();
    }, 120_000);

    it("does not return another user's set", async () => {
      const mine = await fixture("read-mine@tally.test");
      const intruder = await createUser({ email: "read-intruder@tally.test" });

      await generate({ userId: mine.user.id, projectId: mine.project.id });

      const { getThumbnails } = await import("@/lib/thumbnails/service");
      expect(await getThumbnails(intruder.id, mine.project.id)).toBeNull();
      expect(await getThumbnails(mine.user.id, mine.project.id)).not.toBeNull();
    }, 300_000);

    it("returns the variants in card order with their images", async () => {
      const { user, project } = await fixture("read@tally.test");
      const { result } = await generate({
        userId: user.id,
        projectId: project.id,
      });

      const { getThumbnails } = await import("@/lib/thumbnails/service");
      const set = await getThumbnails(user.id, project.id);

      expect(set!.id).toBe(result.thumbnailId);
      expect(set!.variants.map((v) => v.index)).toEqual([0, 1, 2, 3]);
      expect(set!.selectedVariantId).toBeNull();
      // CTR is populated by the analytics feedback loop, which has not run.
      expect(set!.variants.every((v) => v.ctr === null)).toBe(true);
    }, 300_000);
  });
});

/**
 * A small PNG for the render-poster case.
 *
 * Generated with ffmpeg rather than being a hard-coded byte array: the compositor
 * has to *decode* it, so it must be a real image, and a fixture nobody can read is
 * a fixture nobody can fix. 1600×900 so `scale`+`crop` is exercised rather than
 * being a no-op.
 */
async function pngBytes(): Promise<Buffer> {
  const { spawn } = await import("node:child_process");
  const { ffmpegBinary } = await import("@/lib/media/ffmpeg");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const binary = ffmpegBinary();
  if (!binary) throw new Error("ffmpeg is required for this fixture");

  const dir = await mkdtemp(join(tmpdir(), "tally-thumb-fixture-"));
  const output = join(dir, "poster.png");

  try {
    await new Promise<void>((settle, reject) => {
      const child = spawn(
        binary,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc=size=1600x900:duration=1:rate=1",
          "-frames:v",
          "1",
          output,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? settle() : reject(new Error(`ffmpeg exited ${code}`)),
      );
    });

    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

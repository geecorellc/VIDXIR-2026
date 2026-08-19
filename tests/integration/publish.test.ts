/**
 * YouTube publishing integration tests (§13, §34, §39, §42).
 *
 * The one rule this file exists to prove: **the database never says PUBLISHED
 * because an upload was started.** Every case below is a way that invariant could
 * be broken — a failure mid-upload, a retry after a crash, a missing asset, a
 * legacy grant, a foreign publish job — and the assertion is always the same pair:
 * what `projects.status` says, and whether a `published_videos` row exists.
 *
 * ## What is real here, and what is not
 *
 * Real: Postgres, the migrations, the state machine, MinIO (the video and
 * thumbnail bytes are genuinely written and read back), the encrypted token path
 * through `withChannelToken`, `missingRequiredScopes`, `composeDescription`, the
 * `published_videos` unique index, and the usage counters.
 *
 * Mocked: `uploadVideo` and `setThumbnail` — the two functions that talk to
 * youtube.com. That is not a shortcut, it is §9: a real upload would put a test
 * video on a real channel, and `.env.local` sets `TALLY_BLOCK_REAL_PUBLISH=true`
 * precisely so that cannot happen by accident. Everything on Tally's side of those
 * two calls is exercised for real; the two calls themselves are covered by
 * `providers/youtube`'s own error-translation tests and, for the wiring, by
 * `scripts/verify-publish.ts` running under real Node.
 *
 * Stated plainly so the §20 report can be honest: **these tests do not prove that
 * a byte ever reached Google.** They prove that Tally's bookkeeping around the
 * upload is correct, including every failure ordering.
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

/**
 * Only the two network calls are replaced. `missingRequiredScopes`, `watchUrl` and
 * the error translation stay real — the scope test below depends on the genuine
 * implementation, and a mocked `watchUrl` would let a wrong URL into the database
 * unnoticed.
 */
const youtube = vi.hoisted(() => ({
  uploadVideo: vi.fn(),
  setThumbnail: vi.fn(),
}));

vi.mock("@/lib/providers/youtube", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/youtube")>();
  return {
    ...actual,
    uploadVideo: youtube.uploadVideo,
    setThumbnail: youtube.setThumbnail,
  };
});

const suite = hasDatabase ? describe : describe.skip;

/** The full grant a channel connected today would have. */
const FULL_SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
].join(" ");

/** What `videos.insert` returns on success, in the provider's own shape. */
function uploadResult(overrides: Record<string, unknown> = {}) {
  return {
    videoId: "dQw4w9WgXcQ",
    uploadStatus: "uploaded",
    privacyStatus: "public",
    publishAt: null,
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ...overrides,
  };
}

suite("youtube publishing (integration)", () => {
  useDatabase();

  /**
   * Warm the modules before the first test. The publish service reaches BullMQ, the
   * S3 client and the `googleapis` barrel, which is tens of seconds cold on
   * Windows — the same reason the video and thumbnail suites do this.
   */
  beforeAll(async () => {
    await import("@/lib/publish/service");
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
    youtube.uploadVideo.mockReset();
    youtube.uploadVideo.mockResolvedValue(uploadResult());
    youtube.setThumbnail.mockReset();
    youtube.setThumbnail.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Fixture
  // -------------------------------------------------------------------------

  interface FixtureOptions {
    /** Omit the render row or its output asset, so there is no file to upload. */
    withVideo?: boolean;
    /** Omit the thumbnail, or leave it generated but unselected. */
    thumbnail?: "selected" | "unselected" | "none";
    withMetadata?: boolean;
    /** A grant missing the read/write scope, as a channel connected in Phase 2 has. */
    legacyScopes?: boolean;
    /** Bytes for the thumbnail asset — used to exceed YouTube's 2 MB ceiling. */
    thumbnailBytes?: Buffer;
  }

  /**
   * A project at READY_TO_PUBLISH with a rendered file, a chosen thumbnail and
   * metadata — the only state a publish legally starts from.
   *
   * Walked through `transition` one legal edge at a time rather than UPDATEing
   * `status`, because the state machine is under test in several cases here and a
   * fixture that wrote the status directly could pass from a state production
   * cannot reach.
   */
  async function fixture(email: string, options: FixtureOptions = {}) {
    const { db } = await import("@/lib/db");
    const {
      assets,
      channels,
      renders,
      thumbnailVariants,
      thumbnails,
      videoMetadata,
    } = await import("@/lib/db/schema");
    const { createProject, transition } = await import("@/lib/projects/service");
    const { putObject, storageKey } = await import("@/lib/storage");
    const { eq } = await import("drizzle-orm");

    const user = await createUser({ email });
    const channelId = await createChannel(user.id);

    // `createChannel` writes the Phase 2 grant (`youtube.upload` only). Unless the
    // test wants that legacy shape, bring it up to what today's consent produces.
    if (!options.legacyScopes) {
      await db
        .update(channels)
        .set({ grantedScopes: FULL_SCOPES })
        .where(eq(channels.id, channelId));
    }

    const project = await createProject({
      userId: user.id,
      channelId,
      title: "Budget smart home sensors",
      maxVideosPerMonth: null,
    });

    for (const [status, stage] of [
      ["SCRIPT_GENERATING", "SCRIPT"],
      ["SCRIPT_READY", "SCRIPT"],
      ["ASSETS_GENERATING", "SCENE_PLAN"],
      ["ASSETS_READY", "TIMELINE"],
      ["RENDERING", "RENDER"],
      ["VIDEO_READY", "RENDER"],
      ["READY_TO_PUBLISH", "METADATA"],
    ] as const) {
      await transition(user.id, project.id, status, { stage, message: status });
    }

    // --- the rendered file --------------------------------------------------
    if (options.withVideo !== false) {
      /**
       * Real bytes in real object storage. Not a valid MP4 — `uploadVideo` is
       * mocked, so nothing decodes it — but the bytes make the round trip through
       * MinIO, which is what `getObjectBuffer` is being asked to do. Phase 5's
       * smoke test is where a genuinely playable MP4 is proven.
       */
      const key = storageKey({
        userId: user.id,
        folder: "video",
        projectId: project.id,
        extension: "mp4",
      });
      const put = await putObject({
        key,
        body: Buffer.from("tally-test-video-bytes"),
        contentType: "video/mp4",
      });
      const [videoAsset] = await db
        .insert(assets)
        .values({
          userId: user.id,
          projectId: project.id,
          kind: "render_output",
          storageKey: put.key,
          mimeType: "video/mp4",
          bytes: put.bytes,
          provider: "ffmpeg",
        })
        .returning({ id: assets.id });

      await db.insert(renders).values({
        projectId: project.id,
        userId: user.id,
        provider: "ffmpeg",
        status: "succeeded",
        progress: 100,
        durationMs: 122_000,
        outputAssetId: videoAsset!.id,
      });
    }

    // --- the thumbnail ------------------------------------------------------
    let variantId: string | null = null;
    if (options.thumbnail !== "none") {
      const key = storageKey({
        userId: user.id,
        folder: "thumbnail",
        projectId: project.id,
        extension: "jpg",
      });
      const put = await putObject({
        key,
        body: options.thumbnailBytes ?? Buffer.from("tally-test-thumbnail-bytes"),
        contentType: "image/jpeg",
      });
      const [imageAsset] = await db
        .insert(assets)
        .values({
          userId: user.id,
          projectId: project.id,
          kind: "thumbnail",
          storageKey: put.key,
          mimeType: "image/jpeg",
          bytes: put.bytes,
          width: 1280,
          height: 720,
          provider: "ffmpeg",
        })
        .returning({ id: assets.id });

      const [thumbnailRow] = await db
        .insert(thumbnails)
        .values({ projectId: project.id, userId: user.id, status: "succeeded" })
        .returning({ id: thumbnails.id });

      const [variant] = await db
        .insert(thumbnailVariants)
        .values({
          thumbnailId: thumbnailRow!.id,
          userId: user.id,
          index: 0,
          headline: "It's 40%: the cheap one won",
          subline: "Three weeks, twelve sensors",
          emotion: "surprise",
          imageAssetId: imageAsset!.id,
        })
        .returning({ id: thumbnailVariants.id });
      variantId = variant!.id;

      // Phase 6a's selection, which is what `selectedThumbnail` reads. Left null
      // for the "generated but not chosen" case.
      if (options.thumbnail !== "unselected") {
        await db
          .update(thumbnails)
          .set({ selectedVariantId: variantId })
          .where(eq(thumbnails.id, thumbnailRow!.id));
      }
    }

    // --- the metadata ------------------------------------------------------
    if (options.withMetadata !== false) {
      await db.insert(videoMetadata).values({
        projectId: project.id,
        userId: user.id,
        title: "I tested twelve cheap sensors so you don't have to",
        description: "Three weeks, twelve sensors, one hallway.",
        tags: ["smart home", "sensors"],
        // Stored without the leading hash — `normaliseHashtags` strips it on the
        // way in, and `composeDescription` adds it back on the way out.
        hashtags: ["smarthome"],
        // Three, because YouTube ignores a shorter list and `composeDescription`
        // honours that by omitting the section entirely below `MIN_CHAPTERS`.
        chapters: [
          { startMs: 0, label: "The claim" },
          { startMs: 45_000, label: "The test" },
          { startMs: 90_000, label: "The result" },
        ],
        categoryId: "28",
        defaultLanguage: "en-GB",
        madeForKids: false,
      });
    }

    return { user, channelId, project, variantId };
  }

  /**
   * Queue and run a publish with the bookkeeping the worker does around it.
   *
   * Goes through `startPublish` so the entry point's own checks — readiness, the
   * competing job, the transition ordering — are the ones under test, and closes
   * the `jobs` row afterwards because `hasActiveJob` reads it: a row left `queued`
   * would make a second publish in the same test fail on the fixture rather than
   * on the behaviour.
   */
  async function publish(
    context: { userId: string; projectId: string },
    options: { visibility?: "public" | "unlisted" | "private"; scheduledFor?: Date } = {},
  ) {
    const { startPublish, executePublish } = await import("@/lib/publish/service");
    const { markJobFailed, markJobSucceeded } = await import("@/lib/queue/jobs");

    const started = await startPublish({
      userId: context.userId,
      projectId: context.projectId,
      tier: "studio",
      visibility: options.visibility ?? "public",
      ...(options.scheduledFor ? { scheduledFor: options.scheduledFor } : {}),
      traceId: "test-trace",
    });

    try {
      const result = await executePublish({
        userId: context.userId,
        projectId: context.projectId,
        publishJobId: started.publishJobId,
        jobId: started.jobId,
        madeForKids: null,
        traceId: "test-trace",
      });
      await markJobSucceeded(started.jobId, result as Record<string, unknown>);
      return { ...started, result };
    } catch (error) {
      await markJobFailed(started.jobId, error);
      throw error;
    }
  }

  /** The project's row, read the way the studio reads it. */
  async function statusOf(userId: string, projectId: string): Promise<string> {
    const { getProject } = await import("@/lib/projects/service");
    return (await getProject(userId, projectId)).status;
  }

  async function publicationRows(projectId: string) {
    const { db } = await import("@/lib/db");
    const { publishedVideos } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    return db
      .select()
      .from(publishedVideos)
      .where(eq(publishedVideos.projectId, projectId));
  }

  async function publishJobRow(publishJobId: string) {
    const { db } = await import("@/lib/db");
    const { publishJobs } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(publishJobs)
      .where(eq(publishJobs.id, publishJobId));
    return rows[0];
  }

  // -------------------------------------------------------------------------
  // The confirmed publish
  // -------------------------------------------------------------------------

  describe("a confirmed upload", () => {
    it("records the publication from YouTube's response and then marks PUBLISHED", async () => {
      const { user, project, channelId, variantId } = await fixture("pub@tally.test");

      const { result, publishJobId } = await publish({
        userId: user.id,
        projectId: project.id,
      });

      expect(result.youtubeVideoId).toBe("dQw4w9WgXcQ");
      expect(result.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      expect(result.thumbnailSet).toBe(true);
      // §29: nothing in `videos.insert` files the synthetic-content disclosure, so
      // it is always still the user's to make.
      expect(result.disclosureOutstanding).toBe(true);

      const publications = await publicationRows(project.id);
      expect(publications).toHaveLength(1);
      const publication = publications[0]!;
      expect(publication.youtubeVideoId).toBe("dQw4w9WgXcQ");
      expect(publication.userId).toBe(user.id);
      expect(publication.channelId).toBe(channelId);
      expect(publication.publishJobId).toBe(publishJobId);
      // Which thumbnail actually went live, so a later A/B test has a baseline.
      expect(publication.thumbnailVariantId).toBe(variantId);
      expect(publication.titleUsed).toBe(
        "I tested twelve cheap sensors so you don't have to",
      );
      expect(publication.publishedAt).not.toBeNull();

      // Only now is the project published.
      expect(await statusOf(user.id, project.id)).toBe("PUBLISHED");

      const job = await publishJobRow(publishJobId);
      expect(job!.status).toBe("published");
      expect(job!.uploadProgress).toBe(100);
      expect(job!.error).toBeNull();
      expect(job!.completedAt).not.toBeNull();
    }, 120_000);

    it("mirrors YouTube's own statuses rather than what Tally asked for", async () => {
      /**
       * The upload was requested public; YouTube is still processing and reports it
       * private. Storing the request instead of the response is how a UI ends up
       * claiming a video is live while YouTube is still transcoding (§42).
       */
      youtube.uploadVideo.mockResolvedValue(
        uploadResult({ uploadStatus: "processed", privacyStatus: "private" }),
      );

      const { user, project } = await fixture("mirror@tally.test");
      await publish({ userId: user.id, projectId: project.id }, { visibility: "public" });

      const [publication] = await publicationRows(project.id);
      expect(publication!.uploadStatus).toBe("processed");
      expect(publication!.privacyStatus).toBe("private");
    }, 120_000);

    it("sends the composed description, the metadata and the video bytes", async () => {
      const { user, project } = await fixture("payload@tally.test");
      await publish({ userId: user.id, projectId: project.id });

      const call = youtube.uploadVideo.mock.calls[0]![0] as Record<string, unknown>;
      expect(call["title"]).toBe(
        "I tested twelve cheap sensors so you don't have to",
      );
      // `composeDescription` appends chapters and hashtags — the timestamps are what
      // make YouTube render chapter markers, so their absence is a silent feature
      // loss rather than an error.
      expect(call["description"]).toContain("Three weeks, twelve sensors");
      expect(call["description"]).toContain("0:00 The claim");
      expect(call["description"]).toContain("0:45 The test");
      expect(call["description"]).toContain("#smarthome");
      expect(call["tags"]).toEqual(["smart home", "sensors"]);
      expect(call["categoryId"]).toBe("28");
      expect(call["language"]).toBe("en-GB");
      expect(call["privacyStatus"]).toBe("public");
      // A legal declaration, read from the row rather than defaulted (§29).
      expect(call["madeForKids"]).toBe(false);
      expect(call["mimeType"]).toBe("video/mp4");

      // The thumbnail is a second call, after the video exists.
      expect(youtube.setThumbnail).toHaveBeenCalledTimes(1);
      const thumbCall = youtube.setThumbnail.mock.calls[0]![0] as Record<string, unknown>;
      expect(thumbCall["videoId"]).toBe("dQw4w9WgXcQ");
      expect(thumbCall["mimeType"]).toBe("image/jpeg");
    }, 120_000);

    it("counts the publication once against the month's usage", async () => {
      const { user, project } = await fixture("usage@tally.test");
      await publish({ userId: user.id, projectId: project.id });

      const { db } = await import("@/lib/db");
      const { usageCounters } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.userId, user.id));

      expect(rows).toHaveLength(1);
      expect(rows[0]!.videosPublished).toBe(1);
    }, 120_000);

    it("uploads private with publishAt when the publish is scheduled", async () => {
      const { user, project } = await fixture("sched@tally.test");
      await setTier(user.id, "studio");
      const when = new Date(Date.now() + 6 * 60 * 60 * 1000);

      youtube.uploadVideo.mockResolvedValue(
        uploadResult({ privacyStatus: "private", publishAt: when }),
      );

      /**
       * The upload happens now; YouTube flips the video public at `publishAt`. That
       * is what makes the schedule survive Tally being down — a job held in the
       * queue until 18:00 does not go live at 18:00 if the worker is restarted (§19).
       */
      await publish(
        { userId: user.id, projectId: project.id },
        { visibility: "public", scheduledFor: when },
      );

      const call = youtube.uploadVideo.mock.calls[0]![0] as Record<string, unknown>;
      expect(call["privacyStatus"]).toBe("private");
      expect(call["publishAt"]).toEqual(when);

      // The project went SCHEDULED → PUBLISHING → PUBLISHED. The middle step is
      // load-bearing: PUBLISHED is only reachable from PUBLISHING, so a stage that
      // uploaded straight from SCHEDULED would leave a live video on a project it
      // could never legally mark published.
      expect(await statusOf(user.id, project.id)).toBe("PUBLISHED");
      const { listEvents } = await import("@/lib/projects/service");
      const events = await listEvents(user.id, project.id);
      expect(events.map((e) => e.toStatus)).toContain("SCHEDULED");

      const [publication] = await publicationRows(project.id);
      // Not yet live, so no `publishedAt` — the scheduled time is what is known.
      expect(publication!.publishedAt).toBeNull();
      expect(publication!.scheduledPublishAt?.getTime()).toBe(when.getTime());
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  // Failure
  // -------------------------------------------------------------------------

  describe("failure never publishes", () => {
    it("leaves the project PUBLISHING and records nothing when the upload is retryable", async () => {
      const { user, project } = await fixture("retry@tally.test");

      const { YouTubeUploadError } = await import("@/lib/errors");
      // A 500 from Google. The worker has an attempt left, and flashing FAILED
      // between two attempts of a recovering upload is a lie about a live job (§37).
      youtube.uploadVideo.mockRejectedValue(
        new YouTubeUploadError("backend error", { retryable: true }),
      );

      const started = await (async () => {
        const { startPublish } = await import("@/lib/publish/service");
        return startPublish({
          userId: user.id,
          projectId: project.id,
          tier: "studio",
          visibility: "public",
        });
      })();

      const { executePublish } = await import("@/lib/publish/service");
      await expect(
        executePublish({
          userId: user.id,
          projectId: project.id,
          publishJobId: started.publishJobId,
          jobId: started.jobId,
        }),
      ).rejects.toThrow(/backend error/i);

      expect(await publicationRows(project.id)).toHaveLength(0);
      expect(await statusOf(user.id, project.id)).toBe("PUBLISHING");

      const job = await publishJobRow(started.publishJobId);
      expect(job!.status).toBe("publishing");
      expect(job!.attempt).toBe(1);
      expect(job!.completedAt).toBeNull();
      expect(job!.errorCode).toBe("youtube_upload_failed");
    }, 120_000);

    it("moves the project to FAILED with the real code when the failure is permanent", async () => {
      const { user, project } = await fixture("perm@tally.test");

      const { ProviderError } = await import("@/lib/errors");
      // `uploadLimitExceeded` — the channel's daily cap. No number of retries
      // changes it before tomorrow, so the user has to see it.
      youtube.uploadVideo.mockRejectedValue(
        new ProviderError(
          "YouTube",
          "This channel has reached its daily upload limit. Try again tomorrow.",
          { retryable: false },
        ),
      );

      const { startPublish, executePublish } = await import("@/lib/publish/service");
      const started = await startPublish({
        userId: user.id,
        projectId: project.id,
        tier: "studio",
        visibility: "public",
      });

      await expect(
        executePublish({
          userId: user.id,
          projectId: project.id,
          publishJobId: started.publishJobId,
          jobId: started.jobId,
        }),
      ).rejects.toThrow(/daily upload limit/i);

      expect(await publicationRows(project.id)).toHaveLength(0);
      expect(await statusOf(user.id, project.id)).toBe("FAILED");

      const job = await publishJobRow(started.publishJobId);
      expect(job!.status).toBe("failed");
      expect(job!.completedAt).not.toBeNull();
      expect(job!.errorCode).toBe("provider_failed");
      expect(job!.error).toMatch(/daily upload limit/i);

      // The reason is on the project too, because that is where the user is.
      const { getProject } = await import("@/lib/projects/service");
      const after = await getProject(user.id, project.id);
      expect(after.errorCode).toBe("provider_failed");
      expect(after.errorMessage).toMatch(/daily upload limit/i);
    }, 120_000);

    it("does not upload at all when the rendered file is missing", async () => {
      const { user, project } = await fixture("novideo@tally.test", {
        withVideo: false,
      });

      const { startPublish } = await import("@/lib/publish/service");
      // Refused in the request, before a job exists: the user is present to be told.
      await expect(
        startPublish({
          userId: user.id,
          projectId: project.id,
          tier: "studio",
          visibility: "public",
        }),
      ).rejects.toThrow(/has not finished rendering/i);

      expect(youtube.uploadVideo).not.toHaveBeenCalled();
      expect(await statusOf(user.id, project.id)).toBe("READY_TO_PUBLISH");

      const { db } = await import("@/lib/db");
      const { publishJobs } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      expect(
        await db.select().from(publishJobs).where(eq(publishJobs.projectId, project.id)),
      ).toHaveLength(0);
    }, 120_000);

    it("refuses when thumbnails exist but none was chosen", async () => {
      /**
       * §7: reaching publish without a selected thumbnail must fail safely rather
       * than upload and let YouTube pick a frame. The variant rows exist here — only
       * `selected_variant_id` is null — which is the state a user who generated
       * thumbnails and then navigated away is actually in.
       */
      const { user, project } = await fixture("nothumb@tally.test", {
        thumbnail: "unselected",
      });

      const { startPublish } = await import("@/lib/publish/service");
      await expect(
        startPublish({
          userId: user.id,
          projectId: project.id,
          tier: "studio",
          visibility: "public",
        }),
      ).rejects.toThrow(/No thumbnail has been chosen/i);

      expect(youtube.uploadVideo).not.toHaveBeenCalled();
    }, 120_000);

    it("refuses when the video has no metadata", async () => {
      const { user, project } = await fixture("nometa@tally.test", {
        withMetadata: false,
      });

      const { startPublish } = await import("@/lib/publish/service");
      await expect(
        startPublish({
          userId: user.id,
          projectId: project.id,
          tier: "studio",
          visibility: "public",
        }),
      ).rejects.toThrow(/no title or description/i);

      expect(youtube.uploadVideo).not.toHaveBeenCalled();
    }, 120_000);

    it("fails the stage rather than uploading when an asset disappears after queueing", async () => {
      /**
       * The gap the second readiness check exists to close. Minutes pass between
       * the click and the worker, and a thumbnail deselected in between must stop
       * the upload — publishing the wrong asset is worse than not publishing (§7).
       */
      const { user, project } = await fixture("vanish@tally.test");

      const { startPublish, executePublish } = await import("@/lib/publish/service");
      const started = await startPublish({
        userId: user.id,
        projectId: project.id,
        tier: "studio",
        visibility: "public",
      });

      const { db } = await import("@/lib/db");
      const { thumbnails } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      await db
        .update(thumbnails)
        .set({ selectedVariantId: null })
        .where(eq(thumbnails.projectId, project.id));

      await expect(
        executePublish({
          userId: user.id,
          projectId: project.id,
          publishJobId: started.publishJobId,
          jobId: started.jobId,
        }),
      ).rejects.toThrow(/selected thumbnail/i);

      expect(youtube.uploadVideo).not.toHaveBeenCalled();
      expect(await publicationRows(project.id)).toHaveLength(0);
      // `asset_missing` is not retryable, so the project stops rather than looping.
      expect(await statusOf(user.id, project.id)).toBe("FAILED");
    }, 120_000);

    it("refuses a thumbnail larger than YouTube's 2 MB limit", async () => {
      const { user, project } = await fixture("bigthumb@tally.test", {
        // Just over the ceiling. Discovering this from the API costs a full upload
        // of the bytes and a confusing 400.
        thumbnailBytes: Buffer.alloc(2 * 1024 * 1024 + 1, 0x41),
      });

      const { startPublish, executePublish } = await import("@/lib/publish/service");
      const started = await startPublish({
        userId: user.id,
        projectId: project.id,
        tier: "studio",
        visibility: "public",
      });

      await expect(
        executePublish({
          userId: user.id,
          projectId: project.id,
          publishJobId: started.publishJobId,
          jobId: started.jobId,
        }),
      ).rejects.toThrow(/2 MB limit/i);

      // Refused before the video went anywhere, which is the point of checking the
      // size rather than letting `thumbnails.set` fail after a successful upload.
      expect(youtube.uploadVideo).not.toHaveBeenCalled();
      expect(await publicationRows(project.id)).toHaveLength(0);
    }, 120_000);

    it("stays published when YouTube accepts the video but rejects the thumbnail", async () => {
      const { user, project } = await fixture("thumbfail@tally.test");

      const { ProviderError } = await import("@/lib/errors");
      youtube.setThumbnail.mockRejectedValue(
        new ProviderError("YouTube", "thumbnail rejected", { retryable: false }),
      );

      const { result } = await publish({ userId: user.id, projectId: project.id });

      /**
       * The video is live. Throwing here would send the project to FAILED while
       * YouTube shows it published — the exact contradiction §42 forbids — so the
       * failure is reported, not raised.
       */
      expect(result.thumbnailSet).toBe(false);
      expect(await statusOf(user.id, project.id)).toBe("PUBLISHED");
      expect(await publicationRows(project.id)).toHaveLength(1);

      // And the user is told, on the event trail the project page renders.
      const { db } = await import("@/lib/db");
      const { projectEvents } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const events = await db
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(
        events.some((e) => (e.message ?? "").includes("thumbnail could not be set")),
      ).toBe(true);
    }, 120_000);

    it("routes a channel with a pre-Phase-7 grant back through re-authorisation", async () => {
      /**
       * §8: a grant with only `youtube.upload` cannot set a thumbnail or edit
       * details. Uploading anyway would produce a live video with the wrong picture,
       * so the channel goes back through the existing reconnect flow instead of
       * Tally assuming an old token has new permissions.
       */
      const { user, project } = await fixture("legacy@tally.test", {
        legacyScopes: true,
      });

      const { startPublish, executePublish } = await import("@/lib/publish/service");
      const started = await startPublish({
        userId: user.id,
        projectId: project.id,
        tier: "studio",
        visibility: "public",
      });

      await expect(
        executePublish({
          userId: user.id,
          projectId: project.id,
          publishJobId: started.publishJobId,
          jobId: started.jobId,
        }),
      ).rejects.toThrow(/reconnect/i);

      expect(youtube.uploadVideo).not.toHaveBeenCalled();
      expect(await publicationRows(project.id)).toHaveLength(0);

      const job = await publishJobRow(started.publishJobId);
      expect(job!.errorCode).toBe("oauth_reauth_required");
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  // Retry and duplication
  // -------------------------------------------------------------------------

  describe("retries do not duplicate", () => {
    it("reconciles instead of re-uploading when the publication already exists", async () => {
      /**
       * The pathological case: YouTube accepted the upload and the process died
       * before the bookkeeping finished. The video is on the channel; uploading
       * again would put a second copy there, and that cannot be undone.
       */
      const { user, project } = await fixture("reconcile@tally.test");

      const { startPublish, executePublish } = await import("@/lib/publish/service");
      const started = await startPublish({
        userId: user.id,
        projectId: project.id,
        tier: "studio",
        visibility: "public",
      });

      // First attempt succeeds at YouTube.
      await executePublish({
        userId: user.id,
        projectId: project.id,
        publishJobId: started.publishJobId,
        jobId: started.jobId,
      });
      expect(youtube.uploadVideo).toHaveBeenCalledTimes(1);

      // BullMQ redelivers the same job.
      const second = await executePublish({
        userId: user.id,
        projectId: project.id,
        publishJobId: started.publishJobId,
        jobId: started.jobId,
      });

      expect(youtube.uploadVideo).toHaveBeenCalledTimes(1);
      expect(second.youtubeVideoId).toBe("dQw4w9WgXcQ");
      expect(await publicationRows(project.id)).toHaveLength(1);
      expect(await statusOf(user.id, project.id)).toBe("PUBLISHED");
    }, 120_000);

    it("keeps one publication when the same video id is recorded twice", async () => {
      /**
       * The layer beneath the reconcile check: if two workers somehow both upload,
       * the unique index on `youtube_video_id` is what stops Tally reporting two
       * publications for one video — and the usage counter must not move twice
       * either.
       */
      const { user, project } = await fixture("dupe@tally.test");
      await publish({ userId: user.id, projectId: project.id });

      const { db } = await import("@/lib/db");
      const { publishedVideos, usageCounters } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      const [existing] = await publicationRows(project.id);
      await expect(
        db.insert(publishedVideos).values({
          projectId: project.id,
          userId: user.id,
          channelId: existing!.channelId,
          youtubeVideoId: "dQw4w9WgXcQ",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        }),
      ).rejects.toThrow(/published_videos_youtube_id_key|duplicate key/i);

      expect(await publicationRows(project.id)).toHaveLength(1);
      const counters = await db
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.userId, user.id));
      expect(counters[0]!.videosPublished).toBe(1);
    }, 120_000);

    it("publishes on a retry after a permanent failure", async () => {
      /**
       * The state this stage is most often entered from in production, and the one
       * that made the missing PUBLISHING transition a live bug: the project sits at
       * FAILED, the user clicks publish again, and the upload succeeds. Without a
       * transition into PUBLISHING first, the final `FAILED → PUBLISHED` edge is
       * illegal — so the video would be on YouTube with the project marked FAILED,
       * and every subsequent retry would hit the same wall.
       */
      const { user, project } = await fixture("failed-retry@tally.test");

      const { ProviderError } = await import("@/lib/errors");
      youtube.uploadVideo.mockRejectedValueOnce(
        new ProviderError("YouTube", "processingFailure", { retryable: false }),
      );

      await expect(
        publish({ userId: user.id, projectId: project.id }),
      ).rejects.toThrow(/processingFailure/);
      expect(await statusOf(user.id, project.id)).toBe("FAILED");

      // Second click. `beforeEach`'s default resolve is back in play.
      await publish({ userId: user.id, projectId: project.id });

      expect(await statusOf(user.id, project.id)).toBe("PUBLISHED");
      expect(await publicationRows(project.id)).toHaveLength(1);
    }, 120_000);

    it("refuses a second publish for a project that is already live", async () => {
      const { user, project } = await fixture("already@tally.test");
      await publish({ userId: user.id, projectId: project.id });

      const { startPublish } = await import("@/lib/publish/service");
      await expect(
        startPublish({
          userId: user.id,
          projectId: project.id,
          tier: "studio",
          visibility: "public",
        }),
      ).rejects.toThrow(/already been published/i);

      expect(youtube.uploadVideo).toHaveBeenCalledTimes(1);
    }, 120_000);

    it("refuses a second upload while one is already in flight for the project", async () => {
      /**
       * Two guards can stop this, and which one fires depends on the state. For an
       * immediate publish the project is already PUBLISHING, so the status check
       * refuses first — the `hasActiveJob` check below never gets a chance. Asserted
       * as "refused", not on a particular sentence, because either message is
       * correct and pinning one would make a harmless reordering look like a
       * regression. What must not happen is a second upload.
       */
      const { user, project } = await fixture("inflight@tally.test");

      const { startPublish } = await import("@/lib/publish/service");
      await startPublish({
        userId: user.id,
        projectId: project.id,
        tier: "studio",
        visibility: "public",
      });

      const error = await startPublish({
        userId: user.id,
        projectId: project.id,
        tier: "studio",
        visibility: "public",
      }).catch((e: unknown) => e);

      const { isAppError } = await import("@/lib/errors");
      expect(isAppError(error)).toBe(true);
      expect(youtube.uploadVideo).not.toHaveBeenCalled();

      // Exactly one publish job, so exactly one upload can ever run.
      const { db } = await import("@/lib/db");
      const { publishJobs } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      expect(
        await db.select().from(publishJobs).where(eq(publishJobs.projectId, project.id)),
      ).toHaveLength(1);
    }, 120_000);

    it("refuses a second upload for a channel whose scheduled publish is queued", async () => {
      /**
       * The state where `hasActiveJob` is the *only* thing standing in the way: a
       * scheduled publish leaves the project at SCHEDULED, which the status check
       * accepts as publishable. Without the active-job check a second click here
       * would queue a second upload of the same video to the same channel.
       */
      const { user, project } = await fixture("inflight-sched@tally.test");
      await setTier(user.id, "studio");
      const when = new Date(Date.now() + 6 * 60 * 60 * 1000);

      const { startPublish } = await import("@/lib/publish/service");
      await startPublish({
        userId: user.id,
        projectId: project.id,
        tier: "studio",
        visibility: "public",
        scheduledFor: when,
      });

      await expect(
        startPublish({
          userId: user.id,
          projectId: project.id,
          tier: "studio",
          visibility: "public",
          scheduledFor: when,
        }),
      ).rejects.toThrow(/already in progress/i);
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  // The state machine
  // -------------------------------------------------------------------------

  describe("PUBLISHED is unreachable without confirmation", () => {
    it("has no legal edge into PUBLISHED except from PUBLISHING", async () => {
      const { PROJECT_STATUSES, canTransition } = await import(
        "@/lib/projects/state-machine"
      );

      const canReach = PROJECT_STATUSES.filter(
        (status) => status !== "PUBLISHED" && canTransition(status, "PUBLISHED"),
      );
      // One door in, and the publish stage is the only thing that opens it after a
      // video id comes back from YouTube.
      expect(canReach).toEqual(["PUBLISHING"]);
    });

    it("rejects a jump from READY_TO_PUBLISH straight to PUBLISHED", async () => {
      const { user, project } = await fixture("jump@tally.test");
      const { transition } = await import("@/lib/projects/service");

      await expect(
        transition(user.id, project.id, "PUBLISHED", { stage: "PUBLISH" }),
      ).rejects.toThrow(/Cannot move a project from READY_TO_PUBLISH to PUBLISHED/i);

      expect(await statusOf(user.id, project.id)).toBe("READY_TO_PUBLISH");
      expect(await publicationRows(project.id)).toHaveLength(0);
    }, 120_000);

    it("is terminal: a published project cannot be re-published or rewound", async () => {
      const { user, project } = await fixture("terminal@tally.test");
      await publish({ userId: user.id, projectId: project.id });

      const { transition } = await import("@/lib/projects/service");
      for (const target of ["PUBLISHING", "READY_TO_PUBLISH", "FAILED"] as const) {
        await expect(
          transition(user.id, project.id, target, { stage: "PUBLISH" }),
        ).rejects.toThrow(/Cannot move a project from PUBLISHED/i);
      }

      expect(await statusOf(user.id, project.id)).toBe("PUBLISHED");
    }, 120_000);

    it("reports 100% progress once published", async () => {
      const { user, project } = await fixture("progress@tally.test");
      await publish({ userId: user.id, projectId: project.id });

      const { getProject } = await import("@/lib/projects/service");
      const after = await getProject(user.id, project.id);
      expect(after.progress).toBe(100);
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  // Tenant isolation (§10, §34)
  // -------------------------------------------------------------------------

  describe("cross-tenant publishing", () => {
    it("will not publish another user's project", async () => {
      const owner = await fixture("owner@tally.test");
      const intruder = await createUser({ email: "intruder@tally.test" });

      const { startPublish } = await import("@/lib/publish/service");
      // `getProject` is tenant-scoped, so a foreign project id is simply not found.
      // There is no path that leaks whether it exists (§34).
      await expect(
        startPublish({
          userId: intruder.id,
          projectId: owner.project.id,
          tier: "studio",
          visibility: "public",
        }),
      ).rejects.toThrow(/not found/i);

      expect(youtube.uploadVideo).not.toHaveBeenCalled();
      expect(await statusOf(owner.user.id, owner.project.id)).toBe("READY_TO_PUBLISH");
    }, 120_000);

    it("will not upload for a publish job belonging to another user", async () => {
      /**
       * The queue payload is the attack surface: it carries a `publishJobId`, and a
       * worker that loaded that row without the tenant predicate would upload user
       * A's video using user B's token. `loadPublishJob` scopes by `userId`, so the
       * row is invisible.
       */
      const victim = await fixture("victim@tally.test");
      const attacker = await fixture("attacker@tally.test");

      const { startPublish, executePublish } = await import("@/lib/publish/service");
      const victimJob = await startPublish({
        userId: victim.user.id,
        projectId: victim.project.id,
        tier: "studio",
        visibility: "public",
      });

      await expect(
        executePublish({
          // The attacker's own identity, from their `jobs` row...
          userId: attacker.user.id,
          projectId: attacker.project.id,
          // ...pointed at the victim's publish job.
          publishJobId: victimJob.publishJobId,
          jobId: victimJob.jobId,
        }),
      ).rejects.toThrow(/does not exist/i);

      expect(youtube.uploadVideo).not.toHaveBeenCalled();
      expect(await publicationRows(victim.project.id)).toHaveLength(0);
      expect(await publicationRows(attacker.project.id)).toHaveLength(0);
      // The victim's project is untouched — still waiting on its own upload.
      expect(await statusOf(victim.user.id, victim.project.id)).toBe("PUBLISHING");
    }, 120_000);

    it("will not upload one project using another project's publish job", async () => {
      /**
       * The subtler half, and the one a `userId` predicate alone would miss: both
       * rows belong to the same user. Only comparing the job's `project_id` to the
       * payload's stops project A's video being uploaded under project B's chosen
       * visibility and thumbnail.
       */
      const first = await fixture("same-a@tally.test");

      const { db } = await import("@/lib/db");
      const { createProject, transition } = await import("@/lib/projects/service");
      const second = await createProject({
        userId: first.user.id,
        channelId: first.channelId,
        title: "A second video",
        maxVideosPerMonth: null,
      });
      for (const [status, stage] of [
        ["SCRIPT_GENERATING", "SCRIPT"],
        ["SCRIPT_READY", "SCRIPT"],
        ["ASSETS_GENERATING", "SCENE_PLAN"],
        ["ASSETS_READY", "TIMELINE"],
        ["RENDERING", "RENDER"],
        ["VIDEO_READY", "RENDER"],
        ["READY_TO_PUBLISH", "METADATA"],
      ] as const) {
        await transition(first.user.id, second.id, status, { stage, message: status });
      }

      const { startPublish, executePublish } = await import("@/lib/publish/service");
      const job = await startPublish({
        userId: first.user.id,
        projectId: first.project.id,
        tier: "studio",
        visibility: "public",
      });

      await expect(
        executePublish({
          userId: first.user.id,
          // Project B, job from project A. Same owner throughout.
          projectId: second.id,
          publishJobId: job.publishJobId,
          jobId: job.jobId,
        }),
      ).rejects.toThrow(/does not belong to this project/i);

      expect(youtube.uploadVideo).not.toHaveBeenCalled();
      expect(await publicationRows(second.id)).toHaveLength(0);

      // And the guard is not retryable: a mismatch is a mismatch on every attempt.
      const { shouldRetry } = await import("@/worker/runner");
      const error = await executePublish({
        userId: first.user.id,
        projectId: second.id,
        publishJobId: job.publishJobId,
        jobId: job.jobId,
      }).catch((e: unknown) => e);
      expect(shouldRetry(error)).toBe(false);

      // Nothing was written against the unrelated project.
      const { publishedVideos } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      expect(
        await db
          .select()
          .from(publishedVideos)
          .where(eq(publishedVideos.userId, first.user.id)),
      ).toHaveLength(0);
    }, 120_000);

    it("will not upload for a channel the project does not belong to", async () => {
      /**
       * A publish job whose `channel_id` was swapped for another channel of the same
       * user. §10's exact scenario: the video is real, the token is real, and they
       * belong to different channels — so the video would land on the wrong one.
       */
      const owner = await fixture("chan-a@tally.test");
      const otherChannelId = await createChannel(owner.user.id, {
        youtubeChannelId: "UCotherchannel0000000000",
        title: "Second channel",
      });

      const { startPublish, executePublish } = await import("@/lib/publish/service");
      const started = await startPublish({
        userId: owner.user.id,
        projectId: owner.project.id,
        tier: "studio",
        visibility: "public",
      });

      const { db } = await import("@/lib/db");
      const { publishJobs } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      await db
        .update(publishJobs)
        .set({ channelId: otherChannelId })
        .where(eq(publishJobs.id, started.publishJobId));

      await expect(
        executePublish({
          userId: owner.user.id,
          projectId: owner.project.id,
          publishJobId: started.publishJobId,
          jobId: started.jobId,
        }),
      ).rejects.toThrow(/channel does not match/i);

      expect(youtube.uploadVideo).not.toHaveBeenCalled();
      expect(await publicationRows(owner.project.id)).toHaveLength(0);
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  // Readiness reporting
  // -------------------------------------------------------------------------

  describe("readiness", () => {
    it("names every missing prerequisite in workflow order", async () => {
      const { user, project } = await fixture("blocked@tally.test", {
        withVideo: false,
        thumbnail: "none",
        withMetadata: false,
      });

      const { publishReadiness } = await import("@/lib/publish/service");
      const readiness = await publishReadiness(user.id, project.id);

      expect(readiness.ready).toBe(false);
      // Ordered by where they sit in the pipeline, so the first is the next thing
      // to do rather than an arbitrary one of three (§37).
      expect(readiness.blocked).toHaveLength(3);
      expect(readiness.blocked[0]).toMatch(/finished rendering/i);
      expect(readiness.blocked[1]).toMatch(/thumbnail/i);
      expect(readiness.blocked[2]).toMatch(/title or description/i);
    }, 120_000);

    it("is ready when every asset exists", async () => {
      const { user, project } = await fixture("ready@tally.test");
      const { publishReadiness } = await import("@/lib/publish/service");
      const readiness = await publishReadiness(user.id, project.id);
      expect(readiness).toEqual({ ready: true, blocked: [] });
    }, 120_000);

    it("does not see another user's assets as this project's", async () => {
      const owner = await fixture("assets-owner@tally.test");
      const intruder = await createUser({ email: "assets-intruder@tally.test" });

      const { publishReadiness } = await import("@/lib/publish/service");
      // Every read in `publishReadiness` carries `userId`, so a foreign caller sees
      // an empty project rather than someone else's rendered video.
      const readiness = await publishReadiness(intruder.id, owner.project.id);
      expect(readiness.ready).toBe(false);
      expect(readiness.blocked).toHaveLength(3);
    }, 120_000);
  });
});

/**
 * YouTube publishing (§18, §42).
 *
 * The rule this file exists to keep is the one §42 states in a single sentence:
 * **a project is PUBLISHED only after YouTube says so.** Every design choice below
 * follows from it.
 *
 *  - The row in `published_videos` is written from YouTube's own response, after
 *    `videos.insert` has returned a video id. It carries YouTube's `uploadStatus`
 *    and `privacyStatus` verbatim rather than what we asked for, because "what we
 *    asked for" is a request and "what came back" is a fact.
 *  - The `PUBLISHING → PUBLISHED` transition happens after that insert, in that
 *    order. Starting the upload does not move the project; only a confirmed video
 *    id does.
 *  - `published_videos.youtube_video_id` is unique. A retry that reaches YouTube
 *    twice — the pathological case, where the upload succeeded but the process
 *    died before recording it — collides on that index instead of producing two
 *    publication records for one video.
 *
 * Two failure shapes are handled differently on purpose. A transient one (5xx,
 * a socket reset, a rate limit) leaves the project in `PUBLISHING` so the worker's
 * next attempt continues, because flashing FAILED between attempts makes a
 * recoverable blip look like a dead upload. A permanent one (revoked grant, a
 * rejected video, a quota that will not reset within the retry window) moves the
 * project to `FAILED` with the real error code, because no number of retries
 * changes it and the user needs to see it.
 *
 * What this file does **not** do: it does not re-implement the upload. The
 * resumable `videos.insert` call, its error translation and its byte-progress
 * callback all live in `providers/youtube.ts`; the thumbnail comes from Phase 6a's
 * `thumbnail_variants`; the token comes from `channels/service.withChannelToken`.
 * This module is the connective tissue that decides *whether* to publish, *what*
 * to publish, and *what is true afterwards*.
 */
import { Readable } from "node:stream";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  assets,
  channels,
  projects,
  publishJobs,
  publishedVideos,
  renders,
  thumbnailVariants,
  thumbnails,
  usageCounters,
  videoMetadata,
} from "@/lib/db/schema";
import {
  AssetMissingError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ReauthRequiredError,
  ValidationError,
  errorCodeOf,
  isAppError,
  userMessageOf,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { composeDescription } from "@/lib/metadata/format";
import { hasFeature } from "@/lib/plans/enforce";
import type { PlanTier } from "@/lib/plans";
import {
  currentPeriod,
  deriveProgress,
  getProject,
  transition,
} from "@/lib/projects/service";
import { enqueue, hasActiveJob, reportProgress } from "@/lib/queue/jobs";
import { getObjectBuffer } from "@/lib/storage";
import { withChannelToken } from "@/lib/channels/service";
import {
  missingRequiredScopes,
  setThumbnail,
  uploadVideo,
  watchUrl,
} from "@/lib/providers/youtube";

const log = logger.child({ component: "publish" });

/** Queue job name. One name, one handler, on the serialised `publish` queue. */
export const PUBLISH_JOB = "publish-video";

/** Visibility values YouTube accepts, mirroring `publish_visibility`. */
export type PublishVisibility = "public" | "unlisted" | "private";

/**
 * Stages complete once a video is live. `PUBLISH` is not in `PIPELINE_STAGES`
 * (its weights stop at METADATA and sum to 100), so a published project's
 * progress is every weighted stage: 100.
 */
const COMPLETED_AFTER_PUBLISH = [
  "SCRIPT",
  "SCENE_PLAN",
  "VOICEOVER",
  "VISUALS",
  "MUSIC",
  "CAPTIONS",
  "TIMELINE",
  "RENDER",
  "QUALITY_CHECK",
  "THUMBNAIL",
  "METADATA",
] as const;

/**
 * YouTube's own limit on thumbnail uploads. Larger is rejected, and finding that
 * out from the API costs a full upload of the bytes.
 */
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Request side
// ---------------------------------------------------------------------------

export interface StartPublishInput {
  userId: string;
  projectId: string;
  tier: PlanTier;
  visibility: PublishVisibility;
  /**
   * When set, the video is uploaded *now* as private and YouTube flips it public
   * at this time. That is YouTube's own `status.publishAt`, so the schedule
   * survives Tally being down — which is the point of scheduling rather than
   * holding the job in the queue.
   */
  scheduledFor?: Date | null;
  madeForKids?: boolean;
  traceId?: string | null;
}

export interface StartPublishResult {
  jobId: string;
  publishJobId: string;
  status: "queued" | "scheduled";
}

/**
 * Queue a publish. Runs inside the request and touches no provider.
 *
 * Every prerequisite is re-checked here rather than only in the worker, because
 * the user is present to be told. A project that moved to PUBLISHING and back to
 * FAILED two seconds later because its metadata was missing reads as a bug; a
 * sentence naming the missing thing does not (§37).
 */
export async function startPublish(
  input: StartPublishInput,
): Promise<StartPublishResult> {
  const project = await getProject(input.userId, input.projectId);

  if (project.status === "PUBLISHED") {
    throw new ConflictError(
      "This video has already been published. Start a new video, or change the " +
        "live one from YouTube Studio.",
    );
  }

  // A publication row is the §42 definition of published. If one exists the
  // project should already be PUBLISHED; publishing again would upload a second
  // copy of the same video to the same channel.
  const existing = await publicationFor(input.userId, input.projectId);
  if (existing) {
    throw new ConflictError(
      `This video is already on YouTube (${existing.url}). Uploading again would ` +
        "create a duplicate.",
    );
  }

  if (project.status !== "READY_TO_PUBLISH" && project.status !== "SCHEDULED") {
    // FAILED is deliberately excluded from the fast path but not from publishing:
    // a project that failed *at the publish stage* is retried through this same
    // route, and one that failed earlier has no finished video to upload. The
    // render check below is what tells those apart, so the message points at the
    // work rather than at the status name.
    if (project.status !== "FAILED") {
      throw new ValidationError(
        "This video is not ready to publish yet. Finish the video and choose a " +
          "thumbnail first.",
      );
    }
  }

  const ready = await publishReadiness(input.userId, input.projectId);
  if (!ready.ready) {
    // The first blocker, not all of them: they are ordered by where they sit in
    // the workflow, so the first is the next thing to do.
    throw new ValidationError(ready.blocked[0] ?? "This video cannot be published yet.");
  }

  // Readiness already refused a channel-less project, so this holds. Re-read as a
  // narrowing rather than a cast: `channelId` is nullable since Phase 11 (§4), and
  // an assertion here would be the one place a future edit to `publishReadiness`
  // could silently start queueing an upload with no channel.
  const channelId = project.channelId;
  if (!channelId) {
    throw new ValidationError(
      "This video is not linked to a YouTube channel. Connect a channel to " +
        "publish it.",
    );
  }

  // Scheduling is a Studio feature (§23). Checked here rather than in the worker
  // because a plan gate the user can act on belongs in the response to their
  // click, and because `scheduledFor` reaching YouTube is what makes it real.
  if (input.scheduledFor) {
    if (!hasFeature(input.tier, "scheduling")) {
      throw new ValidationError(
        "Scheduling a publish time is part of the Studio plan. Publish now, or " +
          "upgrade to schedule.",
      );
    }
    if (input.scheduledFor.getTime() <= Date.now()) {
      throw new ValidationError(
        "That publish time is in the past. Choose a future time, or publish now.",
      );
    }
  }

  // One upload at a time per channel. The `publish` queue's concurrency of 1
  // serialises execution, but two queued jobs would still upload twice, and a
  // duplicate upload cannot be undone.
  if (await hasActiveJob(input.userId, channelId, PUBLISH_JOB)) {
    throw new ConflictError(
      "An upload is already in progress for this channel. Wait for it to finish.",
    );
  }

  const scheduled = input.scheduledFor ?? null;

  const [row] = await db
    .insert(publishJobs)
    .values({
      projectId: project.id,
      userId: input.userId,
      channelId,
      status: scheduled ? "scheduled" : "queued",
      visibility: input.visibility,
      scheduledFor: scheduled,
    })
    .returning({ id: publishJobs.id });

  if (!row) throw new Error("Failed to create publish job");

  /**
   * The project moves to PUBLISHING (or SCHEDULED) *before* the queue push, for
   * the same reason the script and video stages do: if the push fails, the catch
   * below records the failure against a project the user can see. The reverse
   * order could leave a worker uploading for a project still displayed as ready.
   *
   * PUBLISHING here is not a claim that anything is on YouTube. `published_videos`
   * is that claim, and nothing writes it until YouTube answers.
   */
  const target = scheduled ? "SCHEDULED" : "PUBLISHING";
  try {
    await transition(input.userId, project.id, target, {
      stage: "PUBLISH",
      message: scheduled ? "Scheduled for upload" : "Uploading to YouTube",
      meta: { publishJobId: row.id, visibility: input.visibility },
      incrementRetry: project.status === "FAILED",
    });
  } catch (error) {
    await db
      .update(publishJobs)
      .set({
        status: "cancelled",
        error: userMessageOf(error).slice(0, 500),
        errorCode: errorCodeOf(error).slice(0, 64),
        updatedAt: new Date(),
      })
      .where(eq(publishJobs.id, row.id));
    throw error;
  }

  try {
    const job = await enqueue({
      queue: "publish",
      name: PUBLISH_JOB,
      userId: input.userId,
      channelId: project.channelId,
      projectId: project.id,
      stage: "PUBLISH",
      payload: {
        projectId: project.id,
        publishJobId: row.id,
        madeForKids: input.madeForKids ?? null,
      },
      /**
       * One attempt fewer than the pipeline default. Each attempt re-uploads the
       * whole file, so the cost of an optimistic retry is bandwidth and YouTube
       * quota rather than a few seconds of CPU. Two attempts covers the transient
       * failure this is for; a third mostly repeats a permanent one.
       */
      maxAttempts: 2,
      /**
       * A scheduled publish still uploads immediately — as private, with
       * YouTube's `publishAt` set. Delaying the *job* would mean the schedule
       * only holds while Tally is running, and an upload that starts at 18:00
       * does not go live at 18:00 (§19).
       */
      traceId: input.traceId ?? project.traceId,
      statusMessage: "Queued",
    });

    return {
      jobId: job.id,
      publishJobId: row.id,
      status: scheduled ? "scheduled" : "queued",
    };
  } catch (error) {
    await db
      .update(publishJobs)
      .set({
        status: "failed",
        error: "Could not reach the job queue. Please try again.",
        errorCode: "internal_error",
        updatedAt: new Date(),
      })
      .where(eq(publishJobs.id, row.id));

    await transition(input.userId, project.id, "FAILED", {
      stage: "PUBLISH",
      error: {
        code: "internal_error",
        message: "Could not reach the job queue. Please try again.",
        stage: "PUBLISH",
      },
    }).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export interface PublishReadiness {
  ready: boolean;
  /** Sentences naming what is missing, in workflow order. */
  blocked: string[];
}

/**
 * Whether the assets a publish needs actually exist.
 *
 * Read by the route before queueing and by the stage before uploading. The second
 * check is not redundant: minutes pass between them, and §7 requires the stage to
 * fail safely rather than publish the wrong asset if a thumbnail selection was
 * changed or a variant's image went missing in between.
 */
export async function publishReadiness(
  userId: string,
  projectId: string,
): Promise<PublishReadiness> {
  const blocked: string[] = [];

  /**
   * A channel first (Phase 11 §4).
   *
   * Link mode deliberately removes the channel requirement from research and
   * generation — a user can paste any URL and get a finished video with nothing
   * connected. Publishing is where that stops: uploading needs a channel's OAuth
   * grant, and §4 keeps publishing subject to the existing requirement. Reported
   * first because it is the earliest thing to fix, and as a blocker rather than an
   * exception so the UI shows it beside the others instead of erroring the screen.
   *
   * Read with its own scoped query rather than through `getProject`, which throws
   * `ForbiddenError` for a project the caller does not own. Every other read in
   * this function carries `userId` and *reports* what it cannot see, so a foreign
   * caller is told three things are missing rather than being told the project
   * exists — and answering with the same shape for "not yours" and "not ready"
   * is what keeps this endpoint from confirming another tenant's project id.
   */
  const channelRows = await db
    .select({ channelId: projects.channelId })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);

  if (!channelRows[0]?.channelId) {
    blocked.push(
      "This video is not linked to a YouTube channel. Connect a channel to " +
        "publish it — everything up to this point works without one.",
    );
  }

  const video = await renderedVideo(userId, projectId);
  if (!video) {
    blocked.push(
      "This video has not finished rendering, so there is no file to upload. " +
        "Build the video first.",
    );
  }

  const thumbnail = await selectedThumbnail(userId, projectId);
  if (!thumbnail) {
    blocked.push(
      "No thumbnail has been chosen. Pick one of the four concepts before " +
        "publishing — YouTube would otherwise use a frame from the video.",
    );
  }

  const metadata = await publishMetadata(userId, projectId);
  if (!metadata) {
    blocked.push(
      "This video has no title or description yet. Generate its metadata before " +
        "publishing.",
    );
  }

  return { ready: blocked.length === 0, blocked };
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

export interface PublishStageInput {
  userId: string;
  projectId: string;
  publishJobId: string;
  jobId: string;
  /**
   * Overrides the stored `made_for_kids` when the caller passed one. Null means
   * "use the project's metadata", which is the normal case.
   */
  madeForKids?: boolean | null;
  traceId?: string | null;
}

/**
 * A type alias, not an interface, deliberately: `JobHandler` returns
 * `Record<string, unknown> | void`, and only an alias gets the implicit index
 * signature that assignment needs. Same reason the video stages' results are
 * aliases.
 */
export type PublishStageResult = {
  youtubeVideoId: string;
  url: string;
  uploadStatus: string | null;
  privacyStatus: string | null;
  /** False when YouTube accepted the video but rejected the thumbnail. */
  thumbnailSet: boolean;
  /**
   * §29: YouTube's altered/synthetic-content disclosure has no Data API field —
   * it is made in Studio. True means Tally has *not* filed it and the user must.
   */
  disclosureOutstanding: boolean;
};

/**
 * Upload the video, then record that it happened.
 *
 * The order in this function is the §42 guarantee, and it is worth reading as a
 * sequence: resolve the assets → open the stream → upload → *YouTube returns an
 * id* → insert `published_videos` → count the publication → set the thumbnail →
 * transition to PUBLISHED. Nothing before the fourth step writes anything that
 * claims the video is live.
 */
export async function executePublish(
  input: PublishStageInput,
): Promise<PublishStageResult> {
  const startedAt = Date.now();
  const base = {
    userId: input.userId,
    projectId: input.projectId,
    jobId: input.jobId,
    stage: "PUBLISH" as const,
    ...(input.traceId ? { traceId: input.traceId } : {}),
  };

  try {
    const result = await runPublish(input);
    log.info("stage complete", {
      ...base,
      status: "succeeded",
      durationMs: Date.now() - startedAt,
      videoId: result.youtubeVideoId,
    });
    return result;
  } catch (error) {
    log.error("stage failed", {
      ...base,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error,
    });

    const retryable = isAppError(error) && error.retryable;

    await db
      .update(publishJobs)
      .set({
        // A retryable failure keeps the row `publishing`: the UI polls this and
        // "failed" between two attempts of a recovering upload is a lie about a
        // job that is still running.
        status: retryable ? "publishing" : "failed",
        error: userMessageOf(error).slice(0, 500),
        errorCode: errorCodeOf(error).slice(0, 64),
        attempt: sql`${publishJobs.attempt} + 1`,
        ...(retryable ? {} : { completedAt: new Date() }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(publishJobs.id, input.publishJobId),
          eq(publishJobs.userId, input.userId),
        ),
      );

    if (!retryable) {
      await transition(input.userId, input.projectId, "FAILED", {
        stage: "PUBLISH",
        error: {
          code: errorCodeOf(error),
          message: userMessageOf(error),
          stage: "PUBLISH",
        },
      }).catch((transitionError) => {
        log.error("could not record publish failure on project", {
          ...base,
          error: transitionError,
        });
      });
    }

    throw error;
  }
}

async function runPublish(
  input: PublishStageInput,
): Promise<PublishStageResult> {
  /**
   * Idempotency, first thing. A retry after a successful upload whose bookkeeping
   * failed must not upload again — the video is already on the channel, and
   * `published_videos` is the record of it. Returning it finishes the job.
   */
  const already = await publicationFor(input.userId, input.projectId);
  if (already) {
    log.warn("publish already confirmed, reconciling instead of re-uploading", {
      userId: input.userId,
      projectId: input.projectId,
      jobId: input.jobId,
      videoId: already.youtubeVideoId,
    });
    await finalise(input, already, { thumbnailSet: true });
    return {
      youtubeVideoId: already.youtubeVideoId,
      url: already.url,
      uploadStatus: already.uploadStatus,
      privacyStatus: already.privacyStatus,
      thumbnailSet: true,
      disclosureOutstanding: true,
    };
  }

  const job = await loadPublishJob(input.userId, input.publishJobId);
  if (job.projectId !== input.projectId) {
    // The payload's project and the row's project disagree. That is the shape a
    // cross-tenant publish would take, and no retry changes the comparison (§34).
    throw new ForbiddenError("Publish job does not belong to this project.");
  }
  if (job.status === "cancelled") {
    throw new ConflictError("This publish was cancelled.");
  }

  const project = await getProject(input.userId, input.projectId);
  if (project.channelId !== job.channelId) {
    throw new ForbiddenError("Publish job channel does not match the project.");
  }

  /**
   * The channel must belong to this user. `withChannelToken` already scopes its
   * credential read by `userId`, so a foreign channel id cannot yield a token —
   * but checking here produces the honest error rather than a "channel not found"
   * three layers down, and it is the assertion the cross-tenant tests read.
   */
  const channel = await loadChannel(input.userId, job.channelId);

  // A legacy grant with only `youtube.upload` cannot set a thumbnail or edit
  // metadata. Uploading anyway would produce a video with the wrong picture, so
  // the channel is routed back through the existing reconnect flow instead (§8).
  const missing = missingRequiredScopes(channel.grantedScopes ?? "");
  if (missing.length > 0) {
    throw new ReauthRequiredError(
      channel.id,
      "This channel was connected before Tally needed permission to set " +
        "thumbnails and edit video details. Reconnect it to publish.",
    );
  }

  // Re-read the assets rather than trusting the route's check: minutes have
  // passed, and §7 requires failing safely over publishing the wrong asset.
  const video = await renderedVideo(input.userId, input.projectId);
  if (!video) {
    throw new AssetMissingError("the rendered video file for this project");
  }

  const thumbnail = await selectedThumbnail(input.userId, input.projectId);
  if (!thumbnail) {
    throw new AssetMissingError(
      "the selected thumbnail image — choose a thumbnail before publishing",
    );
  }

  const metadata = await publishMetadata(input.userId, input.projectId);
  if (!metadata) {
    throw new AssetMissingError("the video's title and description");
  }

  /**
   * Enter PUBLISHING before a byte moves.
   *
   * Not cosmetic. `PUBLISHED` is reachable only from `PUBLISHING` (§11), and this
   * stage is entered from three different states: `PUBLISHING` for an immediate
   * publish, `SCHEDULED` for a scheduled one, and `FAILED` for a retry. Uploading
   * from either of the latter two and *then* asking for PUBLISHED is an illegal
   * transition — which would leave a video live on YouTube and the project marked
   * FAILED, the §42 lie in its worst direction, and unrecoverable because the retry
   * would find the same illegal edge.
   *
   * `canTransition` allows `from === to`, so this is a no-op on the normal path.
   */
  if (project.status !== "PUBLISHING") {
    await transition(input.userId, input.projectId, "PUBLISHING", {
      stage: "PUBLISH",
      message: "Uploading to YouTube",
      meta: { publishJobId: input.publishJobId },
    });
  }

  await db
    .update(publishJobs)
    .set({ status: "publishing", startedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(publishJobs.id, input.publishJobId),
        eq(publishJobs.userId, input.userId),
      ),
    );

  const bytes = await getObjectBuffer(video.storageKey);
  const thumbnailBytes = await getObjectBuffer(thumbnail.storageKey);

  if (thumbnailBytes.byteLength > MAX_THUMBNAIL_BYTES) {
    throw new ValidationError(
      "The selected thumbnail is larger than YouTube's 2 MB limit. Regenerate " +
        "the thumbnails and choose again.",
    );
  }

  /**
   * A scheduled publish is uploaded private with YouTube's `publishAt`, which is
   * YouTube's own scheduler. The visibility the user chose is what the video
   * becomes at that time — recorded on the row, applied by Google.
   */
  const scheduled = job.scheduledFor;
  const uploadPrivacy: PublishVisibility =
    scheduled && scheduled.getTime() > Date.now() ? "private" : job.visibility;

  const description = composeDescription({
    description: metadata.description,
    chapters: metadata.chapters,
    hashtags: metadata.hashtags,
  });

  const madeForKids = input.madeForKids ?? metadata.madeForKids;

  const uploaded = await withChannelToken(
    input.userId,
    job.channelId,
    (accessToken) =>
      uploadVideo({
        accessToken,
        title: metadata.title,
        description,
        tags: metadata.tags,
        categoryId: metadata.categoryId,
        ...(metadata.defaultLanguage
          ? { language: metadata.defaultLanguage }
          : {}),
        privacyStatus: uploadPrivacy,
        ...(scheduled && uploadPrivacy === "private"
          ? { publishAt: scheduled }
          : {}),
        // A fresh stream per attempt. A Readable is consumed once, so building it
        // inside the callback is what makes `withChannelToken`'s forced-refresh
        // retry able to actually re-send the body.
        body: Readable.from(bytes),
        mimeType: video.mimeType ?? "video/mp4",
        madeForKids,
        onProgress: (bytesUploaded) => {
          void recordUploadProgress(input, bytesUploaded, bytes.byteLength);
        },
      }),
  );

  /**
   * YouTube has confirmed the upload. This insert is the moment the video becomes
   * published as far as Tally is concerned, and everything after it is
   * bookkeeping that must not be able to un-publish it.
   */
  const record = await recordPublication({
    userId: input.userId,
    projectId: input.projectId,
    channelId: job.channelId,
    publishJobId: input.publishJobId,
    youtubeVideoId: uploaded.videoId,
    url: uploaded.url,
    uploadStatus: uploaded.uploadStatus,
    privacyStatus: uploaded.privacyStatus,
    publishedAt: uploaded.publishAt ? null : new Date(),
    scheduledPublishAt: uploaded.publishAt ?? scheduled,
    thumbnailVariantId: thumbnail.variantId,
    titleUsed: metadata.title,
  });

  /**
   * The thumbnail is set after the upload because `thumbnails.set` needs a video
   * id. A failure here does not fail the publish: the video is live, and throwing
   * would send the project to FAILED while YouTube shows it published — exactly
   * the state §42 forbids. It is logged and reported instead.
   */
  let thumbnailSet = false;
  try {
    await withChannelToken(input.userId, job.channelId, (accessToken) =>
      setThumbnail({
        accessToken,
        videoId: uploaded.videoId,
        body: Readable.from(thumbnailBytes),
        mimeType: thumbnail.mimeType ?? "image/jpeg",
      }),
    );
    thumbnailSet = true;
  } catch (error) {
    log.warn("video published but thumbnail could not be set", {
      userId: input.userId,
      projectId: input.projectId,
      jobId: input.jobId,
      videoId: uploaded.videoId,
      errorCode: errorCodeOf(error),
      error,
    });
  }

  await finalise(input, record, { thumbnailSet });

  return {
    youtubeVideoId: uploaded.videoId,
    url: uploaded.url,
    uploadStatus: uploaded.uploadStatus,
    privacyStatus: uploaded.privacyStatus,
    thumbnailSet,
    // Always outstanding: nothing in `videos.insert` files the §29 disclosure.
    disclosureOutstanding: true,
  };
}

/**
 * Close the books on a confirmed publication.
 *
 * Separated from the upload because the reconciliation path — a retry that finds
 * the video already recorded — runs it too. Every write here is idempotent, so
 * running it twice for the same publication is safe.
 */
async function finalise(
  input: PublishStageInput,
  record: PublicationRecord,
  options: { thumbnailSet: boolean },
): Promise<void> {
  await db
    .update(publishJobs)
    .set({
      status: "published",
      uploadProgress: 100,
      error: null,
      errorCode: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(publishJobs.id, input.publishJobId),
        eq(publishJobs.userId, input.userId),
      ),
    );

  await reportProgress(input.jobId, 100, "Published");

  /**
   * PUBLISHED, last. The status is the consequence of the `published_videos` row
   * above, never the other way round — and `canTransition` allows `PUBLISHED →
   * PUBLISHED`, so a reconciling retry re-asserting it is not an error.
   */
  const project = await getProject(input.userId, input.projectId);
  if (project.status !== "PUBLISHED") {
    await transition(input.userId, input.projectId, "PUBLISHED", {
      stage: "PUBLISH",
      message: options.thumbnailSet
        ? "Published to YouTube"
        : "Published to YouTube — the thumbnail could not be set",
      progress: deriveProgress([...COMPLETED_AFTER_PUBLISH]),
      meta: {
        youtubeVideoId: record.youtubeVideoId,
        url: record.url,
        thumbnailSet: options.thumbnailSet,
      },
    });
  }
}

/**
 * Insert the publication, tolerating the row already existing.
 *
 * `onConflictDoNothing` on the unique video id, then a re-read. The conflict is
 * the pathological retry — YouTube accepted the upload, the process died before
 * this insert, the retry uploaded again — and returning the *existing* row means
 * Tally reports one publication for one project instead of two.
 */
async function recordPublication(values: {
  userId: string;
  projectId: string;
  channelId: string;
  publishJobId: string;
  youtubeVideoId: string;
  url: string;
  uploadStatus: string | null;
  privacyStatus: string | null;
  publishedAt: Date | null;
  scheduledPublishAt: Date | null;
  thumbnailVariantId: string | null;
  titleUsed: string;
}): Promise<PublicationRecord> {
  const [inserted] = await db
    .insert(publishedVideos)
    .values({
      projectId: values.projectId,
      userId: values.userId,
      channelId: values.channelId,
      publishJobId: values.publishJobId,
      youtubeVideoId: values.youtubeVideoId,
      url: values.url,
      uploadStatus: values.uploadStatus,
      privacyStatus: values.privacyStatus,
      publishedAt: values.publishedAt,
      scheduledPublishAt: values.scheduledPublishAt,
      thumbnailVariantId: values.thumbnailVariantId,
      titleUsed: values.titleUsed.slice(0, 200),
    })
    .onConflictDoNothing({ target: publishedVideos.youtubeVideoId })
    .returning(PUBLICATION_COLUMNS);

  if (inserted) {
    // The monthly count moves with the insert, not with the upload: a duplicate
    // upload that lost the race above must not be counted twice.
    await db
      .insert(usageCounters)
      .values({
        userId: values.userId,
        period: currentPeriod(),
        videosPublished: 1,
      })
      .onConflictDoUpdate({
        target: [usageCounters.userId, usageCounters.period],
        set: {
          videosPublished: sql`${usageCounters.videosPublished} + 1`,
          updatedAt: new Date(),
        },
      });

    return inserted;
  }

  const existing = await publicationByVideoId(
    values.userId,
    values.youtubeVideoId,
  );
  if (existing) return existing;

  /**
   * The unique index rejected the insert and the row is not visible to this user.
   * That means the video id belongs to *another tenant's* publication — the only
   * way one YouTube video id maps to two Tally users is a shared channel, which
   * is a real state (two people connecting the same channel) and not one to
   * silently absorb.
   */
  throw new ConflictError(
    "This video id is already recorded against another Tally account. The same " +
      "YouTube channel appears to be connected twice.",
  );
}

/**
 * Byte progress → the three places the UI reads it from.
 *
 * Best-effort by design: a failed progress write must not fail an upload that is
 * succeeding. Throttled to whole percents because `onUploadProgress` fires per
 * chunk and a 200 MB file would otherwise issue thousands of UPDATEs.
 */
const lastPercent = new Map<string, number>();

async function recordUploadProgress(
  input: PublishStageInput,
  bytesUploaded: number,
  totalBytes: number,
): Promise<void> {
  if (totalBytes <= 0) return;
  const percent = Math.max(
    0,
    Math.min(99, Math.floor((bytesUploaded / totalBytes) * 100)),
  );
  if ((lastPercent.get(input.publishJobId) ?? -1) >= percent) return;
  lastPercent.set(input.publishJobId, percent);

  try {
    await db
      .update(publishJobs)
      .set({ uploadProgress: percent, updatedAt: new Date() })
      .where(
        and(
          eq(publishJobs.id, input.publishJobId),
          eq(publishJobs.userId, input.userId),
        ),
      );
    await reportProgress(input.jobId, percent, `Uploading ${percent}%`);
  } catch (error) {
    log.debug("could not record upload progress", {
      jobId: input.jobId,
      error,
    });
  }
}

/** Drop a finished job's throttle entry so a long-lived worker does not grow. */
export function forgetUploadProgress(publishJobId: string): void {
  lastPercent.delete(publishJobId);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const PUBLICATION_COLUMNS = {
  id: publishedVideos.id,
  projectId: publishedVideos.projectId,
  youtubeVideoId: publishedVideos.youtubeVideoId,
  url: publishedVideos.url,
  uploadStatus: publishedVideos.uploadStatus,
  privacyStatus: publishedVideos.privacyStatus,
  publishedAt: publishedVideos.publishedAt,
  scheduledPublishAt: publishedVideos.scheduledPublishAt,
} as const;

export interface PublicationRecord {
  id: string;
  projectId: string;
  youtubeVideoId: string;
  url: string;
  uploadStatus: string | null;
  privacyStatus: string | null;
  publishedAt: Date | null;
  scheduledPublishAt: Date | null;
}

/** The project's publication, or null. Scoped to the owner (§34). */
export async function publicationFor(
  userId: string,
  projectId: string,
): Promise<PublicationRecord | null> {
  const rows = await db
    .select(PUBLICATION_COLUMNS)
    .from(publishedVideos)
    .where(
      and(
        eq(publishedVideos.projectId, projectId),
        eq(publishedVideos.userId, userId),
      ),
    )
    .orderBy(desc(publishedVideos.createdAt))
    .limit(1);

  return rows[0] ?? null;
}

async function publicationByVideoId(
  userId: string,
  youtubeVideoId: string,
): Promise<PublicationRecord | null> {
  const rows = await db
    .select(PUBLICATION_COLUMNS)
    .from(publishedVideos)
    .where(
      and(
        eq(publishedVideos.youtubeVideoId, youtubeVideoId),
        eq(publishedVideos.userId, userId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

interface PublishJobRecord {
  id: string;
  projectId: string;
  channelId: string;
  status: string;
  visibility: PublishVisibility;
  scheduledFor: Date | null;
}

async function loadPublishJob(
  userId: string,
  publishJobId: string,
): Promise<PublishJobRecord> {
  const rows = await db
    .select({
      id: publishJobs.id,
      projectId: publishJobs.projectId,
      channelId: publishJobs.channelId,
      status: publishJobs.status,
      visibility: publishJobs.visibility,
      scheduledFor: publishJobs.scheduledFor,
    })
    .from(publishJobs)
    .where(
      and(eq(publishJobs.id, publishJobId), eq(publishJobs.userId, userId)),
    )
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError("That publish job does not exist.");
  return row;
}

async function loadChannel(
  userId: string,
  channelId: string,
): Promise<{ id: string; grantedScopes: string | null }> {
  const rows = await db
    .select({ id: channels.id, grantedScopes: channels.grantedScopes })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
    .limit(1);

  const row = rows[0];
  // 403 rather than 404, matching `requireChannelAccess`: which channel ids exist
  // is not information a foreign id should reveal.
  if (!row) throw new ForbiddenError("Channel not found or not accessible.");
  return row;
}

interface RenderedVideo {
  storageKey: string;
  mimeType: string | null;
  bytes: number | null;
  durationMs: number | null;
}

/**
 * The file a publish would upload: the newest succeeded render's output asset.
 *
 * Joined through `assets` on `output_asset_id` with both tenant predicates, and
 * requiring a non-null `storage_key` — a render row can be `succeeded` while its
 * asset row has no key if the upload to object storage failed, and uploading
 * nothing is worse than refusing to.
 */
async function renderedVideo(
  userId: string,
  projectId: string,
): Promise<RenderedVideo | null> {
  const rows = await db
    .select({
      storageKey: assets.storageKey,
      mimeType: assets.mimeType,
      bytes: assets.bytes,
      durationMs: renders.durationMs,
    })
    .from(renders)
    .innerJoin(assets, eq(assets.id, renders.outputAssetId))
    .where(
      and(
        eq(renders.projectId, projectId),
        eq(renders.userId, userId),
        eq(renders.status, "succeeded"),
        eq(assets.userId, userId),
      ),
    )
    .orderBy(desc(renders.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row || !row.storageKey) return null;
  return {
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    bytes: row.bytes,
    durationMs: row.durationMs,
  };
}

interface SelectedThumbnail {
  variantId: string;
  storageKey: string;
  mimeType: string | null;
}

/**
 * The chosen thumbnail's composited image.
 *
 * Phase 6a decides what is chosen (`thumbnails.selected_variant_id`) and produces
 * the image (`thumbnail_variants.image_asset_id`); this only reads them. Both
 * tenant predicates plus the project predicate, so a variant id from another
 * project of the same user cannot resolve here either (§34).
 */
async function selectedThumbnail(
  userId: string,
  projectId: string,
): Promise<SelectedThumbnail | null> {
  const rows = await db
    .select({
      variantId: thumbnailVariants.id,
      storageKey: assets.storageKey,
      mimeType: assets.mimeType,
    })
    .from(thumbnails)
    .innerJoin(
      thumbnailVariants,
      eq(thumbnailVariants.id, thumbnails.selectedVariantId),
    )
    .innerJoin(assets, eq(assets.id, thumbnailVariants.imageAssetId))
    .where(
      and(
        eq(thumbnails.projectId, projectId),
        eq(thumbnails.userId, userId),
        eq(thumbnailVariants.userId, userId),
        eq(assets.userId, userId),
      ),
    )
    .orderBy(desc(thumbnails.updatedAt))
    .limit(1);

  const row = rows[0];
  if (!row || !row.storageKey) return null;
  return {
    variantId: row.variantId,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
  };
}

interface PublishMetadata {
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  chapters: Array<{ startMs: number; label: string }>;
  categoryId: string;
  defaultLanguage: string | null;
  madeForKids: boolean;
}

/**
 * The metadata as YouTube will receive it.
 *
 * Read from the table rather than through `metadata/service.getMetadata`, which
 * does not project `made_for_kids` — a field `videos.insert` requires and which
 * defaults to a legal declaration, so guessing it is not an option.
 */
async function publishMetadata(
  userId: string,
  projectId: string,
): Promise<PublishMetadata | null> {
  const rows = await db
    .select({
      title: videoMetadata.title,
      description: videoMetadata.description,
      tags: videoMetadata.tags,
      hashtags: videoMetadata.hashtags,
      chapters: videoMetadata.chapters,
      categoryId: videoMetadata.categoryId,
      defaultLanguage: videoMetadata.defaultLanguage,
      madeForKids: videoMetadata.madeForKids,
    })
    .from(videoMetadata)
    .where(
      and(
        eq(videoMetadata.projectId, projectId),
        eq(videoMetadata.userId, userId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row || row.title.trim().length === 0) return null;
  return row;
}

/**
 * Publications for a set of projects — the channels page's "published" column.
 *
 * Kept here rather than in the dashboard loader so the §42 rule that a
 * publication row is the source of truth has exactly one reader shape.
 */
export async function publicationsFor(
  userId: string,
  projectIds: readonly string[],
): Promise<Map<string, PublicationRecord>> {
  if (projectIds.length === 0) return new Map();
  const rows = await db
    .select(PUBLICATION_COLUMNS)
    .from(publishedVideos)
    .where(
      and(
        eq(publishedVideos.userId, userId),
        inArray(publishedVideos.projectId, [...projectIds]),
      ),
    );
  return new Map(rows.map((row) => [row.projectId, row]));
}

/** The watch URL for a video id. Re-exported so callers need one import. */
export { watchUrl };

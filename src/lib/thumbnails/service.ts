/**
 * Thumbnail generation (§16, §20, §42).
 *
 * The THUMBNAIL stage of the pipeline, and the only stage a user starts by hand.
 * It runs on the queue rather than in the request for a reason the metadata stage
 * does not share: this makes an AI call, four stock-library searches and four
 * ffmpeg composites. That is tens of seconds at best, so the request would time
 * out and the studio screen — which already polls while the project is
 * `THUMBNAIL_GENERATING` — would have nothing to poll.
 *
 * Two decisions the rest of the file follows from:
 *
 *  - **A variant row exists before its image does.** The four concepts are written
 *    as soon as the model returns them, then each is composited in turn. A variant
 *    whose composite failed keeps `image_asset_id = null`, and the studio says
 *    "Image not rendered" against it (§42) rather than showing a styled
 *    substitute. Three usable concepts out of four is a better outcome for the
 *    user than a failed job with nothing to show.
 *  - **A generation replaces the previous one.** Regenerate deletes the old
 *    `thumbnails` row and its variants, because the UI shows exactly four cards
 *    and accumulating sets would silently change what "the four concepts" means.
 *    The old rows' assets are left in storage — a lifecycle rule reclaims them,
 *    and deleting an object a publish job might still be uploading is worse than
 *    paying for it.
 *
 * The stage never advances the project past `READY_TO_PUBLISH`. Selecting a
 * variant does that, because a thumbnail nobody chose is not a thumbnail the user
 * approved.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  assets,
  brandKits,
  channelSettings,
  channels,
  renders,
  thumbnailVariants,
  thumbnails,
  videoMetadata,
} from "@/lib/db/schema";
import {
  AssetMissingError,
  ConflictError,
  NotFoundError,
  ValidationError,
  errorCodeOf,
  isAppError,
  userMessageOf,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { generateJson } from "@/lib/providers/ai";
import { acquireVisual } from "@/lib/providers/visuals";
import {
  deriveProgress,
  getProject,
  transition,
} from "@/lib/projects/service";
import { enqueue, hasActiveJob, reportProgress } from "@/lib/queue/jobs";
import { getObjectBuffer, putObject, storageKey } from "@/lib/storage";
import { activeVersion } from "@/lib/metadata/service";
import {
  composite,
  isCompositorConfigured,
} from "@/lib/thumbnails/compositor";
import {
  THUMBNAIL_JSON_SCHEMA,
  THUMBNAIL_SYSTEM_PROMPT,
  ThumbnailConceptsSchema,
  VARIANT_COUNT,
  buildThumbnailPrompt,
  type ThumbnailConcept,
  type ThumbnailEmotion,
} from "@/lib/thumbnails/prompt";
import type { PlanTier } from "@/lib/plans";

const log = logger.child({ component: "thumbnail" });

/** Job name. Registered in `worker/registry.ts`. */
export const THUMBNAIL_JOB = "thumbnail-generate";

/**
 * Stages complete once thumbnails are done.
 *
 * QUALITY_CHECK is included because a thumbnail is only generated for a rendered
 * video, and the render stage is what produces one. METADATA is not: it is a
 * separate action the user may not have taken.
 */
const COMPLETED_AFTER_THUMBNAIL = [
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
] as const;

// ---------------------------------------------------------------------------
// Request side
// ---------------------------------------------------------------------------

export interface StartThumbnailsInput {
  userId: string;
  projectId: string;
  tier: PlanTier;
  traceId?: string | null;
}

export interface StartThumbnailsResult {
  jobId: string;
  /** How many concepts the job will produce, so the UI can size its skeleton. */
  variantCount: number;
}

/**
 * Queue a thumbnail generation. Runs inside the request; does no provider work.
 *
 * A finished render is required. That is the state machine's design rather than a
 * choice made here — `THUMBNAIL_GENERATING` is only reachable from `VIDEO_READY`,
 * `READY_TO_PUBLISH` and `FAILED` (§20) — and it matches the prototype's stage
 * order, where Thumbnail is stage 04 and Video is stage 03. Checking it here means
 * a user gets a sentence explaining what to do next instead of a state-machine
 * error from three layers down.
 */
export async function startThumbnails(
  input: StartThumbnailsInput,
): Promise<StartThumbnailsResult> {
  const project = await getProject(input.userId, input.projectId);

  if (project.status === "PUBLISHED") {
    throw new ConflictError(
      "This video has already been published. Its thumbnail is live on YouTube; " +
        "change it from YouTube Studio, or start a new video.",
    );
  }

  const script = await activeVersion(input.userId, input.projectId);
  if (!script) {
    throw new NotFoundError(
      "There is no script yet. Thumbnail concepts are written from the finished " +
        "script, so that the headline promises something the video delivers.",
    );
  }

  // A successful render, not merely a hopeful status. A project can be FAILED
  // with no video at all, and generating thumbnails for one would produce four
  // images for something that does not exist.
  if (!(await hasFinishedRender(input.userId, input.projectId))) {
    throw new ValidationError(
      "This video has not finished rendering yet. Thumbnails are designed for a " +
        "finished video, so build the video first and Tally will design four " +
        "concepts for it.",
    );
  }

  // One generation per project at a time. A second would spend a second AI call
  // and four more stock downloads to overwrite the first one's rows. Scoped to the
  // project when there is no channel (Phase 11 §4) — `hasActiveJob` needs one or
  // the other, and a link-mode project needs this guard just as much.
  if (
    await hasActiveJob(
      input.userId,
      project.channelId ?? null,
      THUMBNAIL_JOB,
      project.channelId ? undefined : project.id,
    )
  ) {
    throw new ConflictError(
      "Thumbnails are already being designed for this video. Wait for that to " +
        "finish.",
    );
  }

  /**
   * Where the project goes if this generation fails, decided before the
   * transition. A thumbnail generation is not the project's main line of work:
   * failing one must not leave a finished video looking broken. A project that
   * arrived here from FAILED goes to VIDEO_READY, which is what the successful
   * render it has actually means.
   */
  const previousStatus: ReturnToStatus =
    project.status === "READY_TO_PUBLISH" ? "READY_TO_PUBLISH" : "VIDEO_READY";

  await transition(input.userId, project.id, "THUMBNAIL_GENERATING", {
    stage: "THUMBNAIL",
    message: "Designing thumbnails",
    incrementRetry: project.status === "FAILED",
  });

  try {
    const job = await enqueue({
      queue: "pipeline",
      name: THUMBNAIL_JOB,
      userId: input.userId,
      channelId: project.channelId,
      projectId: project.id,
      stage: "THUMBNAIL",
      payload: {
        projectId: project.id,
        tier: input.tier,
        returnTo: previousStatus,
      },
      priority: queuePriorityFor(input.tier),
      traceId: input.traceId ?? project.traceId,
      statusMessage: "Queued",
    });

    return { jobId: job.id, variantCount: VARIANT_COUNT };
  } catch (error) {
    await transition(input.userId, project.id, "FAILED", {
      stage: "THUMBNAIL",
      error: {
        code: "internal_error",
        message: "Could not reach the job queue. Please try again.",
        stage: "THUMBNAIL",
      },
    }).catch(() => {});
    throw error;
  }
}

/** Studio and Scale jump the queue ahead of Starter (§23). */
function queuePriorityFor(tier: PlanTier): number {
  if (tier === "scale") return 1;
  if (tier === "studio") return 3;
  return 5;
}

/**
 * Whether a generation can start, from the provider configuration alone.
 *
 * The server-side twin of the Thumbnail tab's `canGenerate`, so a client that
 * ignored the configuration banner cannot start a job that is guaranteed to fail
 * (§34).
 */
export interface ThumbnailReadiness {
  ready: boolean;
  blocked: string[];
}

export function thumbnailReadiness(): ThumbnailReadiness {
  const blocked: string[] = [];
  // The compositor covers both ffmpeg and the font file. AI and visuals are
  // checked by the route through the capability registry, the same way the video
  // build route checks voice and visuals.
  if (!isCompositorConfigured()) blocked.push("thumbnail");
  return { ready: blocked.length === 0, blocked };
}

/**
 * Whether this project has a render that actually finished.
 *
 * The status alone is not enough: a project can be `FAILED` having never rendered,
 * and `THUMBNAIL_GENERATING` is reachable from `FAILED`. Asking the `renders` table
 * asks about the video file rather than about a label (§45).
 */
async function hasFinishedRender(
  userId: string,
  projectId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: renders.id })
    .from(renders)
    .where(
      and(
        eq(renders.projectId, projectId),
        eq(renders.userId, userId),
        eq(renders.status, "succeeded"),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

/**
 * Where a generation leaves the project when it does not succeed.
 *
 * Narrow on purpose. These are the only two states a thumbnail job can legally
 * have come from, so a payload carrying anything else is a payload from a
 * different build — and defaulting is safer than trusting it.
 */
export type ReturnToStatus = "VIDEO_READY" | "READY_TO_PUBLISH";

export function parseReturnTo(value: unknown): ReturnToStatus {
  return value === "READY_TO_PUBLISH" ? "READY_TO_PUBLISH" : "VIDEO_READY";
}

export interface ThumbnailStageInput {
  userId: string;
  projectId: string;
  jobId: string;
  tier: PlanTier;
  /** Status to restore if this generation fails. */
  returnTo: ReturnToStatus;
  traceId?: string | null;
}

/**
 * A type alias rather than an interface, deliberately: the worker's `JobHandler`
 * returns `Record<string, unknown>` because the result is stored as JSON on the
 * `jobs` row, and only object *type aliases* get the implicit index signature that
 * makes them assignable to it. An interface here would not typecheck.
 */
export type ThumbnailStageResult = {
  thumbnailId: string;
  variantCount: number;
  /** Variants whose image actually composited. Never equal to `variantCount` by assumption. */
  renderedCount: number;
};

/**
 * Generate four concepts and composite an image for each.
 *
 * The AI call and the row writes happen first and atomically enough that a
 * failure during compositing still leaves the user with four concepts they can
 * read. Then each variant is composited independently: one failing background
 * download does not cost the other three their images.
 */
export async function executeThumbnails(
  input: ThumbnailStageInput,
): Promise<ThumbnailStageResult> {
  const startedAt = Date.now();

  try {
    const result = await generateAndComposite(input);

    log.info("stage complete", {
      userId: input.userId,
      projectId: input.projectId,
      jobId: input.jobId,
      stage: "THUMBNAIL",
      status: "succeeded",
      durationMs: Date.now() - startedAt,
      variantCount: result.variantCount,
      renderedCount: result.renderedCount,
    });

    return result;
  } catch (error) {
    log.error("stage failed", {
      userId: input.userId,
      projectId: input.projectId,
      jobId: input.jobId,
      stage: "THUMBNAIL",
      status: "failed",
      durationMs: Date.now() - startedAt,
      error,
    });

    // A retryable error leaves the project in THUMBNAIL_GENERATING: the worker
    // will try again, and flashing FAILED between attempts makes a recoverable
    // blip look like a dead build (§37).
    if (!isAppError(error) || !error.retryable) {
      await recordFailure(input, error);
    }

    throw error;
  }
}

/**
 * Put the project back where it came from, with the error on the thumbnail row.
 *
 * Deliberately **not** `FAILED`. A rendered video whose thumbnail generation
 * failed is still a rendered video, and FAILED would tell the user their video
 * broke — which is wrong, and would also bury the render's own state behind an
 * unrelated error message. The failure is not hidden: it is recorded on
 * `thumbnails.error`, which the thumbnail screen reads, and on the `jobs` row.
 *
 * `transition` writes a `project_events` entry either way, so the attempt remains
 * in the audit trail even though the status returns to where it started (§20).
 */
async function recordFailure(
  input: ThumbnailStageInput,
  error: unknown,
): Promise<void> {
  const message = userMessageOf(error);

  await db
    .update(thumbnails)
    .set({ status: "failed", error: message, updatedAt: new Date() })
    .where(
      and(
        eq(thumbnails.projectId, input.projectId),
        eq(thumbnails.userId, input.userId),
      ),
    )
    .catch(() => {});

  try {
    await transition(input.userId, input.projectId, input.returnTo, {
      stage: "THUMBNAIL",
      message: `Thumbnails failed: ${message}`,
      meta: { errorCode: errorCodeOf(error) },
    });
  } catch (transitionError) {
    log.error("could not record thumbnail failure on project", {
      projectId: input.projectId,
      error: transitionError,
    });
  }
}

async function generateAndComposite(
  input: ThumbnailStageInput,
): Promise<ThumbnailStageResult> {
  const project = await getProject(input.userId, input.projectId);

  const script = await activeVersion(input.userId, input.projectId);
  if (!script) {
    throw new NotFoundError(
      "The script this project's thumbnails were to be written from is gone.",
    );
  }

  const brief = await loadBrief(input, project.channelId, script);

  await reportProgress(input.jobId, 10, "Writing concepts");

  const { concepts } = await generateJson({
    system: THUMBNAIL_SYSTEM_PROMPT,
    prompt: buildThumbnailPrompt(brief),
    schema: ThumbnailConceptsSchema,
    jsonSchema: THUMBNAIL_JSON_SCHEMA,
    maxTokens: 3_000,
    usage: {
      operation: "thumbnail.concepts",
      userId: input.userId,
      projectId: input.projectId,
      jobId: input.jobId,
      traceId: input.traceId ?? null,
    },
  });

  const thumbnailId = await replaceVariants(input, concepts);

  await reportProgress(input.jobId, 30, "Compositing images");

  let renderedCount = 0;

  // Sequential, not parallel. Each composite spawns an ffmpeg process and
  // downloads a stock asset; four at once on a worker already running other
  // pipeline jobs is how a render slot starves. Four short jobs in series is
  // seconds, and the progress the user sees advances as each one lands.
  for (const [index, concept] of concepts.entries()) {
    const ok = await compositeVariant(input, thumbnailId, index, concept);
    if (ok) renderedCount += 1;

    await reportProgress(
      input.jobId,
      30 + Math.round(((index + 1) / concepts.length) * 65),
      `Composited ${index + 1} of ${concepts.length}`,
    );
  }

  if (renderedCount === 0) {
    /**
     * Every composite failed. The concepts are stored and readable, but a
     * thumbnail screen with four "Image not rendered" cards is a failure, and
     * calling the job successful would be the §42 lie in its purest form.
     *
     * `AssetMissingError` is not retryable, which is the right semantics here for
     * the same reason it is in `acquireVisual`: an automatic retry re-runs the AI
     * call and then searches the stock library with the *same* four sets of terms,
     * so a search that matched nothing matches nothing again — at the price of a
     * second model call. The project therefore returns to `returnTo` with the
     * reason on the thumbnail row, and the user's Regenerate button is the retry.
     */
    throw new AssetMissingError(
      "a composited image for any of the four thumbnail concepts",
    );
  }

  await db
    .update(thumbnails)
    .set({ status: "succeeded", error: null, updatedAt: new Date() })
    .where(
      and(eq(thumbnails.id, thumbnailId), eq(thumbnails.userId, input.userId)),
    );

  /**
   * READY_TO_PUBLISH, because the video is rendered and now has thumbnails to
   * choose from. The user still has to *choose* one — `selectVariant` is what sets
   * `selected_variant_id`, and the publish stage uploads nothing without it — so
   * this status means "everything needed exists", not "a thumbnail was picked".
   */
  await transition(input.userId, input.projectId, "READY_TO_PUBLISH", {
    stage: "THUMBNAIL",
    message:
      renderedCount === concepts.length
        ? "Thumbnails ready"
        : `${renderedCount} of ${concepts.length} thumbnails ready`,
    progress: deriveProgress([...COMPLETED_AFTER_THUMBNAIL]),
    meta: { thumbnailId, renderedCount },
  });

  return { thumbnailId, variantCount: concepts.length, renderedCount };
}

/**
 * Replace this project's thumbnail set with the new concepts.
 *
 * In one transaction: the studio polls every four seconds, and a window where the
 * old variants are deleted and the new ones are not yet written would render an
 * empty grid on a project that has thumbnails.
 */
async function replaceVariants(
  input: ThumbnailStageInput,
  concepts: ThumbnailConcept[],
): Promise<string> {
  return db.transaction(async (tx) => {
    await tx
      .delete(thumbnails)
      .where(
        and(
          eq(thumbnails.projectId, input.projectId),
          eq(thumbnails.userId, input.userId),
        ),
      );

    const [row] = await tx
      .insert(thumbnails)
      .values({
        projectId: input.projectId,
        userId: input.userId,
        status: "running",
      })
      .returning({ id: thumbnails.id });

    if (!row) throw new AssetMissingError("a thumbnail record");

    await tx.insert(thumbnailVariants).values(
      concepts.map((concept, index) => ({
        thumbnailId: row.id,
        userId: input.userId,
        index,
        headline: concept.headline.slice(0, 80),
        subline: concept.subline?.slice(0, 120) ?? null,
        concept: concept.concept,
        emotion: concept.emotion,
      })),
    );

    return row.id;
  });
}

/**
 * Acquire a background and composite one variant.
 *
 * Returns false rather than throwing when this single variant cannot be produced.
 * The alternative — failing the whole job on one bad stock search — throws away
 * three good thumbnails to punish one, and the row is left honest with
 * `image_asset_id = null` either way.
 */
async function compositeVariant(
  input: ThumbnailStageInput,
  thumbnailId: string,
  index: number,
  concept: ThumbnailConcept,
): Promise<boolean> {
  try {
    const background = await backgroundFor(input, index, concept);

    const image = await composite({
      background: background.bytes,
      backgroundExtension: background.extension,
      headline: concept.headline,
      subline: concept.subline,
      emotion: concept.emotion as ThumbnailEmotion,
    });

    const key = storageKey({
      userId: input.userId,
      folder: "thumbnail",
      projectId: input.projectId,
      extension: image.extension,
    });

    // Storage first, then the row — the same order and the same reason as the
    // video pipeline's `storeAsset`: an orphaned object is cheap, a row pointing
    // at nothing breaks a publish.
    const put = await putObject({
      key,
      body: image.bytes,
      contentType: image.mimeType,
    });

    const [asset] = await db
      .insert(assets)
      .values({
        userId: input.userId,
        projectId: input.projectId,
        kind: "thumbnail",
        storageKey: put.key,
        mimeType: image.mimeType,
        bytes: put.bytes,
        width: image.width,
        height: image.height,
        checksumSha256: put.checksumSha256,
        provider: "ffmpeg",
        license: background.license,
        attribution: background.attribution,
        authorName: background.authorName,
        sourceUrl: background.sourceUrl,
        meta: {
          headline: concept.headline,
          emotion: concept.emotion,
          backgroundProvider: background.provider,
          // The faces actually used, so a thumbnail that looks wrong can be
          // traced to the font that drew it rather than guessed at.
          headlineFont: image.fonts.headline,
          bodyFont: image.fonts.body,
        },
      })
      .returning({ id: assets.id });

    if (!asset) throw new AssetMissingError("a thumbnail asset record");

    await db
      .update(thumbnailVariants)
      .set({
        imageAssetId: asset.id,
        ...(background.assetId ? { backgroundAssetId: background.assetId } : {}),
      })
      .where(
        and(
          eq(thumbnailVariants.thumbnailId, thumbnailId),
          eq(thumbnailVariants.index, index),
          eq(thumbnailVariants.userId, input.userId),
        ),
      );

    return true;
  } catch (error) {
    log.warn("thumbnail variant could not be composited", {
      userId: input.userId,
      projectId: input.projectId,
      jobId: input.jobId,
      stage: "THUMBNAIL",
      variantIndex: index,
      error,
    });
    return false;
  }
}

interface Background {
  bytes: Buffer;
  extension: string;
  provider: string;
  license: string | null;
  attribution: string | null;
  authorName: string | null;
  sourceUrl: string | null;
  /** Set when the frame came from an existing asset row rather than a fresh fetch. */
  assetId: string | null;
}

/**
 * The background frame for a concept.
 *
 * Prefers a frame from the project's own render when one exists: a thumbnail
 * showing the actual video is more honest than one showing a stock photograph of
 * something similar, and it costs no provider call. Falls back to the stock
 * library, searched with the concept's own terms.
 *
 * Only the first variant gets the render frame. Four cards showing the same poster
 * with different text is not four concepts.
 */
async function backgroundFor(
  input: ThumbnailStageInput,
  index: number,
  concept: ThumbnailConcept,
): Promise<Background> {
  if (index === 0) {
    const poster = await posterFrame(input.userId, input.projectId);
    if (poster) return poster;
  }

  const visual = await acquireVisual(
    {
      // Not a real scene; the field labels the accounting row and the log line.
      sceneIndex: index,
      visualPrompt: `${concept.headline} — ${concept.concept}`,
      searchTerms: concept.searchTerms,
      // A still is wanted, so ask for the shortest thing the provider will give.
      durationMs: 1_000,
    },
    {
      usage: {
        operation: "thumbnail.background",
        userId: input.userId,
        projectId: input.projectId,
        jobId: input.jobId,
        traceId: input.traceId ?? null,
      },
    },
  );

  return {
    bytes: visual.bytes,
    extension: visual.extension,
    provider: visual.provider,
    license: visual.license,
    attribution: visual.attribution,
    authorName: visual.authorName,
    sourceUrl: visual.sourceUrl,
    assetId: null,
  };
}

/**
 * A frame from the project's finished render, if one has been extracted.
 *
 * Currently this returns null for every project built by Tally: `renders`
 * declares `poster_asset_id`, but no stage writes it — the local ffmpeg renderer
 * produces an MP4 and nothing else. The read is here rather than deferred because
 * it is the branch that decides *where a background comes from*, and a hosted
 * render provider that returns a poster URL (§32 keeps that door open) would
 * otherwise need this function written under a deadline. It is exercised by the
 * integration test against a poster row inserted directly.
 *
 * Nothing here extracts a frame on demand: pulling a whole MP4 out of storage to
 * grab one frame inside a thumbnail job would make a fast job slow, and the stock
 * path is a perfectly good background.
 */
async function posterFrame(
  userId: string,
  projectId: string,
): Promise<Background | null> {
  const rows = await db
    .select({
      assetId: assets.id,
      storageKey: assets.storageKey,
      mimeType: assets.mimeType,
      license: assets.license,
      attribution: assets.attribution,
      authorName: assets.authorName,
    })
    .from(renders)
    .innerJoin(assets, eq(assets.id, renders.posterAssetId))
    .where(
      and(
        eq(renders.projectId, projectId),
        eq(renders.userId, userId),
        eq(renders.status, "succeeded"),
      ),
    )
    .orderBy(desc(renders.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row?.storageKey) return null;

  try {
    const bytes = await getObjectBuffer(row.storageKey);
    return {
      bytes,
      extension: row.mimeType?.includes("png") ? "png" : "jpg",
      provider: "render-poster",
      license: row.license,
      attribution: row.attribution,
      authorName: row.authorName,
      // No source URL: the frame came out of the user's own render, so there is no
      // third-party page to credit.
      sourceUrl: null,
      assetId: row.assetId,
    };
  } catch (error) {
    // The row exists but the object does not. Not fatal — the stock path is right
    // behind it — but worth a line, because it means storage and the database
    // disagree.
    log.warn("render poster could not be read", { projectId, error });
    return null;
  }
}

/** Everything the concept prompt needs, in one pass. */
/**
 * The thumbnail brief.
 *
 * `channelId` is nullable since Phase 11 (§4): the three channel lookups supply
 * brand face and audience, which a link-mode project does not have yet. The script
 * and the metadata title — the parts the headline is actually written from — do not
 * depend on a channel, so the brief is still complete without one.
 */
async function loadBrief(
  input: ThumbnailStageInput,
  channelId: string | null,
  script: NonNullable<Awaited<ReturnType<typeof activeVersion>>>,
): Promise<Parameters<typeof buildThumbnailPrompt>[0]> {
  const [channelRows, settingsRows, brandRows, metadataRows, previous] =
    await Promise.all([
      channelId
        ? db
            .select({ title: channels.title })
            .from(channels)
            .where(
              and(eq(channels.id, channelId), eq(channels.userId, input.userId)),
            )
            .limit(1)
        : [],
      channelId
        ? db
            .select({
              niche: channelSettings.niche,
              targetAudience: channelSettings.targetAudience,
              contentLanguage: channelSettings.contentLanguage,
              thumbnailStyle: channelSettings.thumbnailStyle,
            })
            .from(channelSettings)
            .where(
              and(
                eq(channelSettings.channelId, channelId),
                eq(channelSettings.userId, input.userId),
              ),
            )
            .limit(1)
        : [],
      channelId
        ? db
            .select({
              brandName: brandKits.brandName,
              primaryColor: brandKits.primaryColor,
            })
            .from(brandKits)
            .where(
              and(
                eq(brandKits.channelId, channelId),
                eq(brandKits.userId, input.userId),
              ),
            )
            .limit(1)
        : [],
      db
        .select({ title: videoMetadata.title })
        .from(videoMetadata)
        .where(
          and(
            eq(videoMetadata.projectId, input.projectId),
            eq(videoMetadata.userId, input.userId),
          ),
        )
        .limit(1),
      previousHeadlines(input.userId, input.projectId),
    ]);

  const settings = settingsRows[0];

  return {
    channelTitle: channelRows[0]?.title ?? null,
    niche: settings?.niche ?? null,
    targetAudience: settings?.targetAudience ?? null,
    contentLanguage: settings?.contentLanguage ?? "en-US",
    scriptTitle: script.title,
    publishedTitle: metadataRows[0]?.title ?? null,
    hook: script.hook,
    sectionHeadings: script.sections.map((s) => s.heading),
    conclusion: script.conclusion,
    brandName: brandRows[0]?.brandName ?? null,
    primaryColor: brandRows[0]?.primaryColor ?? null,
    thumbnailStyle: settings?.thumbnailStyle ?? null,
    previousHeadlines: previous,
  };
}

/** Headlines from the generation being replaced, so a regenerate is actually new. */
async function previousHeadlines(
  userId: string,
  projectId: string,
): Promise<string[]> {
  const rows = await db
    .select({ headline: thumbnailVariants.headline })
    .from(thumbnails)
    .innerJoin(
      thumbnailVariants,
      eq(thumbnailVariants.thumbnailId, thumbnails.id),
    )
    .where(
      and(eq(thumbnails.projectId, projectId), eq(thumbnails.userId, userId)),
    )
    .orderBy(asc(thumbnailVariants.index))
    .limit(VARIANT_COUNT * 2);

  return rows.map((r) => r.headline);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface SelectVariantInput {
  userId: string;
  projectId: string;
  variantId: string;
}

export interface SelectVariantResult {
  thumbnailId: string;
  variantId: string;
  /** The project status after selecting, so the caller need not re-read it. */
  status: string;
}

/**
 * Choose the variant that will be uploaded with the video.
 *
 * Refuses a variant with no composited image. The publish stage uploads
 * `image_asset_id`, so selecting a concept whose picture does not exist would
 * produce a video published with no thumbnail and a UI that said one was chosen
 * (§42).
 */
export async function selectVariant(
  input: SelectVariantInput,
): Promise<SelectVariantResult> {
  const project = await getProject(input.userId, input.projectId);

  const rows = await db
    .select({
      variantId: thumbnailVariants.id,
      thumbnailId: thumbnails.id,
      imageAssetId: thumbnailVariants.imageAssetId,
      headline: thumbnailVariants.headline,
    })
    .from(thumbnailVariants)
    .innerJoin(thumbnails, eq(thumbnails.id, thumbnailVariants.thumbnailId))
    .where(
      and(
        eq(thumbnailVariants.id, input.variantId),
        // Both predicates: the variant's own tenant column and the parent's
        // project. A variant id from another user's project must not resolve
        // here, and a variant belonging to a *different project of the same user*
        // must not either (§34).
        eq(thumbnailVariants.userId, input.userId),
        eq(thumbnails.projectId, input.projectId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new NotFoundError("That thumbnail variant does not exist.");
  }

  if (!row.imageAssetId) {
    throw new ValidationError(
      `“${row.headline}” has no composited image, so it cannot be uploaded. ` +
        "Regenerate the thumbnails to try again.",
    );
  }

  await db
    .update(thumbnails)
    .set({ selectedVariantId: row.variantId, updatedAt: new Date() })
    .where(
      and(
        eq(thumbnails.id, row.thumbnailId),
        eq(thumbnails.userId, input.userId),
      ),
    );

  /**
   * A rendered video with a chosen thumbnail is ready to publish. Selecting does
   * not move a project that has no video yet — the status would be a claim about
   * work that has not happened.
   */
  let status = project.status;
  if (project.status === "VIDEO_READY") {
    const updated = await transition(
      input.userId,
      input.projectId,
      "READY_TO_PUBLISH",
      {
        stage: "THUMBNAIL",
        message: "Thumbnail selected",
        progress: deriveProgress([...COMPLETED_AFTER_THUMBNAIL]),
      },
    );
    status = updated.status;
  }

  log.info("thumbnail selected", {
    userId: input.userId,
    projectId: input.projectId,
    stage: "THUMBNAIL",
    variantId: row.variantId,
  });

  return { thumbnailId: row.thumbnailId, variantId: row.variantId, status };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface ThumbnailVariantRecord {
  id: string;
  index: number;
  headline: string;
  subline: string | null;
  concept: string | null;
  emotion: string | null;
  imageAssetId: string | null;
  ctr: number | null;
}

export interface ThumbnailRecord {
  id: string;
  projectId: string;
  status: string;
  selectedVariantId: string | null;
  error: string | null;
  variants: ThumbnailVariantRecord[];
}

/** A project's thumbnail set, or null when none has been generated. */
export async function getThumbnails(
  userId: string,
  projectId: string,
): Promise<ThumbnailRecord | null> {
  const rows = await db
    .select({
      id: thumbnails.id,
      projectId: thumbnails.projectId,
      status: thumbnails.status,
      selectedVariantId: thumbnails.selectedVariantId,
      error: thumbnails.error,
    })
    .from(thumbnails)
    .where(
      and(eq(thumbnails.projectId, projectId), eq(thumbnails.userId, userId)),
    )
    .orderBy(desc(thumbnails.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const variants = await db
    .select({
      id: thumbnailVariants.id,
      index: thumbnailVariants.index,
      headline: thumbnailVariants.headline,
      subline: thumbnailVariants.subline,
      concept: thumbnailVariants.concept,
      emotion: thumbnailVariants.emotion,
      imageAssetId: thumbnailVariants.imageAssetId,
      ctr: thumbnailVariants.ctr,
    })
    .from(thumbnailVariants)
    .where(
      and(
        eq(thumbnailVariants.thumbnailId, row.id),
        eq(thumbnailVariants.userId, userId),
      ),
    )
    .orderBy(asc(thumbnailVariants.index));

  return { ...row, variants };
}

/**
 * Storage keys for a set of variant image assets, tenant-scoped.
 *
 * Used by the publish stage to fetch the chosen image. Kept here so the tenant
 * predicate lives next to everything else that reads these rows.
 */
export async function variantImageKeys(
  userId: string,
  assetIds: readonly string[],
): Promise<Map<string, string>> {
  if (assetIds.length === 0) return new Map();

  const rows = await db
    .select({ id: assets.id, storageKey: assets.storageKey })
    .from(assets)
    .where(and(inArray(assets.id, [...assetIds]), eq(assets.userId, userId)));

  return new Map(
    rows
      .filter((r): r is { id: string; storageKey: string } => r.storageKey !== null)
      .map((r) => [r.id, r.storageKey]),
  );
}

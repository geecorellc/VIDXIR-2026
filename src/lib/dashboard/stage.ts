/**
 * Data loader shared by the five stage screens (Research → Publish).
 *
 * The prototype held one `project` object in React state and passed it down to
 * every tab. §45 turns that inside out: the project and everything hanging off it
 * live in Postgres, and each stage screen loads the slice it needs on the server.
 * Closing the browser mid-render loses nothing.
 *
 * Every query below carries `userId` in its predicate — tenant isolation is a
 * property of the query rather than of remembering to check (§34).
 */
import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  channels,
  jobs,
  publishJobs,
  publishedVideos,
  qualityChecks,
  renders,
  scenes,
  scriptVersions,
  scripts,
  thumbnailVariants,
  thumbnails,
  videoMetadata,
} from "@/lib/db/schema";
import { getActiveProject, getProject, type ProjectRecord } from "@/lib/projects/service";
import type { PipelineStage } from "@/lib/stages";
import type { ProjectStatus } from "@/lib/projects/state-machine";

export interface ChannelSummary {
  id: string;
  title: string;
  handle: string | null;
  thumbnailUrl: string | null;
  subscriberCount: number | null;
  videoCount: number | null;
  statsRefreshedAt: Date | null;
  reauthRequiredAt: Date | null;
  connectedAt: Date;
}

/** Connected channels, newest first. Disconnected channels are excluded. */
export async function listChannelSummaries(
  userId: string,
): Promise<ChannelSummary[]> {
  return db
    .select({
      id: channels.id,
      title: channels.title,
      handle: channels.handle,
      thumbnailUrl: channels.thumbnailUrl,
      subscriberCount: channels.subscriberCount,
      videoCount: channels.videoCount,
      statsRefreshedAt: channels.statsRefreshedAt,
      reauthRequiredAt: channels.reauthRequiredAt,
      connectedAt: channels.connectedAt,
    })
    .from(channels)
    .where(and(eq(channels.userId, userId), isNull(channels.disconnectedAt)))
    .orderBy(desc(channels.connectedAt));
}

export interface ScriptView {
  scriptId: string;
  versionId: string;
  version: number;
  title: string;
  titleIdeas: string[];
  hook: string;
  introduction: string | null;
  sections: Array<{
    heading: string;
    body: string;
    talkingPoints?: string[];
    transition?: string;
  }>;
  conclusion: string | null;
  cta: string | null;
  storyStructure: string | null;
  estimatedDurationSeconds: number | null;
  wordCount: number | null;
  source: string;
  provider: string | null;
  model: string | null;
  approvedAt: Date | null;
  createdAt: Date;
}

export interface SceneView {
  index: number;
  label: string | null;
  narration: string;
  startMs: number | null;
  durationMs: number | null;
}

export interface RenderView {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "blocked_not_configured";
  progress: number;
  provider: string;
  durationMs: number | null;
  error: string | null;
  outputAssetId: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface ThumbnailVariantView {
  id: string;
  index: number;
  headline: string;
  subline: string | null;
  concept: string | null;
  emotion: string | null;
  imageAssetId: string | null;
  ctr: number | null;
}

export interface MetadataView {
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  chapters: Array<{ startMs: number; label: string }>;
  editedByUser: boolean;
}

export interface PublishView {
  id: string;
  status: "queued" | "scheduled" | "publishing" | "published" | "failed" | "cancelled";
  visibility: "public" | "unlisted" | "private";
  scheduledFor: Date | null;
  uploadProgress: number;
  error: string | null;
  createdAt: Date;
}

export interface PublishedView {
  youtubeVideoId: string;
  url: string;
  privacyStatus: string | null;
  uploadStatus: string | null;
  publishedAt: Date | null;
}

export interface StageJobView {
  stage: PipelineStage | null;
  name: string;
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "blocked_not_configured";
  progress: number;
  statusMessage: string | null;
  error: string | null;
  /**
   * `AppError` code behind `error`. Needed alongside `status` because
   * `blocked_not_configured` covers a missing credential and an exhausted
   * provider balance, which are different things to tell the operator.
   */
  errorCode: string | null;
  notConfiguredProvider: string | null;
  updatedAt: Date;
}

export interface QualityCheckView {
  verdict: string;
  findings: Array<{
    code: string;
    severity: "info" | "warn" | "fail";
    message: string;
    detail?: string;
  }>;
  createdAt: Date;
}

export interface StageContext {
  channels: ChannelSummary[];
  project: ProjectRecord | null;
  channelTitle: string | null;
  script: ScriptView | null;
  scriptVersionCount: number;
  scenes: SceneView[];
  render: RenderView | null;
  thumbnailVariants: ThumbnailVariantView[];
  selectedThumbnailVariantId: string | null;
  metadata: MetadataView | null;
  publishJob: PublishView | null;
  published: PublishedView | null;
  stageJobs: StageJobView[];
  qualityCheck: QualityCheckView | null;
}

/**
 * Load the stage screens' context.
 *
 * `projectId` comes from `?project=` when the user is looking at a specific
 * video; otherwise the most recently touched unpublished project is used, which
 * is the persisted equivalent of the prototype's single in-memory project.
 */
export async function getStageContext(
  userId: string,
  projectId?: string,
): Promise<StageContext> {
  const channelList = await listChannelSummaries(userId);

  const project = projectId
    ? await getProject(userId, projectId)
    : await getActiveProject(userId);

  const empty: StageContext = {
    channels: channelList,
    project: null,
    channelTitle: null,
    script: null,
    scriptVersionCount: 0,
    scenes: [],
    render: null,
    thumbnailVariants: [],
    selectedThumbnailVariantId: null,
    metadata: null,
    publishJob: null,
    published: null,
    stageJobs: [],
    qualityCheck: null,
  };

  if (!project) return empty;

  const [
    scriptRows,
    sceneRows,
    renderRows,
    thumbRows,
    metadataRows,
    publishRows,
    publishedRows,
    jobRows,
    qualityRows,
  ] = await Promise.all([
    db
      .select({
        scriptId: scripts.id,
        approvedAt: scripts.approvedAt,
        activeVersionId: scripts.activeVersionId,
      })
      .from(scripts)
      .where(and(eq(scripts.projectId, project.id), eq(scripts.userId, userId)))
      .limit(1),

    db
      .select({
        index: scenes.index,
        label: scenes.label,
        narration: scenes.narration,
        startMs: scenes.startMs,
        durationMs: scenes.durationMs,
      })
      .from(scenes)
      .where(and(eq(scenes.projectId, project.id), eq(scenes.userId, userId)))
      .orderBy(scenes.index),

    db
      .select({
        id: renders.id,
        status: renders.status,
        progress: renders.progress,
        provider: renders.provider,
        durationMs: renders.durationMs,
        error: renders.error,
        outputAssetId: renders.outputAssetId,
        createdAt: renders.createdAt,
        completedAt: renders.completedAt,
      })
      .from(renders)
      .where(and(eq(renders.projectId, project.id), eq(renders.userId, userId)))
      .orderBy(desc(renders.createdAt))
      .limit(1),

    db
      .select({
        thumbnailId: thumbnails.id,
        selectedVariantId: thumbnails.selectedVariantId,
      })
      .from(thumbnails)
      .where(
        and(eq(thumbnails.projectId, project.id), eq(thumbnails.userId, userId)),
      )
      .orderBy(desc(thumbnails.createdAt))
      .limit(1),

    db
      .select({
        title: videoMetadata.title,
        description: videoMetadata.description,
        tags: videoMetadata.tags,
        hashtags: videoMetadata.hashtags,
        chapters: videoMetadata.chapters,
        editedByUser: videoMetadata.editedByUser,
      })
      .from(videoMetadata)
      .where(
        and(
          eq(videoMetadata.projectId, project.id),
          eq(videoMetadata.userId, userId),
        ),
      )
      .limit(1),

    db
      .select({
        id: publishJobs.id,
        status: publishJobs.status,
        visibility: publishJobs.visibility,
        scheduledFor: publishJobs.scheduledFor,
        uploadProgress: publishJobs.uploadProgress,
        error: publishJobs.error,
        createdAt: publishJobs.createdAt,
      })
      .from(publishJobs)
      .where(
        and(
          eq(publishJobs.projectId, project.id),
          eq(publishJobs.userId, userId),
        ),
      )
      .orderBy(desc(publishJobs.createdAt))
      .limit(1),

    db
      .select({
        youtubeVideoId: publishedVideos.youtubeVideoId,
        url: publishedVideos.url,
        privacyStatus: publishedVideos.privacyStatus,
        uploadStatus: publishedVideos.uploadStatus,
        publishedAt: publishedVideos.publishedAt,
      })
      .from(publishedVideos)
      .where(
        and(
          eq(publishedVideos.projectId, project.id),
          eq(publishedVideos.userId, userId),
        ),
      )
      .orderBy(desc(publishedVideos.createdAt))
      .limit(1),

    db
      .select({
        stage: jobs.stage,
        name: jobs.name,
        status: jobs.status,
        progress: jobs.progress,
        statusMessage: jobs.statusMessage,
        error: jobs.error,
        errorCode: jobs.errorCode,
        notConfiguredProvider: jobs.notConfiguredProvider,
        updatedAt: jobs.updatedAt,
      })
      .from(jobs)
      .where(and(eq(jobs.projectId, project.id), eq(jobs.userId, userId)))
      .orderBy(desc(jobs.updatedAt))
      .limit(40),

    db
      .select({
        verdict: qualityChecks.verdict,
        findings: qualityChecks.findings,
        createdAt: qualityChecks.createdAt,
      })
      .from(qualityChecks)
      .where(
        and(
          eq(qualityChecks.projectId, project.id),
          eq(qualityChecks.userId, userId),
        ),
      )
      .orderBy(desc(qualityChecks.createdAt))
      .limit(1),
  ]);

  const scriptRow = scriptRows[0];
  let script: ScriptView | null = null;
  let scriptVersionCount = 0;

  if (scriptRow) {
    const versions = await db
      .select({
        id: scriptVersions.id,
        version: scriptVersions.version,
        title: scriptVersions.title,
        titleIdeas: scriptVersions.titleIdeas,
        hook: scriptVersions.hook,
        introduction: scriptVersions.introduction,
        sections: scriptVersions.sections,
        conclusion: scriptVersions.conclusion,
        cta: scriptVersions.cta,
        storyStructure: scriptVersions.storyStructure,
        estimatedDurationSeconds: scriptVersions.estimatedDurationSeconds,
        wordCount: scriptVersions.wordCount,
        source: scriptVersions.source,
        provider: scriptVersions.provider,
        model: scriptVersions.model,
        createdAt: scriptVersions.createdAt,
      })
      .from(scriptVersions)
      .where(
        and(
          eq(scriptVersions.scriptId, scriptRow.scriptId),
          eq(scriptVersions.userId, userId),
        ),
      )
      .orderBy(desc(scriptVersions.version));

    scriptVersionCount = versions.length;
    // Prefer the version the script row points at; fall back to the newest, so
    // a half-written activeVersionId never blanks the screen.
    const active =
      versions.find((v) => v.id === scriptRow.activeVersionId) ?? versions[0];

    if (active) {
      script = {
        scriptId: scriptRow.scriptId,
        versionId: active.id,
        version: active.version,
        title: active.title,
        titleIdeas: active.titleIdeas,
        hook: active.hook,
        introduction: active.introduction,
        sections: active.sections,
        conclusion: active.conclusion,
        cta: active.cta,
        storyStructure: active.storyStructure,
        estimatedDurationSeconds: active.estimatedDurationSeconds,
        wordCount: active.wordCount,
        source: active.source,
        provider: active.provider,
        model: active.model,
        approvedAt: scriptRow.approvedAt,
        createdAt: active.createdAt,
      };
    }
  }

  const thumbRow = thumbRows[0];
  const variants: ThumbnailVariantView[] = thumbRow
    ? await db
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
            eq(thumbnailVariants.thumbnailId, thumbRow.thumbnailId),
            eq(thumbnailVariants.userId, userId),
          ),
        )
        .orderBy(thumbnailVariants.index)
    : [];

  const channelTitle =
    channelList.find((c) => c.id === project.channelId)?.title ?? null;

  return {
    channels: channelList,
    project,
    channelTitle,
    script,
    scriptVersionCount,
    scenes: sceneRows,
    render: renderRows[0] ?? null,
    thumbnailVariants: variants,
    selectedThumbnailVariantId: thumbRow?.selectedVariantId ?? null,
    metadata: metadataRows[0] ?? null,
    publishJob: publishRows[0] ?? null,
    published: publishedRows[0] ?? null,
    stageJobs: jobRows,
    qualityCheck: qualityRows[0] ?? null,
  };
}

/** Latest job row for a given stage, for the §38 per-stage status display. */
export function jobForStage(
  stageJobs: StageJobView[],
  stage: PipelineStage,
): StageJobView | null {
  return stageJobs.find((j) => j.stage === stage) ?? null;
}

/** Statuses at or beyond which a video file is expected to exist. */
export function hasRenderedVideo(status: ProjectStatus): boolean {
  return (
    status === "VIDEO_READY" ||
    status === "THUMBNAIL_GENERATING" ||
    status === "READY_TO_PUBLISH" ||
    status === "SCHEDULED" ||
    status === "PUBLISHING" ||
    status === "PUBLISHED"
  );
}

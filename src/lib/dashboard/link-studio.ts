/**
 * Channel-less studio screen data (Phase 11 §5, §6, §7, §18; §1C).
 *
 * The counterpart of `dashboard/research.ts` for the two entry paths that have no
 * channel. That module is scoped by channel in every predicate —
 * `eq(researchRuns.channelId, channelId)` — which is correct for channel mode and
 * unusable here, because neither a link-mode nor a description-mode run has a
 * channel at all (§4, §1C). So this is a second *loader*, not a second pipeline: it
 * reads the same `research_runs`, `research_results` and `ideas` tables, keyed by the
 * project instead.
 *
 * Named for link mode because that is what it was written for. It serves both
 * channel-less paths rather than being copied for the second one, for the same reason
 * `/api/projects/link-status` does: the question the two screens ask is identical, and
 * only the key onto the run differs.
 *
 * Everything the screen shows is persisted. §18 requires progress to come from
 * Vidxir AI's own job records, and §42 forbids inventing what has not happened, so a
 * run that is still queued yields empty result and angle lists rather than
 * placeholders — the caller renders "researching", not fabricated rows.
 */
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { ideas, projects, researchResults, researchRuns } from "@/lib/db/schema";
import { getActiveProjectJobs, type JobView } from "@/lib/queue/jobs";
import type { ProjectOrigin, ProjectRecord } from "@/lib/projects/service";
import { getProject } from "@/lib/projects/service";
import { channelLessRunKeys } from "@/lib/research/run-key";

/**
 * The source video, read back out of the stored analysis (§5).
 *
 * `research_runs.source_analysis` is a `jsonb` column, so every field arrives as
 * `unknown` and is narrowed rather than cast. A field the analysis did not carry
 * stays null: §5's "handle incomplete metadata" means the screen says a figure is
 * unavailable, never that it is zero.
 */
export interface SourceView {
  videoId: string;
  url: string | null;
  title: string | null;
  channelTitle: string | null;
  publishedAt: Date | null;
  durationSeconds: number | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  viewsPerHour: number | null;
  engagementRate: number | null;
  /** Display only. The image is never downloaded or re-encoded (§22). */
  thumbnailUrl: string | null;
  categoryTitle: string | null;
  tags: string[];
  topics: string[];
  niche: string | null;
  /** `owner_only` | `none` | `unknown` — never "available" (§5). */
  transcript: string | null;
  /** Metadata YouTube did not return, so the UI can say which parts are thin. */
  missingFields: string[];
}

/** One proposed angle: §7's title + hook + why-this-angle + trend signal. */
export interface AngleView {
  id: string;
  title: string;
  hook: string | null;
  angle: string | null;
  rationale: string | null;
  trendSignal: string | null;
  topic: string | null;
  targetKeywords: string[];
  vidxirScore: number | null;
  state: string;
}

/** One researched video, as evidence behind the angles. Metadata only (§22). */
export interface TrendView {
  id: string;
  title: string;
  url: string | null;
  channelTitle: string | null;
  viewCount: number | null;
  viewsPerHour: number | null;
  topic: string | null;
}

export interface LinkRunView {
  id: string;
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "blocked_not_configured";
  niche: string | null;
  keywords: string[];
  sources: string[];
  /**
   * What the user said they wanted to make, for a description-mode run (§1C).
   *
   * Null in link mode. Read back from the run row rather than from the project title,
   * which `configureProject` overwrites with the chosen angle — this is the only place
   * the user's own words survive verbatim.
   */
  description: string | null;
  error: string | null;
  errorCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface LinkStudioData {
  project: ProjectRecord;
  run: LinkRunView | null;
  source: SourceView | null;
  trends: TrendView[];
  angles: AngleView[];
  /** The angle already attached to this project, if the user has chosen one. */
  selectedAngleId: string | null;
  /**
   * The project's own live jobs, newest first (§18).
   *
   * From the `jobs` table via `getActiveProjectJobs` — the channel-less equivalent
   * of what the Research screen polls. Empty when nothing is running.
   */
  activeJobs: JobView[];
}

/**
 * Load one channel-less project's screen.
 *
 * `getProject` throws `ForbiddenError` for a project that is not the caller's, so
 * ownership is established before any of the reads below run — and each of those
 * still carries `userId` in its predicate anyway (§34).
 */
export async function getLinkStudioData(
  userId: string,
  projectId: string,
): Promise<LinkStudioData> {
  const project = await getProject(userId, projectId);

  /**
   * The run this project is waiting on.
   *
   * Keyed through `channelLessRunKeys`, the same shared helper
   * `/api/projects/link-status` uses, so the polled status and the rendered page can
   * never disagree about which run they mean. The keys are tried in order, and every
   * one of them is restricted to this user's channel-less runs here, so none can pick
   * up a trending-mode run belonging to one of their channels.
   */
  let runRow:
    | {
        id: string;
        status: LinkRunView["status"];
        niche: string | null;
        keywords: string[];
        sources: string[];
        description: string | null;
        sourceAnalysis: Record<string, unknown> | null;
        sourceTitle: string | null;
        sourceChannelTitle: string | null;
        sourceVideoId: string | null;
        error: string | null;
        errorCode: string | null;
        createdAt: Date;
        completedAt: Date | null;
      }
    | undefined;

  for (const runKey of channelLessRunKeys(projectId, project.sourceVideoId)) {
    const runRows = await db
      .select({
        id: researchRuns.id,
        status: researchRuns.status,
        niche: researchRuns.niche,
        keywords: researchRuns.keywords,
        sources: researchRuns.sources,
        description: researchRuns.description,
        sourceAnalysis: researchRuns.sourceAnalysis,
        sourceTitle: researchRuns.sourceTitle,
        sourceChannelTitle: researchRuns.sourceChannelTitle,
        sourceVideoId: researchRuns.sourceVideoId,
        error: researchRuns.error,
        errorCode: researchRuns.errorCode,
        createdAt: researchRuns.createdAt,
        completedAt: researchRuns.completedAt,
      })
      .from(researchRuns)
      .where(
        and(
          eq(researchRuns.userId, userId),
          runKey,
          isNull(researchRuns.channelId),
        ),
      )
      .orderBy(desc(researchRuns.createdAt))
      .limit(1);

    runRow = runRows[0];
    if (runRow) break;
  }

  const [resultRows, angleRows, activeJobs] = await Promise.all([
    runRow
      ? db
          .select({
            id: researchResults.id,
            title: researchResults.title,
            url: researchResults.url,
            channelTitle: researchResults.channelTitle,
            viewCount: researchResults.viewCount,
            viewsPerHour: researchResults.viewsPerHour,
            topic: researchResults.topic,
          })
          .from(researchResults)
          .where(
            and(
              eq(researchResults.runId, runRow.id),
              eq(researchResults.userId, userId),
            ),
          )
          .orderBy(desc(researchResults.viewsPerHour))
          .limit(12)
      : Promise.resolve([]),

    runRow
      ? db
          .select({
            id: ideas.id,
            title: ideas.title,
            hook: ideas.hook,
            angle: ideas.angle,
            rationale: ideas.rationale,
            trendSignal: ideas.trendSignal,
            topic: ideas.topic,
            targetKeywords: ideas.targetKeywords,
            vidxirScore: ideas.vidxirScore,
            state: ideas.state,
          })
          .from(ideas)
          .where(
            and(
              eq(ideas.runId, runRow.id),
              eq(ideas.userId, userId),
              ne(ideas.state, "rejected"),
            ),
          )
          .orderBy(desc(ideas.vidxirScore))
          .limit(12)
      : Promise.resolve([]),

    getActiveProjectJobs(userId, project.id),
  ]);

  return {
    project,
    run: runRow
      ? {
          id: runRow.id,
          status: runRow.status,
          niche: runRow.niche,
          keywords: runRow.keywords,
          sources: runRow.sources,
          description: runRow.description,
          error: runRow.error,
          errorCode: runRow.errorCode,
          createdAt: runRow.createdAt,
          completedAt: runRow.completedAt,
        }
      : null,
    /**
     * The source video, only where it was actually read.
     *
     * A description-mode run has no source at all, and `readSource` on its null
     * analysis would produce a `SourceView` whose every field is null — a card
     * reading "not reported" about a video that does not exist (§42).
     *
     * A video id is not enough to make that card worth rendering, which is the
     * correction here. `projects.source_video_id` is written the moment a link is
     * pasted, whereas the analysis is written later by the worker, so a run that was
     * cancelled or failed before it read the video leaves an id with nothing behind
     * it. The card then rendered its own last resort — the bare eleven-character
     * video id as the headline, "not reported" under every figure — which reads as
     * though Vidxir AI analysed the video and understood nothing about it. The truthful
     * answer at that point is that there is no analysis yet, and the panel's empty
     * state already says exactly that.
     *
     * So the test is the metadata, not the id: an analysis, or one of the denormalised
     * title columns the same worker step writes. Any of those means a real read
     * happened and every "not reported" beside it is a fact about the video rather
     * than an artefact of when the run stopped.
     */
    source:
      runRow &&
      (runRow.sourceVideoId ?? project.sourceVideoId) &&
      (runRow.sourceAnalysis !== null ||
        runRow.sourceTitle !== null ||
        runRow.sourceChannelTitle !== null)
        ? readSource(
            runRow.sourceVideoId ?? project.sourceVideoId ?? "",
            runRow.sourceAnalysis,
            runRow.sourceTitle,
            runRow.sourceChannelTitle,
          )
        : null,
    trends: resultRows.map((row) => ({
      id: row.id,
      title: row.title,
      url: row.url,
      channelTitle: row.channelTitle,
      // `numeric` arrives as a string because view counts exceed 2^31.
      viewCount: row.viewCount === null ? null : Number(row.viewCount),
      viewsPerHour: row.viewsPerHour,
      topic: row.topic,
    })),
    angles: angleRows,
    selectedAngleId: project.ideaId,
    activeJobs,
  };
}

/**
 * The most recent project started from one of the given origins, for a screen's
 * default view when the URL names no project.
 *
 * Matched on `origin` rather than on "has a sourceVideoId": origin records how the
 * project was started, which is the question being asked, and a future channel-mode
 * feature could legitimately reference a source video too. Each screen passes its own
 * origins, so the link screen never opens on a described idea and the description
 * screen never opens on a pasted link.
 *
 * `PUBLISHED` is excluded because the default view is "what am I working on".
 */
export async function latestLinkProjectId(
  userId: string,
  origins: readonly ProjectOrigin[] = ["youtube_link"],
): Promise<string | null> {
  // An empty list would compile to a predicate that matches nothing, which reads as
  // "no project in progress" — a caller asking about no origins is a bug, not a user
  // with nothing in flight.
  if (origins.length === 0) return null;

  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.userId, userId),
        inArray(projects.origin, [...origins]),
        ne(projects.status, "PUBLISHED"),
      ),
    )
    .orderBy(desc(projects.updatedAt))
    .limit(1);

  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// jsonb narrowing
// ---------------------------------------------------------------------------

/**
 * Read the stored analysis into a typed view.
 *
 * Every field is narrowed by type rather than cast, because `sourceAnalysis` is a
 * `jsonb` column written by `toStoredAnalysis` — and a row written by an older
 * version of that function is a real possibility. A field that is missing or of
 * the wrong shape becomes null, which the UI renders as "not reported"; the
 * alternative, a cast, would put `undefined` on screen or throw.
 */
function readSource(
  videoId: string,
  stored: Record<string, unknown> | null,
  fallbackTitle: string | null,
  fallbackChannelTitle: string | null,
): SourceView {
  const raw = stored ?? {};

  return {
    videoId: str(raw["videoId"]) ?? videoId,
    url: str(raw["url"]),
    title: str(raw["title"]) ?? fallbackTitle,
    channelTitle: str(raw["channelTitle"]) ?? fallbackChannelTitle,
    publishedAt: date(raw["publishedAt"]),
    durationSeconds: num(raw["durationSeconds"]),
    viewCount: num(raw["viewCount"]),
    likeCount: num(raw["likeCount"]),
    commentCount: num(raw["commentCount"]),
    viewsPerHour: num(raw["viewsPerHour"]),
    engagementRate: num(raw["engagementRate"]),
    thumbnailUrl: str(raw["thumbnailUrl"]),
    categoryTitle: str(raw["categoryTitle"]),
    tags: strings(raw["tags"]),
    topics: strings(raw["topics"]),
    niche: str(raw["niche"]),
    transcript: str(raw["transcript"]),
    missingFields: strings(raw["missingFields"]),
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function date(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * "Create from YouTube" screen data (Phase 11 §5, §6, §7, §18).
 *
 * The link-mode counterpart of `dashboard/research.ts`. That module is scoped by
 * channel in every predicate — `eq(researchRuns.channelId, channelId)` — which is
 * correct for channel mode and unusable here, because a link-mode run has no
 * channel at all (§4). So this is a second *loader*, not a second pipeline: it
 * reads the same `research_runs`, `research_results` and `ideas` tables, keyed by
 * the project the pasted link created instead.
 *
 * Everything the screen shows is persisted. §18 requires progress to come from
 * Tally's own job records, and §42 forbids inventing what has not happened, so a
 * run that is still queued yields empty result and angle lists rather than
 * placeholders — the caller renders "researching", not fabricated rows.
 */
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { ideas, projects, researchResults, researchRuns } from "@/lib/db/schema";
import { getActiveProjectJobs, type JobView } from "@/lib/queue/jobs";
import type { ProjectRecord } from "@/lib/projects/service";
import { getProject } from "@/lib/projects/service";

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
  tallyScore: number | null;
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
 * Load one link-mode project's screen.
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

  // The run is found through the source video rather than through a foreign key:
  // `research_runs` has no `projectId` column, and adding one would be a schema
  // change to express something the two rows already agree on. Restricted to
  // channel-less runs so a channel-mode run for the same video cannot be picked up.
  const runRows = project.sourceVideoId
    ? await db
        .select({
          id: researchRuns.id,
          status: researchRuns.status,
          niche: researchRuns.niche,
          keywords: researchRuns.keywords,
          sources: researchRuns.sources,
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
            eq(researchRuns.sourceVideoId, project.sourceVideoId),
            isNull(researchRuns.channelId),
          ),
        )
        .orderBy(desc(researchRuns.createdAt))
        .limit(1)
    : [];

  const runRow = runRows[0];

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
            tallyScore: ideas.tallyScore,
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
          .orderBy(desc(ideas.tallyScore))
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
          error: runRow.error,
          errorCode: runRow.errorCode,
          createdAt: runRow.createdAt,
          completedAt: runRow.completedAt,
        }
      : null,
    source: runRow
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
 * The most recent link-mode project, for the screen's default view.
 *
 * `origin = 'youtube_link'` rather than "has a sourceVideoId": origin records how
 * the project was started, which is the question being asked, and a future
 * channel-mode feature could legitimately reference a source video too.
 */
export async function latestLinkProjectId(
  userId: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.userId, userId),
        eq(projects.origin, "youtube_link"),
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

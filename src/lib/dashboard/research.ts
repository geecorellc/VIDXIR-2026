/**
 * Research screen data (§7, §8).
 *
 * The prototype's Research tab read three module-level constants: `trending`,
 * `searchDemand`, `competitors` and `ideaVault`. All four are replaced here by
 * reads of the persisted research tables. §42 forbids shipping the static arrays
 * as though they were live signals, so when no run has completed the page shows a
 * "run research" state instead of numbers.
 */
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { ideas, researchResults, researchRuns } from "@/lib/db/schema";

export interface TrendingRow {
  id: string;
  title: string;
  url: string | null;
  channelTitle: string | null;
  viewCount: number | null;
  viewsPerHour: number | null;
  topic: string | null;
}

export interface CompetitorRow {
  channelTitle: string;
  videoCount: number;
  totalViews: number;
}

export interface IdeaRow {
  id: string;
  title: string;
  angle: string | null;
  rationale: string | null;
  topic: string | null;
  vidxirScore: number | null;
  scores: {
    trend: number | null;
    opportunity: number | null;
    competition: number | null;
    audienceFit: number | null;
    velocity: number | null;
    freshness: number | null;
  };
  state: string;
  createdAt: Date;
}

export interface RunSummary {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "blocked_not_configured";
  niche: string | null;
  sources: string[];
  demandSeries: Array<{ label: string; value: number }> | null;
  error: string | null;
  /** `AppError` code behind `error`, so the UI can name the right remedy. */
  errorCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface ResearchData {
  run: RunSummary | null;
  trending: TrendingRow[];
  competitors: CompetitorRow[];
  ideas: IdeaRow[];
  /** The idea already attached to the active project, if any. */
  selectedIdeaId: string | null;
}

export async function getResearchData(
  userId: string,
  channelId: string,
  selectedIdeaId: string | null,
): Promise<ResearchData> {
  // Most recent run of any status: a failed or blocked run must be visible, not
  // hidden behind an "up to date" screen (§30).
  const runRows = await db
    .select({
      id: researchRuns.id,
      status: researchRuns.status,
      niche: researchRuns.niche,
      sources: researchRuns.sources,
      demandSeries: researchRuns.demandSeries,
      error: researchRuns.error,
      errorCode: researchRuns.errorCode,
      createdAt: researchRuns.createdAt,
      completedAt: researchRuns.completedAt,
    })
    .from(researchRuns)
    .where(
      and(eq(researchRuns.userId, userId), eq(researchRuns.channelId, channelId)),
    )
    .orderBy(desc(researchRuns.createdAt))
    .limit(1);

  const run = runRows[0] ?? null;

  const [resultRows, ideaRows] = await Promise.all([
    run
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
              eq(researchResults.runId, run.id),
              eq(researchResults.userId, userId),
            ),
          )
          .orderBy(desc(researchResults.viewsPerHour))
          .limit(60)
      : Promise.resolve([]),

    // The idea vault spans runs: a saved idea stays available after the run that
    // produced it has been superseded.
    db
      .select({
        id: ideas.id,
        title: ideas.title,
        angle: ideas.angle,
        rationale: ideas.rationale,
        topic: ideas.topic,
        vidxirScore: ideas.vidxirScore,
        trendScore: ideas.trendScore,
        opportunityScore: ideas.opportunityScore,
        competitionScore: ideas.competitionScore,
        audienceFitScore: ideas.audienceFitScore,
        velocityScore: ideas.velocityScore,
        freshnessScore: ideas.freshnessScore,
        state: ideas.state,
        createdAt: ideas.createdAt,
      })
      .from(ideas)
      .where(
        and(
          eq(ideas.userId, userId),
          eq(ideas.channelId, channelId),
          ne(ideas.state, "rejected"),
        ),
      )
      .orderBy(desc(ideas.vidxirScore), desc(ideas.createdAt))
      .limit(40),
  ]);

  return {
    run,
    trending: resultRows.slice(0, 6).map((r) => ({
      id: r.id,
      title: r.title,
      url: r.url,
      channelTitle: r.channelTitle,
      viewCount: r.viewCount === null ? null : Number(r.viewCount),
      viewsPerHour: r.viewsPerHour,
      topic: r.topic,
    })),
    competitors: summariseCompetitors(resultRows),
    ideas: ideaRows.map((i) => ({
      id: i.id,
      title: i.title,
      angle: i.angle,
      rationale: i.rationale,
      topic: i.topic,
      vidxirScore: i.vidxirScore,
      scores: {
        trend: i.trendScore,
        opportunity: i.opportunityScore,
        competition: i.competitionScore,
        audienceFit: i.audienceFitScore,
        velocity: i.velocityScore,
        freshness: i.freshnessScore,
      },
      state: i.state,
      createdAt: i.createdAt,
    })),
    selectedIdeaId,
  };
}

/**
 * "Competitor top videos" from the run's results, grouped by channel.
 *
 * The prototype listed four fixed competitor names. Here the competitor set is
 * whatever the research actually surfaced in this channel's niche, ranked by the
 * views those videos really have.
 */
function summariseCompetitors(
  rows: Array<{ channelTitle: string | null; viewCount: string | null }>,
): CompetitorRow[] {
  const byChannel = new Map<string, CompetitorRow>();

  for (const row of rows) {
    if (!row.channelTitle) continue;
    const existing = byChannel.get(row.channelTitle) ?? {
      channelTitle: row.channelTitle,
      videoCount: 0,
      totalViews: 0,
    };
    existing.videoCount += 1;
    existing.totalViews += row.viewCount ? Number(row.viewCount) : 0;
    byChannel.set(row.channelTitle, existing);
  }

  return [...byChannel.values()]
    .sort((a, b) => b.totalViews - a.totalViews)
    .slice(0, 6);
}

/** Ideas by id, for validating a selection server-side. */
export async function ideaBelongsToUser(
  userId: string,
  ideaIds: string[],
): Promise<Set<string>> {
  if (ideaIds.length === 0) return new Set();
  const rows = await db
    .select({ id: ideas.id })
    .from(ideas)
    .where(and(eq(ideas.userId, userId), inArray(ideas.id, ideaIds)));
  return new Set(rows.map((r) => r.id));
}

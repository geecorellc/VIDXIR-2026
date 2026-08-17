/**
 * Overview data (§25).
 *
 * The prototype hard-coded "6 channels / 817K subscribers / 631K views /
 * $4,280 revenue". Every one of those becomes a real query here, and — this is
 * the important part — anything Tally cannot know yet comes back as `null` so
 * the tile renders a dash instead of a fabricated figure (§42).
 *
 * Estimated revenue is deliberately `null` until Phase 9 wires YouTube Analytics
 * monetary metrics, which need the `yt-analytics-monetary.readonly` scope. A
 * revenue number Tally has not actually read from YouTube would be a lie, and
 * §42 forbids exactly that.
 */
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  analyticsSnapshots,
  channels,
  projects,
  publishedVideos,
  researchRuns,
} from "@/lib/db/schema";
import { compact } from "@/lib/dashboard/format";
import type { ProjectStatus } from "@/lib/projects/state-machine";
import { isWorking } from "@/lib/projects/state-machine";

export interface OverviewStat {
  /** Formatted value, or null when Tally has no real figure yet. */
  value: string | null;
  /** Why the value is null, shown under the dash. */
  emptyHint?: string;
  delta?: string | null;
}

export interface OverviewData {
  channels: OverviewStat;
  subscribers: OverviewStat;
  views7d: OverviewStat;
  revenue: OverviewStat;
  /** Projects currently being worked on by the pipeline. */
  inProgress: Array<{
    id: string;
    title: string;
    status: ProjectStatus;
    progress: number;
    channelTitle: string;
    updatedAt: Date;
  }>;
  /** Search-demand series for the niche chart, from the latest research run. */
  demandSeries: Array<{ label: string; value: number }> | null;
  demandNiche: string | null;
  publishedCount: number;
  hasChannel: boolean;
}

export async function getOverview(userId: string): Promise<OverviewData> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [channelRows, viewRows, projectRows, latestRun, publishedRows] =
    await Promise.all([
      db
        .select({
          id: channels.id,
          title: channels.title,
          subscriberCount: channels.subscriberCount,
          statsRefreshedAt: channels.statsRefreshedAt,
        })
        .from(channels)
        .where(
          and(eq(channels.userId, userId), isNull(channels.disconnectedAt)),
        ),

      // Views over the last 7 days, summed from real analytics snapshots.
      db
        .select({
          views: sql<string | null>`sum(${analyticsSnapshots.views})`,
          rows: sql<string>`count(*)`,
        })
        .from(analyticsSnapshots)
        .where(
          and(
            eq(analyticsSnapshots.userId, userId),
            gte(analyticsSnapshots.date, since),
          ),
        ),

      db
        .select({
          id: projects.id,
          title: projects.title,
          status: projects.status,
          progress: projects.progress,
          channelTitle: channels.title,
          updatedAt: projects.updatedAt,
        })
        .from(projects)
        .innerJoin(channels, eq(projects.channelId, channels.id))
        .where(eq(projects.userId, userId))
        .orderBy(desc(projects.updatedAt))
        .limit(12),

      db
        .select({
          demandSeries: researchRuns.demandSeries,
          niche: researchRuns.niche,
        })
        .from(researchRuns)
        .where(
          and(eq(researchRuns.userId, userId), eq(researchRuns.status, "succeeded")),
        )
        .orderBy(desc(researchRuns.createdAt))
        .limit(1),

      db
        .select({ count: sql<string>`count(*)` })
        .from(publishedVideos)
        .where(eq(publishedVideos.userId, userId)),
    ]);

  const hasChannel = channelRows.length > 0;

  // Subscribers: only counted from channels whose stats have actually been
  // fetched. A connected-but-never-refreshed channel contributes nothing, and if
  // none have been refreshed the tile shows a dash rather than "0".
  const refreshed = channelRows.filter((c) => c.statsRefreshedAt !== null);
  const subscriberTotal = refreshed.reduce(
    (sum, c) => sum + (c.subscriberCount ?? 0),
    0,
  );

  const viewRow = viewRows[0];
  const viewSnapshotCount = Number(viewRow?.rows ?? 0);
  const viewTotal = viewRow?.views ? Number(viewRow.views) : 0;

  return {
    channels: {
      value: hasChannel ? String(channelRows.length) : null,
      emptyHint: hasChannel ? undefined : "Connect your first channel",
      delta: describeWorking(projectRows),
    },
    subscribers: {
      value: refreshed.length > 0 ? compact(subscriberTotal) : null,
      emptyHint: hasChannel
        ? "Waiting for the first YouTube sync"
        : "Connect a channel",
    },
    views7d: {
      value: viewSnapshotCount > 0 ? compact(viewTotal) : null,
      emptyHint: hasChannel
        ? "No analytics collected yet"
        : "Connect a channel",
    },
    revenue: {
      // Not guessed, not extrapolated. Requires YouTube Analytics monetary
      // scope, which arrives in Phase 9.
      value: null,
      emptyHint: "Needs YouTube revenue access",
    },
    inProgress: projectRows.filter((p) => isWorking(p.status)),
    demandSeries: latestRun[0]?.demandSeries ?? null,
    demandNiche: latestRun[0]?.niche ?? null,
    publishedCount: Number(publishedRows[0]?.count ?? 0),
    hasChannel,
  };
}

/** "2 rendering now" — the prototype's delta line, made truthful. */
function describeWorking(
  rows: Array<{ status: ProjectStatus }>,
): string | null {
  const working = rows.filter((r) => isWorking(r.status)).length;
  if (working === 0) return null;
  return working === 1 ? "1 in production now" : `${working} in production now`;
}

// `compact` lives in lib/dashboard/format so client components share one
// implementation; re-exported because existing callers import it from here.
export { compact } from "@/lib/dashboard/format";


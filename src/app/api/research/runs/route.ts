/**
 * GET /api/research/runs — run history and live status (§7, §37, §38).
 *
 * The Research screen polls this while a run is in flight. `activeJob` carries
 * the job's real recorded progress — set at actual milestones by the worker, not
 * interpolated on a timer (§42). When no job is active it is null, and the run
 * rows alone describe what happened.
 */
import type { NextRequest } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  handle,
  parseQuery,
  requireChannelAccess,
  requireOnboarded,
} from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { db } from "@/lib/db";
import { researchResults, researchRuns } from "@/lib/db/schema";
import { getActiveJobs } from "@/lib/queue/jobs";
import { capabilityStatus } from "@/lib/providers/config";
import { RESEARCH_JOB_NAME } from "@/lib/research/service";

const QuerySchema = z.object({
  channelId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export async function GET(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    // Polled while a run is in flight, and each call carries a correlated
    // subquery per row. The `read` ceiling is far above the screen's cadence.
    await enforce(rules().read, `runs:${user.id}`);
    const query = parseQuery(request, QuerySchema);

    await requireChannelAccess(user.id, query.channelId);

    const rows = await db
      .select({
        id: researchRuns.id,
        status: researchRuns.status,
        trigger: researchRuns.trigger,
        niche: researchRuns.niche,
        keywords: researchRuns.keywords,
        sources: researchRuns.sources,
        demandSeries: researchRuns.demandSeries,
        error: researchRuns.error,
        errorCode: researchRuns.errorCode,
        startedAt: researchRuns.startedAt,
        completedAt: researchRuns.completedAt,
        createdAt: researchRuns.createdAt,
        // Counted in SQL rather than by loading the rows: the screen shows "182
        // signals", never the signals themselves.
        resultCount: sql<number>`(
          SELECT COUNT(*)::int FROM ${researchResults}
          WHERE ${researchResults.runId} = ${researchRuns.id}
        )`,
      })
      .from(researchRuns)
      .where(
        and(
          eq(researchRuns.userId, user.id),
          eq(researchRuns.channelId, query.channelId),
        ),
      )
      .orderBy(desc(researchRuns.createdAt))
      .limit(query.limit);

    // Live progress comes from the `jobs` table, not from the run row: the run
    // row records what happened, the job records how far along it is.
    const active = await getActiveJobs(user.id, query.channelId);
    const researchJob =
      active.find((job) => job.name === RESEARCH_JOB_NAME) ?? null;

    return {
      runs: rows,
      activeJob: researchJob,
      ai: capabilityStatus("ai"),
    };
  });
}

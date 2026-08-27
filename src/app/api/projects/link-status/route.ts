/**
 * GET /api/projects/link-status — live status of a link-mode project
 * (Phase 11 §4, §6, §18).
 *
 * What the "Create from YouTube" screen polls while research, scripting or a build
 * is in flight. It is the channel-less counterpart of `/api/research/runs`, which
 * cannot serve this because it requires a `channelId` and re-queries the channel for
 * ownership — a link-mode project has neither (§4).
 *
 * §18: "show job progress using Tally's existing job/worker system. Do not create
 * fake progress." Every number here comes from a `jobs` row written by a worker at a
 * real milestone. When nothing is running, `activeJob` is null and the counts below
 * describe what actually landed — there is no interpolation, no timer, and no
 * percentage invented to fill the gap (§42).
 *
 * Counts rather than contents: the screen re-renders from the server once a stage
 * finishes, so this response only has to answer "has anything changed?".
 */
import type { NextRequest } from "next/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  handle,
  parseQuery,
  requireOnboarded,
  requireProjectAccess,
} from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { db } from "@/lib/db";
import { ideas, projects, researchResults, researchRuns } from "@/lib/db/schema";
import { getActiveProjectJobs } from "@/lib/queue/jobs";

const QuerySchema = z.object({
  projectId: z.string().uuid(),
});

export async function GET(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    // Polled every few seconds while a stage runs. The `read` ceiling is far above
    // that cadence, and keyed by user so many open tabs share one budget.
    await enforce(rules().read, `link-status:${user.id}`);
    const query = parseQuery(request, QuerySchema);

    await requireProjectAccess(user.id, query.projectId);

    /**
     * The project's own columns, re-read rather than taken from the access check.
     *
     * `requireProjectAccess` returns the four fields it needs for authorisation;
     * the screen needs the status, the stage and the source video, and re-reading
     * is one indexed lookup against a row already in cache.
     */
    const projectRows = await db
      .select({
        status: projects.status,
        currentStage: projects.currentStage,
        progress: projects.progress,
        ideaId: projects.ideaId,
        sourceVideoId: projects.sourceVideoId,
        generationMode: projects.generationMode,
        generationModel: projects.generationModel,
        videoFormat: projects.videoFormat,
        errorMessage: projects.errorMessage,
        errorCode: projects.errorCode,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .where(
        and(eq(projects.id, query.projectId), eq(projects.userId, user.id)),
      )
      .limit(1);

    const project = projectRows[0];
    // Re-queried under the same predicate the guard used, so this is unreachable
    // in practice — but a missing row must not become a 500 on a polled endpoint.
    if (!project) {
      return { project: null, run: null, activeJob: null };
    }

    // Matched through the source video, restricted to channel-less runs: the same
    // key `getLinkStudioData` uses, so the poll and the render agree on the run.
    const runRows = project.sourceVideoId
      ? await db
          .select({
            id: researchRuns.id,
            status: researchRuns.status,
            niche: researchRuns.niche,
            error: researchRuns.error,
            errorCode: researchRuns.errorCode,
            completedAt: researchRuns.completedAt,
            resultCount: sql<number>`(
              SELECT COUNT(*)::int FROM ${researchResults}
              WHERE ${researchResults.runId} = ${researchRuns.id}
            )`,
            angleCount: sql<number>`(
              SELECT COUNT(*)::int FROM ${ideas}
              WHERE ${ideas.runId} = ${researchRuns.id}
                AND ${ideas.state} <> 'rejected'
            )`,
          })
          .from(researchRuns)
          .where(
            and(
              eq(researchRuns.userId, user.id),
              eq(researchRuns.sourceVideoId, project.sourceVideoId),
              isNull(researchRuns.channelId),
            ),
          )
          .orderBy(desc(researchRuns.createdAt))
          .limit(1)
      : [];

    /**
     * Live jobs for this project, newest first.
     *
     * Scoped by project rather than by channel, which is the read Phase 11 added for
     * exactly this: a link-mode job carries a `projectId` and no `channelId`, so
     * `getActiveJobs` would return nothing for it.
     */
    const active = await getActiveProjectJobs(user.id, query.projectId);

    return {
      project: {
        id: query.projectId,
        status: project.status,
        currentStage: project.currentStage,
        progress: project.progress,
        ideaId: project.ideaId,
        sourceVideoId: project.sourceVideoId,
        generationMode: project.generationMode,
        generationModel: project.generationModel,
        videoFormat: project.videoFormat,
        errorMessage: project.errorMessage,
        errorCode: project.errorCode,
        updatedAt: project.updatedAt,
      },
      run: runRows[0] ?? null,
      /**
       * The job the user is waiting on.
       *
       * The newest of the active ones: the stages run in sequence, so the most
       * recently created active job is the current one. Its `statusMessage` is the
       * worker's own note, which is the most specific true thing available about
       * what is happening right now.
       */
      activeJob: active[0] ?? null,
      activeJobCount: active.length,
    };
  });
}

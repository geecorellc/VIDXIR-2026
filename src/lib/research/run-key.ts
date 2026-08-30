/**
 * How a channel-less project finds its research run (Phase 11 §4, §6; §1C).
 *
 * A trending-mode run is found through its channel. Neither channel-less path has
 * one, so each has needed its own key — and the two keys were not equally good:
 *
 *  - Description mode (§1C) writes `research_runs.project_id`, because a description
 *    is free text with no id to match on.
 *  - Link mode matched on `source_video_id` alone, which is *not unique per project*.
 *    Pasting the same video into a second project — a real thing to do, and one
 *    `/api/projects/from-youtube` permits, since the duplicate guard is scoped to the
 *    project — left both projects resolving to whichever run was newest. The first
 *    project's page then showed the second's angles, evidence and status.
 *
 * So link mode writes `project_id` too, and this module is the one place that says
 * how the lookup works, so the polled status (`/api/projects/link-status`) and the
 * server-rendered page (`getLinkStudioData`) cannot disagree about which run they
 * mean.
 *
 * The keys are returned in priority order and the caller takes the first that
 * matches, rather than being OR-ed into one predicate: "the run for this project"
 * and "a run for this video that predates the column" are different questions, and a
 * single predicate ordered by `created_at` would answer the second one first.
 */
import { and, eq, isNull, type SQL } from "drizzle-orm";
import { researchRuns } from "@/lib/db/schema";

/**
 * Predicates that identify a channel-less project's run, best first.
 *
 * Neither carries the user id or the channel-less restriction: those belong to the
 * caller's own predicate, which must not depend on this module remembering them.
 */
export function channelLessRunKeys(
  projectId: string,
  sourceVideoId: string | null,
): SQL[] {
  const keys: SQL[] = [];

  // What every run started since this column existed carries.
  const byProject = eq(researchRuns.projectId, projectId);
  if (byProject) keys.push(byProject);

  /**
   * Runs from before link mode recorded the project, matched the old way.
   *
   * Restricted to `project_id IS NULL`, which is what makes this a fallback rather
   * than a reintroduction of the bug: a run that *does* name a project is that
   * project's run, and must never be picked up by another one that happens to have
   * been started from the same video.
   */
  if (sourceVideoId) {
    const legacy = and(
      isNull(researchRuns.projectId),
      eq(researchRuns.sourceVideoId, sourceVideoId),
    );
    if (legacy) keys.push(legacy);
  }

  return keys;
}

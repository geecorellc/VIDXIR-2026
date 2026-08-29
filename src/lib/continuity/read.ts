/**
 * The continuity layer's read model (§18, §19).
 *
 * One function, used by both the API route and the video page's server component.
 * Two readers would drift: the panel would show a level the next build does not use,
 * or a score from a different row than the publish screen's, and either one makes the
 * feature less trustworthy than showing nothing.
 *
 * Nothing here plans, generates or spends. It resolves the level the pipeline would
 * resolve, then performs four indexed reads. A page refresh costs four queries (§21).
 */

import { getProject } from "@/lib/projects/service";
import { isGenerationMode } from "@/lib/providers/video-gen";
import type { PlanTier } from "@/lib/plans";
import type { ContinuityLevel, ContinuityThresholds } from "@/lib/continuity/config";
import { resolveFor } from "@/lib/continuity/service";
import {
  getBible,
  getSceneStates,
  latestContinuityCheck,
  regenerationCounts,
} from "@/lib/continuity/store";
import type { StoryBible } from "@/lib/continuity/bible";
import type { SceneState } from "@/lib/continuity/scene-state";
import type { FindingSeverity } from "@/lib/continuity/validate";

export interface ContinuitySceneView {
  sceneIndex: number;
  state: SceneState;
  /** How many paid regenerations this scene has already had. */
  regenerations: number;
}

export interface ContinuityCheckView {
  verdict: string;
  findings: Array<{
    code: string;
    severity: FindingSeverity;
    message: string;
    detail?: string;
  }>;
  createdAt: Date;
}

export interface ContinuityView {
  projectId: string;
  /** The resolved level. `off` is a normal, correct answer. */
  level: ContinuityLevel;
  /** Why that level — shown verbatim, never parsed. */
  reason: string;
  active: boolean;
  preschool: boolean;
  thresholds: ContinuityThresholds;
  bible: StoryBible | null;
  /** True once a human has edited the bible: the next plan will not overwrite it. */
  editedByUser: boolean;
  bibleUpdatedAt: Date | null;
  scenes: ContinuitySceneView[];
  check: ContinuityCheckView | null;
  /**
   * The score from the latest check, or null.
   *
   * Parsed back out of the `continuity.score` finding rather than stored in its own
   * column, because `quality_checks` is a completed migration and the summary finding
   * already carries it. Null when the latest check came from something other than
   * continuity, which is the honest answer — not zero.
   */
  score: number | null;
}

const SCORE_RE = /^Continuity score (\d+)\/100/;

/**
 * Assemble one project's continuity view.
 *
 * Owner-scoped throughout: `getProject` and every store call take the `userId` and put
 * it in the WHERE clause, so this cannot read across tenants even if a caller forgets
 * a guard (§20). Callers should still run `requireProjectAccess` first — that is what
 * gives a foreign id a 403 instead of an empty view.
 */
export async function continuityView(
  userId: string,
  projectId: string,
  tier: PlanTier,
): Promise<ContinuityView> {
  const project = await getProject(userId, projectId);

  const context = await resolveFor({
    projectId,
    channelId: project.channelId,
    generationMode: isGenerationMode(project.generationMode)
      ? project.generationMode
      : null,
    tier,
  });

  const [stored, states, check, counts] = await Promise.all([
    getBible(userId, projectId),
    getSceneStates(userId, projectId),
    latestContinuityCheck(userId, projectId),
    regenerationCounts(userId, projectId),
  ]);

  return {
    projectId,
    level: context.plan.level,
    reason: context.plan.reason,
    active: context.active,
    preschool: context.plan.preschool,
    thresholds: context.thresholds,
    bible: stored?.bible ?? null,
    editedByUser: stored?.editedByUser ?? false,
    bibleUpdatedAt: stored?.updatedAt ?? null,
    scenes: states.map((entry) => ({
      sceneIndex: entry.sceneIndex,
      state: entry.state,
      regenerations: counts.get(entry.sceneIndex) ?? 0,
    })),
    check,
    score: scoreOf(check),
  };
}

/** The score out of the summary finding, or null when this check is not a continuity one. */
function scoreOf(check: ContinuityCheckView | null): number | null {
  const summary = check?.findings.find((f) => f.code === "continuity.score");
  if (!summary) return null;
  const match = SCORE_RE.exec(summary.message);
  if (!match?.[1]) return null;
  const score = Number.parseInt(match[1], 10);
  return Number.isFinite(score) ? score : null;
}

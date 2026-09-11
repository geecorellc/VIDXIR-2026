/**
 * The continuity layer's read model (§18, §19).
 *
 * One function, used by both the API route and the video page's server component.
 * Two readers would drift: the panel would show a level the next build does not use,
 * or a score from a different row than the publish screen's, and either one makes the
 * feature less trustworthy than showing nothing.
 *
 * Nothing here plans, generates or spends. It resolves the level the pipeline would
 * resolve, then performs five indexed reads and signs a URL per stored reference still.
 * Signing is a local HMAC, not a request, so a page refresh costs five queries (§21).
 */

import { getProject } from "@/lib/projects/service";
import { isGenerationMode } from "@/lib/providers/video-gen";
import { signedReadUrl } from "@/lib/storage";
import { logger } from "@/lib/logger";
import type { PlanTier } from "@/lib/plans";
import type { ContinuityLevel, ContinuityThresholds } from "@/lib/continuity/config";
import { resolveFor } from "@/lib/continuity/service";
import {
  getBible,
  getReferenceImages,
  getSceneStates,
  latestContinuityCheck,
  regenerationCounts,
} from "@/lib/continuity/store";
import type { StoryBible } from "@/lib/continuity/bible";
import type { ReferenceKind } from "@/lib/continuity/prompt";
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

/**
 * A stored reference still, ready to render.
 *
 * The same rows `GET /api/video/continuity/references` returns and the same shape, minus
 * the fields a thumbnail has no use for. Deliberately not a second store or a second
 * generator: `executeReferenceImages` writes these assets, `getReferenceImages` is the
 * one reader, and this view signs what it finds. Nothing here draws anything.
 */
export interface ContinuityReferenceView {
  assetId: string;
  kind: ReferenceKind;
  entityId: string;
  name: string;
  /**
   * A short-lived signed URL, or null when signing failed.
   *
   * Nullable rather than omitted, because the still genuinely exists in either case and
   * a panel that dropped it would tell the operator the cast has no reference when it
   * has one that could not be signed this second.
   */
  url: string | null;
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
  /**
   * The reference stills already drawn for this bible, newest per entity.
   *
   * Empty is the ordinary case and not a defect: stills are drawn on request rather than
   * during a build, so most projects have none. A panel showing an empty row would
   * report an absence as a failure.
   */
  references: ContinuityReferenceView[];
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

const log = logger.child({ component: "continuity-read" });

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

  const [stored, states, check, counts, references] = await Promise.all([
    getBible(userId, projectId),
    getSceneStates(userId, projectId),
    latestContinuityCheck(userId, projectId),
    regenerationCounts(userId, projectId),
    getReferenceImages(userId, projectId),
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
    references: await signReferences(references),
    check,
    score: scoreOf(check),
  };
}

/**
 * Sign each stored still for display.
 *
 * In parallel and individually caught, the same arrangement the references route uses:
 * the bucket is private so a storage key is not viewable on its own, and one key that
 * cannot be signed costs that still its thumbnail rather than costing the panel its
 * cast. `Promise.all` over a mapped `catch` never rejects, so this cannot be the reason
 * the video screen fails to render.
 */
async function signReferences(
  stored: readonly {
    assetId: string;
    kind: ReferenceKind;
    entityId: string;
    entityName: string;
    storageKey: string;
  }[],
): Promise<ContinuityReferenceView[]> {
  return Promise.all(
    stored.map(async (reference) => ({
      assetId: reference.assetId,
      kind: reference.kind,
      entityId: reference.entityId,
      name: reference.entityName,
      url: await signedReadUrl(reference.storageKey).catch((error: unknown) => {
        log.warn("could not sign a continuity reference still", {
          assetId: reference.assetId,
          error,
        });
        return null;
      }),
    })),
  );
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

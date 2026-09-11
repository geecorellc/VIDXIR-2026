/**
 * The continuity layer's public surface.
 *
 * Five entry points, called from the existing video pipeline and from nowhere else:
 *
 *  - `planContinuity` — after the script is segmented, before scenes are directed.
 *  - `referenceImagePlan` — which entities still need a reference still (§5, §6).
 *  - `continuityContextFor` — per scene, inside the visuals stage.
 *  - `checkContinuity` — after the visuals stage, as the QUALITY_CHECK stage.
 *  - `scenesToRegenerate` — what §13 acts on.
 *
 * Two properties hold across all of them, and they are the reason this module
 * exists rather than the pipeline calling `planner.ts` and `validate.ts` directly:
 *
 *  1. **Nothing here calls a provider.** The planner does, through the existing AI
 *     abstraction. Generation happens in `executeVisuals`, through the existing
 *     provider abstraction. This module resolves plans, reads and writes rows, and
 *     assembles text.
 *  2. **Nothing here can fail a build.** Every entry point is written so that a
 *     failure inside continuity degrades to the behaviour Tally had before this
 *     layer existed. §22: continuity is a quality feature, and a quality feature
 *     that can lose a paid render is a defect.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channelSettings } from "@/lib/db/schema";
import { emptyStoryBible, isEmptyBible, type StoryBible } from "@/lib/continuity/bible";
import {
  capabilitiesFor,
  resolveContinuityPlan,
  thresholdsFor,
  type ContinuityPlan,
  type ContinuityThresholds,
} from "@/lib/continuity/config";
import { planStoryBible } from "@/lib/continuity/planner";
import {
  buildContinuityPrompt,
  plannerContext,
  referenceImagePrompts,
  regenerationPrompt,
  withContinuity,
  type ReferenceImagePrompt,
} from "@/lib/continuity/prompt";
import {
  buildSceneStateGraph,
  emptySceneState,
  regenerationSet,
  type IndexedSceneState,
  type SceneStateGraph,
} from "@/lib/continuity/scene-state";
import {
  getBible,
  getReferenceImages,
  getSceneStates,
  recordContinuityCheck,
  referencedEntityKeys,
  regenerationCounts,
  saveBible,
  saveSceneContinuity,
  type StoredReference,
} from "@/lib/continuity/store";
import {
  issuesForScene,
  validateContinuity,
  type ContinuityReport,
} from "@/lib/continuity/validate";
import {
  assignSceneVoice,
  usesCharacterVoices,
  type SceneVoiceAssignment,
  type SceneVoiceRecord,
} from "@/lib/continuity/voice";
import { continuityEnabled } from "@/lib/env";
import { logger } from "@/lib/logger";
import { hasFeature } from "@/lib/plans/enforce";
import type { PlanTier } from "@/lib/plans";
import type { GenerationMode } from "@/lib/providers/video-gen";

const log = logger.child({ component: "continuity" });

/**
 * A resolved, inert continuity context.
 *
 * Returned whenever continuity does not apply — flag off, plan does not include it,
 * stock footage, no bible. Every consumer branches on `active` and takes the
 * pre-continuity path, which is why there is one shape rather than a nullable.
 */
export interface ContinuityContext {
  active: boolean;
  plan: ContinuityPlan;
  thresholds: ContinuityThresholds;
  bible: StoryBible;
  states: readonly IndexedSceneState[];
  graph: SceneStateGraph;
}

const INERT_PLAN: ContinuityPlan = {
  level: "off",
  capabilities: capabilitiesFor("off"),
  preschool: false,
  reason: "Continuity is not enabled for this project.",
};

function inert(reason?: string): ContinuityContext {
  const plan = reason ? { ...INERT_PLAN, reason } : INERT_PLAN;
  return {
    active: false,
    plan,
    thresholds: thresholdsFor(plan),
    bible: emptyStoryBible(),
    states: [],
    graph: buildSceneStateGraph([]),
  };
}

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

/**
 * The project facts the level depends on.
 *
 * A struct rather than a project row, so `resolveFor` can be called from a test or
 * a route without one.
 */
export interface ContinuityProject {
  projectId: string;
  channelId: string | null;
  generationMode: GenerationMode | null;
  tier: PlanTier;
}

/**
 * Should this project have continuity at all, and at what level?
 *
 * Three gates, cheapest first, and every one of them is a plain comparison — no
 * database read until the flag and the plan have both said yes, and no AI call
 * ever. §21's rule at the entrance: the common case (a stock video on a starter
 * plan with the flag off) costs three boolean checks.
 *
 * The entitlement gate reuses `aiVideoGeneration` rather than adding a
 * continuity-specific feature key. Continuity only applies to AI-generated video,
 * so a plan that cannot generate AI video cannot reach this code by any path, and a
 * second key would be a second thing to keep in step for no additional refusal.
 */
export async function resolveFor(
  project: ContinuityProject,
): Promise<ContinuityContext> {
  if (!continuityEnabled()) return inert("The continuity engine is switched off.");

  if (project.generationMode !== "AI_VIDEO") {
    return inert(
      "Stock footage: continuity constraints cannot apply to library clips.",
    );
  }

  if (!hasFeature(project.tier, "aiVideoGeneration")) {
    return inert("This plan does not include AI video generation.");
  }

  const settings = await loadContinuitySettings(project.channelId);
  const plan = resolveContinuityPlan({
    generationMode: project.generationMode,
    contentStyle: settings.contentStyle,
    videoStyle: settings.videoStyle,
    targetAudience: settings.targetAudience,
  });

  if (plan.level === "off") return inert(plan.reason);

  return {
    active: true,
    plan,
    thresholds: thresholdsFor(plan),
    bible: emptyStoryBible(),
    states: [],
    graph: buildSceneStateGraph([]),
  };
}

/**
 * The same resolution, plus the stored bible and scene states.
 *
 * Used by every stage after the plan: the level has to be resolved the same way
 * each time (an operator changing a channel's content style mid-build must not
 * leave the visuals stage and the check disagreeing about what they are holding),
 * and an active plan with no stored bible is inert — there is nothing to constrain
 * against.
 */
export async function loadContext(
  userId: string,
  project: ContinuityProject,
): Promise<ContinuityContext> {
  const base = await resolveFor(project);
  if (!base.active) return base;

  const stored = await getBible(userId, project.projectId);
  if (!stored || isEmptyBible(stored.bible)) {
    return inert("No story bible has been planned for this project.");
  }

  const states = await getSceneStates(userId, project.projectId);

  return {
    ...base,
    bible: stored.bible,
    states,
    graph: buildSceneStateGraph(states),
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface PlanContinuityInput {
  userId: string;
  project: ContinuityProject;
  scenes: readonly { index: number; label: string; narration: string }[];
  title: string;
  niche: string | null;
  usage: { jobId: string; traceId?: string | null };
}

export interface PlanContinuityResult {
  context: ContinuityContext;
  /** Extra direction for `directScenes`, or "" when there is none. */
  plannerContext: string;
  /** False when continuity did not apply or could not be planned. */
  planned: boolean;
}

/**
 * Plan the bible and scene states for a project, and persist them.
 *
 * Called from `executeScenePlan` between segmentation and direction, which is the
 * only point where the narration exists and the visual prompts do not — exactly the
 * information a continuity supervisor needs and nothing it should not have.
 *
 * **Never throws.** A planning failure logs and returns `planned: false`, and the
 * scene plan proceeds without continuity. That is a video without continuity
 * constraints, which is the video Tally has always produced; the alternative is
 * failing an approved script's build because a bible could not be drafted.
 */
export async function planContinuity(
  input: PlanContinuityInput,
): Promise<PlanContinuityResult> {
  const context = await resolveFor(input.project);
  if (!context.active) {
    return { context, plannerContext: "", planned: false };
  }

  try {
    const settings = await loadContinuitySettings(input.project.channelId);

    const planned = await planStoryBible({
      scenes: input.scenes,
      title: input.title,
      niche: input.niche,
      contentStyle: settings.contentStyle,
      videoStyle: settings.videoStyle,
      targetAudience: settings.targetAudience,
      plan: context.plan,
      usage: {
        userId: input.userId,
        projectId: input.project.projectId,
        jobId: input.usage.jobId,
        traceId: input.usage.traceId ?? null,
      },
    });

    if (isEmptyBible(planned.bible)) {
      // A legitimate answer, not a failure: a video with no recurring subject has
      // no continuity contract, and pretending otherwise would add constraints
      // with nothing behind them.
      log.info("continuity plan is empty; nothing to constrain", {
        projectId: input.project.projectId,
        level: context.plan.level,
      });
      return { context: inert("Nothing in this video recurs."), plannerContext: "", planned: false };
    }

    const written = await saveBible({
      userId: input.userId,
      projectId: input.project.projectId,
      bible: planned.bible,
      level: context.plan.level,
      generatedBy: "continuity.plan",
    });

    if (!written) {
      // A human has edited this bible. Their casting wins, and the states planned
      // against a bible that is no longer stored would reference entities that may
      // not exist — so the stored pair is loaded instead.
      log.info("keeping user-edited story bible", {
        projectId: input.project.projectId,
      });
      const stored = await loadContext(input.userId, input.project);
      return {
        context: stored,
        plannerContext: stored.active
          ? plannerContext(stored.bible, stored.plan.capabilities)
          : "",
        planned: stored.active,
      };
    }

    const graph = buildSceneStateGraph(planned.states);
    const full: ContinuityContext = {
      ...context,
      bible: planned.bible,
      states: planned.states,
      graph,
    };

    return {
      context: full,
      plannerContext: plannerContext(planned.bible, context.plan.capabilities),
      planned: true,
    };
  } catch (error) {
    log.error("continuity planning failed; continuing without it", {
      projectId: input.project.projectId,
      error,
    });
    return { context: inert("Continuity planning did not complete."), plannerContext: "", planned: false };
  }
}

/**
 * Persist the scene states once the scenes exist.
 *
 * Separate from `planContinuity` because the states are keyed by scene index and
 * the scene rows are written by `executeScenePlan`'s own transaction — writing the
 * states before those rows exist would update nothing. Called immediately after.
 */
export async function persistSceneStates(args: {
  userId: string;
  projectId: string;
  context: ContinuityContext;
}): Promise<void> {
  if (!args.context.active) return;

  for (const entry of args.context.states) {
    try {
      await saveSceneContinuity({
        userId: args.userId,
        projectId: args.projectId,
        sceneIndex: entry.sceneIndex,
        state: entry.state,
        continuityPrompt: null,
      });
    } catch (error) {
      // One scene's state failing to write costs that scene its constraints, not
      // the build.
      log.warn("could not store scene continuity state", {
        projectId: args.projectId,
        sceneIndex: entry.sceneIndex,
        error,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Reference stills (§5, §6)
// ---------------------------------------------------------------------------

export interface ReferenceImagePlan {
  context: ContinuityContext;
  /** Entities that need a still generated. Empty when there is nothing to make. */
  wanted: ReferenceImagePrompt[];
  /** References already stored, current one per entity. */
  existing: StoredReference[];
  /** Why `wanted` is empty, when it is. Shown verbatim, never parsed. */
  reason: string;
}

/**
 * Which bible entities still need a reference still.
 *
 * Reads, never generates. The provider call belongs in the pipeline stage for the
 * reason stated at the top of this module — nothing here spends money — and keeping
 * the decision separate from the spending is also what lets a route show a user what
 * *would* be generated before anything is charged.
 *
 * Already-referenced entities are excluded rather than regenerated. A reference still
 * is not improved by a second draw from the same distribution, and re-making eight of
 * them every time a project is rebuilt would be eight paid generations to arrive back
 * where the project already was.
 *
 * Never throws: a failure to read the existing set returns an empty plan, and a
 * project with no references is the state every project was in before this existed.
 */
export async function referenceImagePlan(args: {
  userId: string;
  project: ContinuityProject;
}): Promise<ReferenceImagePlan> {
  const context = await loadContext(args.userId, args.project);
  if (!context.active) {
    return { context, wanted: [], existing: [], reason: context.plan.reason };
  }

  try {
    const [existing, taken] = await Promise.all([
      getReferenceImages(args.userId, args.project.projectId),
      referencedEntityKeys(args.userId, args.project.projectId),
    ]);

    const all = referenceImagePrompts(context.bible, context.plan.capabilities);
    const wanted = all.filter(
      (entry) => !taken.has(`${entry.kind}:${entry.entityId}`),
    );

    return {
      context,
      wanted,
      existing,
      reason:
        wanted.length > 0
          ? ""
          : all.length === 0
            ? // The honest distinction: a bible whose entities carry no *visual* facts
              // has nothing to draw, which is different from having drawn everything.
              "No entity in this story bible carries visual facts to illustrate."
            : "Every entity in this story bible already has a reference image.",
    };
  } catch (error) {
    log.error("could not resolve the reference image plan", {
      projectId: args.project.projectId,
      error,
    });
    return {
      context,
      wanted: [],
      existing: [],
      reason: "Reference images could not be resolved.",
    };
  }
}

/**
 * The stored references that apply to one scene, in a stable order.
 *
 * The reuse half of §6 — "reused by scene generation where the selected backend
 * supports them". Pure and synchronous: the visuals stage loads the reference set once
 * for the project and calls this per scene, the same arrangement
 * `continuityContextFor` uses, because a query per scene would be 120 round trips for
 * data that cannot change mid-stage.
 *
 * A scene gets references for the entities its own state commits to, and nothing else.
 * Sending the whole cast with every scene would tell the model to put eight characters
 * in a two-hander, and a backend that weights every reference it is given would then
 * produce a crowd. The environment comes after the characters and the props last,
 * matching the priority `buildContinuityPrompt` orders its clauses by, so a backend
 * that caps how many it accepts drops the least important.
 *
 * Capability gating is *not* done here, and the omission is the §28 rule rather than
 * an oversight. Whether the selected model can accept a reference is a fact about the
 * provider layer, which refuses them for a model declaring none; this module does not
 * know what a model is. Duplicating that judgement here would be a second place for it
 * to go out of step with the capability matrix, and the wrong layer to hold it in.
 */
export function referencesForScene(args: {
  context: ContinuityContext;
  sceneIndex: number;
  stored: readonly StoredReference[];
}): StoredReference[] {
  if (!args.context.active || args.stored.length === 0) return [];

  const entry = args.context.states.find(
    (s) => s.sceneIndex === args.sceneIndex,
  );
  if (!entry) return [];

  const { capabilities } = args.context.plan;
  const state = entry.state;

  const byKey = new Map(
    args.stored.map((reference) => [
      `${reference.kind}:${reference.entityId}`,
      reference,
    ]),
  );

  const wanted: string[] = [
    ...(capabilities.characters
      ? state.characters.map((id) => `character:${id}`)
      : []),
    ...(capabilities.environments && state.environment
      ? [`environment:${state.environment}`]
      : []),
    ...(capabilities.props ? state.props.map((id) => `prop:${id}`) : []),
  ];

  const out: StoredReference[] = [];
  const seen = new Set<string>();

  for (const key of wanted) {
    // A state may legitimately name the same entity twice; a reference sent twice is
    // a wasted upload at best and a doubled weight at worst.
    if (seen.has(key)) continue;
    seen.add(key);
    const reference = byKey.get(key);
    // Absent is ordinary: a scene may commit to an entity nobody has drawn yet, and
    // that scene falls back to the textual constraints like every scene does today.
    if (reference) out.push(reference);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Per-scene prompt construction
// ---------------------------------------------------------------------------

export interface SceneContinuity {
  /** The continuity block, or "" when there is nothing to add. */
  block: string;
  /** The scene's prompt with the block attached. Equal to the input when inert. */
  prompt: string;
}

/**
 * Build one scene's continuity-constrained prompt.
 *
 * Synchronous and pure given the context — no database read per scene, because
 * `executeVisuals` loops sequentially over up to 120 scenes and a query each would
 * be 120 round trips for data that cannot change mid-stage.
 *
 * When continuity is inert this returns the prompt unchanged, which is what makes
 * the call site safe to place unconditionally.
 */
export function continuityContextFor(args: {
  context: ContinuityContext;
  sceneIndex: number;
  visualPrompt: string;
}): SceneContinuity {
  if (!args.context.active) {
    return { block: "", prompt: args.visualPrompt };
  }

  const entry = args.context.states.find((s) => s.sceneIndex === args.sceneIndex);
  const state = entry?.state ?? emptySceneState();

  const block = buildContinuityPrompt({
    bible: args.context.bible,
    state,
    sceneIndex: args.sceneIndex,
    allStates: args.context.states,
    graph: args.context.graph,
    capabilities: args.context.plan.capabilities,
  });

  return { block, prompt: withContinuity(args.visualPrompt, block) };
}

// ---------------------------------------------------------------------------
// Per-scene voice identity
// ---------------------------------------------------------------------------

/**
 * The voice each scene's narration must be spoken in.
 *
 * The audio counterpart of `continuityContextFor`, and shaped the same way for the
 * same three reasons:
 *
 *  - **Pure and synchronous given the context.** The voiceover stage loads the
 *    context once and resolves every scene from it, so a project's voices cost no
 *    queries beyond the ones `loadContext` already made.
 *  - **Deterministic.** The same bible and the same scene states produce the same
 *    assignment on every run. That is what makes regeneration safe: re-running the
 *    voiceover stage after a scene was regenerated reproduces the identical voice for
 *    every scene, because the function is the guarantee rather than a cache.
 *  - **Safe to call unconditionally.** An inert context returns an empty map, and the
 *    caller's existing single-voice path is untouched. No branch at the call site.
 *
 * Returns a map rather than an array so the caller can index by scene index without
 * assuming the scenes and the states cover the same set — a partially-planned project
 * legitimately has states for some scenes and not others.
 */
export function sceneVoicesFor(args: {
  context: ContinuityContext;
  sceneIndices: readonly number[];
}): Map<number, SceneVoiceAssignment> {
  const out = new Map<number, SceneVoiceAssignment>();
  if (!args.context.active) return out;

  // Nothing to assert, and the cheap exit: a bible whose cast carries no canonical
  // voices is every project built before this existed (§25).
  if (!usesCharacterVoices(args.context.bible)) return out;

  const input = {
    bible: args.context.bible,
    states: args.context.states,
    capabilities: args.context.plan.capabilities,
  };

  for (const sceneIndex of args.sceneIndices) {
    const assignment = assignSceneVoice(input, sceneIndex);
    // Only assignments that actually name a voice are returned. A scene the layer has
    // no opinion about must reach the provider through the caller's own fallback, not
    // through an entry that says "no voice" and invites a caller to treat it as one.
    if (assignment.source === "character" && assignment.providerVoiceId !== null) {
      out.set(sceneIndex, assignment);
    }
  }

  return out;
}

/**
 * The prompt for a scene being regenerated, carrying the failures that caused it.
 *
 * Returns the block alongside the prompt, the same shape as `continuityContextFor`
 * and for the same reason: the caller has to store the constraints the scene was
 * regenerated under, and the next check reads that row back to decide whether the
 * scene carried them. Returning only the assembled string would leave the caller to
 * rebuild the block itself to record it — a second computation of the same thing,
 * and the one thing that must not differ from what was actually sent.
 */
export function regenerationPromptFor(args: {
  context: ContinuityContext;
  report: ContinuityReport;
  sceneIndex: number;
  visualPrompt: string;
}): { block: string; prompt: string } {
  const scene = continuityContextFor({
    context: args.context,
    sceneIndex: args.sceneIndex,
    visualPrompt: args.visualPrompt,
  });

  return {
    block: scene.block,
    prompt: regenerationPrompt({
      visualPrompt: args.visualPrompt,
      continuity: scene.block,
      issues: issuesForScene(args.report, args.sceneIndex),
    }),
  };
}

/** Record the block a scene was actually generated with, for the check. */
export async function recordScenePrompt(args: {
  userId: string;
  projectId: string;
  sceneIndex: number;
  state: IndexedSceneState | null;
  block: string;
}): Promise<void> {
  try {
    await saveSceneContinuity({
      userId: args.userId,
      projectId: args.projectId,
      sceneIndex: args.sceneIndex,
      state: args.state?.state ?? null,
      continuityPrompt: args.block.length > 0 ? args.block : null,
    });
  } catch (error) {
    log.warn("could not record scene continuity prompt", {
      projectId: args.projectId,
      sceneIndex: args.sceneIndex,
      error,
    });
  }
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

export interface CheckContinuityInput {
  userId: string;
  project: ContinuityProject;
  /** The prompt each scene was generated with, including its continuity block. */
  visuals: readonly {
    sceneIndex: number;
    visualPrompt: string | null;
    searchTerms: readonly string[];
    /**
     * The same scene's direction without the continuity block.
     *
     * Repetition detection compares this instead, because the block is deliberately
     * the same across every scene sharing a cast. See `SceneVisual.shotPrompt`.
     */
    shotPrompt?: string | null;
  }[];
  /**
   * The voice each scene was actually narrated in, when that is known.
   *
   * Optional: a project with no character voices has none to record, and one checked
   * before its voiceover ran has nothing to report. Absent means the voice check
   * evaluates the contract in the bible without claiming anything about audio.
   */
  voices?: readonly SceneVoiceRecord[];
}

export interface CheckContinuityResult {
  /** Null when continuity did not apply. */
  report: ContinuityReport | null;
  context: ContinuityContext;
}

/**
 * Validate a project's continuity and record the result.
 *
 * Writes to `quality_checks` — the existing table, with the existing verdict
 * vocabulary — so the studio screen shows continuity findings through the reader it
 * already has.
 *
 * Never throws, for the same reason as everything else here: this runs after a
 * render has been paid for.
 */
export async function checkContinuity(
  input: CheckContinuityInput,
): Promise<CheckContinuityResult> {
  const context = await loadContext(input.userId, input.project);
  if (!context.active) return { report: null, context };

  try {
    const report = validateContinuity({
      bible: context.bible,
      states: context.states,
      graph: context.graph,
      capabilities: context.plan.capabilities,
      thresholds: context.thresholds,
      visuals: input.visuals.map((visual) => ({
        sceneIndex: visual.sceneIndex,
        visualPrompt: visual.visualPrompt,
        searchTerms: visual.searchTerms,
        shotPrompt: visual.shotPrompt ?? null,
      })),
      voices: input.voices,
    });

    await recordContinuityCheck({
      userId: input.userId,
      projectId: input.project.projectId,
      report,
    });

    return { report, context };
  } catch (error) {
    log.error("continuity check failed", {
      projectId: input.project.projectId,
      error,
    });
    return { report: null, context };
  }
}

/**
 * Which scenes to regenerate, given a report.
 *
 * Three filters, in this order, and the order is the cost control:
 *
 *  1. Only a `fail` verdict regenerates anything. A `warn` is recorded and shown.
 *  2. The failed scenes plus their true downstream dependencies — from the graph,
 *     not "everything after scene five".
 *  3. Scenes already regenerated as many times as the threshold allows are dropped,
 *     and the whole set is capped. A scene that failed twice will not be fixed by a
 *     third paid attempt, and a video needing twenty regenerations has a bad bible
 *     rather than bad luck.
 *
 * Returns ascending scene indices, possibly empty.
 */
export async function scenesToRegenerate(args: {
  userId: string;
  projectId: string;
  context: ContinuityContext;
  report: ContinuityReport | null;
}): Promise<number[]> {
  const { report, context } = args;
  if (!report || !context.active || report.status !== "fail") return [];
  if (report.affectedScenes.length === 0) return [];

  const candidates = regenerationSet(context.graph, report.affectedScenes);

  const counts = await regenerationCounts(args.userId, args.projectId);
  const ceiling = context.thresholds.maxRegenerations;

  const eligible = candidates.filter(
    (sceneIndex) => (counts.get(sceneIndex) ?? 0) < ceiling,
  );

  if (eligible.length > ceiling) {
    log.info("capping continuity regenerations", {
      projectId: args.projectId,
      wanted: eligible.length,
      cap: ceiling,
    });
  }

  return eligible.slice(0, ceiling);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface ContinuitySettings {
  contentStyle: string | null;
  videoStyle: string | null;
  targetAudience: string | null;
}

/**
 * The three channel settings the level depends on.
 *
 * Read here rather than threaded through `loadSettings` in the video service,
 * because that function's return shape is consumed by the voiceover and caption
 * stages and widening it would make three stages depend on continuity's needs.
 */
async function loadContinuitySettings(
  channelId: string | null,
): Promise<ContinuitySettings> {
  if (!channelId) {
    return { contentStyle: null, videoStyle: null, targetAudience: null };
  }

  const rows = await db
    .select({
      contentStyle: channelSettings.contentStyle,
      videoStyle: channelSettings.videoStyle,
      targetAudience: channelSettings.targetAudience,
    })
    .from(channelSettings)
    .where(eq(channelSettings.channelId, channelId))
    .limit(1);

  return (
    rows[0] ?? { contentStyle: null, videoStyle: null, targetAudience: null }
  );
}

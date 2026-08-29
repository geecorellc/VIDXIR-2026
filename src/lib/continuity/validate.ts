/**
 * The continuity validator and its score (§11, §12).
 *
 * Deterministic, in the strong sense `research/scoring.ts` established: pure
 * functions over plain structs, no clock, no randomness, no provider call. The
 * same scene plan scores the same number every time, on every machine. That is
 * what makes the threshold in `config.ts` a decision rather than a guess, and it
 * is what lets a test pin the arithmetic.
 *
 * What it can and cannot check is worth being exact about, because the honest
 * version of this is more useful than an ambitious one:
 *
 *  - It **can** check that a scene's prompt actually carries the constraints its
 *    state committed to, that entity references resolve, that established state is
 *    respected, and that shots are not repeated. All of these are properties of the
 *    plan, and the plan is text.
 *  - It **cannot** check the rendered frames. There is no vision capability in the
 *    repository — no image analysis, no frame comparison — so a model that was
 *    given "brown coat" and drew a blue one is invisible here. The score never
 *    claims otherwise, and the finding codes say `prompt` where they mean prompt.
 *
 * Six components, per §12, each 0–100, combined by fixed weights.
 */

import {
  findCharacter,
  findEnvironment,
  findProp,
  hasStyle,
  type StoryBible,
} from "@/lib/continuity/bible";
import type { ContinuityThresholds, LevelCapabilities } from "@/lib/continuity/config";
import {
  actionableRepetitions,
  findRepetitions,
  type RepetitionFinding,
  type SceneVisual,
} from "@/lib/continuity/duplicate";
import {
  changesBefore,
  type IndexedSceneState,
  type SceneStateGraph,
} from "@/lib/continuity/scene-state";

/**
 * Severity, matching `quality_checks.findings` exactly.
 *
 * Not a new vocabulary: the findings this produces are written to the existing
 * `qualityChecks` table and read by the existing dashboard reader, so the shape is
 * that table's shape.
 */
export type FindingSeverity = "info" | "warn" | "fail";

export interface ContinuityIssue {
  /** Stable machine code, e.g. `continuity.character.missing_constraint`. */
  code: string;
  severity: FindingSeverity;
  message: string;
  detail?: string;
  /** Scene this concerns, or null for a whole-video issue. */
  sceneIndex: number | null;
  /** Bible entity this concerns, or null. */
  entityId: string | null;
}

/** The six components §12 names. Each 0–100, higher is better. */
export interface ContinuityComponents {
  characterConsistency: number;
  environmentConsistency: number;
  propContinuity: number;
  storyContinuity: number;
  styleConsistency: number;
  /** Inverted, like the others: 100 means no unwanted repetition. */
  duplicateRisk: number;
}

export type ContinuityStatus = "pass" | "warn" | "fail";

export interface ContinuityReport {
  /** 0–100, integer. */
  score: number;
  status: ContinuityStatus;
  components: ContinuityComponents;
  issues: readonly ContinuityIssue[];
  /** Scenes with at least one `fail` issue — the regeneration candidates. */
  affectedScenes: readonly number[];
  /** Bible entities named by at least one issue. */
  affectedEntities: readonly string[];
  repetitions: readonly RepetitionFinding[];
}

/**
 * Component weights.
 *
 * Characters carry the most because a face changing is what a viewer notices
 * first; style is next because it is present in every frame. `duplicateRisk` is
 * weighted low — repetition is a quality problem rather than a continuity break,
 * and it is the component most likely to be a false positive given the textual
 * comparison behind it.
 *
 * Components a level does not ask for are excluded and their weight redistributed,
 * so a `style`-level video is not marked down for having no cast.
 */
const WEIGHTS: Record<keyof ContinuityComponents, number> = {
  characterConsistency: 30,
  environmentConsistency: 15,
  propContinuity: 10,
  storyContinuity: 15,
  styleConsistency: 20,
  duplicateRisk: 10,
};

export interface ValidateInput {
  bible: StoryBible;
  states: readonly IndexedSceneState[];
  graph: SceneStateGraph;
  capabilities: LevelCapabilities;
  thresholds: ContinuityThresholds;
  /**
   * The prompt each scene was actually built with, and its search terms.
   *
   * The prompt as *sent*, not as planned: this is what checks that the continuity
   * block survived into the request. Passing the pre-continuity prompt here would
   * make the check pass for a bug that dropped it.
   */
  visuals: readonly SceneVisual[];
}

/**
 * Validate a scene plan against its bible.
 *
 * Every component starts at 100 and loses points for concrete findings, which is
 * the same shape as `research/scoring.ts` and has the same property: a video with
 * nothing wrong scores 100 without needing a model to agree that it is good.
 */
export function validateContinuity(input: ValidateInput): ContinuityReport {
  const issues: ContinuityIssue[] = [];
  const visualBy = new Map(input.visuals.map((v) => [v.sceneIndex, v]));

  const character = checkCharacters(input, visualBy, issues);
  const environment = checkEnvironments(input, visualBy, issues);
  const props = checkProps(input, visualBy, issues);
  const story = checkStory(input, issues);
  const style = checkStyle(input, issues);

  const repetitions = input.capabilities.duplicates
    ? findRepetitions({
        visuals: input.visuals,
        states: input.states,
        thresholds: input.thresholds,
      })
    : [];

  const duplicates = actionableRepetitions(repetitions);
  for (const finding of duplicates) {
    issues.push({
      code: "continuity.duplicate.shot",
      severity: "fail",
      message: finding.reason,
      detail: `Similarity ${finding.similarity.toFixed(3)}.`,
      sceneIndex: finding.sceneIndex,
      entityId: null,
    });
  }
  for (const finding of repetitions.filter((f) => f.classification === "suspicious")) {
    issues.push({
      code: "continuity.duplicate.suspected",
      severity: "warn",
      message: finding.reason,
      detail: `Similarity ${finding.similarity.toFixed(3)}.`,
      sceneIndex: finding.sceneIndex,
      entityId: null,
    });
  }

  const sceneCount = Math.max(1, input.visuals.length);
  const components: ContinuityComponents = {
    characterConsistency: character,
    environmentConsistency: environment,
    propContinuity: props,
    storyContinuity: story,
    styleConsistency: style,
    duplicateRisk: penalise(100, duplicates.length, sceneCount, 100),
  };

  const score = combine(components, input.capabilities);
  const status = statusFor(score, input.thresholds);

  const affectedScenes = [
    ...new Set(
      issues
        .filter((issue) => issue.severity === "fail" && issue.sceneIndex !== null)
        .map((issue) => issue.sceneIndex as number),
    ),
  ].sort((a, b) => a - b);

  const affectedEntities = [
    ...new Set(
      issues
        .filter((issue) => issue.entityId !== null)
        .map((issue) => issue.entityId as string),
    ),
  ].sort();

  return {
    score,
    status,
    components,
    issues,
    affectedScenes,
    affectedEntities,
    repetitions,
  };
}

// ---------------------------------------------------------------------------
// Component checks
// ---------------------------------------------------------------------------

type VisualIndex = ReadonlyMap<number, SceneVisual>;

/**
 * Does each scene's prompt carry the appearance facts its character needs?
 *
 * The check that catches the failure mode this layer exists for: a scene state
 * says Mara is present, the bible says Mara wears a brown coat, and the prompt
 * that went to the provider mentions neither. That scene will draw a different
 * Mara, and no amount of instruction elsewhere prevents it.
 *
 * Matching is on the character's *name* plus at least one distinguishing fact. Name
 * alone is not enough — a generator has never heard of Mara — and requiring every
 * fact would fail on the truncation `buildContinuityPrompt` legitimately performs.
 */
function checkCharacters(
  input: ValidateInput,
  visuals: VisualIndex,
  issues: ContinuityIssue[],
): number {
  if (!input.capabilities.characters) return 100;

  let expected = 0;
  let missing = 0;

  for (const entry of ordered(input.states)) {
    const visual = visuals.get(entry.sceneIndex);

    for (const id of entry.state.characters) {
      const character = findCharacter(input.bible, id);

      if (!character) {
        issues.push({
          code: "continuity.character.unknown",
          severity: "warn",
          message: `Scene ${entry.sceneIndex} references a character that is not in the story bible.`,
          detail: `Character id: ${id}.`,
          sceneIndex: entry.sceneIndex,
          entityId: id,
        });
        continue;
      }

      const facts = [...character.appearance, ...character.wardrobe];
      if (facts.length === 0) continue;

      expected += 1;

      const prompt = (visual?.visualPrompt ?? "").toLowerCase();
      const named = prompt.includes(character.name.toLowerCase());
      const described = facts.some((fact) => containsFact(prompt, fact));

      if (!named || !described) {
        missing += 1;
        issues.push({
          code: "continuity.character.missing_constraint",
          severity: "fail",
          message:
            `Scene ${entry.sceneIndex} features ${character.name} but its prompt does not ` +
            "carry that character's fixed appearance.",
          detail: named
            ? `None of ${facts.length} appearance facts appear in the prompt.`
            : `The name "${character.name}" does not appear in the prompt.`,
          sceneIndex: entry.sceneIndex,
          entityId: character.id,
        });
      }
    }
  }

  return penalise(100, missing, expected, 100);
}

/** The same check for places. */
function checkEnvironments(
  input: ValidateInput,
  visuals: VisualIndex,
  issues: ContinuityIssue[],
): number {
  if (!input.capabilities.environments) return 100;

  let expected = 0;
  let missing = 0;

  for (const entry of ordered(input.states)) {
    const id = entry.state.environment;
    if (!id) continue;

    const environment = findEnvironment(input.bible, id);
    if (!environment) {
      issues.push({
        code: "continuity.environment.unknown",
        severity: "warn",
        message: `Scene ${entry.sceneIndex} references a location that is not in the story bible.`,
        detail: `Location id: ${id}.`,
        sceneIndex: entry.sceneIndex,
        entityId: id,
      });
      continue;
    }

    const facts = [
      ...environment.description,
      ...(environment.lighting ? [environment.lighting] : []),
    ];
    if (facts.length === 0) continue;

    expected += 1;

    const prompt = (visuals.get(entry.sceneIndex)?.visualPrompt ?? "").toLowerCase();
    if (!facts.some((fact) => containsFact(prompt, fact))) {
      missing += 1;
      issues.push({
        code: "continuity.environment.missing_constraint",
        severity: "fail",
        message:
          `Scene ${entry.sceneIndex} is set in ${environment.name} but its prompt does not ` +
          "describe that location.",
        sceneIndex: entry.sceneIndex,
        entityId: environment.id,
      });
    }
  }

  return penalise(100, missing, expected, 100);
}

/**
 * Props, and whether established state is carried forward.
 *
 * A missing prop is a warning rather than a failure: a prop that is in a scene's
 * state but not in its prompt is often a planner listing something incidental, and
 * regenerating a paid clip over an unmentioned teacup is the wrong trade. Losing an
 * established *change* is the harder finding, because it is the one that reads as
 * an error on screen.
 */
function checkProps(
  input: ValidateInput,
  visuals: VisualIndex,
  issues: ContinuityIssue[],
): number {
  if (!input.capabilities.props) return 100;

  let expected = 0;
  let missing = 0;

  for (const entry of ordered(input.states)) {
    const prompt = (visuals.get(entry.sceneIndex)?.visualPrompt ?? "").toLowerCase();

    for (const id of entry.state.props) {
      const prop = findProp(input.bible, id);
      if (!prop) {
        issues.push({
          code: "continuity.prop.unknown",
          severity: "warn",
          message: `Scene ${entry.sceneIndex} references an object that is not in the story bible.`,
          detail: `Object id: ${id}.`,
          sceneIndex: entry.sceneIndex,
          entityId: id,
        });
        continue;
      }

      if (prop.description.length === 0) continue;
      expected += 1;

      if (
        !prompt.includes(prop.name.toLowerCase()) &&
        !prop.description.some((fact) => containsFact(prompt, fact))
      ) {
        missing += 1;
        issues.push({
          code: "continuity.prop.missing_constraint",
          severity: "warn",
          message: `Scene ${entry.sceneIndex} lists ${prop.name} but its prompt does not mention it.`,
          sceneIndex: entry.sceneIndex,
          entityId: prop.id,
        });
      }
    }
  }

  return penalise(100, missing, expected, 60);
}

/**
 * Story continuity: does the plan hold together as a sequence?
 *
 * Three deterministic claims, and no more. Anything further — whether the plot
 * makes sense, whether the arc lands — is a judgement, and §29 is explicit that
 * deterministic checks must not be replaced by an LLM's opinion. So this checks
 * structure, not quality:
 *
 *  1. A scene may not depend on a scene that was never planned.
 *  2. An entity may not first appear at the climax with no setup, when the level
 *     tracks characters.
 *  3. A change established earlier must not be contradicted by a later scene
 *     re-establishing the same thing.
 */
function checkStory(input: ValidateInput, issues: ContinuityIssue[]): number {
  const states = ordered(input.states);
  if (states.length === 0) return 100;

  const planned = new Set(states.map((entry) => entry.sceneIndex));
  let problems = 0;

  for (const entry of states) {
    const echo = entry.state.echoesSceneIndex;
    if (echo !== null && !planned.has(echo)) {
      problems += 1;
      issues.push({
        code: "continuity.story.dangling_echo",
        severity: "warn",
        message: `Scene ${entry.sceneIndex} echoes scene ${echo}, which is not in the plan.`,
        sceneIndex: entry.sceneIndex,
        entityId: null,
      });
    }

    // A change repeated verbatim after it was already established means two scenes
    // both claim to be the moment it happened.
    const earlier = new Set(
      changesBefore(states, entry.sceneIndex).map((c) => c.trim().toLowerCase()),
    );
    for (const change of entry.state.changes) {
      if (earlier.has(change.trim().toLowerCase())) {
        problems += 1;
        issues.push({
          code: "continuity.story.restated_change",
          severity: "warn",
          message:
            `Scene ${entry.sceneIndex} establishes something an earlier scene already ` +
            "established.",
          detail: change,
          sceneIndex: entry.sceneIndex,
          entityId: null,
        });
      }
    }
  }

  if (input.capabilities.characters) {
    for (const entry of states) {
      if (entry.state.beat !== "climax") continue;

      for (const id of entry.state.characters) {
        const origin = input.graph.establishedBy.get(`character:${id}`);
        if (origin === entry.sceneIndex) {
          problems += 1;
          issues.push({
            code: "continuity.story.late_introduction",
            severity: "warn",
            message:
              `${findCharacter(input.bible, id)?.name ?? id} first appears at the climax ` +
              `in scene ${entry.sceneIndex}, with no earlier setup.`,
            sceneIndex: entry.sceneIndex,
            entityId: id,
          });
        }
      }
    }
  }

  return penalise(100, problems, states.length, 50);
}

/**
 * Style consistency: is the video's look asserted in every scene?
 *
 * Whole-video rather than per-entity, because that is what style is. A scene whose
 * prompt carries none of the style facts will be drawn in whatever the model's
 * default is, and one photoreal frame in a hand-drawn video is the most visible
 * continuity failure of all.
 */
function checkStyle(input: ValidateInput, issues: ContinuityIssue[]): number {
  if (!input.capabilities.style || !hasStyle(input.bible.style)) return 100;

  const style = input.bible.style;
  const facts = [
    ...(style.medium ? [style.medium] : []),
    ...style.palette,
    ...(style.lighting ? [style.lighting] : []),
    ...(style.camera ? [style.camera] : []),
  ];
  if (facts.length === 0) return 100;

  const scenes = input.visuals.length;
  if (scenes === 0) return 100;

  let missing = 0;

  for (const visual of [...input.visuals].sort((a, b) => a.sceneIndex - b.sceneIndex)) {
    const prompt = (visual.visualPrompt ?? "").toLowerCase();
    if (!facts.some((fact) => containsFact(prompt, fact))) {
      missing += 1;
      issues.push({
        code: "continuity.style.missing_constraint",
        severity: "fail",
        message: `Scene ${visual.sceneIndex}'s prompt does not carry the video's visual style.`,
        detail: `Expected one of: ${facts.join("; ")}.`,
        sceneIndex: visual.sceneIndex,
        entityId: null,
      });
    }
  }

  return penalise(100, missing, scenes, 100);
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

function ordered(states: readonly IndexedSceneState[]): IndexedSceneState[] {
  return [...states].sort((a, b) => a.sceneIndex - b.sceneIndex);
}

/**
 * Is a fact present in a prompt?
 *
 * A fact is a phrase like "long brown coat"; the prompt may have written "a long,
 * brown coat". Whole-phrase matching would miss that, and single-word matching
 * would match "coat" against "coat of paint". So the test is: every word of the
 * fact longer than three characters appears somewhere in the prompt.
 *
 * Both sides are already lowercased by the callers.
 */
function containsFact(prompt: string, fact: string): boolean {
  const words = fact
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3);

  if (words.length === 0) {
    // A fact of only short words ("red hat") — fall back to substring.
    return prompt.includes(fact.toLowerCase().trim());
  }

  return words.every((word) => prompt.includes(word));
}

/**
 * Deduct proportionally, capped.
 *
 * `misses / expected` scaled by `maxPenalty`, so one bad scene in eighty barely
 * moves the component while half the video failing takes it to the floor. Integer
 * result: a component of 87.33333 is not more informative than 87, and rounding at
 * the component keeps `combine` from accumulating float noise.
 */
function penalise(
  base: number,
  misses: number,
  expected: number,
  maxPenalty: number,
): number {
  if (expected <= 0 || misses <= 0) return base;
  const ratio = Math.min(1, misses / expected);
  return Math.max(0, Math.round(base - ratio * maxPenalty));
}

/**
 * Weighted mean over the components this level actually asks for.
 *
 * Excluded components are dropped from both the numerator and the denominator
 * rather than scored 100, which would let a `style`-level video reach 100 with a
 * broken style by averaging in four irrelevant perfect scores.
 */
function combine(
  components: ContinuityComponents,
  capabilities: LevelCapabilities,
): number {
  const active: Array<keyof ContinuityComponents> = [];

  if (capabilities.characters) active.push("characterConsistency");
  if (capabilities.environments) active.push("environmentConsistency");
  if (capabilities.props) active.push("propContinuity");
  if (capabilities.style) active.push("styleConsistency");
  if (capabilities.duplicates) active.push("duplicateRisk");
  // Story structure is checked whenever anything is, because it needs no entity
  // support — it is a property of the scene sequence itself.
  if (active.length > 0) active.push("storyContinuity");

  if (active.length === 0) return 100;

  const totalWeight = active.reduce((sum, key) => sum + WEIGHTS[key], 0);
  const weighted = active.reduce(
    (sum, key) => sum + components[key] * WEIGHTS[key],
    0,
  );

  return Math.round(weighted / totalWeight);
}

export function statusFor(
  score: number,
  thresholds: ContinuityThresholds,
): ContinuityStatus {
  if (score >= thresholds.pass) return "pass";
  if (score < thresholds.fail) return "fail";
  return "warn";
}

/**
 * The issues for one scene, as plain messages.
 *
 * Feeds `regenerationPrompt`: a regenerated scene is told what was wrong with it,
 * which is §13's requirement and the difference between a fix and a second dice
 * roll.
 */
export function issuesForScene(
  report: ContinuityReport,
  sceneIndex: number,
): string[] {
  return report.issues
    .filter(
      (issue) => issue.sceneIndex === sceneIndex && issue.severity === "fail",
    )
    .map((issue) => (issue.detail ? `${issue.message} ${issue.detail}` : issue.message));
}

/**
 * The report as `quality_checks.findings` rows.
 *
 * The existing table's exact shape — `{code, severity, message, detail?}` — so the
 * dashboard reader that already renders quality findings renders these with no
 * change. The scene index rides in `detail` rather than in a new column, because
 * adding a column to a completed migration is not on the table and the findings
 * blob is where per-item context already lives.
 */
export function toQualityFindings(report: ContinuityReport): Array<{
  code: string;
  severity: FindingSeverity;
  message: string;
  detail?: string;
}> {
  const summary = {
    code: "continuity.score",
    severity:
      report.status === "fail"
        ? ("fail" as const)
        : report.status === "warn"
          ? ("warn" as const)
          : ("info" as const),
    message: `Continuity score ${report.score}/100 (${report.status}).`,
    detail: Object.entries(report.components)
      .map(([key, value]) => `${key} ${value}`)
      .join(", "),
  };

  return [
    summary,
    ...report.issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      detail: [
        issue.sceneIndex !== null ? `scene ${issue.sceneIndex}` : null,
        issue.entityId !== null ? `entity ${issue.entityId}` : null,
        issue.detail ?? null,
      ]
        .filter((part): part is string => part !== null)
        .join(" · "),
    })),
  ];
}

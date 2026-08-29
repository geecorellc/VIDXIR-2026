/**
 * Repetition detection (§10) — and the distinction that makes it useful.
 *
 * Two scenes describing the same shot is sometimes a defect and sometimes the
 * format. A children's song repeating "clap your hands" over four verses is
 * *supposed* to show the same clapping hands; a listicle's recurring title card is
 * supposed to recur. A five-minute explainer showing the identical laptop shot at
 * 0:30 and 3:10 is a planner that ran out of ideas. Flagging both the same way
 * would train the operator to ignore the flag.
 *
 * So this returns a three-way classification, never a boolean:
 *
 *  - `intentional` — the story asked for it. A `refrain` beat, or an explicit
 *    `echoesSceneIndex`. Never an issue, however identical.
 *  - `suspicious` — similar, not identical, with nothing declaring it deliberate.
 *    Reported as a warning; does not trigger a paid regeneration on its own.
 *  - `duplicate` — effectively the same shot, undeclared. This is the finding.
 *
 * Comparison is textual and deterministic. That is a real limit, stated rather
 * than hidden: two prompts that read differently can still generate near-identical
 * footage, and this cannot see that — no vision capability exists in the
 * repository to compare the frames with. What it can do is catch the planner
 * repeating itself, which is where automated repetition actually comes from, and
 * it costs nothing to run.
 */

import type { ContinuityThresholds } from "@/lib/continuity/config";
import type { IndexedSceneState } from "@/lib/continuity/scene-state";

export const REPETITION_CLASSES = [
  "intentional",
  "suspicious",
  "duplicate",
] as const;

export type RepetitionClass = (typeof REPETITION_CLASSES)[number];

export interface RepetitionFinding {
  /** The later of the two scenes — the one that would be regenerated. */
  sceneIndex: number;
  /** The earlier scene it repeats. */
  matchesSceneIndex: number;
  classification: RepetitionClass;
  /** 0–1, rounded to three places so the score is stable across platforms. */
  similarity: number;
  /** Why it was classified this way. Human-readable, never parsed. */
  reason: string;
}

export interface SceneVisual {
  sceneIndex: number;
  /** The visual direction. Null for a scene the director skipped. */
  visualPrompt: string | null;
  /** Stock/generation search terms, which carry signal of their own. */
  searchTerms: readonly string[];
  /**
   * The scene's own direction, with the continuity block removed.
   *
   * Set by the caller when `visualPrompt` is the prompt *as sent to the provider*,
   * which is what the constraint checks in `validate.ts` need to read. Repetition
   * detection must not read it: the continuity block is deliberately near-identical
   * across every scene sharing a cast, so comparing full prompts makes two unrelated
   * shots of the same character look like the same shot. On a video with one recurring
   * character that inflates every pair towards the duplicate mark, and a duplicate is
   * a `fail` — it spends a paid regeneration.
   *
   * Omitted or null means `visualPrompt` carries no continuity block and is itself
   * the shot description.
   */
  shotPrompt?: string | null;
}

/**
 * Words too common to carry meaning in a shot description.
 *
 * Kept small and specific to this domain. A general stop-word list would strip
 * "close" and "wide", which are exactly the words that distinguish two shots of
 * the same subject.
 */
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "over",
  "shot",
  "the",
  "to",
  "with",
]);

/**
 * Similarity of two shot descriptions, 0–1.
 *
 * Jaccard over content words. Chosen over an edit distance because word order is
 * not meaningful here — "a wide shot of a red door" and "a red door, wide shot"
 * are the same shot — and over an embedding because that would be a provider call
 * per pair, which §21 rules out for a comparison this mechanical.
 *
 * Reads `shotPrompt` in preference to `visualPrompt`, so what is compared is each
 * scene's own direction rather than the shared continuity boilerplate appended to it.
 *
 * Rounded to three decimals: the raw ratio is a float division, and a score that
 * differs in the fifteenth digit between two machines is not deterministic in any
 * sense that helps.
 */
export function shotSimilarity(left: SceneVisual, right: SceneVisual): number {
  const a = contentWords(left);
  const b = contentWords(right);

  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const word of a) {
    if (b.has(word)) shared += 1;
  }

  const union = a.size + b.size - shared;
  if (union === 0) return 0;

  return Math.round((shared / union) * 1000) / 1000;
}

function contentWords(visual: SceneVisual): Set<string> {
  // `shotPrompt ?? visualPrompt`, not a concatenation: including the full prompt would
  // reintroduce the continuity block this exists to exclude.
  const shot = visual.shotPrompt ?? visual.visualPrompt ?? "";
  const text = [shot, ...visual.searchTerms].join(" ");

  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}

/**
 * Find every repeated shot in a scene plan.
 *
 * Compares each scene against all earlier ones — O(n²) on scene count, which is
 * bounded at 120 by `MAX_SCENES` and is string work on a few dozen words, so the
 * whole pass is microseconds. Only the *closest* earlier match is reported per
 * scene: a title card repeated eight times should produce seven findings, not
 * twenty-eight.
 *
 * Findings are ascending by scene index, so the output order is fixed.
 */
export function findRepetitions(args: {
  visuals: readonly SceneVisual[];
  states: readonly IndexedSceneState[];
  thresholds: ContinuityThresholds;
}): RepetitionFinding[] {
  const { visuals, states, thresholds } = args;
  const ordered = [...visuals].sort((a, b) => a.sceneIndex - b.sceneIndex);
  const stateBy = new Map(states.map((entry) => [entry.sceneIndex, entry.state]));

  const findings: RepetitionFinding[] = [];

  for (const [position, scene] of ordered.entries()) {
    let best: { other: SceneVisual; similarity: number } | null = null;

    for (let earlier = 0; earlier < position; earlier += 1) {
      const other = ordered[earlier];
      if (!other) continue;

      const similarity = shotSimilarity(scene, other);
      if (similarity < thresholds.suspicious) continue;
      // Strictly greater keeps the *earliest* of equally-similar matches, which is
      // the scene that established the shot.
      if (!best || similarity > best.similarity) best = { other, similarity };
    }

    if (!best) continue;

    const state = stateBy.get(scene.sceneIndex);
    const declaredEcho = state?.echoesSceneIndex === best.other.sceneIndex;
    const refrain = state?.beat === "refrain";

    if (declaredEcho) {
      findings.push({
        sceneIndex: scene.sceneIndex,
        matchesSceneIndex: best.other.sceneIndex,
        classification: "intentional",
        similarity: best.similarity,
        reason: `Scene ${scene.sceneIndex} deliberately echoes scene ${best.other.sceneIndex}.`,
      });
      continue;
    }

    if (refrain) {
      findings.push({
        sceneIndex: scene.sceneIndex,
        matchesSceneIndex: best.other.sceneIndex,
        classification: "intentional",
        similarity: best.similarity,
        reason: `Scene ${scene.sceneIndex} is a refrain; repetition is the format.`,
      });
      continue;
    }

    const duplicate = best.similarity >= thresholds.duplicate;

    findings.push({
      sceneIndex: scene.sceneIndex,
      matchesSceneIndex: best.other.sceneIndex,
      classification: duplicate ? "duplicate" : "suspicious",
      similarity: best.similarity,
      reason: duplicate
        ? `Scene ${scene.sceneIndex} describes the same shot as scene ${best.other.sceneIndex}.`
        : `Scene ${scene.sceneIndex} closely resembles scene ${best.other.sceneIndex}.`,
    });
  }

  return findings;
}

/** Findings that represent a real defect — what the score and §13 act on. */
export function actionableRepetitions(
  findings: readonly RepetitionFinding[],
): RepetitionFinding[] {
  return findings.filter((finding) => finding.classification === "duplicate");
}

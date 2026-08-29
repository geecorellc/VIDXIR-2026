/**
 * Turning continuity data into the words a generator receives.
 *
 * This module is the answer to §7, and the shape of it is the point: a scene's
 * prompt gets **the specific facts that scene is committed to**, not an
 * instruction to be consistent. "Keep the character consistent" tells a model
 * nothing it can act on — it has no memory of the previous call, so the only
 * consistency available is the consistency written into this prompt. So what goes
 * in is the wardrobe, the palette, the lighting and the state changes, verbatim
 * and in a fixed order.
 *
 * Text-only, deliberately. No catalogued model accepts a caller-supplied
 * reference image today, so §8's stated fallback — "detailed textual continuity
 * constraints" — is the behaviour for every model, and this module is that
 * fallback in full rather than a placeholder for it. The seam is here: when a
 * reference-capable model is added to the catalogue, `buildContinuityPrompt`
 * gains a branch, and nothing above it changes.
 *
 * Everything is pure and deterministic. The same bible, state and graph produce
 * byte-identical text, which is what lets `prompt.test.ts` assert continuity
 * rather than eyeball it.
 */

import {
  findCharacter,
  findEnvironment,
  findProp,
  hasStyle,
  type StoryBible,
} from "@/lib/continuity/bible";
import type { LevelCapabilities } from "@/lib/continuity/config";
import {
  changesBefore,
  type IndexedSceneState,
  type SceneState,
  type SceneStateGraph,
} from "@/lib/continuity/scene-state";

/**
 * Ceiling on the continuity block, in characters.
 *
 * The provider layer already truncates a prompt (FAL slices at 1,500), and a
 * continuity block that consumed the whole budget would push out the shot
 * description — leaving a model with a wardrobe and no idea what is happening.
 * 900 characters is room for a cast of three plus a style, and it is enforced by
 * dropping whole clauses in reverse priority order rather than by cutting a
 * sentence in half.
 */
export const MAX_CONTINUITY_CHARS = 900;

export interface ContinuityPromptInput {
  bible: StoryBible;
  /** The scene being generated. */
  state: SceneState;
  sceneIndex: number;
  /** Every scene's state, for accumulated changes. */
  allStates: readonly IndexedSceneState[];
  graph: SceneStateGraph;
  capabilities: LevelCapabilities;
}

/**
 * One continuity clause, with the priority that decides what survives truncation.
 *
 * Lower `weight` is dropped first. Style outranks props because a palette shift is
 * visible in every frame while a missing teacup is not; characters outrank both
 * because a face changing is the failure viewers actually notice.
 */
interface Clause {
  weight: number;
  text: string;
}

/**
 * Build the continuity constraints for one scene.
 *
 * Returns an empty string when there is nothing to say — an empty bible, a level
 * that asks for nothing, or a scene committed to no entities. The caller appends
 * the result, so an empty string means the prompt is exactly what it would have
 * been before this layer existed. That is what keeps §25 true.
 */
export function buildContinuityPrompt(input: ContinuityPromptInput): string {
  const clauses: Clause[] = [];

  if (input.capabilities.characters) {
    for (const id of input.state.characters) {
      const character = findCharacter(input.bible, id);
      if (!character) continue;

      const facts = [
        ...character.appearance,
        ...character.wardrobe,
        ...(character.demeanour ? [character.demeanour] : []),
      ];
      if (facts.length === 0) continue;

      // The name is included so a multi-character scene is unambiguous about
      // which description belongs to whom.
      clauses.push({
        weight: 100,
        text: `${character.name}: ${joinFacts(facts)}.`,
      });
    }
  }

  if (input.capabilities.environments && input.state.environment) {
    const environment = findEnvironment(input.bible, input.state.environment);
    if (environment) {
      const facts = [
        ...environment.description,
        ...(environment.lighting ? [environment.lighting] : []),
        ...environment.palette,
      ];
      if (facts.length > 0) {
        clauses.push({
          weight: 80,
          text: `Location — ${environment.name}: ${joinFacts(facts)}.`,
        });
      }
    }
  }

  if (input.capabilities.style && hasStyle(input.bible.style)) {
    const style = input.bible.style;
    const facts = [
      ...(style.medium ? [style.medium] : []),
      ...style.palette,
      ...(style.lighting ? [style.lighting] : []),
      ...(style.camera ? [style.camera] : []),
      ...style.notes,
    ];
    if (facts.length > 0) {
      clauses.push({ weight: 90, text: `Consistent style: ${joinFacts(facts)}.` });
    }
  }

  if (input.capabilities.props) {
    const props = input.state.props
      .map((id) => findProp(input.bible, id))
      .filter((prop): prop is NonNullable<typeof prop> => prop !== undefined)
      .filter((prop) => prop.description.length > 0);

    if (props.length > 0) {
      clauses.push({
        weight: 60,
        text: `Objects present: ${props
          .map((prop) => `${prop.name} (${joinFacts(prop.description)})`)
          .join("; ")}.`,
      });
    }

    // Accumulated state, oldest first. A change established in scene four is still
    // true in scene nine, so the whole prefix is carried rather than the last one.
    const changes = changesBefore(input.allStates, input.sceneIndex);
    if (changes.length > 0) {
      clauses.push({
        weight: 70,
        text: `Already established: ${joinFacts(dedupe(changes))}.`,
      });
    }
  }

  if (clauses.length === 0) return "";

  return fit(clauses, MAX_CONTINUITY_CHARS);
}

/**
 * Attach the continuity block to a scene's own visual direction.
 *
 * Order matters and is the reverse of what looks natural: the shot comes first,
 * the constraints after. A model reading a wall of wardrobe notes before it learns
 * what the scene *is* produces a portrait of the wardrobe. The label ("Continuity
 * — must match exactly") is what makes the block read as a constraint rather than
 * as more scene description.
 */
export function withContinuity(visualPrompt: string, continuity: string): string {
  const shot = visualPrompt.trim();
  const block = continuity.trim();

  if (block === "") return shot;
  if (shot === "") return block;

  return `${shot}\n\nContinuity — must match exactly: ${block}`;
}

/**
 * The regeneration prompt for a scene that failed continuity.
 *
 * §13's requirement: the prompt carries the actual failure, not a generic retry.
 * A model told "the character's coat was blue and must be brown" has something to
 * act on; one told "try again" produces another random draw, and paying twice for
 * the same distribution is not a fix.
 *
 * `issues` are the human-readable messages from the validator, already scoped to
 * this scene by the caller.
 */
export function regenerationPrompt(args: {
  visualPrompt: string;
  continuity: string;
  issues: readonly string[];
}): string {
  const base = withContinuity(args.visualPrompt, args.continuity);
  const issues = args.issues.map((issue) => issue.trim()).filter(Boolean);

  if (issues.length === 0) return base;

  return (
    `${base}\n\nThe previous attempt at this shot was rejected for these reasons. ` +
    `Correct them:\n${issues.map((issue) => `- ${issue}`).join("\n")}`
  );
}

/**
 * Continuity context for the scene *planner*, not for a generator.
 *
 * A different job and therefore a different shape: the planner is choosing what
 * each scene shows, so it needs the cast list and the established look, and it
 * needs them once for the whole video rather than per scene. Fed into
 * `directScenes` alongside the niche and style it already receives.
 */
export function plannerContext(
  bible: StoryBible,
  capabilities: LevelCapabilities,
): string {
  const lines: string[] = [];

  if (bible.premise) lines.push(`Premise: ${bible.premise}`);
  if (bible.structure) lines.push(`Structure: ${bible.structure}`);
  if (bible.tone) lines.push(`Tone: ${bible.tone}`);

  if (capabilities.characters && bible.characters.length > 0) {
    lines.push("");
    lines.push("Cast — refer to these by id when a scene features them:");
    for (const character of bible.characters) {
      const facts = [
        ...(character.role ? [character.role] : []),
        ...character.appearance,
        ...character.wardrobe,
      ];
      lines.push(`- ${character.id} (${character.name}): ${joinFacts(facts)}`);
    }
  }

  if (capabilities.environments && bible.environments.length > 0) {
    lines.push("");
    lines.push("Locations:");
    for (const environment of bible.environments) {
      lines.push(
        `- ${environment.id} (${environment.name}): ${joinFacts([
          ...environment.description,
          ...(environment.lighting ? [environment.lighting] : []),
        ])}`,
      );
    }
  }

  if (capabilities.props && bible.props.length > 0) {
    lines.push("");
    lines.push("Objects:");
    for (const prop of bible.props) {
      lines.push(`- ${prop.id} (${prop.name}): ${joinFacts(prop.description)}`);
    }
  }

  if (capabilities.style && hasStyle(bible.style)) {
    const style = bible.style;
    lines.push("");
    lines.push(
      `Visual style, applied to every scene: ${joinFacts([
        ...(style.medium ? [style.medium] : []),
        ...style.palette,
        ...(style.lighting ? [style.lighting] : []),
        ...(style.camera ? [style.camera] : []),
      ])}`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Join descriptive facts into one clause.
 *
 * Comma-separated rather than sentence-per-fact: the block is read as a list of
 * constraints, and eight short sentences read as eight instructions competing with
 * the shot description.
 */
function joinFacts(facts: readonly string[]): string {
  return facts
    .map((fact) => fact.trim().replace(/[.;]+$/, ""))
    .filter(Boolean)
    .join(", ");
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
  }
  return out;
}

/**
 * Fit clauses into the budget by dropping whole clauses, lowest weight first.
 *
 * Never truncates mid-clause. A half-written wardrobe — "brown coat, grey bea" —
 * is worse than no wardrobe: the model completes it, and completes it differently
 * on every scene, which is the exact drift this layer exists to prevent.
 *
 * Ties are broken by original order, so the output is stable.
 */
function fit(clauses: readonly Clause[], budget: number): string {
  const ordered = clauses
    .map((clause, position) => ({ ...clause, position }))
    .sort((a, b) => b.weight - a.weight || a.position - b.position);

  const kept: typeof ordered = [];
  let length = 0;

  for (const clause of ordered) {
    const cost = clause.text.length + (kept.length > 0 ? 1 : 0);
    if (length + cost > budget) continue;
    kept.push(clause);
    length += cost;
  }

  // Back into the caller's order, so the text reads in the order it was built.
  return kept
    .sort((a, b) => a.position - b.position)
    .map((clause) => clause.text)
    .join(" ");
}

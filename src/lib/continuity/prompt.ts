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
 * The *scene* prompt is text-only, deliberately — and stays text-only even on the one
 * model that now accepts reference stills. §8's fallback ("detailed textual continuity
 * constraints") is the behaviour for every model without reference support, which is
 * most of the catalogue, and it is the behaviour *alongside* the stills on Tal 3.1
 * rather than instead of it: a still shows a face and a coat, and it cannot express a
 * state change, a lighting note or an entity the scene must not contain. Sending both
 * costs nothing extra and degrades cleanly — if the vendor drops a reference, or the
 * operator has pinned a model version that takes none, the words are still there.
 *
 * So this module is not a placeholder and gains no branch for reference-capable models.
 * Which stills a scene gets is `referencesForScene`'s decision, in `service.ts`.
 *
 * `referenceImagePrompt` is the other direction: it describes one bible entity to an
 * *image* model, so the reference still exists and is stored whether or not the
 * project's video backend can be handed it. That ordering was deliberate and has now
 * paid off — a reference image is worth having on its own, since it is what a human
 * reviews to say "no, her coat is wrong" before eighty scenes are paid for, and because
 * the library was already there, Tal 3.1's reference support needed no new generator.
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
 * The provider layer already truncates a prompt (every backend slices at 1,500), and a
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

// ---------------------------------------------------------------------------
// Reference stills (§5, §6)
// ---------------------------------------------------------------------------

/**
 * Which kind of bible entity a reference still is for.
 *
 * Deliberately the same three words `ImagePurpose` uses for its continuity members,
 * because the value is passed straight through to the provider and stored on the
 * asset: one vocabulary means a stored reference can be found by what it is for
 * without a translation table that can drift.
 */
export type ReferenceKind = "character" | "environment" | "prop";

export interface ReferenceImagePrompt {
  kind: ReferenceKind;
  /** The bible entity's slug. What the asset is keyed by, so it can be found again. */
  entityId: string;
  /** Display name, for a caption in the review UI. */
  name: string;
  prompt: string;
}

/**
 * Ceiling on one reference prompt.
 *
 * Larger than `MAX_CONTINUITY_CHARS` because the opposite trade applies: a scene
 * prompt must leave room for the shot, while a reference prompt *is* the shot — the
 * entity described as fully as the bible knows it. Still bounded, and still below the
 * 1,500 every backend slices at, so the closing instruction is never the thing cut.
 */
export const MAX_REFERENCE_CHARS = 1_200;

/**
 * The framing instruction appended to every reference prompt.
 *
 * Plain and identical across entities on purpose. A reference still is a *chart*, not
 * a scene: a dramatic three-quarter shot of a character in shadow is worse than useless
 * as a reference because the facts it is supposed to fix — the coat colour, the hair —
 * are the parts the lighting hides. Recognisable people are refused for the same reason
 * the video adapters refuse them: a generated likeness in a published video is a rights
 * problem, and no bible entity needs one.
 */
const REFERENCE_FRAMING: Record<ReferenceKind, string> = {
  character:
    "Full-body character reference sheet on a plain neutral background, even " +
    "front lighting, neutral pose, no text, no logos, not a recognisable real person.",
  environment:
    "Establishing reference view of this location on its own, no people present, " +
    "even lighting, no text, no logos.",
  prop:
    "Product-style reference of this single object on a plain neutral background, " +
    "even lighting, no people, no text, no logos.",
};

/**
 * Describe one bible entity to an image model.
 *
 * Built from the same fields `buildContinuityPrompt` renders into a scene, in the same
 * order, which is the property that makes the reference worth generating at all: a
 * still drawn from different facts than the scenes would not be a reference, it would
 * be a second opinion. The whole-video style is included because a character sheet in
 * photoreal detail is no use to a project rendering hand-drawn animation.
 *
 * Returns null when the entity carries no visual facts. An entity with a name and
 * nothing else would produce a picture of the model's guess, which then reads as an
 * approved reference — worse than having none (§19).
 */
export function referenceImagePrompt(args: {
  bible: StoryBible;
  kind: ReferenceKind;
  entityId: string;
  capabilities: LevelCapabilities;
}): ReferenceImagePrompt | null {
  const { bible, kind, entityId } = args;

  let name: string;
  let facts: string[];

  if (kind === "character") {
    if (!args.capabilities.characters) return null;
    const character = findCharacter(bible, entityId);
    if (!character) return null;
    name = character.name;
    facts = [
      ...character.appearance,
      ...character.wardrobe,
      ...(character.demeanour ? [character.demeanour] : []),
    ];
  } else if (kind === "environment") {
    if (!args.capabilities.environments) return null;
    const environment = findEnvironment(bible, entityId);
    if (!environment) return null;
    name = environment.name;
    facts = [
      ...environment.description,
      ...(environment.lighting ? [environment.lighting] : []),
      ...environment.palette,
    ];
  } else {
    if (!args.capabilities.props) return null;
    const prop = findProp(bible, entityId);
    if (!prop) return null;
    name = prop.name;
    facts = [...prop.description];
  }

  const described = joinFacts(facts);
  if (described === "") return null;

  const style =
    args.capabilities.style && hasStyle(bible.style)
      ? joinFacts([
          ...(bible.style.medium ? [bible.style.medium] : []),
          ...bible.style.palette,
          ...(bible.style.lighting ? [bible.style.lighting] : []),
        ])
      : "";

  /**
   * Framing last, so a prompt long enough to be sliced loses a palette note rather
   * than the instruction that makes the output a usable reference. The subject and
   * its facts come first for the same reason the shot precedes the continuity block.
   */
  const parts = [
    `${name}: ${described}.`,
    ...(style ? [`Rendered in this style: ${style}.`] : []),
    REFERENCE_FRAMING[kind],
  ];

  return {
    kind,
    entityId,
    name,
    prompt: fitText(parts.join(" "), MAX_REFERENCE_CHARS),
  };
}

/**
 * Every reference still a bible would need, in a stable order.
 *
 * Characters first, then locations, then objects — the same priority
 * `buildContinuityPrompt` weights its clauses by, so a caller that generates only the
 * first few produces the references that matter most rather than an arbitrary prefix.
 * Entities with no visual facts are absent, not present-and-empty.
 */
export function referenceImagePrompts(
  bible: StoryBible,
  capabilities: LevelCapabilities,
): ReferenceImagePrompt[] {
  const out: ReferenceImagePrompt[] = [];

  const targets: Array<[ReferenceKind, readonly { id: string }[]]> = [
    ["character", bible.characters],
    ["environment", bible.environments],
    ["prop", bible.props],
  ];

  for (const [kind, entities] of targets) {
    for (const entity of entities) {
      const prompt = referenceImagePrompt({
        bible,
        kind,
        entityId: entity.id,
        capabilities,
      });
      if (prompt) out.push(prompt);
    }
  }

  return out;
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

/**
 * Trim one string to a budget on a sentence boundary.
 *
 * `fit` below drops whole clauses, which is right when the clauses are independent.
 * A reference prompt is not: its three parts are subject, style and framing, and
 * dropping the subject to keep the framing would ask for a well-lit picture of
 * nothing. So this cuts from the end at the last sentence break instead, which loses
 * the framing note — the part a model most often infers correctly anyway — and never
 * leaves a half-written fact.
 *
 * Only reachable for a bible near its own field limits; the ceiling is set above what
 * the bounded schema normally produces.
 */
function fitText(text: string, budget: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= budget) return trimmed;

  const window = trimmed.slice(0, budget);
  const lastStop = window.lastIndexOf(". ");
  // No sentence break at all: a hard cut is the only option left, and it is still
  // better than sending a prompt the backend will slice at an arbitrary byte.
  return lastStop > 0 ? window.slice(0, lastStop + 1) : window.trimEnd();
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

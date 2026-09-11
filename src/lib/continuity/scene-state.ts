/**
 * Scene state — which bible entities each scene is committed to, and the graph
 * of dependencies between scenes.
 *
 * A bible says what a character looks like. A scene state says *this* scene has
 * that character in it, in that place, holding that object, at that point in the
 * story. Both halves are needed: without the state, continuity could only ever be
 * a global instruction, and selective regeneration would have to redo everything
 * because nothing would know which scenes were affected.
 *
 * This extends the existing scene representation rather than competing with it.
 * The state for scene *n* is keyed by `scenes.index` — the same 0-based index the
 * planner, the timeline, `EditClip.sceneIndex` and the renderer already use — and
 * is stored on the scene row. There is no second scene table and no second
 * ordering.
 *
 * The graph is deliberately shallow. Scene *n* depends on scene *n-1* for a
 * visual handoff, and on the last scene that established each entity it shares.
 * Deeper inference — "the door was opened in scene 4 so scene 9 must show it
 * open" — is a story-logic claim a deterministic pass cannot make honestly, so it
 * is not attempted.
 */

import { z } from "zod";
import { MAX_PROPS, MAX_TRAITS } from "@/lib/continuity/bible";

/** Ceiling on entities referenced by a single scene. */
export const MAX_SCENE_CHARACTERS = 6;
export const MAX_SCENE_PROPS = MAX_PROPS;

/**
 * Where a scene sits in the narrative.
 *
 * Coarse on purpose. Anything finer would be a guess, and this exists to answer
 * one question — is a visual repeat here intentional? — which the four values
 * below are enough for. A `refrain` scene is one the story means to repeat: the
 * chorus of a children's song, the recurring title card of a listicle. §10's
 * duplicate detector reads this and stops flagging what was asked for.
 */
export const NARRATIVE_BEATS = [
  "setup",
  "development",
  "climax",
  "resolution",
  "refrain",
] as const;

export type NarrativeBeat = (typeof NARRATIVE_BEATS)[number];

export function isNarrativeBeat(value: unknown): value is NarrativeBeat {
  return (
    typeof value === "string" &&
    (NARRATIVE_BEATS as readonly string[]).includes(value)
  );
}

export const SCENE_STATE_VERSION = 1;

const entityRef = z.string().trim().min(1).max(60);

export const SceneStateSchema = z.object({
  schemaVersion: z.literal(SCENE_STATE_VERSION).default(SCENE_STATE_VERSION),
  /** Character ids on screen, in billing order. */
  characters: z.array(entityRef).max(MAX_SCENE_CHARACTERS).default([]),
  /** Where this scene happens. Null for an abstract or graphic-only shot. */
  environment: entityRef.nullable().default(null),
  props: z.array(entityRef).max(MAX_SCENE_PROPS).default([]),
  beat: z.enum(NARRATIVE_BEATS).default("development"),
  /**
   * What changed here that later scenes must respect — "the lamp is now broken".
   *
   * Recorded, rendered into later prompts, and never inferred: the planner says
   * it or it does not exist.
   */
  changes: z.array(z.string().trim().min(1).max(200)).max(MAX_TRAITS).default([]),
  /**
   * Deliberate visual echo of an earlier scene, by index.
   *
   * The explicit form of `beat: "refrain"`. When set, the duplicate detector
   * treats similarity to that scene as intended rather than suspicious.
   */
  echoesSceneIndex: z.number().int().min(0).max(10_000).nullable().default(null),
});

export type SceneState = z.infer<typeof SceneStateSchema>;

/** A scene state paired with the scene it belongs to. */
export interface IndexedSceneState {
  sceneIndex: number;
  state: SceneState;
}

export function parseSceneState(input: unknown): SceneState {
  return SceneStateSchema.parse(input);
}

/** Parse, or null — the pipeline's form. A malformed state means no constraints. */
export function safeParseSceneState(input: unknown): SceneState | null {
  if (input === null || input === undefined) return null;
  const parsed = SceneStateSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function emptySceneState(): SceneState {
  return SceneStateSchema.parse({});
}

/** True when this state commits the scene to nothing. */
export function isEmptySceneState(state: SceneState | null): boolean {
  if (!state) return true;
  return (
    state.characters.length === 0 &&
    state.environment === null &&
    state.props.length === 0 &&
    state.changes.length === 0
  );
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

/**
 * Why one scene depends on another.
 *
 *  - `sequence` — immediately follows it, so a visual jump is visible at the cut.
 *  - `character` — shares a character whose look was established there.
 *  - `environment` — returns to a place established there.
 *  - `prop` — shows an object established there.
 *  - `echo` — deliberately mirrors it (`echoesSceneIndex`).
 */
export const DEPENDENCY_KINDS = [
  "sequence",
  "character",
  "environment",
  "prop",
  "echo",
] as const;

export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

export interface SceneDependency {
  /** The scene that depends. */
  sceneIndex: number;
  /** The scene depended upon. Always `< sceneIndex` except for an echo. */
  dependsOn: number;
  kind: DependencyKind;
  /** Entity id for character/environment/prop edges; null otherwise. */
  entityId: string | null;
}

export interface SceneStateGraph {
  /** Ordered scene indices the graph covers. */
  scenes: readonly number[];
  edges: readonly SceneDependency[];
  /** First scene index that established each entity. */
  establishedBy: ReadonlyMap<string, number>;
}

/**
 * Build the dependency graph from an ordered list of scene states.
 *
 * Pure and deterministic — same states in, byte-identical graph out, edges in a
 * fixed order (by scene, then by the kind order above, then by entity id). That
 * matters because the graph decides what gets regenerated, and a regeneration set
 * that varied between runs would be impossible to reason about or test.
 *
 * `establishedBy` records the *first* scene an entity appears in, which is the one
 * whose rendering became the de-facto reference for it. A later scene that drifts
 * is the one at fault, not the establishing shot — so the edge points backwards
 * and regeneration flows forwards.
 */
export function buildSceneStateGraph(
  states: readonly IndexedSceneState[],
): SceneStateGraph {
  const ordered = [...states].sort((a, b) => a.sceneIndex - b.sceneIndex);
  const scenes = ordered.map((s) => s.sceneIndex);
  const present = new Set(scenes);

  const establishedBy = new Map<string, number>();
  const edges: SceneDependency[] = [];

  for (const [position, entry] of ordered.entries()) {
    const { sceneIndex, state } = entry;
    const local: SceneDependency[] = [];

    const previous = position > 0 ? ordered[position - 1] : undefined;
    if (previous) {
      local.push({
        sceneIndex,
        dependsOn: previous.sceneIndex,
        kind: "sequence",
        entityId: null,
      });
    }

    // Entity edges, in a stable order: characters, then environment, then props,
    // each sorted so two runs over the same states produce the same list.
    const entities: Array<{ kind: DependencyKind; id: string }> = [
      ...[...state.characters].sort().map((id) => ({ kind: "character" as const, id })),
      ...(state.environment
        ? [{ kind: "environment" as const, id: state.environment }]
        : []),
      ...[...state.props].sort().map((id) => ({ kind: "prop" as const, id })),
    ];

    for (const entity of entities) {
      const key = `${entity.kind}:${entity.id}`;
      const origin = establishedBy.get(key);

      if (origin === undefined) {
        // This scene establishes it. No edge — it has nothing to be consistent
        // with yet, and an edge to itself would make every scene its own
        // dependency.
        establishedBy.set(key, sceneIndex);
        continue;
      }

      if (origin !== sceneIndex) {
        local.push({
          sceneIndex,
          dependsOn: origin,
          kind: entity.kind,
          entityId: entity.id,
        });
      }
    }

    // An echo may point forwards or backwards, and is only an edge if the target
    // exists — a planner naming a scene that was never planned is not a graph.
    if (
      state.echoesSceneIndex !== null &&
      state.echoesSceneIndex !== sceneIndex &&
      present.has(state.echoesSceneIndex)
    ) {
      local.push({
        sceneIndex,
        dependsOn: state.echoesSceneIndex,
        kind: "echo",
        entityId: null,
      });
    }

    local.sort(
      (a, b) =>
        DEPENDENCY_KINDS.indexOf(a.kind) - DEPENDENCY_KINDS.indexOf(b.kind) ||
        (a.entityId ?? "").localeCompare(b.entityId ?? "") ||
        a.dependsOn - b.dependsOn,
    );
    edges.push(...local);
  }

  return { scenes, edges, establishedBy };
}

/**
 * Scenes that must be reconsidered if `sceneIndex` is regenerated.
 *
 * The answer §14 needs, and the reason it is narrow: a regenerated scene changes
 * what the *next* scene has to match at the cut, and it changes the reference for
 * any entity it established. It does not change scenes that merely happen later.
 * Redoing everything downstream of scene two would be a full rebuild wearing a
 * different name — and paid for as one.
 *
 * Returns ascending indices, never including `sceneIndex` itself.
 */
export function downstreamOf(
  graph: SceneStateGraph,
  sceneIndex: number,
): number[] {
  const affected = new Set<number>();

  for (const edge of graph.edges) {
    if (edge.dependsOn !== sceneIndex) continue;
    // A `sequence` edge is a real visual handoff. An entity edge means this scene
    // was the reference. An `echo` means another scene was built to mirror it.
    affected.add(edge.sceneIndex);
  }

  affected.delete(sceneIndex);
  return [...affected].sort((a, b) => a - b);
}

/**
 * The full regeneration set for a batch of failed scenes.
 *
 * One transitive step, not a closure: if scene 5 fails, scene 6 is reconsidered
 * because it butts against it, but scene 7 is not dragged in because 6 was. Two
 * consecutive failures still produce the union of both their neighbours, so a real
 * run of bad scenes is covered without one bad scene cascading to the end of the
 * video.
 */
export function regenerationSet(
  graph: SceneStateGraph,
  failed: readonly number[],
): number[] {
  const set = new Set<number>(failed);
  for (const index of failed) {
    for (const downstream of downstreamOf(graph, index)) set.add(downstream);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * The scenes whose rendering defines each entity in `state`.
 *
 * Read when building a prompt: scene 12 showing Mara needs to know Mara was
 * established in scene 3, so the prompt can say what that scene committed to.
 */
export function establishingScenes(
  graph: SceneStateGraph,
  state: SceneState,
): Map<string, number> {
  const out = new Map<string, number>();

  for (const id of state.characters) {
    const origin = graph.establishedBy.get(`character:${id}`);
    if (origin !== undefined) out.set(id, origin);
  }
  if (state.environment) {
    const origin = graph.establishedBy.get(`environment:${state.environment}`);
    if (origin !== undefined) out.set(state.environment, origin);
  }
  for (const id of state.props) {
    const origin = graph.establishedBy.get(`prop:${id}`);
    if (origin !== undefined) out.set(id, origin);
  }

  return out;
}

/**
 * Every change committed before a scene, oldest first.
 *
 * A scene must respect what earlier scenes established — the lamp broken in scene
 * four is still broken in scene nine — so the prompt builder needs the accumulated
 * list, not just the previous scene's.
 */
export function changesBefore(
  states: readonly IndexedSceneState[],
  sceneIndex: number,
): string[] {
  return [...states]
    .sort((a, b) => a.sceneIndex - b.sceneIndex)
    .filter((entry) => entry.sceneIndex < sceneIndex)
    .flatMap((entry) => entry.state.changes);
}

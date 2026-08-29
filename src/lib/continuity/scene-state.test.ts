/**
 * Scene state and dependency graph tests (§5, §6, §14, §24).
 *
 * The graph decides what gets *regenerated*, and a regeneration is a paid provider
 * call. So the properties under test are the ones that keep that bill honest:
 *
 *  - **Determinism.** Same states in, byte-identical edges out, in a fixed order.
 *    A regeneration set that varied between runs could not be reasoned about, and
 *    §12 requires determinism outright.
 *  - **One transitive step, not a closure.** If scene 5 fails, scene 6 is
 *    reconsidered; scene 7 is not dragged in because 6 was. A closure here would be
 *    a full rebuild wearing a different name — and charged as one.
 *  - **The establishing scene has no edge to itself.** Otherwise every scene is its
 *    own dependency and regenerating anything regenerates everything.
 */
import { describe, expect, it } from "vitest";
import {
  SCENE_STATE_VERSION,
  buildSceneStateGraph,
  changesBefore,
  downstreamOf,
  emptySceneState,
  establishingScenes,
  isEmptySceneState,
  parseSceneState,
  regenerationSet,
  safeParseSceneState,
  type IndexedSceneState,
} from "@/lib/continuity/scene-state";

/** A scene state with only the fields a test cares about spelled out. */
function scene(
  sceneIndex: number,
  overrides: Partial<Parameters<typeof parseSceneState>[0] & object> = {},
): IndexedSceneState {
  return { sceneIndex, state: parseSceneState(overrides) };
}

describe("parseSceneState", () => {
  it("defaults every field", () => {
    const state = emptySceneState();

    expect(state.schemaVersion).toBe(SCENE_STATE_VERSION);
    expect(state.characters).toEqual([]);
    expect(state.environment).toBeNull();
    expect(state.props).toEqual([]);
    expect(state.beat).toBe("development");
    expect(state.changes).toEqual([]);
    expect(state.echoesSceneIndex).toBeNull();
  });

  it("rejects an unknown beat rather than coercing it", () => {
    // The beat drives duplicate classification. A silently-defaulted beat would
    // turn a planner typo into "this repeat was not intentional".
    expect(() => parseSceneState({ beat: "chorus" })).toThrow();
  });

  it("returns null for unusable input instead of throwing", () => {
    expect(safeParseSceneState(null)).toBeNull();
    expect(safeParseSceneState({ characters: "mara" })).toBeNull();
    expect(safeParseSceneState({ echoesSceneIndex: -1 })).toBeNull();
    expect(safeParseSceneState({ echoesSceneIndex: 1.5 })).toBeNull();
  });

  it("treats a state with only a beat as empty", () => {
    // A beat is not a commitment to any entity, so it constrains nothing.
    expect(isEmptySceneState(parseSceneState({ beat: "refrain" }))).toBe(true);
    expect(isEmptySceneState(null)).toBe(true);
    expect(isEmptySceneState(parseSceneState({ characters: ["mara"] }))).toBe(false);
    expect(isEmptySceneState(parseSceneState({ changes: ["lamp broken"] }))).toBe(
      false,
    );
  });
});

describe("buildSceneStateGraph", () => {
  it("gives the establishing scene no edge for the entity it establishes", () => {
    const graph = buildSceneStateGraph([scene(0, { characters: ["mara"] })]);

    expect(graph.edges).toEqual([]);
    expect(graph.establishedBy.get("character:mara")).toBe(0);
  });

  it("links a later scene back to where each entity was established", () => {
    const graph = buildSceneStateGraph([
      scene(0, { characters: ["mara"], environment: "workshop" }),
      scene(1, { characters: ["ben"] }),
      scene(2, { characters: ["mara"], environment: "workshop", props: ["lamp"] }),
    ]);

    const toScene2 = graph.edges.filter((e) => e.sceneIndex === 2);

    // Back to 1 at the cut, back to 0 for both entities it inherits. The lamp is
    // new here, so it establishes rather than depends.
    expect(toScene2).toEqual([
      { sceneIndex: 2, dependsOn: 1, kind: "sequence", entityId: null },
      { sceneIndex: 2, dependsOn: 0, kind: "character", entityId: "mara" },
      { sceneIndex: 2, dependsOn: 0, kind: "environment", entityId: "workshop" },
    ]);
    expect(graph.establishedBy.get("prop:lamp")).toBe(2);
  });

  it("keys establishment by kind, so a prop and a character may share a name", () => {
    const graph = buildSceneStateGraph([
      scene(0, { characters: ["raven"] }),
      scene(1, { props: ["raven"] }),
    ]);

    expect(graph.establishedBy.get("character:raven")).toBe(0);
    expect(graph.establishedBy.get("prop:raven")).toBe(1);
    // Scene 1's raven-the-prop is new; the only edge is the cut.
    expect(graph.edges.filter((e) => e.sceneIndex === 1)).toEqual([
      { sceneIndex: 1, dependsOn: 0, kind: "sequence", entityId: null },
    ]);
  });

  it("is deterministic and independent of input order", () => {
    const states = [
      scene(0, { characters: ["mara"], environment: "workshop" }),
      scene(1, { characters: ["zed", "ben", "mara"], props: ["lamp", "key"] }),
      scene(2, { characters: ["ben"], props: ["key"], echoesSceneIndex: 0 }),
    ];

    const forwards = buildSceneStateGraph(states);
    const shuffled = buildSceneStateGraph([states[2]!, states[0]!, states[1]!]);

    expect(shuffled.scenes).toEqual([0, 1, 2]);
    expect(JSON.stringify(shuffled.edges)).toBe(JSON.stringify(forwards.edges));
    // Twice over the same input is byte-identical, not merely equivalent.
    expect(JSON.stringify(buildSceneStateGraph(states).edges)).toBe(
      JSON.stringify(forwards.edges),
    );
  });

  it("orders each scene's edges by kind, then entity, then target", () => {
    const graph = buildSceneStateGraph([
      scene(0, { characters: ["mara", "ben"], environment: "workshop" }),
      scene(1, { props: ["lamp"] }),
      scene(2, {
        characters: ["mara", "ben"],
        environment: "workshop",
        props: ["lamp"],
      }),
    ]);

    const kinds = graph.edges
      .filter((e) => e.sceneIndex === 2)
      .map((e) => `${e.kind}:${e.entityId ?? ""}`);

    expect(kinds).toEqual([
      "sequence:",
      "character:ben",
      "character:mara",
      "environment:workshop",
      "prop:lamp",
    ]);
  });

  it("adds an echo edge only when the target scene exists", () => {
    const real = buildSceneStateGraph([
      scene(0, {}),
      scene(1, { echoesSceneIndex: 0, beat: "refrain" }),
    ]);
    expect(real.edges).toContainEqual({
      sceneIndex: 1,
      dependsOn: 0,
      kind: "echo",
      entityId: null,
    });

    // A planner naming a scene that was never planned is not a graph.
    const dangling = buildSceneStateGraph([
      scene(0, {}),
      scene(1, { echoesSceneIndex: 99 }),
    ]);
    expect(dangling.edges.some((e) => e.kind === "echo")).toBe(false);
  });

  it("never lets a scene echo itself", () => {
    const graph = buildSceneStateGraph([scene(0, { echoesSceneIndex: 0 })]);
    expect(graph.edges).toEqual([]);
  });

  it("handles sparse scene indices without inventing the gaps", () => {
    // Scene rows can be deleted from the editor, so the indices are not dense.
    const graph = buildSceneStateGraph([scene(0, {}), scene(4, {}), scene(9, {})]);

    expect(graph.scenes).toEqual([0, 4, 9]);
    expect(graph.edges).toEqual([
      { sceneIndex: 4, dependsOn: 0, kind: "sequence", entityId: null },
      { sceneIndex: 9, dependsOn: 4, kind: "sequence", entityId: null },
    ]);
  });

  it("returns an empty graph for no scenes", () => {
    const graph = buildSceneStateGraph([]);
    expect(graph.scenes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.establishedBy.size).toBe(0);
  });
});

describe("downstreamOf", () => {
  const graph = buildSceneStateGraph([
    scene(0, { characters: ["mara"], environment: "workshop" }),
    scene(1, { characters: ["ben"] }),
    scene(2, { characters: ["mara"] }),
    scene(3, { characters: ["ben"] }),
    scene(4, { environment: "workshop" }),
  ]);

  it("returns the next scene and every scene that referenced this one", () => {
    // 1 butts against it; 2 inherits Mara; 4 returns to the workshop.
    expect(downstreamOf(graph, 0)).toEqual([1, 2, 4]);
  });

  it("never includes the scene itself", () => {
    for (const index of graph.scenes) {
      expect(downstreamOf(graph, index)).not.toContain(index);
    }
  });

  it("returns ascending indices", () => {
    const result = downstreamOf(graph, 1);
    expect([...result].sort((a, b) => a - b)).toEqual(result);
  });

  it("returns nothing for the last scene", () => {
    expect(downstreamOf(graph, 4)).toEqual([]);
  });

  it("returns nothing for a scene the graph does not contain", () => {
    expect(downstreamOf(graph, 99)).toEqual([]);
  });
});

describe("regenerationSet", () => {
  const graph = buildSceneStateGraph([
    scene(0, {}),
    scene(1, {}),
    scene(2, {}),
    scene(3, {}),
    scene(4, {}),
  ]);

  it("takes one step, not a transitive closure", () => {
    // The cost property: scene 2 fails → 2 and 3. Not 2,3,4 — that is a full
    // rebuild of the tail of the video, paid for scene by scene.
    expect(regenerationSet(graph, [2])).toEqual([2, 3]);
  });

  it("covers a run of consecutive failures without cascading past it", () => {
    expect(regenerationSet(graph, [1, 2])).toEqual([1, 2, 3]);
  });

  it("unions disjoint failures", () => {
    expect(regenerationSet(graph, [0, 3])).toEqual([0, 1, 3, 4]);
  });

  it("always includes the failed scenes themselves", () => {
    expect(regenerationSet(graph, [4])).toEqual([4]);
  });

  it("returns nothing for no failures, and does not deduplicate away a scene", () => {
    expect(regenerationSet(graph, [])).toEqual([]);
    expect(regenerationSet(graph, [2, 2])).toEqual([2, 3]);
  });

  it("is bounded by the failures plus their direct dependants", () => {
    const chained = buildSceneStateGraph([
      scene(0, { characters: ["mara"] }),
      scene(1, { characters: ["mara"] }),
      scene(2, { characters: ["mara"] }),
      scene(3, { characters: ["mara"] }),
    ]);

    // Every scene inherits Mara from scene 0, so failing 0 legitimately reaches
    // them all — but failing scene 1 must not, because none of them reference it.
    expect(regenerationSet(chained, [0])).toEqual([0, 1, 2, 3]);
    expect(regenerationSet(chained, [1])).toEqual([1, 2]);
  });
});

describe("establishingScenes", () => {
  it("maps each of a scene's entities to where it was established", () => {
    const states = [
      scene(0, { characters: ["mara"], environment: "workshop" }),
      scene(1, { props: ["lamp"] }),
      scene(2, { characters: ["mara"], environment: "workshop", props: ["lamp"] }),
    ];
    const graph = buildSceneStateGraph(states);

    const origins = establishingScenes(graph, states[2]!.state);

    expect(origins.get("mara")).toBe(0);
    expect(origins.get("workshop")).toBe(0);
    expect(origins.get("lamp")).toBe(1);
  });

  it("omits an entity the graph never saw rather than guessing zero", () => {
    const graph = buildSceneStateGraph([scene(0, { characters: ["mara"] })]);

    const origins = establishingScenes(graph, parseSceneState({ props: ["ghost"] }));

    expect(origins.has("ghost")).toBe(false);
    expect(origins.size).toBe(0);
  });
});

describe("changesBefore", () => {
  const states = [
    scene(0, { changes: ["lamp lit"] }),
    scene(1, { changes: ["lamp broken", "door open"] }),
    scene(2, { changes: ["door shut"] }),
  ];

  it("accumulates every earlier change, oldest first, exclusive of the scene", () => {
    // Accumulated, not just the previous scene's: the lamp broken in scene one is
    // still broken in scene three.
    expect(changesBefore(states, 2)).toEqual(["lamp lit", "lamp broken", "door open"]);
  });

  it("returns nothing before the first scene", () => {
    expect(changesBefore(states, 0)).toEqual([]);
  });

  it("does not depend on input order", () => {
    const shuffled = [states[2]!, states[0]!, states[1]!];
    expect(changesBefore(shuffled, 2)).toEqual(changesBefore(states, 2));
  });
});

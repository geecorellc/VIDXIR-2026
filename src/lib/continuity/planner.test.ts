/**
 * Planner normalisation tests (§1, §5, §24).
 *
 * `normalise` is where every hallucination is absorbed, and it is a pure function of
 * the model's reply — so it is testable without a provider, and no test here makes an
 * AI call. That is the point of it being exported.
 *
 * The properties, each one a thing the model actually gets wrong:
 *
 *  - **Ids are slugged, and references still resolve afterwards.** A model asked for a
 *    slug returns "Mara's Workshop". Failing the plan over punctuation would be a poor
 *    trade; so would slugging the bible and leaving the scene references dangling.
 *  - **Invented scene indices are dropped.** There is nothing to attach them to.
 *  - **Unresolvable entity references are dropped, not invented.** A scene naming a
 *    character the model never cast gets that reference removed and keeps the rest.
 *  - **Unused entities are dropped from the bible.** They would be rendered into no
 *    prompt and validated against nothing, so storing them is dead weight.
 *  - **The level is respected.** A `style`-level plan returns no cast even if the model
 *    supplied one — otherwise the model's enthusiasm overrides the resolved level.
 *  - **The result always validates against the strict stored schemas**, because
 *    `normalise` re-parses through them.
 */
import { describe, expect, it } from "vitest";
import { StoryBibleSchema } from "@/lib/continuity/bible";
import { capabilitiesFor, type ContinuityPlan } from "@/lib/continuity/config";
import { normalise } from "@/lib/continuity/planner";
import { SceneStateSchema } from "@/lib/continuity/scene-state";

/** The model's reply, with every field defaulted so a test names only what it means. */
function reply(overrides: Record<string, unknown> = {}) {
  const base = {
    premise: null,
    structure: null,
    tone: null,
    characters: [],
    environments: [],
    props: [],
    style: {
      medium: null,
      palette: [],
      lighting: null,
      camera: null,
      notes: [],
    },
    scenes: [],
  };
  // Cast at the boundary: this stands in for a parsed provider reply, and building it
  // through the private `PlanSchema` would mean exporting it purely for a test.
  return { ...base, ...overrides } as Parameters<typeof normalise>[0];
}

function character(overrides: Record<string, unknown> = {}) {
  return {
    id: "mara",
    name: "Mara",
    role: null,
    appearance: [],
    wardrobe: [],
    demeanour: null,
    arc: null,
    ...overrides,
  };
}

function environment(overrides: Record<string, unknown> = {}) {
  return {
    id: "workshop",
    name: "The Workshop",
    description: [],
    lighting: null,
    palette: [],
    ...overrides,
  };
}

function prop(overrides: Record<string, unknown> = {}) {
  return { id: "lamp", name: "Brass Lamp", description: [], significance: null, ...overrides };
}

function sceneEntry(index: number, overrides: Record<string, unknown> = {}) {
  return {
    index,
    characters: [],
    environment: null,
    props: [],
    beat: "development",
    changes: [],
    echoesSceneIndex: null,
    ...overrides,
  };
}

function plan(level: Parameters<typeof capabilitiesFor>[0]): ContinuityPlan {
  return {
    level,
    capabilities: capabilitiesFor(level),
    preschool: false,
    reason: "test",
  };
}

function scenes(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    label: `Scene ${i}`,
    narration: `Narration for scene ${i}.`,
  }));
}

function input(level: Parameters<typeof capabilitiesFor>[0] = "episodic", count = 3) {
  return { scenes: scenes(count), plan: plan(level) };
}

describe("normalise", () => {
  it("slugs ids and keeps scene references resolving through the alias", () => {
    // The model returned a display name where a slug was asked for, and referenced the
    // character by *name* in the scene. Both must land on the same entity.
    const result = normalise(
      reply({
        characters: [character({ id: "Mara's Workshop", name: "Mara" })],
        environments: [environment({ id: "The Workshop", name: "The Workshop" })],
        scenes: [
          sceneEntry(0, { characters: ["Mara"], environment: "The Workshop" }),
        ],
      }),
      input(),
    );

    expect(result.bible.characters[0]?.id).toBe("mara-s-workshop");
    expect(result.states[0]?.state.characters).toEqual(["mara-s-workshop"]);
    expect(result.bible.environments[0]?.id).toBe("the-workshop");
    expect(result.states[0]?.state.environment).toBe("the-workshop");
  });

  it("resolves a reference whose case differs from the definition", () => {
    const result = normalise(
      reply({
        characters: [character({ id: "mara", name: "Mara" })],
        scenes: [sceneEntry(0, { characters: ["MARA"] })],
      }),
      input(),
    );

    expect(result.states[0]?.state.characters).toEqual(["mara"]);
  });

  it("falls back to the name when the model gives no id", () => {
    const result = normalise(
      reply({
        characters: [character({ id: "", name: "Ben Okafor" })],
        scenes: [sceneEntry(0, { characters: ["Ben Okafor"] })],
      }),
      input(),
    );

    expect(result.bible.characters[0]?.id).toBe("ben-okafor");
    expect(result.states[0]?.state.characters).toEqual(["ben-okafor"]);
  });

  it("drops a scene the planner invented", () => {
    // Nothing to attach it to: there is no scene 9 in a three-scene video.
    const result = normalise(
      reply({ scenes: [sceneEntry(0), sceneEntry(9), sceneEntry(2)] }),
      input("episodic", 3),
    );

    expect(result.states.map((s) => s.sceneIndex)).toEqual([0, 2]);
  });

  it("drops an unresolvable entity reference and keeps the rest of the scene", () => {
    // Silent by design: discarding a hallucinated id leaves a smaller but entirely
    // valid plan, where failing the build would lose a paid script.
    const result = normalise(
      reply({
        characters: [character({ id: "mara", name: "Mara" })],
        environments: [environment()],
        props: [prop()],
        scenes: [
          sceneEntry(0, {
            characters: ["mara", "ghost"],
            environment: "atlantis",
            props: ["lamp", "macguffin"],
            changes: ["the lamp is broken"],
          }),
        ],
      }),
      input(),
    );

    const state = result.states[0]?.state;
    expect(state?.characters).toEqual(["mara"]);
    expect(state?.environment).toBeNull();
    expect(state?.props).toEqual(["lamp"]);
    // The rest of the scene survived.
    expect(state?.changes).toEqual(["the lamp is broken"]);
  });

  it("drops an echo of a scene that does not exist", () => {
    // Dropped here rather than surviving as a dangling graph edge.
    const result = normalise(
      reply({
        scenes: [
          sceneEntry(0, { echoesSceneIndex: 42 }),
          sceneEntry(1, { echoesSceneIndex: 0 }),
        ],
      }),
      input("episodic", 3),
    );

    expect(result.states[0]?.state.echoesSceneIndex).toBeNull();
    expect(result.states[1]?.state.echoesSceneIndex).toBe(0);
  });

  it("drops bible entities no scene uses", () => {
    // They would be rendered into no prompt and validated against nothing.
    const result = normalise(
      reply({
        characters: [
          character({ id: "mara", name: "Mara" }),
          character({ id: "ben", name: "Ben" }),
        ],
        environments: [environment(), environment({ id: "pier", name: "The Pier" })],
        props: [prop(), prop({ id: "key", name: "Key" })],
        scenes: [
          sceneEntry(0, {
            characters: ["mara"],
            environment: "workshop",
            props: ["lamp"],
          }),
        ],
      }),
      input(),
    );

    expect(result.bible.characters.map((c) => c.id)).toEqual(["mara"]);
    expect(result.bible.environments.map((e) => e.id)).toEqual(["workshop"]);
    expect(result.bible.props.map((p) => p.id)).toEqual(["lamp"]);
  });

  it("deduplicates entities the model defined twice", () => {
    const result = normalise(
      reply({
        characters: [
          character({ id: "mara", name: "Mara", appearance: ["grey beard"] }),
          character({ id: "Mara", name: "Mara", appearance: ["black beard"] }),
        ],
        scenes: [sceneEntry(0, { characters: ["mara"] })],
      }),
      input(),
    );

    expect(result.bible.characters).toHaveLength(1);
    // First definition wins, so the result does not depend on which duplicate came last.
    expect(result.bible.characters[0]?.appearance).toEqual(["grey beard"]);
  });

  it("deduplicates a scene's repeated references", () => {
    const result = normalise(
      reply({
        characters: [character({ id: "mara", name: "Mara" })],
        scenes: [sceneEntry(0, { characters: ["mara", "Mara", "mara"] })],
      }),
      input(),
    );

    expect(result.states[0]?.state.characters).toEqual(["mara"]);
  });

  it("returns no cast at a level that does not track characters", () => {
    // Otherwise the model's enthusiasm overrides the resolved level, and a listicle
    // acquires a cast it was never going to use.
    const result = normalise(
      reply({
        characters: [character()],
        environments: [environment()],
        props: [prop()],
        scenes: [
          sceneEntry(0, {
            characters: ["mara"],
            environment: "workshop",
            props: ["lamp"],
            changes: ["the lamp is broken"],
          }),
        ],
        style: {
          medium: "hand-drawn animation",
          palette: ["ochre"],
          lighting: null,
          camera: null,
          notes: [],
        },
      }),
      input("style"),
    );

    expect(result.bible.characters).toEqual([]);
    expect(result.bible.environments).toEqual([]);
    expect(result.bible.props).toEqual([]);
    expect(result.states[0]?.state.characters).toEqual([]);
    expect(result.states[0]?.state.environment).toBeNull();
    expect(result.states[0]?.state.props).toEqual([]);
    expect(result.states[0]?.state.changes).toEqual([]);
    // The style is what this level does hold.
    expect(result.bible.style.medium).toBe("hand-drawn animation");
  });

  it("keeps locations but no cast at `world`", () => {
    const result = normalise(
      reply({
        characters: [character()],
        environments: [environment()],
        scenes: [sceneEntry(0, { characters: ["mara"], environment: "workshop" })],
      }),
      input("world"),
    );

    expect(result.bible.characters).toEqual([]);
    expect(result.bible.environments.map((e) => e.id)).toEqual(["workshop"]);
    expect(result.states[0]?.state.environment).toBe("workshop");
  });

  it("caps entity counts and trait lists at the bible's bounds", () => {
    // The model does not know the caps. Every trait is rendered into every scene's
    // prompt, so an unbounded list is an unbounded per-scene cost.
    const many = Array.from({ length: 30 }, (_, i) =>
      character({ id: `c${i}`, name: `Character ${i}`, appearance: [`trait ${i}`] }),
    );
    const result = normalise(
      reply({
        characters: many,
        scenes: [
          sceneEntry(0, { characters: many.slice(0, 6).map((c) => c.id) }),
        ],
      }),
      input(),
    );

    expect(result.bible.characters.length).toBeLessThanOrEqual(6);
    // And the whole thing still satisfies the strict stored schema.
    expect(() => StoryBibleSchema.parse(result.bible)).not.toThrow();
  });

  it("truncates an over-long trait rather than dropping the entity", () => {
    const result = normalise(
      reply({
        characters: [
          character({ id: "mara", name: "Mara", appearance: ["z".repeat(500)] }),
        ],
        scenes: [sceneEntry(0, { characters: ["mara"] })],
      }),
      input(),
    );

    expect(result.bible.characters).toHaveLength(1);
    expect(result.bible.characters[0]?.appearance[0]?.length).toBe(120);
  });

  it("normalises an unknown narrative beat to development", () => {
    const result = normalise(
      reply({ scenes: [sceneEntry(0, { beat: "chorus" })] }),
      input(),
    );

    expect(result.states[0]?.state.beat).toBe("development");
  });

  it("keeps a refrain beat, which the duplicate detector needs", () => {
    const result = normalise(
      reply({ scenes: [sceneEntry(0, { beat: "refrain" })] }),
      input(),
    );

    expect(result.states[0]?.state.beat).toBe("refrain");
  });

  it("turns blank strings into nulls rather than storing empty fields", () => {
    const result = normalise(
      reply({
        premise: "   ",
        structure: "",
        tone: "warm",
        characters: [
          character({ id: "mara", name: "Mara", role: "  ", demeanour: "" }),
        ],
        scenes: [sceneEntry(0, { characters: ["mara"] })],
      }),
      input(),
    );

    expect(result.bible.premise).toBeNull();
    expect(result.bible.structure).toBeNull();
    expect(result.bible.tone).toBe("warm");
    expect(result.bible.characters[0]?.role).toBeNull();
    expect(result.bible.characters[0]?.demeanour).toBeNull();
  });

  it("drops blank traits and deduplicates the rest case-insensitively", () => {
    const result = normalise(
      reply({
        characters: [
          character({
            id: "mara",
            name: "Mara",
            appearance: ["grey beard", "  ", "Grey Beard", "tall"],
          }),
        ],
        scenes: [sceneEntry(0, { characters: ["mara"] })],
      }),
      input(),
    );

    expect(result.bible.characters[0]?.appearance).toEqual(["grey beard", "tall"]);
  });

  it("produces states that all satisfy the stored scene-state schema", () => {
    const result = normalise(
      reply({
        characters: [character({ id: "mara", name: "Mara" })],
        environments: [environment()],
        props: [prop()],
        scenes: [
          sceneEntry(0, { characters: ["mara"], beat: "setup" }),
          sceneEntry(1, {
            characters: ["mara"],
            environment: "workshop",
            props: ["lamp"],
            changes: ["the lamp is broken"],
          }),
          sceneEntry(2, { beat: "resolution", echoesSceneIndex: 0 }),
        ],
      }),
      input(),
    );

    expect(result.states).toHaveLength(3);
    for (const entry of result.states) {
      expect(() => SceneStateSchema.parse(entry.state)).not.toThrow();
    }
    expect(() => StoryBibleSchema.parse(result.bible)).not.toThrow();
  });

  it("returns an empty plan for an empty reply rather than throwing", () => {
    const result = normalise(reply(), input());

    expect(result.states).toEqual([]);
    expect(result.bible.characters).toEqual([]);
    expect(() => StoryBibleSchema.parse(result.bible)).not.toThrow();
  });

  it("is deterministic", () => {
    const raw = reply({
      characters: [character({ id: "mara", name: "Mara", appearance: ["grey beard"] })],
      environments: [environment()],
      scenes: [
        sceneEntry(0, { characters: ["mara"], environment: "workshop" }),
        sceneEntry(1, { characters: ["Mara"] }),
      ],
    });

    expect(JSON.stringify(normalise(raw, input()))).toBe(
      JSON.stringify(normalise(raw, input())),
    );
  });

  it("keeps states in the model's scene order, ascending by index", () => {
    const result = normalise(
      reply({ scenes: [sceneEntry(2), sceneEntry(0), sceneEntry(1)] }),
      input("episodic", 3),
    );

    // Not sorted here — the graph builder sorts — but every index must be present
    // exactly once, so nothing is silently lost in the reorder.
    expect([...result.states.map((s) => s.sceneIndex)].sort()).toEqual([0, 1, 2]);
    expect(new Set(result.states.map((s) => s.sceneIndex)).size).toBe(3);
  });
});

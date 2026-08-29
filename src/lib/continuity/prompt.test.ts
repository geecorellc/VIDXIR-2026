/**
 * Continuity prompt tests (§7, §8, §13, §24).
 *
 * What these guard, in order of how much they would cost to get wrong:
 *
 *  - **No prompt, no change.** An empty bible, an `off`-level capability set, or a
 *    scene committed to nothing must produce the empty string, so the caller appends
 *    nothing and the prompt is byte-identical to what it was before this layer
 *    existed. That is the mechanism behind §25, and it is asserted byte-for-byte.
 *  - **Specific facts, not an instruction.** §7 forbids merely appending "keep the
 *    character consistent". The wardrobe has to actually appear.
 *  - **The shot comes first.** A model reading a wall of wardrobe notes before it
 *    learns what the scene is produces a portrait of the wardrobe.
 *  - **Truncation drops whole clauses.** A half-written wardrobe is worse than none:
 *    the model completes it, differently every scene, which is the drift this layer
 *    exists to prevent. So the budget is respected *and* no clause is ever cut.
 *  - **Determinism** — byte-identical text for identical inputs (§12).
 */
import { describe, expect, it } from "vitest";
import { emptyStoryBible, parseStoryBible } from "@/lib/continuity/bible";
import { capabilitiesFor, type LevelCapabilities } from "@/lib/continuity/config";
import {
  MAX_CONTINUITY_CHARS,
  buildContinuityPrompt,
  plannerContext,
  regenerationPrompt,
  withContinuity,
  type ContinuityPromptInput,
} from "@/lib/continuity/prompt";
import {
  buildSceneStateGraph,
  emptySceneState,
  parseSceneState,
  type IndexedSceneState,
} from "@/lib/continuity/scene-state";

const BIBLE = parseStoryBible({
  premise: "A watchmaker teaches an apprentice to let go.",
  structure: "three-act",
  tone: "warm, unhurried",
  characters: [
    {
      id: "mara",
      name: "Mara",
      role: "the mentor",
      appearance: ["grey beard", "deep-set eyes"],
      wardrobe: ["brown canvas coat"],
      demeanour: "moves slowly and deliberately",
      arc: "learns to let the workshop go",
    },
    { id: "ben", name: "Ben", appearance: ["ginger hair", "freckles"] },
  ],
  environments: [
    {
      id: "workshop",
      name: "The Workshop",
      description: ["brass tools on pegboard", "low wooden bench"],
      lighting: "late afternoon light through one dusty window",
      palette: ["ochre", "walnut"],
    },
  ],
  props: [
    { id: "lamp", name: "Brass Lamp", description: ["dented shade"], significance: "hers" },
    { id: "key", name: "Key", description: [] },
  ],
  style: {
    medium: "hand-drawn 2D animation",
    palette: ["muted ochre", "teal"],
    lighting: "soft directional",
    camera: "static, eye level",
    notes: ["visible paper grain"],
  },
});

/** Build an input for one scene out of a list of states. */
function promptInput(
  states: readonly IndexedSceneState[],
  sceneIndex: number,
  capabilities: LevelCapabilities = capabilitiesFor("episodic"),
  bible = BIBLE,
): ContinuityPromptInput {
  const entry = states.find((s) => s.sceneIndex === sceneIndex);
  return {
    bible,
    state: entry?.state ?? emptySceneState(),
    sceneIndex,
    allStates: states,
    graph: buildSceneStateGraph(states),
    capabilities,
  };
}

const STATES: IndexedSceneState[] = [
  {
    sceneIndex: 0,
    state: parseSceneState({
      characters: ["mara"],
      environment: "workshop",
      changes: ["the lamp is lit"],
      beat: "setup",
    }),
  },
  {
    sceneIndex: 1,
    state: parseSceneState({
      characters: ["mara", "ben"],
      environment: "workshop",
      props: ["lamp"],
      changes: ["the lamp is broken"],
    }),
  },
  {
    sceneIndex: 2,
    state: parseSceneState({ characters: ["ben"], environment: "workshop" }),
  },
];

describe("buildContinuityPrompt", () => {
  it("renders the actual facts, not an instruction to be consistent", () => {
    const text = buildContinuityPrompt(promptInput(STATES, 1));

    // §7: the wardrobe is in the prompt, because the model has no memory of the
    // previous call and this text is the only consistency available to it.
    expect(text).toContain("Mara");
    expect(text).toContain("grey beard");
    expect(text).toContain("brown canvas coat");
    expect(text).toContain("moves slowly and deliberately");
    expect(text).toContain("The Workshop");
    expect(text).toContain("brass tools on pegboard");
    expect(text).toContain("hand-drawn 2D animation");
    expect(text).not.toMatch(/keep the character consistent/i);
  });

  it("returns the empty string for a legacy project — no bible and no states", () => {
    // The §25 mechanism, in the shape an old project actually has: the bible column
    // and every scene's state column are null, so there is nothing to append and the
    // prompt is byte-identical to what it was before this layer existed.
    const text = buildContinuityPrompt(
      promptInput([], 0, capabilitiesFor("episodic"), emptyStoryBible()),
    );
    expect(text).toBe("");
  });

  it("still carries state changes when the bible is empty", () => {
    // Not an oversight: a change is a fact recorded on the *scene*, not on the bible,
    // and it is worth rendering even for a video with no cast. The service is what
    // gates the layer on `isEmptyBible`; this function only reports what it was given.
    const text = buildContinuityPrompt(
      promptInput(STATES, 1, capabilitiesFor("episodic"), emptyStoryBible()),
    );

    expect(text).toBe("Already established: the lamp is lit.");
  });

  it("returns the empty string at level `off`", () => {
    expect(buildContinuityPrompt(promptInput(STATES, 1, capabilitiesFor("off")))).toBe(
      "",
    );
  });

  it("returns the empty string for a scene committed to nothing", () => {
    const bare: IndexedSceneState[] = [{ sceneIndex: 0, state: emptySceneState() }];
    const styleless = parseStoryBible({
      characters: [{ id: "mara", name: "Mara", appearance: ["grey beard"] }],
    });

    expect(
      buildContinuityPrompt(
        promptInput(bare, 0, capabilitiesFor("character"), styleless),
      ),
    ).toBe("");
  });

  it("names only the characters this scene commits to", () => {
    const text = buildContinuityPrompt(promptInput(STATES, 2));

    expect(text).toContain("Ben");
    expect(text).not.toContain("Mara");
    expect(text).not.toContain("grey beard");
  });

  it("skips an entity the bible does not define rather than failing", () => {
    // The planner can name an entity that was dropped from the bible. Continuity
    // must degrade to fewer constraints, never to a thrown error (§22).
    const states: IndexedSceneState[] = [
      {
        sceneIndex: 0,
        state: parseSceneState({ characters: ["ghost"], environment: "atlantis" }),
      },
    ];

    const text = buildContinuityPrompt(promptInput(states, 0));

    expect(text).not.toContain("ghost");
    expect(text).not.toContain("atlantis");
    // The style still applies — it is a whole-video contract, not per-entity.
    expect(text).toContain("hand-drawn 2D animation");
  });

  it("omits a character with no visual facts", () => {
    const bible = parseStoryBible({
      characters: [{ id: "mara", name: "Mara", role: "the mentor", arc: "lets go" }],
    });
    const states: IndexedSceneState[] = [
      { sceneIndex: 0, state: parseSceneState({ characters: ["mara"] }) },
    ];

    // `role` and `arc` are planning fields. A generator given "the mentor who learns
    // to let go" produces a worse shot than one given nothing.
    const text = buildContinuityPrompt(
      promptInput(states, 0, capabilitiesFor("character"), bible),
    );
    expect(text).toBe("");
  });

  it("never renders planning-only fields into a generation prompt", () => {
    const text = buildContinuityPrompt(promptInput(STATES, 1));

    expect(text).not.toContain("the mentor");
    expect(text).not.toContain("learns to let the workshop go");
    expect(text).not.toContain("three-act");
    expect(text).not.toContain("A watchmaker teaches");
  });

  it("carries every earlier change, not just the previous scene's", () => {
    const text = buildContinuityPrompt(promptInput(STATES, 2));

    expect(text).toContain("Already established");
    expect(text).toContain("the lamp is lit");
    expect(text).toContain("the lamp is broken");
  });

  it("does not carry the scene's own change as already established", () => {
    const text = buildContinuityPrompt(promptInput(STATES, 0));
    expect(text).not.toContain("the lamp is lit");
  });

  it("deduplicates repeated changes case-insensitively", () => {
    const states: IndexedSceneState[] = [
      { sceneIndex: 0, state: parseSceneState({ changes: ["The lamp is broken"] }) },
      { sceneIndex: 1, state: parseSceneState({ changes: ["the lamp is broken"] }) },
      { sceneIndex: 2, state: parseSceneState({ characters: ["mara"] }) },
    ];

    const text = buildContinuityPrompt(promptInput(states, 2));
    const occurrences = text.toLowerCase().split("the lamp is broken").length - 1;
    expect(occurrences).toBe(1);
  });

  it("omits a prop with no description, so an empty parenthesis never appears", () => {
    const states: IndexedSceneState[] = [
      { sceneIndex: 0, state: parseSceneState({ props: ["lamp", "key"] }) },
    ];

    const text = buildContinuityPrompt(promptInput(states, 0));

    expect(text).toContain("Brass Lamp (dented shade)");
    expect(text).not.toContain("Key (");
    expect(text).not.toContain("()");
  });

  it("honours the capability set for each level", () => {
    const states: IndexedSceneState[] = [
      {
        sceneIndex: 0,
        state: parseSceneState({
          characters: ["mara"],
          environment: "workshop",
          props: ["lamp"],
        }),
      },
      {
        sceneIndex: 1,
        state: parseSceneState({
          characters: ["mara"],
          environment: "workshop",
          props: ["lamp"],
          changes: ["door open"],
        }),
      },
    ];

    const style = buildContinuityPrompt(promptInput(states, 1, capabilitiesFor("style")));
    expect(style).toContain("hand-drawn 2D animation");
    expect(style).not.toContain("Mara");
    expect(style).not.toContain("The Workshop");
    expect(style).not.toContain("Brass Lamp");

    const world = buildContinuityPrompt(promptInput(states, 1, capabilitiesFor("world")));
    expect(world).toContain("The Workshop");
    expect(world).not.toContain("Mara");
    expect(world).not.toContain("Brass Lamp");

    const character = buildContinuityPrompt(
      promptInput(states, 1, capabilitiesFor("character")),
    );
    expect(character).toContain("Mara");
    expect(character).toContain("The Workshop");
    expect(character).toContain("Brass Lamp");
  });

  it("is byte-identical across repeated calls and independent of state order", () => {
    const forwards = buildContinuityPrompt(promptInput(STATES, 2));
    const again = buildContinuityPrompt(promptInput(STATES, 2));
    const shuffled = buildContinuityPrompt(
      promptInput([STATES[2]!, STATES[0]!, STATES[1]!], 2),
    );

    expect(again).toBe(forwards);
    expect(shuffled).toBe(forwards);
  });

  it("puts characters before the location, style, props and history", () => {
    const text = buildContinuityPrompt(promptInput(STATES, 1));

    const order = ["Mara", "Location —", "Consistent style", "Objects present", "Already established"]
      .map((needle) => text.indexOf(needle));

    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("stays inside the budget without ever cutting a clause in half", () => {
    // A cast of eight, each with the maximum traits at the maximum length — far more
    // than the budget — so truncation definitely fires.
    const long = "x".repeat(110);
    const bible = parseStoryBible({
      characters: Array.from({ length: 6 }, (_, i) => ({
        id: `c${i}`,
        name: `Character ${i}`,
        appearance: Array.from({ length: 8 }, () => long),
      })),
      style: { medium: "hand-drawn 2D animation" },
    });
    const states: IndexedSceneState[] = [
      {
        sceneIndex: 0,
        state: parseSceneState({ characters: ["c0", "c1", "c2", "c3", "c4", "c5"] }),
      },
    ];

    const text = buildContinuityPrompt(
      promptInput(states, 0, capabilitiesFor("character"), bible),
    );

    expect(text.length).toBeLessThanOrEqual(MAX_CONTINUITY_CHARS);
    // Every clause that survived is whole: it ends in a full stop, and each `x` run
    // is the full 110 characters rather than a fragment.
    expect(text.endsWith(".")).toBe(true);
    for (const run of text.match(/x+/g) ?? []) {
      expect(run.length).toBe(110);
    }
  });

  it("drops the lowest-priority clauses first when the budget bites", () => {
    // Characters outrank style, which outranks history, which outranks props: a face
    // changing is what viewers notice; a missing teacup is not.
    // 110 is under `MAX_TRAIT_LENGTH`, so these are legal traits; six of them per
    // clause is what pushes the total past the 900-character budget.
    const long = "y".repeat(110);
    const bible = parseStoryBible({
      characters: [
        {
          id: "mara",
          name: "Mara",
          appearance: [long, long, long, long, long, long],
        },
      ],
      props: [
        { id: "lamp", name: "Brass Lamp", description: [long, long, long, long] },
      ],
      style: { medium: long, palette: [long, long, long] },
    });
    const states: IndexedSceneState[] = [
      { sceneIndex: 0, state: parseSceneState({ changes: [long] }) },
      {
        sceneIndex: 1,
        state: parseSceneState({ characters: ["mara"], props: ["lamp"] }),
      },
    ];

    const text = buildContinuityPrompt(
      promptInput(states, 1, capabilitiesFor("episodic"), bible),
    );

    expect(text.length).toBeLessThanOrEqual(MAX_CONTINUITY_CHARS);
    expect(text).toContain("Mara");
    expect(text).not.toContain("Objects present");
  });

  it("strips trailing punctuation from facts so no clause reads '..'", () => {
    const bible = parseStoryBible({
      characters: [{ id: "mara", name: "Mara", appearance: ["grey beard.", "tall;"] }],
    });
    const states: IndexedSceneState[] = [
      { sceneIndex: 0, state: parseSceneState({ characters: ["mara"] }) },
    ];

    const text = buildContinuityPrompt(
      promptInput(states, 0, capabilitiesFor("character"), bible),
    );

    expect(text).toBe("Mara: grey beard, tall.");
  });
});

describe("withContinuity", () => {
  it("puts the shot first and labels the block as a constraint", () => {
    const out = withContinuity("A wide shot of a workshop", "Mara: grey beard.");

    expect(out.indexOf("A wide shot")).toBe(0);
    expect(out).toContain("Continuity — must match exactly:");
    expect(out.indexOf("A wide shot")).toBeLessThan(out.indexOf("Mara"));
  });

  it("returns the shot byte-identically when there is no continuity", () => {
    // The property the whole additive design rests on: no bible, no difference.
    const shot = "A wide shot of a workshop";
    expect(withContinuity(shot, "")).toBe(shot);
    expect(withContinuity(shot, "   ")).toBe(shot);
    expect(withContinuity(shot, "\n")).toBe(shot);
  });

  it("returns the block alone when there is no shot", () => {
    expect(withContinuity("", "Mara: grey beard.")).toBe("Mara: grey beard.");
  });

  it("returns the empty string when there is neither", () => {
    expect(withContinuity("", "")).toBe("");
  });

  it("is idempotent in the sense that trimming does not change the output", () => {
    expect(withContinuity("  shot  ", "  block  ")).toBe(
      withContinuity("shot", "block"),
    );
  });
});

describe("regenerationPrompt", () => {
  it("carries the actual failures, not a generic retry", () => {
    // §13: a model told "the coat was blue and must be brown" has something to act
    // on. One told "try again" produces another draw from the same distribution,
    // and paying twice for that is not a fix.
    const out = regenerationPrompt({
      visualPrompt: "A wide shot of a workshop",
      continuity: "Mara: brown canvas coat.",
      issues: ["Mara's coat read as blue; the bible says brown canvas."],
    });

    expect(out).toContain("A wide shot of a workshop");
    expect(out).toContain("Continuity — must match exactly:");
    expect(out).toContain("- Mara's coat read as blue; the bible says brown canvas.");
    expect(out).not.toMatch(/try again/i);
  });

  it("is the plain continuity prompt when there are no issues", () => {
    const args = { visualPrompt: "A wide shot", continuity: "Mara: brown coat." };

    expect(regenerationPrompt({ ...args, issues: [] })).toBe(
      withContinuity(args.visualPrompt, args.continuity),
    );
    // Blank issues are not issues, and must not produce an empty bullet.
    expect(regenerationPrompt({ ...args, issues: ["", "  "] })).toBe(
      withContinuity(args.visualPrompt, args.continuity),
    );
  });

  it("lists every issue on its own line", () => {
    const out = regenerationPrompt({
      visualPrompt: "A wide shot",
      continuity: "",
      issues: ["first", "second", "third"],
    });

    expect(out).toContain("- first\n- second\n- third");
  });

  it("is deterministic", () => {
    const args = {
      visualPrompt: "A wide shot",
      continuity: "Mara: brown coat.",
      issues: ["coat wrong"],
    };
    expect(regenerationPrompt(args)).toBe(regenerationPrompt(args));
  });
});

describe("plannerContext", () => {
  it("gives the planner ids to refer to, and the story fields a generator never sees", () => {
    const text = plannerContext(BIBLE, capabilitiesFor("episodic"));

    expect(text).toContain("Premise: A watchmaker teaches an apprentice to let go.");
    expect(text).toContain("Structure: three-act");
    expect(text).toContain("Tone: warm, unhurried");
    // The id is what a scene state stores, so the planner must be told it.
    expect(text).toContain("- mara (Mara)");
    expect(text).toContain("- workshop (The Workshop)");
    expect(text).toContain("- lamp (Brass Lamp)");
    expect(text).toContain("the mentor");
  });

  it("omits the sections the level does not track", () => {
    const text = plannerContext(BIBLE, capabilitiesFor("style"));

    expect(text).not.toContain("Cast");
    expect(text).not.toContain("Locations:");
    expect(text).not.toContain("Objects:");
    expect(text).toContain("Visual style");
  });

  it("is empty for an empty bible", () => {
    expect(plannerContext(emptyStoryBible(), capabilitiesFor("episodic"))).toBe("");
  });

  it("is deterministic", () => {
    expect(plannerContext(BIBLE, capabilitiesFor("character"))).toBe(
      plannerContext(BIBLE, capabilitiesFor("character")),
    );
  });
});

/**
 * Repetition detection tests (§10, §24).
 *
 * The mandate is specific about this one: a children's song repeating "clap your
 * hands" over four verses **must not be flagged**. So that exact case is a test, not
 * an inference from the thresholds.
 *
 * The properties:
 *
 *  - **Three-way, never boolean.** `intentional` repetition is the format; flagging it
 *    the same way as an accident trains the operator to ignore the flag.
 *  - **A declared echo or a refrain beat wins over any similarity**, including 1.0.
 *  - **Only the closest earlier match per scene.** A title card repeated eight times
 *    produces seven findings, not twenty-eight.
 *  - **Determinism**, including the rounding: a ratio differing in the fifteenth digit
 *    between machines is not deterministic in any sense that helps (§12).
 *  - **Only `duplicate` is actionable.** A `suspicious` finding must never on its own
 *    trigger a paid regeneration.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  resolveContinuityPlan,
  thresholdsFor,
} from "@/lib/continuity/config";
import {
  actionableRepetitions,
  findRepetitions,
  shotSimilarity,
  type SceneVisual,
} from "@/lib/continuity/duplicate";
import { parseSceneState, type IndexedSceneState } from "@/lib/continuity/scene-state";

function visual(
  sceneIndex: number,
  visualPrompt: string | null,
  searchTerms: string[] = [],
): SceneVisual {
  return { sceneIndex, visualPrompt, searchTerms };
}

function state(
  sceneIndex: number,
  overrides: Record<string, unknown> = {},
): IndexedSceneState {
  return { sceneIndex, state: parseSceneState(overrides) };
}

/**
 * A pair of shots with an exact Jaccard similarity.
 *
 * The classification bands are ratios, and prose lands wherever it lands — a sentence
 * written to be "nearly identical" can score 0.71. So the band tests construct their
 * similarity instead of hoping: `shared` words appear in both shots and each shot gets
 * one word of its own, giving `shared / (shared + 2)` exactly.
 */
function pair(shared: number): [SceneVisual, SceneVisual] {
  const common = Array.from({ length: shared }, (_, i) => `token${i}`);
  return [
    visual(0, [...common, "leftonly"].join(" ")),
    visual(1, [...common, "rightonly"].join(" ")),
  ];
}

const PRESCHOOL_THRESHOLDS = thresholdsFor(
  resolveContinuityPlan({
    generationMode: "AI_VIDEO",
    contentStyle: null,
    videoStyle: null,
    targetAudience: "toddlers and preschool children",
  }),
);

describe("shotSimilarity", () => {
  it("scores an identical description 1", () => {
    const shot = visual(0, "A wide shot of a red door in a stone wall");
    expect(shotSimilarity(shot, visual(1, "A wide shot of a red door in a stone wall")))
      .toBe(1);
  });

  it("ignores word order, because two orderings are the same shot", () => {
    // The reason for Jaccard over an edit distance.
    const a = visual(0, "a wide shot of a red door");
    const b = visual(1, "a red door, wide shot");
    expect(shotSimilarity(a, b)).toBe(1);
  });

  it("ignores case and punctuation", () => {
    expect(
      shotSimilarity(visual(0, "Red Door, close-up."), visual(1, "red door close up")),
    ).toBe(1);
  });

  it("scores unrelated shots near zero", () => {
    const score = shotSimilarity(
      visual(0, "a watchmaker bent over a brass movement"),
      visual(1, "aerial view of a container ship at dusk"),
    );
    expect(score).toBeLessThan(0.1);
  });

  it("keeps shot-distinguishing words like wide and close", () => {
    // A general stop-word list would strip exactly the words that separate two shots
    // of the same subject, collapsing them to 1.0.
    const wide = visual(0, "wide establishing view of the workshop bench");
    const close = visual(1, "close macro view of the workshop bench");
    expect(shotSimilarity(wide, close)).toBeLessThan(1);
  });

  it("is symmetric", () => {
    const a = visual(0, "a watchmaker at a bench with a brass lamp");
    const b = visual(1, "a brass lamp on a workshop bench");
    expect(shotSimilarity(a, b)).toBe(shotSimilarity(b, a));
  });

  it("is deterministic and rounded to three places", () => {
    const a = visual(0, "one two three four five six seven");
    const b = visual(1, "one two three eight nine ten eleven");

    const score = shotSimilarity(a, b);
    expect(score).toBe(shotSimilarity(a, b));
    // The rounding is what makes the score portable, so it is asserted directly.
    expect(Number(score.toFixed(3))).toBe(score);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("scores zero when either side has nothing to compare", () => {
    // A scene the director skipped is not a duplicate of anything.
    expect(shotSimilarity(visual(0, null), visual(1, "a red door"))).toBe(0);
    expect(shotSimilarity(visual(0, ""), visual(1, "a red door"))).toBe(0);
    // All stop-words leaves no content words at all.
    expect(shotSimilarity(visual(0, "the a of in"), visual(1, "a red door"))).toBe(0);
    expect(shotSimilarity(visual(0, null), visual(1, null))).toBe(0);
  });

  it("folds search terms into the comparison", () => {
    const a = visual(0, null, ["brass", "workshop", "lamp"]);
    const b = visual(1, null, ["brass", "workshop", "lamp"]);
    expect(shotSimilarity(a, b)).toBe(1);
  });

  it("stays within 0 and 1 for every pair", () => {
    const shots = [
      visual(0, "a wide shot of a red door"),
      visual(1, null),
      visual(2, "", ["door"]),
      visual(3, "a red door"),
    ];
    for (const left of shots) {
      for (const right of shots) {
        const score = shotSimilarity(left, right);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("findRepetitions", () => {
  it("does not flag a children's song repeating 'clap your hands'", () => {
    // The case the mandate names outright. Four verses, the same clapping shot each
    // time, declared as a refrain by the planner. Zero actionable findings.
    const visuals = Array.from({ length: 4 }, (_, i) =>
      visual(i, "children clapping their hands together, bright nursery room", [
        "clap your hands",
      ]),
    );
    const states = [
      state(0, { beat: "refrain" }),
      state(1, { beat: "refrain" }),
      state(2, { beat: "refrain" }),
      state(3, { beat: "refrain" }),
    ];

    const findings = findRepetitions({
      visuals,
      states,
      thresholds: PRESCHOOL_THRESHOLDS,
    });

    expect(findings.every((f) => f.classification === "intentional")).toBe(true);
    expect(actionableRepetitions(findings)).toEqual([]);
  });

  it("does not flag it even at the default thresholds", () => {
    // Belt and braces: the refrain beat alone is sufficient, without the preschool
    // audience widening the marks. A planner that labels the chorus is enough.
    const visuals = Array.from({ length: 4 }, (_, i) =>
      visual(i, "children clapping their hands together, bright nursery room"),
    );
    const states = Array.from({ length: 4 }, (_, i) => state(i, { beat: "refrain" }));

    const findings = findRepetitions({
      visuals,
      states,
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(actionableRepetitions(findings)).toEqual([]);
  });

  it("classifies a declared echo as intentional however identical", () => {
    const findings = findRepetitions({
      visuals: [
        visual(0, "the title card, ochre on black"),
        visual(1, "something else entirely, a container ship"),
        visual(2, "the title card, ochre on black"),
      ],
      states: [state(0), state(1), state(2, { echoesSceneIndex: 0 })],
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      sceneIndex: 2,
      matchesSceneIndex: 0,
      classification: "intentional",
      similarity: 1,
    });
    expect(findings[0]?.reason).toContain("deliberately echoes");
  });

  it("does not treat an echo of a different scene as a licence to repeat this one", () => {
    // The echo declares scene 1, but the repeat is of scene 0. That is undeclared.
    const findings = findRepetitions({
      visuals: [
        visual(0, "the title card, ochre on black lettering"),
        visual(1, "an aerial view of a container ship at dusk"),
        visual(2, "the title card, ochre on black lettering"),
      ],
      states: [state(0), state(1), state(2, { echoesSceneIndex: 1 })],
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(findings[0]?.classification).toBe("duplicate");
  });

  it("classifies an undeclared identical shot as a duplicate", () => {
    const findings = findRepetitions({
      visuals: [
        visual(0, "a laptop open on a desk, notification badge visible"),
        visual(1, "an aerial view of a container ship at dusk"),
        visual(2, "a laptop open on a desk, notification badge visible"),
      ],
      states: [state(0), state(1), state(2)],
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      sceneIndex: 2,
      matchesSceneIndex: 0,
      classification: "duplicate",
    });
    expect(actionableRepetitions(findings)).toHaveLength(1);
  });

  it("classifies a near-miss as suspicious, which is not actionable", () => {
    // Similar enough to report, not enough to spend a regeneration on. §13 acts on
    // failures; a warning is recorded and shown. 8/10 = 0.8, between the two marks.
    const findings = findRepetitions({
      visuals: pair(8),
      states: [state(0), state(1)],
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.classification).toBe("suspicious");
    expect(findings[0]?.similarity).toBeGreaterThanOrEqual(
      DEFAULT_THRESHOLDS.suspicious,
    );
    expect(findings[0]?.similarity).toBeLessThan(DEFAULT_THRESHOLDS.duplicate);
    expect(actionableRepetitions(findings)).toEqual([]);
  });

  it("classifies exactly at the duplicate mark as a duplicate", () => {
    // The boundary is inclusive: 18/20 = 0.9 is the default duplicate mark.
    const findings = findRepetitions({
      visuals: pair(18),
      states: [state(0), state(1)],
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(findings[0]?.similarity).toBe(DEFAULT_THRESHOLDS.duplicate);
    expect(findings[0]?.classification).toBe("duplicate");
  });

  it("reports nothing below the suspicious mark", () => {
    const findings = findRepetitions({
      visuals: [
        visual(0, "a watchmaker bent over a brass movement"),
        visual(1, "an aerial view of a container ship at dusk"),
        visual(2, "a child running through tall grass"),
      ],
      states: [state(0), state(1), state(2)],
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(findings).toEqual([]);
  });

  it("reports one finding per repeat, not one per pair", () => {
    // Eight identical title cards: seven findings, not twenty-eight.
    const visuals = Array.from({ length: 8 }, (_, i) =>
      visual(i, "the title card, ochre lettering on black"),
    );
    const states = Array.from({ length: 8 }, (_, i) => state(i));

    const findings = findRepetitions({
      visuals,
      states,
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(findings).toHaveLength(7);
    // Every one points back at the scene that established the shot.
    expect(findings.every((f) => f.matchesSceneIndex === 0)).toBe(true);
    expect(findings.map((f) => f.sceneIndex)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("always points backwards, so the later scene is the one regenerated", () => {
    const visuals = Array.from({ length: 5 }, (_, i) =>
      visual(i, "the title card, ochre lettering on black"),
    );

    const findings = findRepetitions({
      visuals,
      states: visuals.map((v) => state(v.sceneIndex)),
      thresholds: DEFAULT_THRESHOLDS,
    });

    for (const finding of findings) {
      expect(finding.matchesSceneIndex).toBeLessThan(finding.sceneIndex);
    }
  });

  it("returns findings ascending by scene index", () => {
    const visuals = [
      visual(4, "the title card, ochre lettering on black"),
      visual(0, "the title card, ochre lettering on black"),
      visual(2, "the title card, ochre lettering on black"),
    ];

    const findings = findRepetitions({
      visuals,
      states: visuals.map((v) => state(v.sceneIndex)),
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(findings.map((f) => f.sceneIndex)).toEqual([2, 4]);
  });

  it("widens tolerance for children's content", () => {
    // A near-identical repeat that is a duplicate for a general audience and merely
    // suspicious for a preschool one, from the same input. 40/42 ≈ 0.952: above the
    // default duplicate mark of 0.9, below the preschool one of 0.98.
    const visuals = pair(40);
    const states = [state(0), state(1)];

    const general = findRepetitions({
      visuals,
      states,
      thresholds: DEFAULT_THRESHOLDS,
    });
    const preschool = findRepetitions({
      visuals,
      states,
      thresholds: PRESCHOOL_THRESHOLDS,
    });

    expect(general[0]?.classification).toBe("duplicate");
    expect(preschool[0]?.classification).toBe("suspicious");
    expect(actionableRepetitions(preschool)).toEqual([]);
  });

  it("copes with a scene that has no state row", () => {
    // Every project built before this layer has visuals and no states. That must
    // classify as undeclared, not throw (§22, §25).
    const findings = findRepetitions({
      visuals: [
        visual(0, "the title card, ochre lettering on black"),
        visual(1, "the title card, ochre lettering on black"),
      ],
      states: [],
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.classification).toBe("duplicate");
  });

  it("returns nothing for zero or one scene", () => {
    expect(
      findRepetitions({ visuals: [], states: [], thresholds: DEFAULT_THRESHOLDS }),
    ).toEqual([]);
    expect(
      findRepetitions({
        visuals: [visual(0, "a red door")],
        states: [state(0)],
        thresholds: DEFAULT_THRESHOLDS,
      }),
    ).toEqual([]);
  });

  it("does not flag scenes with no visual direction against each other", () => {
    const findings = findRepetitions({
      visuals: [visual(0, null), visual(1, null), visual(2, null)],
      states: [state(0), state(1), state(2)],
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(findings).toEqual([]);
  });

  it("is deterministic and independent of input order", () => {
    const visuals = [
      visual(0, "a watchmaker bent over a brass movement under lamplight"),
      visual(1, "an aerial view of a container ship at dusk"),
      visual(2, "a watchmaker bent over a brass movement under lamplight"),
      visual(3, "a watchmaker bent over a brass movement under daylight"),
    ];
    const states = [state(0), state(1), state(2), state(3, { beat: "refrain" })];

    const forwards = findRepetitions({
      visuals,
      states,
      thresholds: DEFAULT_THRESHOLDS,
    });
    const shuffled = findRepetitions({
      visuals: [visuals[3]!, visuals[1]!, visuals[0]!, visuals[2]!],
      states: [states[2]!, states[3]!, states[0]!, states[1]!],
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(forwards));
    expect(
      JSON.stringify(
        findRepetitions({ visuals, states, thresholds: DEFAULT_THRESHOLDS }),
      ),
    ).toBe(JSON.stringify(forwards));
  });
});

describe("actionableRepetitions", () => {
  it("keeps duplicates and drops everything else", () => {
    const findings = findRepetitions({
      visuals: [
        visual(0, "the title card, ochre lettering on black"),
        visual(1, "the title card, ochre lettering on black"),
        visual(2, "the title card, ochre lettering on black background"),
        visual(3, "the title card, ochre lettering on black"),
      ],
      states: [state(0), state(1), state(2), state(3, { beat: "refrain" })],
      thresholds: DEFAULT_THRESHOLDS,
    });

    const actionable = actionableRepetitions(findings);

    expect(actionable.every((f) => f.classification === "duplicate")).toBe(true);
    // The refrain is in the findings and out of the actionable set.
    expect(findings.some((f) => f.classification === "intentional")).toBe(true);
    expect(actionable.some((f) => f.sceneIndex === 3)).toBe(false);
  });

  it("does not mutate its input", () => {
    const findings = findRepetitions({
      visuals: [
        visual(0, "the title card, ochre lettering on black"),
        visual(1, "the title card, ochre lettering on black"),
      ],
      states: [state(0), state(1)],
      thresholds: DEFAULT_THRESHOLDS,
    });
    const before = JSON.stringify(findings);

    actionableRepetitions(findings);

    expect(JSON.stringify(findings)).toBe(before);
  });
});

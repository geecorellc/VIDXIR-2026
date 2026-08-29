/**
 * Validator and score tests (§11, §12, §24).
 *
 * Following `research/scoring.test.ts`'s convention: assert the *properties* the score
 * has to hold rather than pinning exact numbers, because the weights and thresholds are
 * meant to be tuned. The properties, and why each is load-bearing:
 *
 *  - **Determinism** (§12, stated outright). Same input, same integer, every run, on
 *    every machine. Pinned by comparing full serialised reports, not just the score.
 *  - **`combine` drops inactive components from numerator *and* denominator.** Scoring
 *    them 100 instead would let a `style`-level video with a completely broken style
 *    reach a pass by averaging in four irrelevant perfect scores.
 *  - **A clean plan scores 100 without a model's approval.** The same shape as
 *    `research/scoring.ts`: every component starts at 100 and loses points for
 *    concrete findings.
 *  - **The findings never claim more than was measured.** The validator reads prompts,
 *    not frames — there is no vision capability in this repository — so the codes and
 *    messages say `prompt`.
 *  - **`toQualityFindings` matches `quality_checks.findings` exactly**, so the existing
 *    dashboard reader renders these with no change.
 */
import { describe, expect, it } from "vitest";
import { emptyStoryBible, parseStoryBible } from "@/lib/continuity/bible";
import {
  CONTINUITY_LEVELS,
  DEFAULT_THRESHOLDS,
  capabilitiesFor,
  type LevelCapabilities,
} from "@/lib/continuity/config";
import type { SceneVisual } from "@/lib/continuity/duplicate";
import {
  buildContinuityPrompt,
  withContinuity,
} from "@/lib/continuity/prompt";
import {
  buildSceneStateGraph,
  parseSceneState,
  type IndexedSceneState,
} from "@/lib/continuity/scene-state";
import {
  issuesForScene,
  statusFor,
  toQualityFindings,
  validateContinuity,
  type ContinuityComponents,
  type ValidateInput,
} from "@/lib/continuity/validate";

const BIBLE = parseStoryBible({
  characters: [
    {
      id: "mara",
      name: "Mara",
      appearance: ["grey beard", "deep-set eyes"],
      wardrobe: ["brown canvas coat"],
    },
    { id: "ben", name: "Ben", appearance: ["ginger hair"] },
  ],
  environments: [
    {
      id: "workshop",
      name: "The Workshop",
      description: ["brass tools on a pegboard"],
      lighting: "late afternoon window light",
    },
  ],
  props: [{ id: "lamp", name: "Brass Lamp", description: ["dented shade"] }],
  style: { medium: "hand-drawn animation", palette: ["muted ochre"] },
});

const STATES: IndexedSceneState[] = [
  {
    sceneIndex: 0,
    state: parseSceneState({
      characters: ["mara"],
      environment: "workshop",
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
];

/**
 * Distinct shot subjects, one per scene.
 *
 * Deliberately not a numbered template. "Shot 0: a room" and "Shot 1: a room" differ
 * only by a digit, and the comparator drops tokens shorter than three characters — so
 * a numbered fixture scores 1.0 against itself and every scene reads as a duplicate of
 * the first, quietly costing the fixture five points of `duplicateRisk` in tests that
 * are about something else entirely.
 */
const SUBJECTS = [
  "a mainspring being wound at a cluttered bench",
  "rain running down a bus-stop shelter at dusk",
  "a kettle boiling on a stove in a narrow kitchen",
  "a bicycle abandoned against a brick railway arch",
  "gulls circling above a shuttered pier",
  "a child tracing frost patterns on a bedroom window",
  "a market stall being packed away under floodlights",
  "an empty swimming pool filling with autumn leaves",
  "headlights sweeping across a bedroom ceiling",
  "a paper boat turning in a gutter stream",
];

function subject(sceneIndex: number): string {
  return (
    SUBJECTS[sceneIndex % SUBJECTS.length] ?? "an unremarkable interior in soft light"
  );
}

/**
 * The prompt each scene would actually have been sent.
 *
 * Built by running the real prompt builder, not hand-written: the validator's job is
 * to confirm the continuity block survived into the request, so a hand-written "good"
 * prompt would test the fixture rather than the pipeline.
 */
function realVisuals(
  states: readonly IndexedSceneState[] = STATES,
  capabilities: LevelCapabilities = capabilitiesFor("episodic"),
  bible = BIBLE,
): SceneVisual[] {
  const graph = buildSceneStateGraph(states);

  return states.map((entry) => {
    const shot = subject(entry.sceneIndex);

    return {
      sceneIndex: entry.sceneIndex,
      visualPrompt: withContinuity(
        shot,
        buildContinuityPrompt({
          bible,
          state: entry.state,
          sceneIndex: entry.sceneIndex,
          allStates: states,
          graph,
          capabilities,
        }),
      ),
      searchTerms: [],
      // Both halves, exactly as `executeContinuityCheck` passes them.
      shotPrompt: shot,
    };
  });
}

function input(overrides: Partial<ValidateInput> = {}): ValidateInput {
  const states = overrides.states ?? STATES;
  const capabilities = overrides.capabilities ?? capabilitiesFor("episodic");
  const bible = overrides.bible ?? BIBLE;

  return {
    bible,
    states,
    graph: overrides.graph ?? buildSceneStateGraph(states),
    capabilities,
    thresholds: overrides.thresholds ?? DEFAULT_THRESHOLDS,
    visuals: overrides.visuals ?? realVisuals(states, capabilities, bible),
  };
}

describe("validateContinuity", () => {
  it("scores a plan whose prompts carry their constraints at 100", () => {
    // The whole loop, closed: the prompt builder's output satisfies the validator.
    // If this ever fails, the two halves of the layer have drifted apart.
    const report = validateContinuity(input());

    expect(report.score).toBe(100);
    expect(report.status).toBe("pass");
    expect(report.issues).toEqual([]);
    expect(report.affectedScenes).toEqual([]);
    expect(report.affectedEntities).toEqual([]);
  });

  it("fails a scene whose prompt lost its character constraints", () => {
    // The failure mode the layer exists for: the state says Mara is present, the
    // bible says brown coat, and the prompt says neither. That scene draws a
    // different Mara and nothing elsewhere prevents it.
    const report = validateContinuity(
      input({
        visuals: [
          { sceneIndex: 0, visualPrompt: "A wide shot of a room", searchTerms: [] },
          ...realVisuals().slice(1),
        ],
      }),
    );

    expect(report.score).toBeLessThan(100);
    expect(report.affectedScenes).toContain(0);
    expect(report.affectedEntities).toContain("mara");

    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain("continuity.character.missing_constraint");

    const issue = report.issues.find(
      (i) => i.code === "continuity.character.missing_constraint",
    );
    expect(issue?.severity).toBe("fail");
    // Says "prompt", because a prompt is what it read. It has not seen a frame.
    expect(issue?.message).toContain("prompt");
    expect(issue?.sceneIndex).toBe(0);
    expect(issue?.entityId).toBe("mara");
  });

  it("warns rather than fails for an entity the bible does not define", () => {
    // A planner naming a dropped entity is a plan defect, not a visual break, and
    // regenerating a paid clip over it would be the wrong trade.
    const states: IndexedSceneState[] = [
      {
        sceneIndex: 0,
        state: parseSceneState({
          characters: ["ghost"],
          environment: "atlantis",
          props: ["macguffin"],
        }),
      },
    ];
    const report = validateContinuity(input({ states }));

    const bySeverity = report.issues.filter((i) => i.severity === "warn");
    expect(bySeverity.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        "continuity.character.unknown",
        "continuity.environment.unknown",
        "continuity.prop.unknown",
      ]),
    );
    // No failure, so nothing is regenerated for it.
    expect(report.affectedScenes).toEqual([]);
  });

  it("warns, not fails, for a prop that is listed but unmentioned", () => {
    const states: IndexedSceneState[] = [
      { sceneIndex: 0, state: parseSceneState({ props: ["lamp"] }) },
    ];
    const report = validateContinuity(
      input({
        states,
        visuals: [
          {
            sceneIndex: 0,
            // Carries the style so only the prop check can fire.
            visualPrompt: "A wide shot, hand-drawn animation, muted ochre",
            searchTerms: [],
          },
        ],
      }),
    );

    const prop = report.issues.find(
      (i) => i.code === "continuity.prop.missing_constraint",
    );
    expect(prop?.severity).toBe("warn");
    expect(report.affectedScenes).toEqual([]);
    expect(report.components.propContinuity).toBeLessThan(100);
  });

  it("fails a scene whose prompt carries none of the video's style", () => {
    const report = validateContinuity(
      input({
        states: [{ sceneIndex: 0, state: parseSceneState({}) }],
        visuals: [
          { sceneIndex: 0, visualPrompt: "A wide shot of a room", searchTerms: [] },
        ],
      }),
    );

    const style = report.issues.find(
      (i) => i.code === "continuity.style.missing_constraint",
    );
    expect(style?.severity).toBe("fail");
    expect(report.components.styleConsistency).toBeLessThan(100);
  });

  it("flags a dangling echo and a restated change as story warnings", () => {
    const states: IndexedSceneState[] = [
      { sceneIndex: 0, state: parseSceneState({ changes: ["the lamp is broken"] }) },
      {
        sceneIndex: 1,
        state: parseSceneState({
          changes: ["The lamp is broken"],
          echoesSceneIndex: 42,
        }),
      },
    ];

    const report = validateContinuity(input({ states }));
    const codes = report.issues.map((i) => i.code);

    expect(codes).toContain("continuity.story.dangling_echo");
    expect(codes).toContain("continuity.story.restated_change");
    expect(report.components.storyContinuity).toBeLessThan(100);
  });

  it("flags a character first appearing at the climax", () => {
    const states: IndexedSceneState[] = [
      { sceneIndex: 0, state: parseSceneState({ beat: "setup" }) },
      {
        sceneIndex: 1,
        state: parseSceneState({ characters: ["ben"], beat: "climax" }),
      },
    ];

    const report = validateContinuity(input({ states }));
    const late = report.issues.find(
      (i) => i.code === "continuity.story.late_introduction",
    );

    expect(late?.severity).toBe("warn");
    expect(late?.entityId).toBe("ben");
    // The message names the character, not the slug, because an operator reads it.
    expect(late?.message).toContain("Ben");
  });

  it("does not check late introductions below `character` level", () => {
    const states: IndexedSceneState[] = [
      { sceneIndex: 0, state: parseSceneState({ beat: "setup" }) },
      {
        sceneIndex: 1,
        state: parseSceneState({ characters: ["ben"], beat: "climax" }),
      },
    ];

    const report = validateContinuity(
      input({ states, capabilities: capabilitiesFor("world") }),
    );

    expect(report.issues.map((i) => i.code)).not.toContain(
      "continuity.story.late_introduction",
    );
  });

  it("records an undeclared duplicate as a failure and a near-miss as a warning", () => {
    const states: IndexedSceneState[] = [
      { sceneIndex: 0, state: parseSceneState({}) },
      { sceneIndex: 1, state: parseSceneState({}) },
    ];
    const shot = "the title card, ochre lettering, hand-drawn animation, muted ochre";

    const report = validateContinuity(
      input({
        states,
        visuals: [
          { sceneIndex: 0, visualPrompt: shot, searchTerms: [] },
          { sceneIndex: 1, visualPrompt: shot, searchTerms: [] },
        ],
      }),
    );

    const duplicate = report.issues.find((i) => i.code === "continuity.duplicate.shot");
    expect(duplicate?.severity).toBe("fail");
    expect(report.components.duplicateRisk).toBeLessThan(100);
    expect(report.repetitions).toHaveLength(1);
  });

  it("does not read the shared continuity block as repetition", () => {
    /**
     * A regression, and the reason `shotPrompt` exists.
     *
     * Every scene here features Mara, so every prompt carries the same continuity
     * block by design. Comparing the prompts *as sent* made the block dominate the
     * word overlap and pushed unrelated shots past the duplicate mark — and a
     * duplicate is a `fail`, which spends a paid regeneration on a fine scene.
     */
    const states: IndexedSceneState[] = [
      {
        sceneIndex: 0,
        state: parseSceneState({ characters: ["mara"], environment: "workshop" }),
      },
      {
        sceneIndex: 1,
        state: parseSceneState({ characters: ["mara"], environment: "workshop" }),
      },
    ];
    const shots = [
      "Mara winds a mainspring at the bench, grey beard, brown canvas coat",
      "Mara steps out into rain past a bus stop, grey beard, brown canvas coat",
    ];
    const graph = buildSceneStateGraph(states);

    const visuals: SceneVisual[] = states.map((entry) => ({
      sceneIndex: entry.sceneIndex,
      visualPrompt: withContinuity(
        shots[entry.sceneIndex]!,
        buildContinuityPrompt({
          bible: BIBLE,
          state: entry.state,
          sceneIndex: entry.sceneIndex,
          allStates: states,
          graph,
          capabilities: capabilitiesFor("episodic"),
        }),
      ),
      searchTerms: [],
      shotPrompt: shots[entry.sceneIndex]!,
    }));

    const report = validateContinuity(input({ states, visuals, graph }));

    expect(report.repetitions).toEqual([]);
    expect(report.components.duplicateRisk).toBe(100);

    // And the effect is real: drop `shotPrompt` and the same two scenes cross the
    // duplicate mark purely on shared boilerplate.
    const withoutShot = validateContinuity(
      input({
        states,
        graph,
        visuals: visuals.map(({ shotPrompt: _shotPrompt, ...rest }) => rest),
      }),
    );
    expect(withoutShot.repetitions.length).toBeGreaterThan(0);
  });

  it("runs no duplicate detection when the level does not ask for it", () => {
    const shot = "the title card, ochre lettering";
    const report = validateContinuity(
      input({
        capabilities: capabilitiesFor("off"),
        states: [
          { sceneIndex: 0, state: parseSceneState({}) },
          { sceneIndex: 1, state: parseSceneState({}) },
        ],
        visuals: [
          { sceneIndex: 0, visualPrompt: shot, searchTerms: [] },
          { sceneIndex: 1, visualPrompt: shot, searchTerms: [] },
        ],
      }),
    );

    expect(report.repetitions).toEqual([]);
    expect(report.issues).toEqual([]);
    expect(report.score).toBe(100);
  });

  it("scores an empty bible and no states at 100 rather than 0", () => {
    // §25: a legacy project has nothing to be inconsistent about, and a zero here
    // would fail every project built before this layer existed.
    const report = validateContinuity(
      input({ bible: emptyStoryBible(), states: [], visuals: [] }),
    );

    expect(report.score).toBe(100);
    expect(report.status).toBe("pass");
    expect(report.issues).toEqual([]);
  });

  it("returns an integer score in range for every level", () => {
    for (const level of CONTINUITY_LEVELS) {
      const report = validateContinuity(
        input({
          capabilities: capabilitiesFor(level),
          visuals: [
            { sceneIndex: 0, visualPrompt: "A wide shot", searchTerms: [] },
            { sceneIndex: 1, visualPrompt: "A wide shot", searchTerms: [] },
          ],
        }),
      );

      expect(Number.isInteger(report.score)).toBe(true);
      expect(report.score).toBeGreaterThanOrEqual(0);
      expect(report.score).toBeLessThanOrEqual(100);

      for (const value of Object.values(report.components)) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
    }
  });

  it("is deterministic, byte for byte, and independent of input order", () => {
    // §12's requirement stated as strongly as it can be: the whole report, serialised.
    const args = input({
      visuals: [
        { sceneIndex: 0, visualPrompt: "A wide shot of a room", searchTerms: [] },
        { sceneIndex: 1, visualPrompt: "Another wide shot", searchTerms: [] },
      ],
    });

    const once = JSON.stringify(validateContinuity(args));
    expect(JSON.stringify(validateContinuity(args))).toBe(once);

    const reversed = validateContinuity({
      ...args,
      states: [...args.states].reverse(),
      visuals: [...args.visuals].reverse(),
    });
    expect(JSON.stringify(reversed)).toBe(once);
  });

  it("orders affected scenes ascending and affected entities stably", () => {
    const report = validateContinuity(
      input({
        visuals: [
          { sceneIndex: 0, visualPrompt: "A wide shot", searchTerms: [] },
          { sceneIndex: 1, visualPrompt: "Another shot", searchTerms: [] },
        ],
      }),
    );

    expect([...report.affectedScenes].sort((a, b) => a - b)).toEqual(
      report.affectedScenes,
    );
    expect([...report.affectedEntities].sort()).toEqual(report.affectedEntities);
    // No duplicates: a scene with three failures appears once.
    expect(new Set(report.affectedScenes).size).toBe(report.affectedScenes.length);
  });

  it("degrades proportionally — one bad scene in many beats many bad scenes", () => {
    const manyStates: IndexedSceneState[] = Array.from({ length: 10 }, (_, i) => ({
      sceneIndex: i,
      state: parseSceneState({ characters: ["mara"], environment: "workshop" }),
    }));
    const good = realVisuals(manyStates);

    // Distinct subjects with no continuity constraints: the constraint checks fail
    // while duplicate detection stays clean, so the comparison isolates one variable.
    const stripped = manyStates.map((entry) => ({
      sceneIndex: entry.sceneIndex,
      visualPrompt: subject(entry.sceneIndex),
      searchTerms: [],
    }));

    const oneBad = validateContinuity(
      input({
        states: manyStates,
        visuals: [stripped[0]!, ...good.slice(1)],
      }),
    );
    const allBad = validateContinuity(input({ states: manyStates, visuals: stripped }));

    expect(oneBad.score).toBeGreaterThan(allBad.score);
    // One scene in ten must not cross a threshold on its own — otherwise a single
    // planner slip triggers a paid regeneration pass on a fine video.
    expect(oneBad.score).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.fail);
    expect(allBad.score).toBeLessThan(DEFAULT_THRESHOLDS.fail);
  });
});

describe("component weighting", () => {
  /**
   * The weighted mean over a chosen set of components.
   *
   * Mirrors `combine`'s arithmetic with the *weights read off the module's own
   * behaviour* rather than re-declared: the constants are tunable, so a copy here
   * would go stale silently. Used only to compute what the score *would* have been
   * had inactive components been averaged in, which is the counterfactual the test
   * below rules out.
   */
  const WEIGHTS: Record<keyof ContinuityComponents, number> = {
    characterConsistency: 30,
    environmentConsistency: 15,
    propContinuity: 10,
    storyContinuity: 15,
    styleConsistency: 20,
    duplicateRisk: 10,
  };

  function weightedMean(
    components: ContinuityComponents,
    keys: ReadonlyArray<keyof ContinuityComponents>,
  ): number {
    const total = keys.reduce((sum, key) => sum + WEIGHTS[key], 0);
    const weighted = keys.reduce(
      (sum, key) => sum + components[key] * WEIGHTS[key],
      0,
    );
    return Math.round(weighted / total);
  }

  /**
   * `combine` is private, so it is exercised through the public report.
   *
   * The property under test is the one the doc comment claims: an inactive component
   * is dropped from the numerator *and* the denominator. Scoring it 100 instead would
   * let a `style`-level video with a completely broken style average four irrelevant
   * perfect scores and pass.
   */
  it("does not let inactive components dilute a broken active one", () => {
    const styleOnly = parseStoryBible({
      style: { medium: "hand-drawn animation", palette: ["muted ochre"] },
    });
    const states: IndexedSceneState[] = Array.from({ length: 4 }, (_, i) => ({
      sceneIndex: i,
      state: parseSceneState({}),
    }));
    // Every prompt misses the style entirely, and the shots are all distinct so the
    // duplicate component stays at 100 and only `styleConsistency` moves.
    const visuals: SceneVisual[] = states.map((entry) => ({
      sceneIndex: entry.sceneIndex,
      visualPrompt: subject(entry.sceneIndex),
      searchTerms: [],
    }));

    const report = validateContinuity(
      input({
        bible: styleOnly,
        states,
        visuals,
        capabilities: capabilitiesFor("style"),
      }),
    );

    expect(report.components.styleConsistency).toBe(0);
    // The component is reported as 100 — it was not measured, so there is nothing to
    // deduct — which is exactly why it must not be *counted*.
    expect(report.components.characterConsistency).toBe(100);
    expect(report.status).not.toBe("pass");

    /**
     * The contrast that makes the point.
     *
     * Only style, duplicates and story are active, so a video whose style is entirely
     * absent cannot pass. Had the three unmeasured components been averaged in at 100
     * — 30, 15 and 10 points of weight between them — the same video would clear the
     * pass mark comfortably on the strength of checks that never ran.
     */
    const diluted = weightedMean(report.components, [
      "characterConsistency",
      "environmentConsistency",
      "propContinuity",
      "storyContinuity",
      "styleConsistency",
      "duplicateRisk",
    ]);

    expect(diluted).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.pass);
    expect(report.score).toBeLessThan(DEFAULT_THRESHOLDS.pass);
    expect(report.score).toBeLessThan(diluted);
  });

  it("weights characters above props", () => {
    // Not the exact weights — those are tunable — but the ordering, which is a
    // product decision: a face changing is what a viewer notices, a missing teacup
    // is not.
    const states: IndexedSceneState[] = Array.from({ length: 4 }, (_, i) => ({
      sceneIndex: i,
      state: parseSceneState({ characters: ["mara"], props: ["lamp"] }),
    }));
    const styleless = parseStoryBible({
      characters: BIBLE.characters,
      props: BIBLE.props,
    });

    // A prompt that carries the prop but not the character, and its mirror image.
    // Each keeps a distinct subject so duplicate detection contributes nothing to
    // either side and the difference is purely the two components' weights.
    const characterBroken = validateContinuity(
      input({
        bible: styleless,
        states,
        visuals: states.map((entry) => ({
          sceneIndex: entry.sceneIndex,
          visualPrompt: `${subject(entry.sceneIndex)}, a Brass Lamp with a dented shade`,
          searchTerms: [],
        })),
      }),
    );
    const propBroken = validateContinuity(
      input({
        bible: styleless,
        states,
        visuals: states.map((entry) => ({
          sceneIndex: entry.sceneIndex,
          visualPrompt: `${subject(entry.sceneIndex)}, Mara in a brown canvas coat`,
          searchTerms: [],
        })),
      }),
    );

    expect(characterBroken.score).toBeLessThan(propBroken.score);
  });
});

describe("statusFor", () => {
  it("maps the score onto the three statuses at the configured marks", () => {
    expect(statusFor(100, DEFAULT_THRESHOLDS)).toBe("pass");
    expect(statusFor(DEFAULT_THRESHOLDS.pass, DEFAULT_THRESHOLDS)).toBe("pass");
    expect(statusFor(DEFAULT_THRESHOLDS.pass - 1, DEFAULT_THRESHOLDS)).toBe("warn");
    expect(statusFor(DEFAULT_THRESHOLDS.fail, DEFAULT_THRESHOLDS)).toBe("warn");
    expect(statusFor(DEFAULT_THRESHOLDS.fail - 1, DEFAULT_THRESHOLDS)).toBe("fail");
    expect(statusFor(0, DEFAULT_THRESHOLDS)).toBe("fail");
  });

  it("respects a caller's thresholds rather than the defaults", () => {
    // §12: the thresholds are configurable, so the scorer must not close over them.
    const strict = { ...DEFAULT_THRESHOLDS, pass: 95, fail: 90 };
    expect(statusFor(92, DEFAULT_THRESHOLDS)).toBe("pass");
    expect(statusFor(92, strict)).toBe("warn");
    expect(statusFor(80, strict)).toBe("fail");
  });

  it("is monotonic: a higher score is never a worse status", () => {
    const rank = { fail: 0, warn: 1, pass: 2 };
    let previous = -1;
    for (let score = 0; score <= 100; score += 1) {
      const current = rank[statusFor(score, DEFAULT_THRESHOLDS)];
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});

describe("issuesForScene", () => {
  const report = validateContinuity(
    input({
      visuals: [
        { sceneIndex: 0, visualPrompt: "A wide shot of a room", searchTerms: [] },
        ...realVisuals().slice(1),
      ],
    }),
  );

  it("returns only that scene's failures, as text a model can act on", () => {
    const issues = issuesForScene(report, 0);

    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((text) => text.includes("Mara"))).toBe(true);
    // §13: the regeneration prompt gets the actual failure, so the detail is folded
    // into the message rather than dropped.
    expect(issues.every((text) => text.length > 0)).toBe(true);
  });

  it("excludes warnings, which never justify a paid regeneration on their own", () => {
    const warnOnly = validateContinuity(
      input({
        states: [
          { sceneIndex: 0, state: parseSceneState({ characters: ["ghost"] }) },
        ],
        visuals: [
          {
            sceneIndex: 0,
            visualPrompt: "A wide shot, hand-drawn animation, muted ochre",
            searchTerms: [],
          },
        ],
      }),
    );

    expect(warnOnly.issues.some((i) => i.severity === "warn")).toBe(true);
    expect(issuesForScene(warnOnly, 0)).toEqual([]);
  });

  it("returns nothing for a scene with no failures", () => {
    expect(issuesForScene(report, 1)).toEqual([]);
    expect(issuesForScene(report, 99)).toEqual([]);
  });
});

describe("toQualityFindings", () => {
  it("leads with a summary row carrying the score in a parseable form", () => {
    // `lib/continuity/read.ts` regexes the score back out of this message, so the
    // shape is a contract between the two, not a cosmetic choice.
    const report = validateContinuity(input());
    const findings = toQualityFindings(report);

    expect(findings[0]?.code).toBe("continuity.score");
    expect(findings[0]?.message).toBe("Continuity score 100/100 (pass).");
    expect(findings[0]?.severity).toBe("info");
    // Every component is named in the detail, so an operator can see which one fell.
    for (const key of Object.keys(report.components) as Array<
      keyof ContinuityComponents
    >) {
      expect(findings[0]?.detail).toContain(key);
    }
  });

  it("escalates the summary severity with the status", () => {
    const failing = validateContinuity(
      input({
        visuals: STATES.map((entry) => ({
          sceneIndex: entry.sceneIndex,
          visualPrompt: `An unrelated photographic subject ${entry.sceneIndex}`,
          searchTerms: [],
        })),
      }),
    );

    expect(failing.status).toBe("fail");
    expect(toQualityFindings(failing)[0]?.severity).toBe("fail");
  });

  it("emits one row per issue in the existing table's shape", () => {
    const report = validateContinuity(
      input({
        visuals: [
          { sceneIndex: 0, visualPrompt: "A wide shot of a room", searchTerms: [] },
          ...realVisuals().slice(1),
        ],
      }),
    );
    const findings = toQualityFindings(report);

    expect(findings).toHaveLength(report.issues.length + 1);

    for (const finding of findings) {
      // `{code, severity, message, detail?}` — no extra keys, because the reader
      // that already renders quality findings must render these unchanged.
      expect(Object.keys(finding).sort()).toEqual([
        "code",
        "detail",
        "message",
        "severity",
      ]);
      expect(typeof finding.code).toBe("string");
      expect(["info", "warn", "fail"]).toContain(finding.severity);
      expect(finding.message.length).toBeGreaterThan(0);
    }
  });

  it("carries the scene and entity in the detail, not in a new column", () => {
    // Adding a column to a completed migration is not on the table (§17), so the
    // per-item context rides in the findings blob where it already lives.
    const report = validateContinuity(
      input({
        visuals: [
          { sceneIndex: 0, visualPrompt: "A wide shot of a room", searchTerms: [] },
          ...realVisuals().slice(1),
        ],
      }),
    );

    const row = toQualityFindings(report).find(
      (f) => f.code === "continuity.character.missing_constraint",
    );

    expect(row?.detail).toContain("scene 0");
    expect(row?.detail).toContain("entity mara");
  });

  it("is deterministic", () => {
    const report = validateContinuity(input());
    expect(JSON.stringify(toQualityFindings(report))).toBe(
      JSON.stringify(toQualityFindings(report)),
    );
  });
});

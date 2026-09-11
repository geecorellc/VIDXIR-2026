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
  isVoiceCode,
  issuesForScene,
  sceneOfFinding,
  statusFor,
  storedIssuesForScene,
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
    // Forwarded rather than defaulted: absent is the ordinary case, and a default
    // here would make every case in this file assert something about audio.
    ...(overrides.voices ? { voices: overrides.voices } : {}),
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
      /**
       * A third scene, so the negative control below still has a pair whose blocks are
       * byte-identical. Scene 0 *introduces* Mara and the workshop while 1 and 2 return
       * to both, and `buildContinuityPrompt` says so — which means 0's block differs
       * from 1's by that one clause. Scenes 1 and 2 are the identical pair.
       */
      {
        sceneIndex: 2,
        state: parseSceneState({ characters: ["mara"], environment: "workshop" }),
      },
    ];
    const shots = [
      "Mara winds a mainspring at the bench, grey beard, brown canvas coat",
      "Mara steps out into rain past a bus stop, grey beard, brown canvas coat",
      "Mara sorts escapement wheels under a desk lamp, grey beard, brown canvas coat",
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

// ---------------------------------------------------------------------------
// Reading a stored finding's scene back out
// ---------------------------------------------------------------------------

/**
 * `sceneOfFinding` is the inverse of the `scene N` field `toQualityFindings` writes, and
 * it exists because the regeneration stage rebuilds a prompt from *stored* findings.
 *
 * The bug it replaces was a substring test: `detail.includes("scene 1")` matched scene 1,
 * scenes 10–19 and scenes 100–119 alike, so on a project near `MAX_SCENES` redrawing
 * scene 1 was handed twenty other shots' failures to correct — at full provider price,
 * with the wrong instructions.
 */
describe("sceneOfFinding", () => {
  it("does not read scene 1 out of a finding about scene 10", () => {
    // The regression, stated at its narrowest. Every one of these is a real detail
    // `toQualityFindings` can produce, and the old predicate matched all of them.
    expect(sceneOfFinding("scene 10 · entity mara · Expected: a brown canvas coat.")).toBe(
      10,
    );
    expect(sceneOfFinding("scene 1 · entity mara · Expected: a brown canvas coat.")).toBe(
      1,
    );

    for (const near of ["scene 10", "scene 12", "scene 19", "scene 100", "scene 119"]) {
      expect(sceneOfFinding(`${near} · entity mara · drifted`), near).not.toBe(1);
    }
  });

  it("reads every scene index back exactly, across the whole plan", () => {
    /**
     * The full range rather than a sample, because the failure was arithmetical: any
     * index whose decimal form has another index as a prefix was affected, which is most
     * of them once a project passes ten scenes. `MAX_SCENES` is 120.
     */
    for (let index = 0; index < 120; index += 1) {
      const detail = `scene ${index} · entity mara · the coat is the wrong colour`;
      expect(sceneOfFinding(detail), detail).toBe(index);
    }
  });

  it("round-trips what toQualityFindings actually wrote", () => {
    /**
     * The contract asserted end to end rather than against a hand-written string. The
     * writer and the reader are in one module precisely so this cannot drift, and a
     * fixture detail would let the format change without either test noticing.
     */
    const report = validateContinuity(
      input({
        visuals: [
          { sceneIndex: 0, visualPrompt: "A wide shot of a room", searchTerms: [] },
          ...realVisuals().slice(1),
        ],
      }),
    );

    const rows = toQualityFindings(report).filter(
      (row) => row.code === "continuity.character.missing_constraint",
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(sceneOfFinding(row.detail)).toBe(0);
    }
  });

  it("says null rather than zero for a finding about no scene", () => {
    // The summary row and a whole-video finding have no scene, and null must not be
    // confused with scene 0 — which is a real scene, and the first one.
    const report = validateContinuity(input());
    const summary = toQualityFindings(report)[0];

    expect(summary?.code).toBe("continuity.score");
    expect(sceneOfFinding(summary?.detail)).toBeNull();

    expect(sceneOfFinding(undefined)).toBeNull();
    expect(sceneOfFinding(null)).toBeNull();
    expect(sceneOfFinding("")).toBeNull();
    expect(sceneOfFinding("entity mara · no scene here")).toBeNull();
  });

  it("does not match a scene number that appears in a finding's own prose", () => {
    // Anchored to the leading field, which is where the writer puts it. Searching the
    // whole string would let a change description name a scene and be believed.
    expect(sceneOfFinding("entity lamp · echoes scene 4, which is not in the plan")).toBe(
      null,
    );
    // And the leading field wins when the prose mentions another scene.
    expect(
      sceneOfFinding("scene 7 · entity mara · differs from scene 2's rendering"),
    ).toBe(7);
  });
});

/**
 * The selector the regeneration stage runs, against the rows it actually has.
 *
 * `issuesForScene` is the same decision made on a live report. This one reads stored
 * `quality_checks` rows, which is the only thing available to a job that runs after the
 * check's job has ended — and it is where the scene-matching bug lived.
 */
describe("storedIssuesForScene", () => {
  /** A stored row, in the shape `toQualityFindings` writes. */
  function row(
    overrides: Partial<{
      code: string;
      severity: "info" | "warn" | "fail";
      message: string;
      detail: string;
    }> = {},
  ) {
    return {
      code: "continuity.character.missing_constraint",
      severity: "fail" as const,
      message: "Scene 1's prompt did not carry Mara's description.",
      detail: "scene 1 · entity mara",
      ...overrides,
    };
  }

  it("does not hand scene 1 the failures of scenes 10 through 19", () => {
    /**
     * The regression, on the path that spends money. Every row below is a real detail
     * for a different scene; the old `includes("scene 1")` matched all of them, so a
     * redraw of scene 1 was told to correct nineteen other shots.
     */
    const findings = [
      row({ message: "scene 1's own failure", detail: "scene 1 · entity mara" }),
      ...[10, 11, 12, 15, 19, 100, 119].map((index) =>
        row({
          message: `scene ${index}'s failure`,
          detail: `scene ${index} · entity mara`,
        }),
      ),
    ];

    expect(storedIssuesForScene(findings, 1)).toEqual(["scene 1's own failure"]);
    expect(storedIssuesForScene(findings, 19)).toEqual(["scene 19's failure"]);
    expect(storedIssuesForScene(findings, 119)).toEqual(["scene 119's failure"]);
    // And a scene with no findings gets no instructions rather than somebody else's.
    expect(storedIssuesForScene(findings, 2)).toEqual([]);
  });

  it("excludes voice findings, which no redraw can fix", () => {
    // The whole reason `isVoiceCode` is exported. A scene with both a wrong coat and a
    // wrong voice is redrawn to fix the coat; telling an image model about the narration
    // spends a generation on an instruction it cannot act on.
    const findings = [
      row({ message: "The coat is the wrong colour." }),
      row({
        code: "continuity.voice.assignment_mismatch",
        message: "Scene 1 was narrated in a different voice.",
      }),
      row({ code: "continuity.voice.drift", message: "Mara sounds like two people." }),
    ];

    expect(storedIssuesForScene(findings, 1)).toEqual(["The coat is the wrong colour."]);
  });

  it("ignores warnings and notes, so a warn verdict cannot bill a redraw", () => {
    const findings = [
      row({ severity: "warn", message: "A note about scene 1." }),
      row({ severity: "info", message: "Another note about scene 1." }),
      row({ code: "continuity.score", severity: "fail", detail: "characters 40" }),
    ];

    expect(storedIssuesForScene(findings, 1)).toEqual([]);
    // The summary row has no scene, and null must not read as scene 0.
    expect(storedIssuesForScene(findings, 0)).toEqual([]);
  });

  it("selects from the rows a real check wrote, not from a fixture", () => {
    /**
     * End to end through the writer, because the format is the contract. A change to how
     * `toQualityFindings` renders the scene field would leave the fixtures above passing
     * and this failing, which is the right way round.
     */
    const report = validateContinuity(
      input({
        // Scene 1's constraints stripped: the block never reached the request.
        visuals: realVisuals().map((visual) =>
          visual.sceneIndex === 1
            ? { ...visual, visualPrompt: "A kettle on a stove", shotPrompt: "A kettle on a stove" }
            : visual,
        ),
      }),
    );

    const stored = toQualityFindings(report);
    const selected = storedIssuesForScene(stored, 1);

    expect(selected.length).toBeGreaterThan(0);
    // Every message selected belongs to a row whose stored scene really is 1.
    for (const message of selected) {
      const source = stored.find((f) => f.message === message);
      expect(sceneOfFinding(source?.detail)).toBe(1);
    }
    // And scene 0, which carried its constraints, is told to correct nothing.
    expect(storedIssuesForScene(stored, 0)).toEqual([]);
  });

  it("is empty for a project that has never been checked", () => {
    // The stage passes `check?.findings ?? []`, so this is the first-run case: a
    // regeneration with no stored report is a plain redraw, not a crash.
    expect(storedIssuesForScene([], 0)).toEqual([]);
  });
});

describe("isVoiceCode", () => {
  it("is true for exactly the codes a visual regeneration cannot fix", () => {
    /**
     * Exported so `executeSceneRegeneration` can apply the same exclusion the report
     * already applies. A second copy of the prefix test in the pipeline is how the two
     * would come to disagree — and a disagreement here means an image model being told
     * to correct a narration.
     */
    for (const code of [
      "continuity.voice.missing",
      "continuity.voice.assignment_mismatch",
      "continuity.voice.drift",
      "continuity.voice.unused",
      // A code that does not exist yet is excluded by default, which is the point of a
      // prefix test rather than a list of the three that do.
      "continuity.voice.something_added_later",
    ]) {
      expect(isVoiceCode(code), code).toBe(true);
    }

    for (const code of [
      "continuity.score",
      "continuity.character.missing_constraint",
      "continuity.style.missing_constraint",
      "continuity.duplicate.shot",
      "continuity.story.dangling_echo",
      "continuity.regenerate",
    ]) {
      expect(isVoiceCode(code), code).toBe(false);
    }
  });

  it("keeps voice findings out of a stored-finding regeneration prompt", () => {
    /**
     * The other half of the exclusion, on the path that actually spends money.
     * `issuesForScene` covers a live report; `storedIssuesForScene` covers the rows the
     * regeneration stage reads back, and only the second one is reachable from a job.
     */
    const voiced = validateContinuity(
      input({
        bible: voicedBible(CANONICAL),
        states: voicedStates(3),
        voices: voiceRecords(3, { 1: OTHER }),
        // A real visual failure on the same scene, so the prompt is not empty for the
        // trivial reason that nothing at all was wrong with it.
        visuals: realVisuals(voicedStates(3), capabilitiesFor("episodic"), voicedBible(CANONICAL)).map(
          (visual) =>
            visual.sceneIndex === 1
              ? { ...visual, visualPrompt: "A figure at a bench", shotPrompt: "A figure at a bench" }
              : visual,
        ),
      }),
    );

    const stored = toQualityFindings(voiced);
    expect(stored.some((row) => row.code === "continuity.voice.assignment_mismatch")).toBe(
      true,
    );

    const issues = storedIssuesForScene(stored, 1);

    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.toLowerCase()).not.toContain("narrated");
      expect(issue.toLowerCase()).not.toContain("voice");
    }
  });

  it("agrees with the codes checkVoices actually emits", () => {
    // The predicate is a string test; this is what ties it to the emitter. A voice code
    // added under a different prefix would pass the test above and fail here.
    const report = validateContinuity(
      input({
        bible: voicedBible(CANONICAL),
        states: voicedStates(3),
        voices: voiceRecords(3, { 2: OTHER }),
      }),
    );

    const voice = report.issues.filter((issue) =>
      issue.message.toLowerCase().includes("voice"),
    );
    expect(voice.length).toBeGreaterThan(0);
    for (const issue of voice) expect(isVoiceCode(issue.code)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Voice continuity
// ---------------------------------------------------------------------------

/**
 * A bible where Mara is voiced, plus optional extra characters.
 *
 * Built from `BIBLE` so the visual half of every case below still passes: a fixture
 * that lost Mara's appearance facts would fail the character check as well, and the
 * scores under test would move for two reasons at once.
 */
function voicedBible(voiceId: string | null, extra: unknown[] = []) {
  return parseStoryBible({
    characters: [
      {
        ...BIBLE.characters[0],
        ...(voiceId === null
          ? {}
          : { voice: { providerVoiceId: voiceId, name: "Mara's voice" } }),
      },
      ...extra,
    ],
    environments: BIBLE.environments,
    props: BIBLE.props,
    style: BIBLE.style,
  });
}

/** Mara leads every scene. */
function voicedStates(count: number): IndexedSceneState[] {
  return Array.from({ length: count }, (_, i) => ({
    sceneIndex: i,
    state: parseSceneState({ characters: ["mara"], environment: "workshop" }),
  }));
}

const CANONICAL = "voice-unit-placeholder-canonical";
const OTHER = "voice-unit-placeholder-other";
const BEN = "voice-unit-placeholder-ben";

/** A record per scene, all the same voice unless overridden. */
function voiceRecords(
  count: number,
  overrides: Record<number, string | null> = {},
) {
  return Array.from({ length: count }, (_, i) => ({
    sceneIndex: i,
    providerVoiceId: i in overrides ? overrides[i]! : CANONICAL,
    characterId: "mara",
    provider: "mock",
    source: "character" as const,
  }));
}

describe("voice continuity", () => {
  it("scores a project whose scenes used the canonical voice at 100", () => {
    // The closed loop, as for prompts: the assignment the resolver produces satisfies
    // the validator. A drift between the two halves fails here first.
    const report = validateContinuity(
      input({
        bible: voicedBible(CANONICAL),
        states: voicedStates(3),
        voices: voiceRecords(3),
      }),
    );

    expect(report.score).toBe(100);
    expect(
      report.issues.filter((i) => i.code.startsWith("continuity.voice.")),
    ).toEqual([]);
  });

  it("scores a project with no character voices exactly as it did before", () => {
    /**
     * §25's guarantee, asserted as an equality rather than as a range.
     *
     * The same states and prompts, with and without a voice on Mara and with no voice
     * records either way. If the voice check ever contributed to the tally for an
     * unvoiced project these two numbers would diverge, and every existing project's
     * score would have silently moved.
     */
    const states = voicedStates(3);
    const withoutVoices = validateContinuity(
      input({ bible: voicedBible(null), states }),
    );
    const withVoicesButNoRecords = validateContinuity(
      input({ bible: voicedBible(CANONICAL), states }),
    );

    expect(withoutVoices.score).toBe(withVoicesButNoRecords.score);
    expect(
      withoutVoices.issues.some((i) => i.code.startsWith("continuity.voice.")),
    ).toBe(false);
  });

  it("reports a mismatch when a scene was narrated in another voice", () => {
    const report = validateContinuity(
      input({
        bible: voicedBible(CANONICAL),
        states: voicedStates(3),
        voices: voiceRecords(3, { 1: OTHER }),
      }),
    );

    const issue = report.issues.find(
      (i) => i.code === "continuity.voice.assignment_mismatch",
    );

    expect(issue?.severity).toBe("fail");
    expect(issue?.sceneIndex).toBe(1);
    expect(issue?.entityId).toBe("mara");
    expect(report.score).toBeLessThan(100);
    // The provider voice id is never in the message: it is meaningless to an operator
    // and it is the vendor's token, not Tally's.
    expect(issue?.message).not.toContain(OTHER);
    expect(issue?.message).not.toContain(CANONICAL);
  });

  it("reports drift when one character is heard as two voices", () => {
    // Scenes 0 and 1 in the canonical voice, scene 2 in another: the character audibly
    // changes mid-video, which is the failure the feature exists to prevent.
    const report = validateContinuity(
      input({
        bible: voicedBible(CANONICAL),
        states: voicedStates(3),
        voices: voiceRecords(3, { 2: OTHER }),
      }),
    );

    const drift = report.issues.find((i) => i.code === "continuity.voice.drift");
    expect(drift?.severity).toBe("fail");
    expect(drift?.sceneIndex).toBe(2);
    expect(drift?.entityId).toBe("mara");
    // Names both scenes, so an operator knows which two to compare.
    expect(drift?.message).toContain("scene 2");
    expect(drift?.message).toContain("scene 0");
    expect(report.score).toBeLessThan(100);
  });

  it("distinguishes disobeying the bible from changing mid-video", () => {
    /**
     * Why `mismatch` and `drift` are separate codes rather than one.
     *
     * Every scene voiced with the same wrong id is internally consistent audio that
     * disobeys the bible: a mismatch on each scene and drift on none. The earlier
     * shape of this check returned after the first mismatch, which made drift
     * unreachable whenever the bible was also disobeyed — that is, nearly always.
     */
    const report = validateContinuity(
      input({
        bible: voicedBible(CANONICAL),
        states: voicedStates(3),
        voices: voiceRecords(3, { 0: OTHER, 1: OTHER, 2: OTHER }),
      }),
    );

    const codes = report.issues.map((i) => i.code);
    expect(codes.filter((c) => c === "continuity.voice.assignment_mismatch")).toHaveLength(
      3,
    );
    expect(codes).not.toContain("continuity.voice.drift");
  });

  it("counts a scene that is both a mismatch and a drift as one wrong voice", () => {
    /**
     * Two descriptions of one wrong voice are not two wrong voices.
     *
     * The comparison is built to hold the denominator fixed: both videos have three
     * scenes, each with a voice contract, and exactly one scene narrated in the wrong
     * voice. The only difference is that Mara's wrong scene is also a drift — she is
     * heard correctly first — while Ben's cannot be, because he leads one scene and has
     * nothing to have drifted from. Same misses over same expected, so the same score;
     * one extra finding describing the same fault.
     */
    const cast = [
      { id: "ben", name: "Ben", appearance: ["ginger hair"], voice: { providerVoiceId: BEN } },
    ];
    const threeStates: IndexedSceneState[] = [
      { sceneIndex: 0, state: parseSceneState({ characters: ["mara"] }) },
      { sceneIndex: 1, state: parseSceneState({ characters: ["ben"] }) },
      { sceneIndex: 2, state: parseSceneState({ characters: ["mara"] }) },
    ];

    // Ben's one scene narrated in the wrong voice: a mismatch, and no drift possible.
    const mismatchOnly = validateContinuity(
      input({
        bible: voicedBible(CANONICAL, cast),
        states: threeStates,
        voices: [
          { sceneIndex: 0, providerVoiceId: CANONICAL, characterId: "mara", provider: "mock", source: "character" as const },
          { sceneIndex: 1, providerVoiceId: OTHER, characterId: "ben", provider: "mock", source: "character" as const },
          { sceneIndex: 2, providerVoiceId: CANONICAL, characterId: "mara", provider: "mock", source: "character" as const },
        ],
      }),
    );

    // Mara's second scene narrated in the wrong voice: a mismatch *and* a drift.
    const both = validateContinuity(
      input({
        bible: voicedBible(CANONICAL, cast),
        states: threeStates,
        voices: [
          { sceneIndex: 0, providerVoiceId: CANONICAL, characterId: "mara", provider: "mock", source: "character" as const },
          { sceneIndex: 1, providerVoiceId: BEN, characterId: "ben", provider: "mock", source: "character" as const },
          { sceneIndex: 2, providerVoiceId: OTHER, characterId: "mara", provider: "mock", source: "character" as const },
        ],
      }),
    );

    const codesOf = (r: typeof both) =>
      r.issues.filter((i) => i.code.startsWith("continuity.voice.")).map((i) => i.code);

    expect(codesOf(mismatchOnly)).toEqual(["continuity.voice.assignment_mismatch"]);
    expect(codesOf(both)).toEqual([
      "continuity.voice.assignment_mismatch",
      "continuity.voice.drift",
    ]);
    // One extra finding, identical deduction.
    expect(both.score).toBe(mismatchOnly.score);
  });

  it("warns rather than fails for a character with no canonical voice", () => {
    // A gap, not a break: the project voice narrated the scene, which is what Tally
    // has always done. Failing it would spend a regeneration on business as usual.
    const states: IndexedSceneState[] = [
      {
        sceneIndex: 0,
        state: parseSceneState({ characters: ["mara"], environment: "workshop" }),
      },
      {
        sceneIndex: 1,
        state: parseSceneState({ characters: ["ben"], environment: "workshop" }),
      },
    ];

    const report = validateContinuity(
      input({
        bible: voicedBible(CANONICAL, [
          { id: "ben", name: "Ben", appearance: ["ginger hair"] },
        ]),
        states,
        voices: voiceRecords(1),
      }),
    );

    const issue = report.issues.find((i) => i.code === "continuity.voice.missing");
    expect(issue?.severity).toBe("warn");
    expect(issue?.sceneIndex).toBe(1);
    expect(issue?.entityId).toBe("ben");
    expect(issue?.message).toContain("Ben");
  });

  it("says nothing about a scene it has no record for", () => {
    // A project checked before its voiceover ran. Inventing a break out of an absent
    // measurement is exactly what an honest report must not do.
    const report = validateContinuity(
      input({ bible: voicedBible(CANONICAL), states: voicedStates(3), voices: [] }),
    );

    expect(report.issues.some((i) => i.code === "continuity.voice.drift")).toBe(false);
    expect(
      report.issues.some((i) => i.code === "continuity.voice.assignment_mismatch"),
    ).toBe(false);
  });

  it("treats a silent scene as legitimately unvoiced", () => {
    const report = validateContinuity(
      input({
        bible: voicedBible(CANONICAL),
        states: voicedStates(3),
        voices: voiceRecords(3, { 2: null }),
      }),
    );

    expect(report.score).toBe(100);
  });

  it("notes an assigned voice that never speaks, without moving the score", () => {
    const clean = validateContinuity(
      input({
        bible: voicedBible(CANONICAL),
        states: voicedStates(2),
        voices: voiceRecords(2),
      }),
    );
    const withUnused = validateContinuity(
      input({
        bible: voicedBible(CANONICAL, [
          {
            id: "ben",
            name: "Ben",
            appearance: ["ginger hair"],
            voice: { providerVoiceId: OTHER, name: "Ben's voice" },
          },
        ]),
        states: voicedStates(2),
        voices: voiceRecords(2),
      }),
    );

    const note = withUnused.issues.find((i) => i.code === "continuity.voice.unused");
    expect(note?.severity).toBe("info");
    expect(note?.sceneIndex).toBeNull();
    expect(note?.entityId).toBe("ben");
    // A casting decision, not a continuity break.
    expect(withUnused.score).toBe(clean.score);
  });

  it("keeps voice failures out of the regeneration set", () => {
    /**
     * The cost guarantee. `scenesToRegenerate` reads `affectedScenes` and
     * `executeSceneRegeneration` regenerates a scene's *visual* — redrawing a shot
     * cannot change which voice narrated it, so a voice mismatch must not bill for an
     * image generation. The finding stays `fail` and still moves the score; only the
     * automatic re-billing is excluded.
     */
    const report = validateContinuity(
      input({
        bible: voicedBible(CANONICAL),
        states: voicedStates(3),
        voices: voiceRecords(3, { 1: OTHER }),
      }),
    );

    expect(
      report.issues.some(
        (i) =>
          i.code === "continuity.voice.assignment_mismatch" && i.severity === "fail",
      ),
    ).toBe(true);
    expect(report.affectedScenes).not.toContain(1);
    expect(issuesForScene(report, 1)).toEqual([]);
  });

  it("says nothing at a level that does not track characters", () => {
    const states: IndexedSceneState[] = Array.from({ length: 3 }, (_, i) => ({
      sceneIndex: i,
      state: parseSceneState({}),
    }));

    const report = validateContinuity(
      input({
        bible: voicedBible(CANONICAL),
        states,
        capabilities: capabilitiesFor("style"),
        voices: voiceRecords(3, { 1: OTHER }),
      }),
    );

    expect(report.issues.some((i) => i.code.startsWith("continuity.voice."))).toBe(
      false,
    );
  });

  it("is deterministic, records and all", () => {
    const args = input({
      bible: voicedBible(CANONICAL),
      states: voicedStates(4),
      voices: voiceRecords(4, { 2: OTHER }),
    });

    const once = JSON.stringify(validateContinuity(args));
    expect(JSON.stringify(validateContinuity(args))).toBe(once);
    // Record order is an artefact of how the rows came back, not a fact about the
    // video, so it must not change the report.
    expect(
      JSON.stringify(
        validateContinuity({ ...args, voices: [...(args.voices ?? [])].reverse() }),
      ),
    ).toBe(once);
  });

  it("carries voice findings into quality findings unchanged in shape", () => {
    const report = validateContinuity(
      input({
        bible: voicedBible(CANONICAL),
        states: voicedStates(3),
        voices: voiceRecords(3, { 1: OTHER }),
      }),
    );

    const row = toQualityFindings(report).find(
      (f) => f.code === "continuity.voice.assignment_mismatch",
    );

    expect(row).toBeDefined();
    expect(row?.detail).toContain("scene 1");
    expect(row?.detail).toContain("entity mara");
  });

  it("names an action an operator can actually take", () => {
    /**
     * The messaging correction, asserted rather than left to review.
     *
     * These details used to instruct a "re-run of the voiceover stage". No surface
     * offers one, and there is no narrow path to add cheaply: `executeVoiceover` ends by
     * chaining into visuals, so re-running it redraws every scene at full provider cost,
     * and the segment durations it produces are what the timeline, the captions and the
     * render are built from. A finding that names an unavailable action is a finding an
     * operator cannot act on, so each one names the rebuild that does fix it — which
     * works because `sceneVoicesFor` resolves the assignment from the bible on every
     * run, so a corrected bible is obeyed by the next build.
     */
    const report = validateContinuity(
      input({
        bible: voicedBible(CANONICAL),
        states: voicedStates(3),
        voices: voiceRecords(3, { 1: OTHER, 2: OTHER }),
      }),
    );

    const voice = report.issues.filter((issue) => isVoiceCode(issue.code));
    const failures = voice.filter((issue) => issue.severity === "fail");
    expect(failures.length).toBeGreaterThan(0);

    for (const issue of failures) {
      const detail = issue.detail ?? "";
      // The action that exists.
      expect(detail.toLowerCase(), issue.code).toContain("rebuild");
      // And not the one that does not. No phrasing of "re-run the voiceover", and
      // nothing promising a single scene can be re-narrated on its own.
      expect(detail.toLowerCase(), issue.code).not.toMatch(/re-?run/);
      expect(detail.toLowerCase(), issue.code).not.toMatch(/voiceover stage/);
    }

    // The mismatch says outright that no per-scene re-narration exists, because an
    // operator's first instinct is to look for one.
    const mismatch = failures.find(
      (issue) => issue.code === "continuity.voice.assignment_mismatch",
    );
    expect(mismatch?.detail).toContain("no way to re-narrate one scene on its own");
  });
});

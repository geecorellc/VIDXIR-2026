/**
 * Level resolution and threshold tests (§15, §24).
 *
 * This module is the layer's cheapest and most consequential decision: a project
 * resolved to `off` costs nothing for the rest of the pipeline, and a project
 * resolved too high fails videos for missing something they never had.
 *
 * Three properties are load-bearing:
 *
 *  - **Stock footage is `off`, unconditionally.** This is the branch that keeps every
 *    project built before this layer behaving exactly as it did (§25). No content
 *    style, video style or audience may override it — a stock library cannot hold a
 *    character consistent, so constraining and then failing would be pure noise.
 *  - **Preschool wins over the content style** (§15), and widens the duplicate marks.
 *    A song repeating "clap your hands" over four verses is *supposed* to repeat.
 *  - **Resolution is free and total.** No AI call, no database read, and an answer for
 *    every input including all-null — the case for every legacy project.
 */
import { describe, expect, it } from "vitest";
import {
  CONTINUITY_LEVELS,
  DEFAULT_THRESHOLDS,
  atLeast,
  capabilitiesFor,
  isContinuityLevel,
  isPreschoolAudience,
  levelRank,
  resolveContinuityPlan,
  thresholdsFor,
  type LevelInput,
} from "@/lib/continuity/config";

function input(overrides: Partial<LevelInput> = {}): LevelInput {
  return {
    generationMode: "AI_VIDEO",
    contentStyle: null,
    videoStyle: null,
    targetAudience: null,
    ...overrides,
  };
}

describe("levels", () => {
  it("ranks weakest to strictest", () => {
    expect(CONTINUITY_LEVELS[0]).toBe("off");
    expect(levelRank("off")).toBeLessThan(levelRank("style"));
    expect(levelRank("style")).toBeLessThan(levelRank("world"));
    expect(levelRank("world")).toBeLessThan(levelRank("character"));
    expect(levelRank("character")).toBeLessThan(levelRank("episodic"));
  });

  it("compares inclusively", () => {
    expect(atLeast("character", "character")).toBe(true);
    expect(atLeast("episodic", "character")).toBe(true);
    expect(atLeast("world", "character")).toBe(false);
    expect(atLeast("off", "style")).toBe(false);
  });

  it("recognises only the five known levels", () => {
    for (const level of CONTINUITY_LEVELS) expect(isContinuityLevel(level)).toBe(true);
    expect(isContinuityLevel("strict")).toBe(false);
    expect(isContinuityLevel("")).toBe(false);
    expect(isContinuityLevel(null)).toBe(false);
    expect(isContinuityLevel(3)).toBe(false);
  });
});

describe("capabilitiesFor", () => {
  it("switches everything off at `off`", () => {
    expect(capabilitiesFor("off")).toEqual({
      characters: false,
      environments: false,
      props: false,
      style: false,
      duplicates: false,
    });
  });

  it("widens monotonically as the level rises", () => {
    // The property, rather than five pinned tables: a stricter level must never
    // switch a capability back off, or a video could pass at `character` for
    // something it failed at `world`.
    const keys = ["characters", "environments", "props", "style", "duplicates"] as const;

    for (let i = 1; i < CONTINUITY_LEVELS.length; i += 1) {
      const weaker = capabilitiesFor(CONTINUITY_LEVELS[i - 1]!);
      const stronger = capabilitiesFor(CONTINUITY_LEVELS[i]!);
      for (const key of keys) {
        if (weaker[key]) expect(stronger[key]).toBe(true);
      }
    }
  });

  it("tracks no characters below `character`", () => {
    expect(capabilitiesFor("style").characters).toBe(false);
    expect(capabilitiesFor("world").characters).toBe(false);
    expect(capabilitiesFor("character").characters).toBe(true);
  });
});

describe("resolveContinuityPlan", () => {
  it("is `off` for stock footage whatever else is set", () => {
    // The §25 guarantee, tested against every input that could plausibly override it.
    for (const overrides of [
      {},
      { contentStyle: "storytelling" },
      { targetAudience: "preschool children" },
      { videoStyle: "cinematic", contentStyle: "documentary" },
    ]) {
      const plan = resolveContinuityPlan(
        input({ generationMode: "STOCK", ...overrides }),
      );
      expect(plan.level).toBe("off");
      expect(plan.capabilities.duplicates).toBe(false);
    }
  });

  it("is `off` when the generation mode is unknown", () => {
    // An old project row with a null mode is not AI video, so it must not acquire
    // continuity retroactively.
    expect(resolveContinuityPlan(input({ generationMode: null })).level).toBe("off");
  });

  it("gives storytelling `character`", () => {
    expect(resolveContinuityPlan(input({ contentStyle: "storytelling" })).level).toBe(
      "character",
    );
  });

  it("gives documentary, explainer and tutorial `world`", () => {
    for (const style of ["documentary", "explainer", "tutorial"]) {
      expect(resolveContinuityPlan(input({ contentStyle: style })).level).toBe("world");
    }
  });

  it("gives listicle and commentary `style` — a voice over footage has no cast", () => {
    for (const style of ["listicle", "commentary"]) {
      expect(resolveContinuityPlan(input({ contentStyle: style })).level).toBe("style");
    }
  });

  it("gives motion graphics `style` even when the content style says otherwise", () => {
    const plan = resolveContinuityPlan(
      input({ contentStyle: "vlog", videoStyle: "motion-graphics" }),
    );
    expect(plan.level).toBe("style");
  });

  it("does not let motion graphics override a narrative content style", () => {
    // Content style is checked first on purpose: an animated story is still a story.
    const plan = resolveContinuityPlan(
      input({ contentStyle: "storytelling", videoStyle: "motion-graphics" }),
    );
    expect(plan.level).toBe("character");
  });

  it("defaults AI video with nothing known to `style`, never `off`", () => {
    const plan = resolveContinuityPlan(input());
    expect(plan.level).toBe("style");
    expect(plan.capabilities.style).toBe(true);
  });

  it("raises preschool content to `character` over any content style", () => {
    // §15: the bear must not change colour between verses.
    for (const style of [null, "listicle", "commentary", "documentary"]) {
      const plan = resolveContinuityPlan(
        input({ contentStyle: style, targetAudience: "Toddlers aged 2-4" }),
      );
      expect(plan.level).toBe("character");
      expect(plan.preschool).toBe(true);
    }
  });

  it("reports preschool even on a stock project, where the level is off", () => {
    // The flag is a fact about the audience, not about the level. Keeping it true
    // here means a stock project's thresholds are still audience-appropriate if
    // anything downstream reads them.
    const plan = resolveContinuityPlan(
      input({ generationMode: "STOCK", targetAudience: "kids" }),
    );
    expect(plan.level).toBe("off");
    expect(plan.preschool).toBe(true);
  });

  it("normalises the case and whitespace of a style", () => {
    expect(
      resolveContinuityPlan(input({ contentStyle: "  STORYTELLING " })).level,
    ).toBe("character");
  });

  it("always gives a non-empty reason and matching capabilities", () => {
    for (const overrides of [
      { generationMode: "STOCK" as const },
      { contentStyle: "storytelling" },
      { contentStyle: "documentary" },
      { contentStyle: "listicle" },
      { videoStyle: "motion-graphics" },
      { targetAudience: "nursery" },
      {},
    ]) {
      const plan = resolveContinuityPlan(input(overrides));
      expect(plan.reason.length).toBeGreaterThan(0);
      // The reason is shown verbatim in the UI, so it must read as a sentence.
      expect(plan.reason.trim()).toBe(plan.reason);
      expect(plan.capabilities).toEqual(capabilitiesFor(plan.level));
    }
  });

  it("is deterministic", () => {
    const args = input({ contentStyle: "documentary", targetAudience: "adults" });
    expect(resolveContinuityPlan(args)).toEqual(resolveContinuityPlan(args));
  });
});

describe("isPreschoolAudience", () => {
  it("matches the children's-content vocabulary case-insensitively", () => {
    for (const audience of [
      "preschool",
      "Pre-School teachers",
      "toddlers",
      "Nursery rhymes",
      "kindergarten kids",
      "children aged 3-5",
      "KIDS",
      "babies and infants",
    ]) {
      expect(isPreschoolAudience(audience)).toBe(true);
    }
  });

  it("does not match unrelated audiences", () => {
    for (const audience of [null, "", "adults", "software engineers", "gamers 18-34"]) {
      expect(isPreschoolAudience(audience)).toBe(false);
    }
  });
});

describe("thresholdsFor", () => {
  it("uses the defaults for general content", () => {
    const plan = resolveContinuityPlan(input({ contentStyle: "storytelling" }));
    expect(thresholdsFor(plan)).toEqual(DEFAULT_THRESHOLDS);
  });

  it("raises the duplicate marks towards identity for children's content", () => {
    // Asserted as a relation, not as pinned numbers: the point is that a preschool
    // video tolerates more repetition, and the constants are meant to be tuned.
    const preschool = thresholdsFor(
      resolveContinuityPlan(input({ targetAudience: "toddlers" })),
    );

    expect(preschool.duplicate).toBeGreaterThan(DEFAULT_THRESHOLDS.duplicate);
    expect(preschool.suspicious).toBeGreaterThan(DEFAULT_THRESHOLDS.suspicious);
    // Still a threshold, and still ordered.
    expect(preschool.duplicate).toBeLessThanOrEqual(1);
    expect(preschool.suspicious).toBeLessThan(preschool.duplicate);
  });

  it("does not move the score marks or the regeneration cap for children's content", () => {
    // Repetition tolerance is a duplicate-detection decision. Loosening the pass
    // mark as well would quietly accept a worse video, and raising the cap would
    // spend more provider calls.
    const preschool = thresholdsFor(
      resolveContinuityPlan(input({ targetAudience: "kids" })),
    );

    expect(preschool.pass).toBe(DEFAULT_THRESHOLDS.pass);
    expect(preschool.fail).toBe(DEFAULT_THRESHOLDS.fail);
    expect(preschool.maxRegenerations).toBe(DEFAULT_THRESHOLDS.maxRegenerations);
  });

  it("keeps the defaults internally consistent", () => {
    expect(DEFAULT_THRESHOLDS.fail).toBeLessThan(DEFAULT_THRESHOLDS.pass);
    expect(DEFAULT_THRESHOLDS.suspicious).toBeLessThan(DEFAULT_THRESHOLDS.duplicate);
    // Regeneration is a paid provider call per scene, so the cap must be a small
    // positive integer rather than "however many failed".
    expect(DEFAULT_THRESHOLDS.maxRegenerations).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_THRESHOLDS.maxRegenerations)).toBe(true);
    expect(DEFAULT_THRESHOLDS.maxRegenerations).toBeLessThanOrEqual(10);
  });
});

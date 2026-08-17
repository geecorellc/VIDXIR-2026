/**
 * Scene segmentation tests (§39).
 *
 * The property under test throughout is the one the whole design rests on: the
 * narration that reaches the voiceover is **the approved script, verbatim**. Every
 * other assertion here — sentence boundaries, runt merging, scene counts — matters
 * only because a bug in it would silently change what the voice reads.
 */
import { describe, expect, it } from "vitest";
import { estimateSceneMs, segmentScript } from "@/lib/video/scenes";
import type { ScriptDraft } from "@/lib/scripts/prompt";

function draft(overrides: Partial<ScriptDraft> = {}): ScriptDraft {
  return {
    title: "Why compound interest beats a raise",
    titleIdeas: [],
    hook: "You are being lied to about saving money.",
    introduction: "Most advice tells you to earn more. The maths says otherwise.",
    sections: [
      {
        heading: "The problem",
        body: "A raise is taxed the moment it arrives. Compounding is not.",
        talkingPoints: ["Tax hits income first"],
      },
      {
        heading: "The mechanism",
        body: "Every year the balance grows on last year's growth.",
      },
      {
        heading: "The result",
        body: "Thirty years later the gap is enormous.",
      },
    ],
    conclusion: "So the lever is time, not salary.",
    cta: "Subscribe for more of this.",
    storyStructure: "problem-mechanism-result",
    references: [],
    ...overrides,
  };
}

/** Every word of the script, normalised for whitespace only. */
function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

describe("segmentScript", () => {
  it("preserves every word of the script across the scenes", () => {
    const d = draft();
    const scenes = segmentScript(d);

    const expected = words(
      [
        d.hook,
        d.introduction,
        ...d.sections.map((s) =>
          s.transition ? `${s.body} ${s.transition}` : s.body,
        ),
        d.conclusion,
        d.cta,
      ].join(" "),
    );

    expect(words(scenes.map((s) => s.narration).join(" "))).toEqual(expected);
  });

  it("gives the hook its own scene with no transition in", () => {
    const scenes = segmentScript(draft());
    expect(scenes[0]?.label).toBe("Hook");
    expect(scenes[0]?.narration).toBe("You are being lied to about saving money.");
    // Fading in from black onto the first frame wastes the hook.
    expect(scenes[0]?.transition).toBe("none");
  });

  it("numbers scenes contiguously from zero", () => {
    const scenes = segmentScript(draft());
    expect(scenes.map((s) => s.index)).toEqual(scenes.map((_, i) => i));
  });

  it("labels section scenes with the section's own heading", () => {
    const scenes = segmentScript(draft());
    expect(scenes.some((s) => s.label === "The mechanism")).toBe(true);
  });

  it("speaks a section's transition line rather than dropping it", () => {
    const scenes = segmentScript(
      draft({
        sections: [
          {
            heading: "One",
            body: "First the setup.",
            transition: "But there is a catch.",
          },
          { heading: "Two", body: "Then the catch itself." },
          { heading: "Three", body: "Then what to do about it." },
        ],
      }),
    );

    const narration = scenes.map((s) => s.narration).join(" ");
    expect(narration).toContain("But there is a catch.");
  });

  it("splits a long section into several scenes on sentence boundaries", () => {
    const sentence = "This is a complete sentence about the topic at hand. ";
    const scenes = segmentScript(
      draft({
        sections: [
          { heading: "Long", body: sentence.repeat(20).trim() },
          { heading: "B", body: "Short." },
          { heading: "C", body: "Also short." },
        ],
      }),
    );

    const longScenes = scenes.filter((s) => s.label === "Long");
    expect(longScenes.length).toBeGreaterThan(1);
    // Each chunk ends where a sentence ends, never mid-clause.
    for (const scene of longScenes) {
      expect(scene.narration.trim().endsWith(".")).toBe(true);
    }
  });

  it("keeps abbreviations, decimals and initials inside one sentence", () => {
    const body =
      "Dr. Chen showed the fund returned 4.5 percent, i.e. above inflation, across the U.S. market every year.";

    const scenes = segmentScript(
      draft({
        sections: [
          { heading: "Data", body },
          { heading: "B", body: "Filler sentence one." },
          { heading: "C", body: "Filler sentence two." },
        ],
      }),
    );

    const data = scenes.filter((s) => s.label === "Data");
    // One sentence in, one scene out — and the periods come back untouched.
    expect(data).toHaveLength(1);
    expect(data[0]?.narration).toBe(body);
  });

  it("assigns talking points to the scenes of their own section only", () => {
    const scenes = segmentScript(
      draft({
        sections: [
          // Two sections deliberately share a heading: an earlier implementation
          // matched by label and cross-assigned one section's points to the other.
          { heading: "Same", body: "First body here.", talkingPoints: ["Point A"] },
          { heading: "Same", body: "Second body here.", talkingPoints: ["Point B"] },
          { heading: "Other", body: "Third body here." },
        ],
      }),
    );

    const same = scenes.filter((s) => s.label === "Same");
    expect(same[0]?.onScreenText).toBe("Point A");
    expect(same[1]?.onScreenText).toBe("Point B");
  });

  it("rejects a talking point too long to be an overlay", () => {
    const long = "This talking point is a full sentence and far too long to sit on screen as an overlay.";
    const scenes = segmentScript(
      draft({
        sections: [
          { heading: "A", body: "Body one.", talkingPoints: [long] },
          { heading: "B", body: "Body two." },
          { heading: "C", body: "Body three." },
        ],
      }),
    );

    expect(scenes.find((s) => s.label === "A")?.onScreenText).toBeNull();
  });

  it("folds a runt trailing chunk into its predecessor", () => {
    const sentence = "This is a reasonably long sentence carrying the argument forward. ";
    const scenes = segmentScript(
      draft({
        sections: [
          { heading: "Runt", body: `${sentence.repeat(6)}Right.` },
          { heading: "B", body: "Filler." },
          { heading: "C", body: "More filler." },
        ],
      }),
    );

    // "Right." is two words; on its own it would get a stock clip and a cut.
    expect(scenes.some((s) => s.narration.trim() === "Right.")).toBe(false);
    expect(scenes.some((s) => s.narration.includes("Right."))).toBe(true);
  });

  it("does not merge across a label boundary", () => {
    const scenes = segmentScript(
      draft({
        conclusion: "Done.",
        cta: "Subscribe.",
      }),
    );

    // Both are runts, but merging them would put the CTA's visual on the
    // conclusion's scene.
    expect(scenes.at(-1)?.label).toBe("CTA");
    expect(scenes.at(-1)?.narration).toBe("Subscribe.");
  });

  it("omits empty optional beats instead of producing silent scenes", () => {
    const scenes = segmentScript(draft({ introduction: "", conclusion: "" }));
    expect(scenes.some((s) => s.label === "Intro")).toBe(false);
    expect(scenes.some((s) => s.label === "Conclusion")).toBe(false);
    expect(scenes.every((s) => s.narration.trim().length > 0)).toBe(true);
  });

  it("counts words per scene consistently with its narration", () => {
    for (const scene of segmentScript(draft())) {
      expect(scene.wordCount).toBe(words(scene.narration).length);
    }
  });

  it("leaves search terms and visual prompt unset before direction", () => {
    for (const scene of segmentScript(draft())) {
      expect(scene.visualPrompt).toBeNull();
      expect(scene.searchTerms).toEqual([]);
    }
  });
});

describe("estimateSceneMs", () => {
  it("scales with the word count at the narration rate", () => {
    // 150 words at 150 wpm is a minute.
    expect(estimateSceneMs(150)).toBe(60_000);
  });

  it("floors a very short scene rather than returning a flash frame", () => {
    expect(estimateSceneMs(1)).toBe(4_000);
  });
});

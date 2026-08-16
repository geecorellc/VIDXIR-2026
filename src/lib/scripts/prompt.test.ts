/**
 * Script prompt unit tests (§9, §29, §39).
 *
 * Two kinds of claim are worth pinning here, and neither needs a database or a
 * provider:
 *
 *  - **The measurement is real.** §42 forbids invented numbers, and the duration
 *    shown on the Script screen is derived from the delivered word count. These
 *    tests assert what is counted and what is deliberately not — headings and
 *    talking points become on-screen text, and counting them would inflate the
 *    timeline the video builder plans against.
 *  - **The prompt keeps its promises.** The originality framing, the length
 *    budget, and the prohibition list are the substance of this stage. A test that
 *    reads the assembled prompt is the only thing that stops a refactor from
 *    quietly dropping the sentence that tells the model not to rewrite somebody
 *    else's video.
 */
import { describe, expect, it } from "vitest";
import {
  SCRIPT_SYSTEM_PROMPT,
  ScriptDraftSchema,
  WORDS_PER_MINUTE,
  buildScriptPrompt,
  countSpokenWords,
  estimateDuration,
  wordBudget,
  type ScriptBrief,
  type ScriptDraft,
} from "@/lib/scripts/prompt";

function brief(overrides: Partial<ScriptBrief> = {}): ScriptBrief {
  return {
    projectTitle: "Budget smart home sensors",
    channelTitle: "Wired Cottage",
    niche: "home automation",
    targetAudience: "renters setting up their first smart home",
    contentLanguage: "en-GB",
    contentStyle: "practical, hands-on",
    targetDurationSeconds: 480,
    idea: {
      title: "Why cheap sensors beat expensive ones",
      angle: "Measure the failure rate of the budget tier nobody reviews.",
      rationale: "Every top performer reviews flagship kit.",
      topic: "budget smart home",
      targetKeywords: ["budget smart home", "cheap sensors"],
    },
    sourceTitles: ["I tested 40 smart home gadgets", "Smart home on a budget"],
    ownTopPerformers: ["The plug that saved me £90"],
    brand: { brandName: "Wired Cottage", defaultCta: "Grab the parts list" },
    ...overrides,
  };
}

/**
 * A valid draft with a known word count: 20 spoken words.
 *
 * The words are deliberately long enough to satisfy the schema's per-field
 * character minimums while staying individually countable — the counting tests
 * below assert exact totals, so a fixture of filler prose would make them
 * unreadable.
 */
function draft(overrides: Partial<ScriptDraft> = {}): ScriptDraft {
  return {
    title: "Why cheap sensors beat expensive ones",
    titleIdeas: ["The six pound sensor test"],
    hook: "alpha bravo charlie delta echo",
    introduction: "foxtrot golfclub hotelroom",
    sections: [
      {
        heading: "Heading words here",
        body: "india juliett kilo lima",
        talkingPoints: ["mike november oscar"],
        transition: "papa quebec",
      },
      { heading: "Second heading", body: "romeo sierra" },
      { heading: "Third heading", body: "tango" },
    ],
    conclusion: "uniform victor",
    cta: "whiskeyxrayyankee",
    storyStructure: "test → result → recommendation",
    references: [],
    ...overrides,
  };
}

describe("wordBudget", () => {
  it("converts a duration into words at the stated rate", () => {
    expect(wordBudget(600)).toBe(10 * WORDS_PER_MINUTE);
    expect(wordBudget(480)).toBe(8 * WORDS_PER_MINUTE);
  });

  it("floors at 150 words rather than asking for a script too short to be one", () => {
    // A 20-second target would compute to 50 words. Asking a model for 50 words
    // across a hook, three sections, a conclusion and a CTA produces fragments,
    // and the schema's minimums would reject it — a hard failure in place of a
    // short script.
    expect(wordBudget(20)).toBe(150);
    expect(wordBudget(0)).toBe(150);
  });
});

describe("countSpokenWords", () => {
  it("counts narration and transitions", () => {
    // hook 5 + intro 3 + bodies 4/2/1 + transition 2 + conclusion 2 + cta 1
    expect(countSpokenWords(draft())).toBe(20);
  });

  it("excludes headings and talking points", () => {
    const withExtras = draft({
      sections: [
        {
          heading: "a heading that is quite long indeed",
          body: "one two",
          talkingPoints: ["several extra words here", "and several more again"],
        },
        { heading: "another heading", body: "three" },
        { heading: "third heading", body: "four" },
      ],
    });

    // Headings become storyboard labels and talking points become on-screen
    // text. Neither is spoken, so neither may lengthen the estimated runtime the
    // timeline is planned against.
    // hook 5 + intro 3 + bodies 2/1/1 + conclusion 2 + cta 1
    expect(countSpokenWords(withExtras)).toBe(15);
  });

  it("treats an absent transition as nothing rather than as a word", () => {
    const noTransitions = draft({
      sections: draft().sections.map(({ transition: _drop, ...rest }) => rest),
    });
    expect(countSpokenWords(noTransitions)).toBe(18);
  });

  it("ignores whitespace-only fields", () => {
    expect(countSpokenWords(draft({ conclusion: "   \n  " }))).toBe(18);
  });
});

describe("estimateDuration", () => {
  it("is the inverse of the word budget", () => {
    // The same constant in both directions, so what was asked for and what is
    // reported cannot drift apart.
    expect(estimateDuration(wordBudget(480))).toBe(480);
  });

  it("scales with the word count", () => {
    expect(estimateDuration(150)).toBe(60);
    expect(estimateDuration(75)).toBe(30);
    expect(estimateDuration(0)).toBe(0);
  });
});

describe("buildScriptPrompt", () => {
  it("frames source titles as evidence and forbids using them as material", () => {
    const prompt = buildScriptPrompt(brief());

    expect(prompt).toContain("I tested 40 smart home gadgets");
    // §29. The titles are why the idea was chosen, so removing them loses the
    // brief; including them unframed is how a "research-driven" script becomes a
    // rewrite of the top result.
    expect(prompt).toContain("They are NOT material");
    expect(prompt).toMatch(/take nothing else/i);
  });

  it("omits the source-title block entirely when there are none", () => {
    const prompt = buildScriptPrompt(brief({ sourceTitles: [] }));
    expect(prompt).not.toMatch(/EXISTING VIDEOS/);
  });

  it("states the length as a word budget, not only as minutes", () => {
    const prompt = buildScriptPrompt(brief({ targetDurationSeconds: 600 }));
    // "Make it 10 minutes" means nothing to a text model; 1500 words does.
    expect(prompt).toContain("1500 spoken words");
    expect(prompt).toContain("10 minutes");
    expect(prompt).toMatch(/do not pad/i);
  });

  it("singularises a one-minute target", () => {
    const prompt = buildScriptPrompt(brief({ targetDurationSeconds: 60 }));
    expect(prompt).toContain("1 minute of narration");
  });

  it("carries the idea's angle and rationale, not just its title", () => {
    const prompt = buildScriptPrompt(brief());
    expect(prompt).toContain("Measure the failure rate");
    expect(prompt).toContain("Every top performer reviews flagship kit");
  });

  it("falls back to the project title when there is no idea", () => {
    const prompt = buildScriptPrompt(brief({ idea: null }));
    expect(prompt).toContain("Budget smart home sensors");
  });

  it("includes a revision note only when rewriting", () => {
    expect(buildScriptPrompt(brief())).not.toMatch(/REVISION NOTE/);
    expect(
      buildScriptPrompt(brief({ feedback: "The hook is too slow." })),
    ).toContain("The hook is too slow.");
  });

  it("asks for the channel's language", () => {
    const prompt = buildScriptPrompt(brief({ contentLanguage: "de-DE" }));
    expect(prompt).toContain("Write the complete script in de-DE");
  });

  it("survives an empty brief without emitting the word undefined", () => {
    const sparse = buildScriptPrompt({
      projectTitle: "Untitled",
      channelTitle: null,
      niche: null,
      targetAudience: null,
      contentLanguage: "en-US",
      contentStyle: null,
      targetDurationSeconds: 300,
      idea: null,
      sourceTitles: [],
      ownTopPerformers: [],
      brand: { brandName: null, defaultCta: null },
    });

    // A brand-new channel with no settings still gets a usable prompt. "Niche:
    // undefined" would be a worse instruction than "(not specified)".
    expect(sparse).not.toContain("undefined");
    expect(sparse).not.toContain("null");
    expect(sparse).toContain("(not specified)");
  });
});

describe("SCRIPT_SYSTEM_PROMPT", () => {
  it("forbids stage directions, because a voice model reads them aloud", () => {
    expect(SCRIPT_SYSTEM_PROMPT).toMatch(/stage directions/i);
    expect(SCRIPT_SYSTEM_PROMPT).toMatch(/literally/i);
  });

  it("forbids unverified statistics and requires references for claims", () => {
    expect(SCRIPT_SYSTEM_PROMPT).toMatch(/never state a statistic/i);
    expect(SCRIPT_SYSTEM_PROMPT).toMatch(/references/);
  });

  it("forbids narrating over or summarising another creator's video (§29)", () => {
    expect(SCRIPT_SYSTEM_PROMPT).toMatch(/narrate over/i);
    expect(SCRIPT_SYSTEM_PROMPT).toMatch(/original work/i);
  });

  it("forbids claiming experience the brief does not describe", () => {
    expect(SCRIPT_SYSTEM_PROMPT).toMatch(/personal experience/i);
  });
});

describe("ScriptDraftSchema", () => {
  it("requires the §9 structure", () => {
    expect(ScriptDraftSchema.safeParse(draft()).success).toBe(true);
  });

  it("rejects a body with fewer than three sections", () => {
    const thin = ScriptDraftSchema.safeParse({
      ...draft(),
      sections: draft().sections.slice(0, 2),
    });
    // Two sections is not a shape, and the storyboard would have nothing to
    // build a timeline from.
    expect(thin.success).toBe(false);
  });

  it("rejects a title over YouTube's 100-character limit", () => {
    const long = ScriptDraftSchema.safeParse({
      ...draft(),
      title: "x".repeat(101),
    });
    expect(long.success).toBe(false);
  });

  it("accepts an empty reference list", () => {
    // The prompt tells the model to return an empty array rather than invent
    // sources for a script that makes no factual claims. The schema has to allow
    // that, or the honest answer would be the one that fails validation.
    expect(ScriptDraftSchema.safeParse({ ...draft(), references: [] }).success).toBe(
      true,
    );
  });

  it("allows a reference without a URL", () => {
    const parsed = ScriptDraftSchema.safeParse({
      ...draft(),
      references: [{ label: "ONS 2024 housing survey" }],
    });
    // A model that knows the source but not the exact URL should say so rather
    // than guess a link.
    expect(parsed.success).toBe(true);
  });
});

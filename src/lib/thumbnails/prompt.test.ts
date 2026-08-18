/**
 * The thumbnail concept contract (§16, §29).
 *
 * Two things are asserted here that a reviewer cannot check by reading: that the
 * Zod schema and the JSON schema handed to the model agree — they are written
 * separately, and a disagreement shows up as a model returning valid-looking
 * output that fails validation after the tokens are spent — and that the brief
 * actually carries the script into the prompt, since a prompt missing the hook
 * produces headlines about a video the model has not read.
 */
import { describe, expect, it } from "vitest";
import {
  EMOTIONS,
  MAX_HEADLINE_CHARS,
  MAX_SUBLINE_CHARS,
  THUMBNAIL_JSON_SCHEMA,
  THUMBNAIL_SYSTEM_PROMPT,
  ThumbnailConceptsSchema,
  VARIANT_COUNT,
  buildThumbnailPrompt,
  type ThumbnailBrief,
} from "@/lib/thumbnails/prompt";

function concept(overrides: Record<string, unknown> = {}) {
  return {
    headline: "THE CHEAPEST FIX",
    subline: "And why nobody tries it first",
    concept:
      "Bets on the cost angle, which the script opens with and returns to twice.",
    emotion: "curiosity",
    searchTerms: ["toolbox on concrete floor"],
    ...overrides,
  };
}

const brief: ThumbnailBrief = {
  channelTitle: "Workshop Notes",
  niche: "hand tools",
  targetAudience: "weekend woodworkers",
  contentLanguage: "en-GB",
  scriptTitle: "The cheapest fix for a wobbling bench",
  publishedTitle: "Stop your bench wobbling for £4",
  hook: "Your bench does not need new legs.",
  sectionHeadings: ["Why it wobbles", "The £4 fix", "When it will not work"],
  conclusion: "Check the floor before you blame the bench.",
  brandName: "Workshop Notes",
  primaryColor: "#E8332B",
  thumbnailStyle: "bold-text",
  previousHeadlines: [],
};

describe("ThumbnailConceptsSchema", () => {
  it("requires exactly four concepts, matching the four cards in the UI", () => {
    const four = { concepts: [concept(), concept(), concept(), concept()] };
    expect(ThumbnailConceptsSchema.safeParse(four).success).toBe(true);

    expect(
      ThumbnailConceptsSchema.safeParse({ concepts: [concept(), concept()] }).success,
    ).toBe(false);
    expect(
      ThumbnailConceptsSchema.safeParse({
        concepts: [concept(), concept(), concept(), concept(), concept()],
      }).success,
    ).toBe(false);
  });

  it("caps the headline at what the compositor can lay out legibly", () => {
    // Not the column width. `headline` is varchar(80), but 80 characters at 96px
    // does not fit a 1280-wide frame at a size that survives 320px.
    expect(MAX_HEADLINE_CHARS).toBeLessThan(80);

    const tooLong = concept({ headline: "X".repeat(MAX_HEADLINE_CHARS + 1) });
    expect(
      ThumbnailConceptsSchema.safeParse({
        concepts: [tooLong, concept(), concept(), concept()],
      }).success,
    ).toBe(false);
  });

  it("accepts a null subline, because the strongest thumbnails often have none", () => {
    const parsed = ThumbnailConceptsSchema.safeParse({
      concepts: [
        concept({ subline: null }),
        concept(),
        concept(),
        concept(),
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a subline longer than fits under the headline", () => {
    const parsed = ThumbnailConceptsSchema.safeParse({
      concepts: [
        concept({ subline: "y".repeat(MAX_SUBLINE_CHARS + 1) }),
        concept(),
        concept(),
        concept(),
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an emotion the compositor has no colour treatment for", () => {
    // The compositor's ACCENT map is keyed by this union; an unknown value would
    // index to undefined and produce `fontcolor=undefined`.
    const parsed = ThumbnailConceptsSchema.safeParse({
      concepts: [
        concept({ emotion: "nostalgia" }),
        concept(),
        concept(),
        concept(),
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("requires at least one search term, since the background is searched for", () => {
    expect(
      ThumbnailConceptsSchema.safeParse({
        concepts: [concept({ searchTerms: [] }), concept(), concept(), concept()],
      }).success,
    ).toBe(false);
  });
});

/**
 * `jsonSchema()` returns `Record<string, unknown>` because it is a wire document,
 * not a typed object. Walking it in a test needs a shape, and one written by hand
 * here is honest about the fact that the assertions below are the only thing
 * keeping the two schemas in step.
 */
const conceptsSchema = (
  THUMBNAIL_JSON_SCHEMA["properties"] as {
    concepts: {
      minItems: number;
      maxItems: number;
      items: {
        additionalProperties: boolean;
        required: string[];
        properties: {
          emotion: { enum: string[] };
          subline: { type: string[] };
          searchTerms: { minItems: number; maxItems: number };
        };
      };
    };
  }
).concepts;

describe("THUMBNAIL_JSON_SCHEMA", () => {
  /**
   * The two schemas are authored separately — one constrains the model, the other
   * validates what came back. When they disagree the model is told one thing and
   * judged by another, and the cost is a wasted call.
   */
  it("pins the same count as the Zod schema", () => {
    expect(conceptsSchema.minItems).toBe(VARIANT_COUNT);
    expect(conceptsSchema.maxItems).toBe(VARIANT_COUNT);
  });

  it("offers the same emotions the Zod enum accepts", () => {
    expect(conceptsSchema.items.properties.emotion.enum).toEqual([...EMOTIONS]);
  });

  it("bounds searchTerms the same way the Zod schema does", () => {
    expect(conceptsSchema.items.properties.searchTerms.minItems).toBe(1);
    expect(conceptsSchema.items.properties.searchTerms.maxItems).toBe(4);
  });

  it("allows a null subline, so the model is not forced to invent one", () => {
    expect(conceptsSchema.items.properties.subline.type).toContain("null");
    // Required *and* nullable: an omitted key and an explicit null are different,
    // and the Zod schema demands the key.
    expect(conceptsSchema.items.required).toContain("subline");
  });

  it("forbids extra properties, so a hallucinated field fails loudly", () => {
    expect(conceptsSchema.items.additionalProperties).toBe(false);
  });
});

describe("THUMBNAIL_SYSTEM_PROMPT", () => {
  it("forbids inventing figures the script does not contain", () => {
    // §29: a thumbnail is a promise made before the click, and "$0 vs $4,000" is
    // a great thumbnail and a lie unless the script says so.
    expect(THUMBNAIL_SYSTEM_PROMPT).toMatch(/never state a number/i);
  });

  it("rules out concepts the pipeline cannot draw", () => {
    // The compositor puts text over a stock frame. Nothing here can produce a
    // face, an arrow or a chart, and a concept requiring one renders as a
    // headline over an unrelated image.
    expect(THUMBNAIL_SYSTEM_PROMPT).toMatch(/no faces/i);
    expect(THUMBNAIL_SYSTEM_PROMPT).toMatch(/no arrows/i);
  });

  it("tells the model not to shout, because casing is the compositor's job", () => {
    expect(THUMBNAIL_SYSTEM_PROMPT).toMatch(/ALL CAPS/);
  });
});

describe("buildThumbnailPrompt", () => {
  it("carries the script's own words, not just its title", () => {
    const prompt = buildThumbnailPrompt(brief);
    expect(prompt).toContain(brief.hook);
    expect(prompt).toContain("Why it wobbles");
    expect(prompt).toContain("When it will not work");
    expect(prompt).toContain(brief.conclusion!);
  });

  it("includes the published title when it differs from the script's", () => {
    const prompt = buildThumbnailPrompt(brief);
    expect(prompt).toContain("Published title: Stop your bench wobbling for £4");
  });

  it("omits the published title when it is the same, rather than repeating it", () => {
    // A title stated twice reads to the model as emphasis, which biases every
    // concept towards the words already in the title.
    const prompt = buildThumbnailPrompt({
      ...brief,
      publishedTitle: brief.scriptTitle,
    });
    expect(prompt).not.toContain("Published title:");
    expect(prompt.match(new RegExp(brief.scriptTitle, "g"))).toHaveLength(1);
  });

  it("asks for the script's language, so a Spanish script gets Spanish headlines", () => {
    const prompt = buildThumbnailPrompt({ ...brief, contentLanguage: "es-ES" });
    expect(prompt).toContain("es-ES");
  });

  it("lists previous headlines so a regenerate is actually new", () => {
    const prompt = buildThumbnailPrompt({
      ...brief,
      previousHeadlines: ["THE £4 FIX", "STOP THE WOBBLE"],
    });
    expect(prompt).toContain("ALREADY TRIED");
    expect(prompt).toContain("THE £4 FIX");
  });

  it("says nothing about previous headlines on a first generation", () => {
    expect(buildThumbnailPrompt(brief)).not.toContain("ALREADY TRIED");
  });

  it("handles a brief with nothing configured, which a new channel has", () => {
    const bare = buildThumbnailPrompt({
      channelTitle: null,
      niche: null,
      targetAudience: null,
      contentLanguage: "en-US",
      scriptTitle: "A title",
      publishedTitle: null,
      hook: "A hook.",
      sectionHeadings: [],
      conclusion: null,
      brandName: null,
      primaryColor: null,
      thumbnailStyle: null,
      previousHeadlines: [],
    });

    expect(bare).toContain("A hook.");
    expect(bare).toContain("(not specified)");
    // No dangling "undefined" or "null" reaching the model as if it were content.
    expect(bare).not.toMatch(/\bundefined\b|: null\b/);
  });

  it("asks for exactly the number of concepts the schema requires", () => {
    expect(buildThumbnailPrompt(brief)).toContain(`Design ${VARIANT_COUNT}`);
  });
});

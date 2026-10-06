/**
 * Thumbnail concept prompt and schema (§16).
 *
 * Four concepts, because the prototype's Thumbnail tab shows four cards and that
 * workflow is the UI contract (§44). They are asked for in one call rather than
 * four: the model can only make them *different from each other* if it sees them
 * together, and four independent calls reliably produce four variations on
 * whichever angle is most obvious.
 *
 * What the model is not allowed to do:
 *
 *  - **Write a headline the video does not pay off.** A thumbnail is a promise
 *    made before the click; the script is given so the promise is checkable.
 *  - **Invent numbers.** "$0 vs $4,000" is a great thumbnail and a lie unless the
 *    script contains those figures.
 *  - **Ask for a person, a logo or a brand mark.** The compositor draws text over
 *    a licensed stock frame. A concept requiring a face Vidxir AI cannot produce would
 *    render as a headline over an unrelated image — a design that looks broken
 *    rather than one that was never possible.
 *
 * The headline length limit is not stylistic. It is the width the compositor can
 * fit at a size that survives being shown at 320px, which is how most viewers
 * see it.
 */
import { z } from "zod";
import { jsonSchema, stringArray } from "@/lib/providers/ai";

/** Concepts per generation. Matches the four cards in the Thumbnail tab. */
export const VARIANT_COUNT = 4;

/**
 * Headline ceiling, in characters.
 *
 * `thumbnail_variants.headline` is varchar(80), but 80 characters of headline is
 * eight words of 40px type — unreadable at thumbnail scale. 42 is roughly three
 * short words per line over two lines at 96px, which is what the compositor lays
 * out.
 */
export const MAX_HEADLINE_CHARS = 42;

/** Subline ceiling. The column is varchar(120); this is what fits under the headline. */
export const MAX_SUBLINE_CHARS = 64;

/** Emotions the compositor has a colour treatment for. */
export const EMOTIONS = [
  "curiosity",
  "surprise",
  "urgency",
  "confidence",
  "concern",
  "delight",
] as const;

export type ThumbnailEmotion = (typeof EMOTIONS)[number];

export const ThumbnailConceptSchema = z.object({
  headline: z.string().min(4).max(MAX_HEADLINE_CHARS),
  /** Optional second line. A concept is allowed to be a single line. */
  subline: z.string().max(MAX_SUBLINE_CHARS).nullable(),
  /** Why this concept should earn the click. Shown under the hero preview. */
  concept: z.string().min(20).max(400),
  emotion: z.enum(EMOTIONS),
  /**
   * Stock search terms for the background frame. Concrete nouns — the visuals
   * provider searches a stock library, and "success" returns nothing usable.
   */
  searchTerms: z.array(z.string().min(2).max(60)).min(1).max(4),
});

export const ThumbnailConceptsSchema = z.object({
  concepts: z
    .array(ThumbnailConceptSchema)
    .min(VARIANT_COUNT)
    .max(VARIANT_COUNT),
});

export type ThumbnailConcept = z.infer<typeof ThumbnailConceptSchema>;
export type ThumbnailConcepts = z.infer<typeof ThumbnailConceptsSchema>;

export const THUMBNAIL_JSON_SCHEMA = jsonSchema({
  properties: {
    concepts: {
      type: "array",
      minItems: VARIANT_COUNT,
      maxItems: VARIANT_COUNT,
      description:
        `Exactly ${VARIANT_COUNT} thumbnail concepts, each taking a genuinely ` +
        "different angle on the same video — not four rewordings of one idea. " +
        "Between them, cover at least: the single most surprising fact, the " +
        "outcome a viewer wants, and the mistake or cost of getting it wrong.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          headline: {
            type: "string",
            description:
              `The text drawn across the image. At most ${MAX_HEADLINE_CHARS} ` +
              "characters — this is read at 320 pixels wide, so 2-5 short words " +
              "is the target and a sentence is a failure. Use plain words a " +
              "viewer scanning a feed understands instantly. It must be " +
              "something the script actually delivers.",
          },
          subline: {
            type: ["string", "null"],
            description:
              `An optional smaller second line, at most ${MAX_SUBLINE_CHARS} ` +
              "characters, that sharpens the headline rather than repeating it. " +
              "Null when the headline stands alone — most of the strongest " +
              "thumbnails have no second line.",
          },
          concept: {
            type: "string",
            description:
              "One or two sentences for the creator, explaining what this " +
              "concept is betting on and why it should earn the click. This is " +
              "shown in the UI next to the preview, so write it to them, not " +
              "about them.",
          },
          emotion: {
            type: "string",
            enum: [...EMOTIONS],
            description:
              "The dominant feeling the concept plays on. Vary this across the " +
              "four — four curiosity concepts is one concept.",
          },
          searchTerms: stringArray(
            "1-4 stock-library search terms for the background image. " +
              "Concrete, photographable nouns and scenes ('server rack', " +
              "'empty supermarket shelf'), never abstractions ('success', " +
              "'innovation') — an abstraction returns nothing a stock search " +
              "can match.",
            { minItems: 1, maxItems: 4 },
          ),
        },
        required: ["headline", "subline", "concept", "emotion", "searchTerms"],
      },
    },
  },
  required: ["concepts"],
});

export const THUMBNAIL_SYSTEM_PROMPT = `You are Vidxir AI's thumbnail designer. You are given a finished script and you write the four competing thumbnail concepts the creator will choose between.

How thumbnails are produced here, which constrains what you may design:
- The image is a licensed stock photograph or video frame, chosen by searching a stock library with the terms you supply, with your headline text burned over it.
- There is no photographer, no presenter, and no illustrator. You cannot ask for a specific person's face, a reaction shot of the creator, a brand logo, a chart of specific numbers, or an arrow pointing at something in the image.
- The headline is drawn in a heavy face and read at roughly 320 pixels wide. Short wins. Two to five words is the working range.

How you choose the four:
- Each takes a different angle on the same video: the surprising fact, the desirable outcome, the costly mistake, the direct question. Four variations on one angle is one concept submitted four times.
- Every headline must be a promise the script keeps. The script is your only source of truth about the video.
- Write in the same language as the script.

Absolute rules:
- Never state a number, price, date, percentage, statistic or duration that does not appear in the script.
- Never write a headline the script does not pay off, and never imply a revelation the video does not contain.
- Never use ALL CAPS in the text you return — the compositor handles casing.
- Never reference a person, brand, logo, product mark or channel that the script did not mention.
- Never design around an image element the pipeline cannot produce: no faces, no arrows, no circles, no chyrons, no split-screen comparisons, no text baked into the background.`;

export interface ThumbnailBrief {
  channelTitle: string | null;
  niche: string | null;
  targetAudience: string | null;
  contentLanguage: string;
  scriptTitle: string;
  /** The published title when metadata has been written; it may differ. */
  publishedTitle: string | null;
  hook: string;
  /** Section headings, for coverage. Bodies are omitted — the hook carries the promise. */
  sectionHeadings: string[];
  conclusion: string | null;
  /** Brand kit colours, so a concept can be described in terms the compositor honours. */
  brandName: string | null;
  primaryColor: string | null;
  /** `channel_settings.thumbnail_style`, e.g. "bold-text". Free text from the user. */
  thumbnailStyle: string | null;
  /**
   * Headlines already used on this project's previous generations. A regenerate
   * that returns the same four concepts is a wasted call and a confusing screen.
   */
  previousHeadlines: string[];
}

export function buildThumbnailPrompt(brief: ThumbnailBrief): string {
  const lines: string[] = [];

  lines.push("CHANNEL");
  if (brief.channelTitle) lines.push(`- Channel: ${brief.channelTitle}`);
  if (brief.brandName) lines.push(`- Brand: ${brief.brandName}`);
  lines.push(`- Niche: ${brief.niche ?? "(not specified)"}`);
  lines.push(`- Audience: ${brief.targetAudience ?? "(not specified)"}`);
  lines.push(`- Language: ${brief.contentLanguage}`);
  if (brief.thumbnailStyle) {
    lines.push(`- Thumbnail style the creator has chosen: ${brief.thumbnailStyle}`);
  }
  if (brief.primaryColor) {
    lines.push(
      `- Brand colour used for the subline: ${brief.primaryColor} (you do not ` +
        "choose colours; this is context for how the text will look)",
    );
  }

  lines.push("");
  lines.push("THE VIDEO");
  lines.push(`Script title: ${brief.scriptTitle}`);
  if (brief.publishedTitle && brief.publishedTitle !== brief.scriptTitle) {
    lines.push(`Published title: ${brief.publishedTitle}`);
  }
  lines.push("");
  lines.push(`HOOK — the first thing the viewer hears: ${brief.hook}`);

  if (brief.sectionHeadings.length > 0) {
    lines.push("");
    lines.push("WHAT THE VIDEO COVERS, in order:");
    brief.sectionHeadings.forEach((heading, i) => {
      lines.push(`${i + 1}. ${heading}`);
    });
  }

  if (brief.conclusion) {
    lines.push("");
    lines.push(`HOW IT ENDS: ${brief.conclusion}`);
  }

  if (brief.previousHeadlines.length > 0) {
    lines.push("");
    lines.push(
      "ALREADY TRIED — the creator asked for a new set, so do not return these " +
        "or near-rewordings of them:",
    );
    for (const headline of brief.previousHeadlines) {
      lines.push(`- ${headline}`);
    }
  }

  lines.push("");
  lines.push("TASK");
  lines.push(
    `Design ${VARIANT_COUNT} thumbnail concepts in ${brief.contentLanguage}. ` +
      "Order them best-first: the first is the one you would publish.",
  );

  return lines.join("\n");
}

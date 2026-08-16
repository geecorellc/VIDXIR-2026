/**
 * Metadata generation prompt and schema (§17).
 *
 * Metadata is written from the finished script, not from the idea, because a
 * description must describe what the video actually says. Two things this file
 * refuses to let the model do:
 *
 *  - **Invent chapter timings.** The model proposes chapter *labels* only. Their
 *    timestamps are computed from the script's own section word counts (see
 *    `chaptersFrom` in `service.ts`), because a timestamp is a claim about the
 *    video file and a guessed one sends viewers to the wrong moment.
 *  - **Write a title the script does not pay off.** The script's own title is
 *    given as the starting point; the model may sharpen it, but the schema's
 *    description names over-promising as the failure to avoid.
 */
import { z } from "zod";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_TAGS,
  MAX_TAG_CHARS,
  MAX_TITLE_CHARS,
} from "@/lib/metadata/format";
import { jsonSchema, stringArray } from "@/lib/providers/ai";

export const MetadataDraftSchema = z.object({
  title: z.string().min(8).max(MAX_TITLE_CHARS),
  /** Body only. Chapters and hashtags are appended in code. */
  description: z.string().min(40).max(MAX_DESCRIPTION_CHARS),
  tags: z.array(z.string().min(2).max(MAX_TAG_CHARS)).min(3).max(MAX_TAGS),
  hashtags: z.array(z.string().min(2).max(30)).max(3),
  /** One label per script section, in order. Timings are computed, not asked for. */
  chapterLabels: z.array(z.string().min(2).max(60)).max(12),
  /** YouTube category id the model judges correct for this content. */
  categoryId: z.string().regex(/^\d{1,3}$/),
});

export type MetadataDraft = z.infer<typeof MetadataDraftSchema>;

export const METADATA_JSON_SCHEMA = jsonSchema({
  properties: {
    title: {
      type: "string",
      description:
        `The published title, at most ${MAX_TITLE_CHARS} characters. Front-load ` +
        "the specific thing the viewer gets. It must be something the script " +
        "actually delivers — a title the video does not pay off costs more in " +
        "watch time than it gains in clicks. No ALL CAPS words, no " +
        "'you won't believe', no fabricated numbers.",
    },
    description: {
      type: "string",
      description:
        "The description body. First two lines are what shows above the fold: " +
        "say what the video covers and who it is for. Then 2-4 short paragraphs " +
        "of genuinely useful summary, written for a reader rather than for a " +
        "crawler. Do NOT include chapter timestamps, hashtags, subscribe " +
        "boilerplate, or a list of keywords — those are added separately or not " +
        "at all.",
    },
    tags: stringArray(
      `3-${MAX_TAGS} search tags: the phrases someone would actually type to ` +
        "find this video. Lowercase, no '#', no single letters, no repetition of " +
        "the same phrase in different word order.",
      { minItems: 3, maxItems: MAX_TAGS },
    ),
    hashtags: stringArray(
      "Up to 3 hashtags, without the '#'. These appear above the title on " +
        "YouTube, so they must read as topic labels, not as a keyword dump.",
      { maxItems: 3 },
    ),
    chapterLabels: stringArray(
      "One short label per script section, in the same order as the sections " +
        "you were given — these become chapter names. 2-5 words each, " +
        "descriptive rather than teasing. Return exactly as many as there are " +
        "sections, and no timestamps: timings are computed from the video.",
      { maxItems: 12 },
    ),
    categoryId: {
      type: "string",
      description:
        "YouTube category id. Common ones: 27 Education, 28 Science & " +
        "Technology, 22 People & Blogs, 24 Entertainment, 26 Howto & Style, " +
        "20 Gaming, 25 News & Politics, 10 Music, 17 Sport, 19 Travel & Events. " +
        "Pick the single best fit.",
    },
  },
  required: [
    "title",
    "description",
    "tags",
    "hashtags",
    "chapterLabels",
    "categoryId",
  ],
});

export const METADATA_SYSTEM_PROMPT = `You are Tally's metadata writer. You are given a finished script and you write the title, description, tags and chapter labels the video will be published with.

How you write:
- The description is read by people, not only by an algorithm. Write it as a useful summary someone would actually read, and put the substance in the first two lines because that is all YouTube shows before "more".
- Every claim in the metadata must be supported by the script. If the script does not say it, it does not go in the title or description.
- Tags are search phrases, not synonyms of each other. Prefer the words a viewer would type over the words a marketer would choose.

Absolute rules:
- Never write a title or description that promises something the script does not deliver.
- Never invent a statistic, price, date, credential or endorsement.
- Never include timestamps — you do not know the video's timings.
- Never pad with keyword lists, "subscribe for more" boilerplate, or copied text from another channel's description.
- Never imply an affiliation, sponsorship or partnership that you were not told about.`;

export interface MetadataBrief {
  channelTitle: string | null;
  niche: string | null;
  targetAudience: string | null;
  contentLanguage: string;
  scriptTitle: string;
  titleIdeas: string[];
  hook: string;
  introduction: string | null;
  /** Section headings with their narration, so the summary is grounded. */
  sections: Array<{ heading: string; body: string }>;
  conclusion: string | null;
  cta: string | null;
  /** §29 references the script grounded its claims in. */
  references: Array<{ label: string; url?: string }>;
  keywords: string[];
  brandName: string | null;
  defaultCta: string | null;
}

export function buildMetadataPrompt(brief: MetadataBrief): string {
  const lines: string[] = [];

  lines.push("CHANNEL");
  if (brief.channelTitle) lines.push(`- Channel: ${brief.channelTitle}`);
  if (brief.brandName) lines.push(`- Brand: ${brief.brandName}`);
  lines.push(`- Niche: ${brief.niche ?? "(not specified)"}`);
  lines.push(`- Audience: ${brief.targetAudience ?? "(not specified)"}`);
  lines.push(`- Language: ${brief.contentLanguage}`);
  if (brief.keywords.length > 0) {
    lines.push(`- Topics this channel targets: ${brief.keywords.join(", ")}`);
  }

  lines.push("");
  lines.push("THE SCRIPT");
  lines.push(`Working title: ${brief.scriptTitle}`);
  if (brief.titleIdeas.length > 0) {
    lines.push(`Alternatives considered: ${brief.titleIdeas.join(" | ")}`);
  }
  lines.push("");
  lines.push(`HOOK: ${brief.hook}`);
  if (brief.introduction) lines.push(`INTRO: ${brief.introduction}`);

  brief.sections.forEach((section, i) => {
    lines.push("");
    lines.push(`SECTION ${i + 1} — ${section.heading}`);
    lines.push(section.body);
  });

  if (brief.conclusion) {
    lines.push("");
    lines.push(`CONCLUSION: ${brief.conclusion}`);
  }
  if (brief.cta) {
    lines.push("");
    lines.push(`CTA: ${brief.cta}`);
  }

  if (brief.references.length > 0) {
    lines.push("");
    lines.push(
      "SOURCES the script cites — you may reference these in the description:",
    );
    for (const ref of brief.references) {
      lines.push(`- ${ref.label}${ref.url ? ` (${ref.url})` : ""}`);
    }
  }

  lines.push("");
  lines.push("TASK");
  lines.push(
    `Write the publishing metadata in ${brief.contentLanguage}. Return exactly ` +
      `${brief.sections.length + 1} chapter labels: one for the opening, then ` +
      "one per section in order.",
  );

  return lines.join("\n");
}

/**
 * Script generation prompt and schema (§9, §29).
 *
 * Separated from `service.ts` so the shape of a script — the part that decides
 * output quality and is worth iterating on — can be read and tested without the
 * persistence, transitions and job bookkeeping around it.
 *
 * Three things this file is careful about:
 *
 *  - **The schema is the structure.** §9 asks for a hook, an intro, body sections,
 *    a conclusion and a CTA, and the JSON Schema demands exactly those. A prompt
 *    that merely requests a structure gets one most of the time; a schema gets one
 *    every time, and the Script screen renders named fields rather than parsing
 *    prose.
 *  - **Duration is honoured as a word budget, not as a request.** "Make it 8
 *    minutes" means nothing to a text model. A words-per-minute target does, and
 *    the resulting word count is measured afterwards in code (see
 *    `estimateDuration`) rather than taken from the model's own estimate.
 *  - **Originality is a constraint on this stage too.** The idea was checked
 *    against source titles in research; the script is where copying would
 *    actually happen. §29's rules are stated as prohibitions the model can check
 *    its own draft against.
 */
import { z } from "zod";
import { jsonSchema, stringArray } from "@/lib/providers/ai";
import { isPlaceholderTitle } from "@/lib/projects/display-title";

/**
 * Spoken words per minute.
 *
 * 150 is the middle of the range for clear narration on educational YouTube —
 * fast enough not to drag, slow enough to follow. It is used in both directions:
 * to set the target length in the prompt, and to convert the delivered word
 * count back into an estimated duration. Using one constant for both keeps the
 * estimate consistent with what was asked for.
 */
export const WORDS_PER_MINUTE = 150;

/** Body sections. Fewer than 3 has no shape; more than 8 fragments a video. */
const MIN_SECTIONS = 3;
const MAX_SECTIONS = 8;

const SectionSchema = z.object({
  heading: z.string().min(2).max(120),
  body: z.string().min(1),
  talkingPoints: z.array(z.string()).max(10).optional(),
  transition: z.string().optional(),
});

export const ScriptDraftSchema = z.object({
  title: z.string().min(8).max(100),
  titleIdeas: z.array(z.string().min(8).max(100)).max(6),
  hook: z.string().min(20),
  introduction: z.string().min(20),
  sections: z.array(SectionSchema).min(MIN_SECTIONS).max(MAX_SECTIONS),
  conclusion: z.string().min(10),
  cta: z.string().min(10),
  storyStructure: z.string().min(3).max(200),
  references: z
    .array(
      z.object({
        label: z.string().min(2),
        url: z.string().optional(),
      }),
    )
    .max(12),
});

export type ScriptDraft = z.infer<typeof ScriptDraftSchema>;

export const SCRIPT_JSON_SCHEMA = jsonSchema({
  properties: {
    title: {
      type: "string",
      description:
        "The video title, at most 100 characters. Specific and honest — it must " +
        "describe what the script actually delivers. No ALL CAPS, no clickbait " +
        "the video does not pay off.",
    },
    titleIdeas: stringArray(
      "2-5 alternative titles for the same script, for A/B consideration.",
      { maxItems: 6 },
    ),
    hook: {
      type: "string",
      description:
        "The first 3-8 seconds, written as spoken narration. State the stake or " +
        "the surprise immediately. Do not greet the viewer, do not say " +
        "'welcome back', do not introduce yourself, do not describe what the " +
        "video will cover.",
    },
    introduction: {
      type: "string",
      description:
        "10-25 seconds of spoken narration after the hook: why this matters to " +
        "this specific audience, and what they will be able to do by the end.",
    },
    sections: {
      type: "array",
      description:
        `The body, in ${MIN_SECTIONS}-${MAX_SECTIONS} ordered sections. Each is ` +
        "a distinct beat that advances the video; none repeats another.",
      minItems: MIN_SECTIONS,
      maxItems: MAX_SECTIONS,
      items: jsonSchema({
        properties: {
          heading: {
            type: "string",
            description:
              "Short label for this beat, used as a storyboard caption. 2-6 words.",
          },
          body: {
            type: "string",
            description:
              "The narration for this section, written to be read aloud: " +
              "complete sentences, spoken rhythm, no bullet points, no stage " +
              "directions, no markdown.",
          },
          talkingPoints: stringArray(
            "The concrete claims or steps this section makes, one per item. Used " +
              "for on-screen text, so keep each under 10 words.",
            { maxItems: 10 },
          ),
          transition: {
            type: "string",
            description:
              "One spoken sentence leading into the next section. Omit for the " +
              "final section.",
          },
        },
        required: ["heading", "body", "talkingPoints"],
      }),
    },
    conclusion: {
      type: "string",
      description:
        "Spoken narration that resolves the promise made in the hook. Do not " +
        "summarise section by section.",
    },
    cta: {
      type: "string",
      description:
        "The closing ask, as spoken narration. One specific action. Earn it by " +
        "referring to what the viewer just got.",
    },
    storyStructure: {
      type: "string",
      description:
        "The narrative shape used, named in a few words (e.g. " +
        "'problem → failed fixes → working method → proof').",
    },
    references: {
      type: "array",
      description:
        "Sources for any factual claim, statistic or quotation in the script. " +
        "Include the source for every number you state. If the script makes no " +
        "factual claims requiring a source, return an empty array — do NOT " +
        "invent references.",
      maxItems: 12,
      items: jsonSchema({
        properties: {
          label: {
            type: "string",
            description: "What the source is, e.g. 'ONS 2024 housing survey'.",
          },
          url: {
            type: "string",
            description: "URL, only if you are certain of it. Omit otherwise.",
          },
        },
        required: ["label"],
      }),
    },
  },
  required: [
    "title",
    "titleIdeas",
    "hook",
    "introduction",
    "sections",
    "conclusion",
    "cta",
    "storyStructure",
    "references",
  ],
});

/**
 * The system prompt.
 *
 * The prohibitions are as important as the instructions. Every one of them
 * corresponds to a specific failure this stage would otherwise produce: padded
 * word-count filler, invented statistics, a hook that opens with a greeting, or
 * narration containing stage directions that the voiceover provider would then
 * read out loud.
 */
export const SCRIPT_SYSTEM_PROMPT = `You are Tally's scriptwriter. You write narration for a specific YouTube channel, to be read aloud by a synthetic voice and cut to visuals.

How you write:
- Every word you produce is spoken narration. Never write stage directions, camera notes, speaker labels, timestamps, markdown, or bracketed instructions — a voice model will read whatever you write, literally.
- Earn each moment. The hook earns the first thirty seconds; each section earns the next. If a sentence does not inform, advance, or land, cut it.
- Be concrete. Specific numbers, named examples and real mechanisms beat adjectives.
- Write for the ear: shorter sentences than you would write for the page, one idea per sentence, plain words.
- Respect the requested length by making the content fit it, never by padding. It is better to be a minute short than a minute of filler.

Absolute rules:
- Never state a statistic, study, price, date or quotation you are not confident is accurate. If you are unsure, write the point without the number. Every factual claim you do make must appear in "references".
- Never claim personal experience, testing or results that the channel has not described. Do not write "I tried this for 30 days" unless the brief says so.
- Never write a hook that begins by greeting the viewer, naming the channel, or previewing the video's contents.
- Never reproduce, paraphrase closely, react to, narrate over, or summarise another creator's video as the substance of this script. The evidence describes what the audience wants; the script must be original work.
- Never promise in the title or hook something the body does not deliver.
- No medical, legal or financial instruction presented as professional advice.`;

export interface ScriptBrief {
  /** Working title of the project — the idea's title, usually. */
  projectTitle: string;
  channelTitle: string | null;
  niche: string | null;
  targetAudience: string | null;
  contentLanguage: string;
  contentStyle: string | null;
  /** Target length in seconds, from channel settings or the project. */
  targetDurationSeconds: number;
  /** The researched idea this script is for, when there is one. */
  idea: {
    title: string;
    angle: string;
    rationale: string;
    topic: string;
    targetKeywords: string[];
    /**
     * The opening line the user chose with the angle (Phase 11 §7 → §8).
     *
     * A *starting point*, not a script line to reproduce: the writer is told to
     * open on this promise in its own words. Null for a Phase 1-10 idea.
     */
    hook: string | null;
    /** The trend signal that justified the angle, for the writer's framing. */
    trendSignal: string | null;
  } | null;
  /** Public titles the idea was derived from — context, never material to copy. */
  sourceTitles: string[];
  /** This channel's own recent performers, so the voice matches the audience. */
  ownTopPerformers: string[];
  /** §28 brand kit values that affect wording. */
  brand: {
    brandName: string | null;
    defaultCta: string | null;
  };
  /**
   * How the video will be made (Phase 11 §8, §16, §17).
   *
   * §8 lists the generation method and the format among the script's inputs, and
   * they genuinely change the writing rather than only the rendering. Stock footage
   * means a beat has to be *findable* in a library, so a narrated abstraction works
   * better than a specific object; an AI model means each beat becomes one
   * generated clip of a few seconds, so short concrete visual beats work better than
   * long argued ones. Portrait means less on-screen room and a faster open.
   *
   * Null when the choice has not been made yet — a pre-Phase-11 project, and the
   * prompt then says nothing about it rather than assuming stock.
   */
  generation: {
    mode: "STOCK" | "AI_VIDEO";
    /** Display label of the chosen model, or null in stock mode. */
    modelLabel: string | null;
    /** Longest clip the chosen model produces, when that is bounded. */
    maxClipSeconds: number | null;
    format: "landscape" | "portrait" | "square";
  } | null;
  /** Operator note for a regeneration ("shorter hook", "less formal"). */
  feedback?: string | null;
}

/** Word budget for a target duration. */
export function wordBudget(targetDurationSeconds: number): number {
  return Math.max(150, Math.round((targetDurationSeconds / 60) * WORDS_PER_MINUTE));
}

/**
 * Build the user turn.
 *
 * Source titles are included but explicitly framed as evidence of demand rather
 * than as material — and the model is told what it may take from them (the
 * subject) and what it may not (the treatment). Omitting them entirely would
 * lose the reason the idea was chosen; including them without that framing is how
 * a "research-driven" script quietly becomes a rewrite of the top result.
 */
export function buildScriptPrompt(brief: ScriptBrief): string {
  const lines: string[] = [];
  const words = wordBudget(brief.targetDurationSeconds);
  const minutes = Math.round(brief.targetDurationSeconds / 60);

  lines.push("CHANNEL");
  if (brief.channelTitle) lines.push(`- Channel: ${brief.channelTitle}`);
  if (brief.brand.brandName) lines.push(`- Brand name: ${brief.brand.brandName}`);
  lines.push(`- Niche: ${brief.niche ?? "(not specified)"}`);
  lines.push(`- Audience: ${brief.targetAudience ?? "(not specified)"}`);
  lines.push(`- Language: ${brief.contentLanguage}`);
  if (brief.contentStyle) lines.push(`- Style: ${brief.contentStyle}`);

  if (brief.ownTopPerformers.length > 0) {
    lines.push("");
    lines.push("WHAT THIS AUDIENCE ALREADY RESPONDS TO (this channel's own videos)");
    for (const title of brief.ownTopPerformers) lines.push(`- ${title}`);
  }

  lines.push("");
  lines.push("THE VIDEO");
  if (brief.idea) {
    lines.push(`- Working title: ${brief.idea.title}`);
    lines.push(`- Topic: ${brief.idea.topic}`);
    lines.push(`- The angle to take: ${brief.idea.angle}`);
    lines.push(`- Why this idea was chosen: ${brief.idea.rationale}`);
    if (brief.idea.trendSignal) {
      lines.push(`- The trend behind it: ${brief.idea.trendSignal}`);
    }
    if (brief.idea.hook) {
      // Framed as the promise to open on rather than as a line to use. Quoting it
      // verbatim is not wrong, but a writer told to reproduce it stops writing.
      lines.push(
        `- The opening promise the user picked: "${brief.idea.hook}" — open on ` +
          "this idea in your own words. Do not treat it as a line to reproduce.",
      );
    }
    if (brief.idea.targetKeywords.length > 0) {
      lines.push(`- Search terms to serve: ${brief.idea.targetKeywords.join(", ")}`);
    }
  } else if (!isPlaceholderTitle(brief.projectTitle)) {
    /**
     * Omitted rather than emitted empty when there is no real working title.
     *
     * A project seeded from a pasted link carries a system-generated placeholder until
     * research names it, and passing that through told the model the video is about an
     * eleven-character YouTube id. `- Working title:` with nothing after it would be no
     * better: it reads as a title the brief failed to fill in, and the writer is
     * entitled to treat it as a constraint. With the line absent, the model works from
     * the niche, audience and duration — genuinely all that is known about a video
     * nobody has named yet.
     *
     * Classified here as well as in `buildScriptBrief`, which already strips it. Not
     * redundant: this is the boundary where a title reaches a provider, so it is the
     * last place the check can be made — and a future caller assembling a brief without
     * going through that function would otherwise bake the id into a generated script,
     * where it is permanent rather than merely on screen.
     */
    lines.push(`- Working title: ${brief.projectTitle}`);
  }

  if (brief.sourceTitles.length > 0) {
    lines.push("");
    lines.push(
      "EXISTING VIDEOS ON THIS SUBJECT — these are evidence that the audience " +
        "wants this subject. They are NOT material. Take the subject; take " +
        "nothing else. Do not follow their structure, reuse their examples, or " +
        "restate their titles.",
    );
    for (const title of brief.sourceTitles) lines.push(`- ${title}`);
  }

  if (brief.brand.defaultCta) {
    lines.push("");
    lines.push("BRAND CTA — work this ask into your closing, in your own words:");
    lines.push(brief.brand.defaultCta);
  }

  if (brief.feedback) {
    lines.push("");
    lines.push(
      "REVISION NOTE — this is a rewrite. Address this specifically while " +
        "keeping everything that already worked:",
    );
    lines.push(brief.feedback);
  }

  if (brief.generation) {
    lines.push("");
    lines.push("HOW THIS WILL BE FILMED");
    if (brief.generation.mode === "AI_VIDEO") {
      lines.push(
        "Every beat of this script becomes one short AI-generated clip" +
          (brief.generation.modelLabel
            ? ` (${brief.generation.modelLabel})`
            : "") +
          (brief.generation.maxClipSeconds
            ? `, at most ${brief.generation.maxClipSeconds} seconds long`
            : "") +
          ". So write in short, visually concrete beats: each paragraph should " +
          "describe or imply one thing that can be *seen*. Avoid long stretches " +
          "of abstract argument with nothing to show.",
      );
    } else {
      lines.push(
        "This script will be cut to real stock footage searched by keyword. So " +
          "keep each beat's subject something that plausibly exists as a library " +
          "clip — a place, an action, an object, a person doing something. Avoid " +
          "beats whose only visual is a specific named individual, a specific " +
          "product screen, or an on-screen diagram.",
      );
    }
    if (brief.generation.format === "portrait") {
      lines.push(
        "The video is vertical and will be watched on a phone, often in a feed: " +
          "the first sentence has to land in under three seconds, and sentences " +
          "should be shorter throughout.",
      );
    } else if (brief.generation.format === "square") {
      lines.push("The video is square, for a feed rather than a widescreen player.");
    }
  }

  lines.push("");
  lines.push("LENGTH");
  lines.push(
    `Target about ${minutes} minute${minutes === 1 ? "" : "s"} of narration, ` +
      `which is roughly ${words} spoken words in total across the hook, ` +
      "introduction, sections, conclusion and CTA. Fit the content to the " +
      "length; do not pad to reach it.",
  );

  lines.push("");
  lines.push("TASK");
  lines.push(
    "Write the complete script in " +
      brief.contentLanguage +
      ". Return only the structured fields.",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Count the words that will actually be spoken.
 *
 * `talkingPoints` and `heading` are excluded: they become on-screen text and
 * storyboard labels, not narration. Counting them would inflate the duration
 * estimate the video builder then plans a timeline against.
 */
export function countSpokenWords(draft: ScriptDraft): number {
  const spoken = [
    draft.hook,
    draft.introduction,
    ...draft.sections.flatMap((s) => [s.body, s.transition ?? ""]),
    draft.conclusion,
    draft.cta,
  ];

  return spoken.reduce((total, text) => total + words(text), 0);
}

function words(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Estimated spoken duration, in seconds, from the delivered word count.
 *
 * Derived rather than asked for. §42 forbids invented numbers, and a model's own
 * guess at its script's runtime is exactly that — whereas words ÷ rate is a
 * stated assumption anyone can check.
 */
export function estimateDuration(wordCount: number): number {
  return Math.round((wordCount / WORDS_PER_MINUTE) * 60);
}

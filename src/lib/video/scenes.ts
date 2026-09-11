/**
 * Scene planning — the script becomes a storyboard (§10, §12).
 *
 * The approved script is prose meant to be read aloud. A renderer needs something
 * else: an ordered list of beats, each with the narration for that beat, a visual
 * direction, and search terms a stock library will actually match. This module is
 * that translation.
 *
 * It is a two-part design, and the split is the important part:
 *
 *  1. **Segmentation is code.** `segmentScript()` splits the script into scenes by
 *     its own structure — hook, introduction, each section, conclusion, CTA — and
 *     then breaks any scene whose narration runs long. Deterministic, testable,
 *     and it cannot drop a sentence, which is the failure mode of asking a model
 *     to "split this into scenes": it paraphrases, and the voiceover then reads
 *     text the writer never approved.
 *  2. **Visual direction is the model's job.** Choosing what to *show* over
 *     "compound interest quietly does the work" is a creative judgement, and a
 *     model is good at it. So the model receives the fixed segmentation and adds
 *     a visual prompt and search terms per scene — it never touches the narration.
 *
 * The narration in `scenes.narration` is therefore always a verbatim slice of the
 * approved script version. §9 makes approval meaningful; that guarantee is only
 * real if nothing downstream rewrites the words.
 */
import { z } from "zod";
import { logger } from "@/lib/logger";
import { generateJson, jsonSchema, stringArray } from "@/lib/providers/ai";
import { WORDS_PER_MINUTE, type ScriptDraft } from "@/lib/scripts/prompt";

const log = logger.child({ component: "scenes" });

/**
 * Seconds of narration per scene, targeted.
 *
 * A scene is one visual, and a single stock clip held for more than about twenty
 * seconds reads as a stalled video however good the clip is. Below eight seconds
 * the cutting becomes frantic and the viewer never settles.
 */
const TARGET_SCENE_SECONDS = 14;
const MAX_SCENE_SECONDS = 22;
const MIN_SCENE_SECONDS = 4;

/** Words in a scene at the narration rate. */
const TARGET_SCENE_WORDS = Math.round((TARGET_SCENE_SECONDS * WORDS_PER_MINUTE) / 60);
const MAX_SCENE_WORDS = Math.round((MAX_SCENE_SECONDS * WORDS_PER_MINUTE) / 60);
const MIN_SCENE_WORDS = Math.round((MIN_SCENE_SECONDS * WORDS_PER_MINUTE) / 60);

/**
 * Ceiling on scene count.
 *
 * Every scene is a stock search plus a download plus a filter-graph input, so
 * cost and render time are linear in this. A 20-minute video at the target scene
 * length is ~85 scenes; 120 leaves headroom without allowing a pathological plan.
 */
const MAX_SCENES = 120;

/**
 * Placeholder for a period that is not a sentence end.
 *
 * A private-use code point rather than a printable one, so it cannot collide with
 * anything a script could legitimately contain.
 */
const SENTINEL = "󰀀";

export interface PlannedScene {
  index: number;
  /** Storyboard label. From the script's own structure, not invented. */
  label: string;
  /** Verbatim narration for this beat. */
  narration: string;
  /** What to show. Null until the model has directed it. */
  visualPrompt: string | null;
  /** Stock search terms, best first. */
  searchTerms: string[];
  /** Short overlay text, or null. */
  onScreenText: string | null;
  transition: string | null;
  /** Words of narration, for the duration estimate before any audio exists. */
  wordCount: number;
}

// ---------------------------------------------------------------------------
// Segmentation (deterministic)
// ---------------------------------------------------------------------------

interface Beat {
  label: string;
  narration: string;
  /** Talking points for this beat, used as candidate on-screen text. */
  points: string[];
  transition: string | null;
}

/**
 * Split an approved script into scenes.
 *
 * Pure and exported: the whole point of doing this in code is that it can be
 * asserted on, and "every word of the script appears in exactly one scene" is the
 * property worth asserting.
 */
export function segmentScript(draft: ScriptDraft): PlannedScene[] {
  const beats: Beat[] = [];

  // The hook is always its own scene. It is the three seconds that decide whether
  // the video is watched at all, and it gets its own visual for that reason.
  beats.push({
    label: "Hook",
    narration: draft.hook.trim(),
    points: [],
    transition: "none",
  });

  if (draft.introduction.trim()) {
    beats.push({
      label: "Intro",
      narration: draft.introduction.trim(),
      points: [],
      transition: "fade",
    });
  }

  draft.sections.forEach((section) => {
    const body = section.body.trim();
    if (!body) return;

    beats.push({
      label: section.heading.trim().slice(0, 80) || "Section",
      narration: body,
      points: (section.talkingPoints ?? []).map((p) => p.trim()).filter(Boolean),
      transition: "fade",
    });

    // A transition line is spoken narration and must be voiced. It rides with the
    // section rather than becoming a scene of its own — a two-second scene for
    // "But there's a catch." would be a visual hiccup.
    const transition = section.transition?.trim();
    if (transition) {
      const last = beats[beats.length - 1];
      if (last) last.narration = `${last.narration} ${transition}`.trim();
    }
  });

  if (draft.conclusion.trim()) {
    beats.push({
      label: "Conclusion",
      narration: draft.conclusion.trim(),
      points: [],
      transition: "fade",
    });
  }

  if (draft.cta.trim()) {
    beats.push({
      label: "CTA",
      narration: draft.cta.trim(),
      points: [],
      transition: "fade",
    });
  }

  const scenes: PlannedScene[] = [];

  for (const beat of beats) {
    // Scenes are built, merged and annotated one beat at a time. Doing it per
    // beat rather than over the whole list is what keeps beats independent: two
    // sections can legitimately share a heading, and both the runt merge and the
    // talking-point assignment would otherwise reach across from one into the
    // other — folding unrelated narration together, or putting one section's
    // points on another section's scenes.
    const beatScenes = mergeRunts(
      splitNarration(beat.narration).map((chunk) => ({
        // Provisional; every scene is renumbered once the plan is complete.
        index: 0,
        label: beat.label,
        narration: chunk,
        visualPrompt: null,
        searchTerms: [],
        onScreenText: null,
        transition: beat.transition,
        wordCount: countWords(chunk),
      })),
    );

    // Talking points become overlays, one per scene, in order. Repeating a point
    // across the beat would put the same text on screen three times, and more
    // than one point per scene would stack them.
    beat.points.slice(0, beatScenes.length).forEach((point, i) => {
      const scene = beatScenes[i];
      // Long points are sentences, not overlays; the captions already carry those.
      if (scene && point.length <= 60) scene.onScreenText = point;
    });

    for (const scene of beatScenes) {
      if (scenes.length >= MAX_SCENES) break;
      scenes.push({
        ...scene,
        index: scenes.length,
        // The very first frame does not fade in from black; that would spend the
        // hook's opening moment on a transition.
        transition: scenes.length === 0 ? "none" : scene.transition,
      });
    }

    if (scenes.length >= MAX_SCENES) {
      log.warn("scene plan truncated at the ceiling", { max: MAX_SCENES });
      break;
    }
  }

  return scenes;
}

/**
 * Break one beat's narration into scene-sized chunks on sentence boundaries.
 *
 * Sentence boundaries specifically: a mid-sentence cut puts a visual change in
 * the middle of a clause, which the ear notices even when the eye does not.
 */
function splitNarration(narration: string): string[] {
  const sentences = splitSentences(narration);
  if (sentences.length === 0) return [];

  const chunks: string[] = [];
  let current: string[] = [];
  let words = 0;

  for (const sentence of sentences) {
    const sentenceWords = countWords(sentence);

    // A single sentence over the maximum is left whole. Splitting it would cut
    // mid-clause, and one slightly long scene is a smaller defect than that.
    if (words > 0 && words + sentenceWords > MAX_SCENE_WORDS) {
      chunks.push(current.join(" "));
      current = [];
      words = 0;
    }

    current.push(sentence);
    words += sentenceWords;

    if (words >= TARGET_SCENE_WORDS) {
      chunks.push(current.join(" "));
      current = [];
      words = 0;
    }
  }

  if (current.length > 0) chunks.push(current.join(" "));

  return chunks;
}

/**
 * Sentence splitter that survives the abbreviations narration actually contains.
 *
 * "Dr. Chen", "$4.5 billion", "e.g." and "U.S." all contain a period that is not
 * a sentence end, and a naive split on `.` turns each into its own two-word
 * scene.
 */
function splitSentences(text: string): string[] {
  // A period that is not a sentence end is swapped for a sentinel, split on,
  // then swapped back. Deleting the period instead would corrupt the narration,
  // and the narration is the approved text — it has to come back identical.
  const guarded = text
    .replace(
      /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|approx|Inc|Ltd|Co|Fig|No)\./gi,
      `$1${SENTINEL}`,
    )
    // "e.g." and "i.e." — two periods each.
    .replace(/\b([ei])\.([ge])\./gi, `$1${SENTINEL}$2${SENTINEL}`)
    // A decimal point between digits.
    .replace(/(\d)\.(\d)/g, `$1${SENTINEL}$2`)
    // Single-letter initials and acronyms: "U.S.", "A. B. Smith".
    .replace(/\b([A-Z])\./g, `$1${SENTINEL}`);

  return guarded
    .split(/(?<=[.!?])["')\]]?\s+/)
    .map((s) => s.split(SENTINEL).join(".").trim())
    .filter(Boolean);
}

/**
 * Fold a too-short scene into its predecessor, within one beat.
 *
 * A beat whose last chunk is three words ("And that's it.") would otherwise get a
 * whole stock clip and a cut of its own. Called per beat, so a short CTA or
 * conclusion keeps its own frame — it is brief by nature, not by accident of
 * where the sentence splitter landed.
 */
function mergeRunts(scenes: readonly PlannedScene[]): PlannedScene[] {
  const out: PlannedScene[] = [];

  for (const scene of scenes) {
    const previous = out[out.length - 1];

    if (
      previous &&
      scene.wordCount < MIN_SCENE_WORDS &&
      previous.wordCount + scene.wordCount <= MAX_SCENE_WORDS
    ) {
      previous.narration = `${previous.narration} ${scene.narration}`.trim();
      previous.wordCount = countWords(previous.narration);
      previous.onScreenText = previous.onScreenText ?? scene.onScreenText;
      continue;
    }

    // Copied rather than pushed by reference: the caller mutates `onScreenText`
    // on the result, and sharing an object with the input would write through.
    out.push({ ...scene });
  }

  return out;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Estimated scene length before any audio exists, from the word count. */
export function estimateSceneMs(wordCount: number): number {
  return Math.max(
    MIN_SCENE_SECONDS * 1000,
    Math.round((wordCount / WORDS_PER_MINUTE) * 60_000),
  );
}

// ---------------------------------------------------------------------------
// Visual direction (model)
// ---------------------------------------------------------------------------

const DirectionSchema = z.object({
  scenes: z.array(
    z.object({
      index: z.number().int().min(0),
      visualPrompt: z.string().min(3).max(400),
      searchTerms: z.array(z.string().min(2).max(60)).min(1).max(5),
    }),
  ),
  mood: z.string().min(3).max(80),
});

export type SceneDirection = z.infer<typeof DirectionSchema>;

const DIRECTION_JSON_SCHEMA = jsonSchema({
  properties: {
    scenes: {
      type: "array",
      description:
        "One entry per scene, in order, with the same index as the input. Do not " +
        "add, remove, merge or reorder scenes.",
      items: jsonSchema({
        properties: {
          index: {
            type: "integer",
            description: "The index of the scene this direction is for.",
          },
          visualPrompt: {
            type: "string",
            description:
              "What the viewer should see during this narration, as one concrete " +
              "sentence describing a single shot: subject, setting, action, " +
              "framing. It is used both to search a stock library and as a " +
              "generation prompt, so describe a filmable shot rather than an " +
              "abstraction. No text, no logos, no recognisable public figures.",
          },
          searchTerms: stringArray(
            "1-4 stock-footage search queries for this shot, best first. Two to " +
              "four plain words each, the kind of query that matches a stock " +
              "library's own tags — 'busy city crosswalk', 'hands typing laptop'. " +
              "No abstract nouns, no proper nouns, no full sentences.",
            { maxItems: 5 },
          ),
        },
        required: ["index", "visualPrompt", "searchTerms"],
      }),
    },
    mood: {
      type: "string",
      description:
        "Two or three words describing the musical mood for the whole video, " +
        "e.g. 'calm, curious' or 'urgent, tense'. Used to search a music library.",
    },
  },
  required: ["scenes", "mood"],
});

const DIRECTION_SYSTEM_PROMPT = [
  "You are a video director planning the visuals for a YouTube video.",
  "",
  "You are given a finished, approved narration split into scenes. The narration",
  "is fixed: you must not change, rewrite, summarise, extend or reorder it. Your",
  "only job is to decide what appears on screen during each scene.",
  "",
  "Rules:",
  "- One shot per scene. If you find yourself describing a sequence, choose the",
  "  single most telling image instead.",
  "- Show, do not restate. If the narration says 'saving is hard', do not ask for",
  "  a shot of the words 'saving is hard' — ask for a shot of someone staring at a",
  "  bank balance.",
  "- Vary the shots. Consecutive scenes must not describe the same subject or the",
  "  same framing; repetition is what makes an automated video look automated.",
  "- Search terms are queries, not descriptions. They must be the words a stock",
  "  library tags footage with.",
  "- Never request on-screen text, captions, watermarks, logos, brand names, or a",
  "  recognisable real person. Stock searches for these return nothing usable and",
  "  generated versions create a rights problem.",
].join("\n");

export interface DirectSceneInput {
  scenes: readonly PlannedScene[];
  title: string;
  niche: string | null;
  videoStyle: string | null;
  /**
   * Continuity direction from the story bible, or omitted.
   *
   * Optional, and the empty case is the pre-continuity behaviour byte for byte: the
   * block is only added to the prompt when it is non-empty, so a project without a
   * bible sends exactly the request it always sent. Built by
   * `lib/continuity/prompt.plannerContext` — the director is told the cast and the
   * agreed look so it can direct *into* them rather than inventing a new subject per
   * scene.
   */
  continuity?: string | null;
  usage: {
    userId: string;
    projectId: string;
    jobId: string;
    traceId?: string | null;
  };
}

export interface DirectSceneResult {
  scenes: PlannedScene[];
  mood: string;
}

/**
 * Add a visual direction and search terms to each planned scene.
 *
 * Every returned scene keeps its original narration and index — the model's reply
 * is merged in by index, never trusted to be a complete or correctly ordered
 * list. A scene the model skipped falls back to terms derived from its own
 * narration, because a missing entry must not leave a scene with nothing to
 * search for.
 */
export async function directScenes(
  input: DirectSceneInput,
): Promise<DirectSceneResult> {
  const numbered = input.scenes
    .map(
      (scene) =>
        `${scene.index}. [${scene.label}] ${scene.narration}` +
        (scene.onScreenText ? `\n   On-screen text: ${scene.onScreenText}` : ""),
    )
    .join("\n\n");

  const continuity = input.continuity?.trim() ?? "";

  const prompt = [
    `Video title: ${input.title}`,
    input.niche ? `Channel niche: ${input.niche}` : null,
    input.videoStyle ? `Visual style: ${input.videoStyle}` : null,
    "",
    // Before the scene list, unlike the per-scene continuity block: the director is
    // choosing subjects, so it needs the cast and the look before it reads the first
    // beat rather than after the last.
    continuity
      ? [
          "This video has an established look and cast. Direct every scene to fit",
          "them — name a character when they are on screen, and keep the stated",
          "medium and palette in every shot.",
          "",
          continuity,
          "",
        ].join("\n")
      : null,
    `Plan the visuals for these ${input.scenes.length} scenes.`,
    "Return exactly one direction per scene, using the same indices.",
    "",
    numbered,
  ]
    .filter((line) => line !== null)
    .join("\n");

  const direction = await generateJson({
    system: DIRECTION_SYSTEM_PROMPT,
    prompt,
    schema: DirectionSchema,
    jsonSchema: DIRECTION_JSON_SCHEMA,
    // Roughly 120 tokens of direction per scene, plus room for a long plan.
    maxTokens: Math.min(32_000, 2_000 + input.scenes.length * 220),
    usage: {
      operation: "scenes.direct",
      userId: input.usage.userId,
      projectId: input.usage.projectId,
      jobId: input.usage.jobId,
      traceId: input.usage.traceId ?? null,
    },
  });

  const byIndex = new Map(direction.scenes.map((s) => [s.index, s]));

  let missing = 0;
  const scenes = input.scenes.map((scene) => {
    const directed = byIndex.get(scene.index);
    if (!directed) missing += 1;

    return {
      ...scene,
      visualPrompt: directed?.visualPrompt ?? null,
      searchTerms:
        directed && directed.searchTerms.length > 0
          ? dedupe(directed.searchTerms)
          : fallbackTerms(scene),
    };
  });

  if (missing > 0) {
    // Worth a log rather than a failure: the fallback terms are worse but usable,
    // and failing the whole build over one undirected scene out of eighty would
    // be the wrong trade.
    log.warn("scene directions incomplete, using fallback search terms", {
      projectId: input.usage.projectId,
      missing,
      total: input.scenes.length,
    });
  }

  return { scenes, mood: direction.mood };
}

function dedupe(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const clean = term.trim().toLowerCase();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(term.trim());
  }
  return out;
}

/**
 * Search terms from the narration itself, when the model gave none.
 *
 * Content words only, longest first. A crude query, and better than none — the
 * alternative is a scene with no visual, which cannot be rendered.
 */
function fallbackTerms(scene: PlannedScene): string[] {
  const stop = new Set([
    "the", "and", "that", "this", "with", "have", "will", "your", "you", "for",
    "are", "but", "not", "they", "what", "when", "from", "there", "their", "been",
    "were", "into", "than", "then", "them", "these", "those", "just", "about",
    "because", "which", "would", "could", "should", "really", "actually", "very",
  ]);

  const words = scene.narration
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stop.has(w));

  const ranked = [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 4);

  // Pairs read better as stock queries than single words do.
  const pairs: string[] = [];
  for (let i = 0; i + 1 < ranked.length; i += 2) {
    pairs.push(`${ranked[i]} ${ranked[i + 1]}`);
  }

  return pairs.length > 0 ? pairs : ranked.length > 0 ? ranked : ["abstract background"];
}

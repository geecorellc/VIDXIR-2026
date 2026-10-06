/**
 * How much continuity a video actually needs, and where the pass marks sit.
 *
 * Continuity is not one setting. A narrative short with a recurring character has
 * to hold that character's face across eighty scenes; a faceless listicle has to
 * hold a look and nothing else, and demanding character consistency of it would
 * fail every video for missing something it never had. So the layer resolves a
 * **level** first, from the channel's existing style settings, and every later step
 * reads the level rather than deciding for itself.
 *
 * The levels map onto vocabularies the repository already has —
 * `CONTENT_STYLES` from onboarding and `VIDEO_STYLES` from settings — because
 * inventing a third taxonomy would mean asking the user the same question twice.
 *
 * Thresholds are here rather than inline in the scorer so an operator can see all
 * of them at once, and so a test can assert the scorer's arithmetic without also
 * pinning a product decision about what counts as good enough.
 */

import type { GenerationMode } from "@/lib/providers/video-gen";

/**
 * Continuity levels, weakest first.
 *
 *  - `off` — the layer does nothing. Stock-footage videos and anything with no
 *    story to be continuous about.
 *  - `style` — hold the look: palette, medium, lighting. No characters tracked.
 *    The right level for faceless, listicle and motion-graphics content.
 *  - `world` — hold the look and the places. Documentary and explainer work that
 *    returns to the same settings without a cast.
 *  - `character` — hold the look, the places and the cast. Narrative and
 *    storytelling content.
 *  - `episodic` — `character`, plus strict props and state changes. For content
 *    where a viewer is expected to notice across episodes.
 */
export const CONTINUITY_LEVELS = [
  "off",
  "style",
  "world",
  "character",
  "episodic",
] as const;

export type ContinuityLevel = (typeof CONTINUITY_LEVELS)[number];

export function isContinuityLevel(value: unknown): value is ContinuityLevel {
  return (
    typeof value === "string" &&
    (CONTINUITY_LEVELS as readonly string[]).includes(value)
  );
}

/** Rank, for "at least this strict" comparisons. */
export function levelRank(level: ContinuityLevel): number {
  return CONTINUITY_LEVELS.indexOf(level);
}

export function atLeast(
  level: ContinuityLevel,
  minimum: ContinuityLevel,
): boolean {
  return levelRank(level) >= levelRank(minimum);
}

/** What each level actually asks the pipeline to hold. */
export interface LevelCapabilities {
  /** Track and constrain named characters. */
  characters: boolean;
  /** Track and constrain places. */
  environments: boolean;
  /** Track props and state changes. */
  props: boolean;
  /** Hold the visual style across scenes. */
  style: boolean;
  /** Run duplicate/repetition detection. */
  duplicates: boolean;
}

const CAPABILITIES: Record<ContinuityLevel, LevelCapabilities> = {
  off: {
    characters: false,
    environments: false,
    props: false,
    style: false,
    duplicates: false,
  },
  style: {
    characters: false,
    environments: false,
    props: false,
    style: true,
    duplicates: true,
  },
  world: {
    characters: false,
    environments: true,
    props: false,
    style: true,
    duplicates: true,
  },
  character: {
    characters: true,
    environments: true,
    props: true,
    style: true,
    duplicates: true,
  },
  episodic: {
    characters: true,
    environments: true,
    props: true,
    style: true,
    duplicates: true,
  },
};

export function capabilitiesFor(level: ContinuityLevel): LevelCapabilities {
  return CAPABILITIES[level];
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** The settings the level is derived from. All nullable — old projects have none. */
export interface LevelInput {
  /** `projects.generationMode` — STOCK or AI_VIDEO. */
  generationMode: GenerationMode | null;
  /** `channel_settings.content_style`, one of `CONTENT_STYLES`. */
  contentStyle: string | null;
  /** `channel_settings.video_style`, one of `VIDEO_STYLES`. */
  videoStyle: string | null;
  /** `channel_settings.target_audience`, free text from onboarding. */
  targetAudience: string | null;
}

/**
 * Content styles that carry a cast, and therefore want character continuity.
 *
 * `storytelling` and `commentary` differ here for a reason: a storytelling video
 * has characters, while commentary is a voice over footage and has none.
 */
const NARRATIVE_STYLES = new Set(["storytelling"]);

/** Styles about places and process rather than people. */
const WORLD_STYLES = new Set(["documentary", "explainer", "tutorial"]);

/** Styles with no continuity subject beyond the look. */
const STYLE_ONLY_STYLES = new Set(["listicle", "commentary"]);

/**
 * Audience words that raise the level.
 *
 * Preschool and children's content is the case §15 calls out specifically: a
 * character a three-year-old follows must not change colour between verses, and
 * the repetition such videos are built on must not be mistaken for a defect. So
 * matching audiences get `character` at minimum, and the duplicate detector reads
 * `preschool` off the resolved plan to widen its tolerance for repetition.
 *
 * Substring matching on free text, which is imprecise in one direction only:
 * a false positive costs some prompt tokens, a false negative costs a video where
 * the bear changes colour.
 */
const PRESCHOOL_WORDS = [
  "preschool",
  "pre-school",
  "toddler",
  "nursery",
  "kindergarten",
  "children",
  "kids",
  "baby",
  "babies",
  "infant",
];

export interface ContinuityPlan {
  level: ContinuityLevel;
  capabilities: LevelCapabilities;
  /** True for children's content: repetition is the format, not a fault. */
  preschool: boolean;
  /** Why this level was chosen. Shown in the UI and logged, never parsed. */
  reason: string;
}

/**
 * Decide how much continuity this project needs.
 *
 * Deterministic and free — no AI call, no database read beyond the settings the
 * caller already has. §21's rule applied at the top of the layer: the cheapest
 * possible answer to "does this video need continuity at all?" is a lookup, and a
 * video that answers "no" then costs nothing for the rest of the pipeline.
 *
 * Stock-footage mode is `off` unconditionally. A stock library cannot be asked to
 * keep a character consistent — the clips are of different people by definition —
 * so constraining prompts and then failing scenes for drift would produce nothing
 * but noise on every video Vidxir AI built before this layer existed.
 */
export function resolveContinuityPlan(input: LevelInput): ContinuityPlan {
  const preschool = isPreschoolAudience(input.targetAudience);

  if (input.generationMode !== "AI_VIDEO") {
    return {
      level: "off",
      capabilities: capabilitiesFor("off"),
      preschool,
      // Named precisely, because this is the branch that keeps every pre-existing
      // project behaving exactly as it did.
      reason:
        "Stock footage: continuity constraints cannot apply to library clips.",
    };
  }

  const contentStyle = input.contentStyle?.trim().toLowerCase() ?? null;
  const videoStyle = input.videoStyle?.trim().toLowerCase() ?? null;

  // Preschool content is character-driven whatever the style says.
  if (preschool) {
    return {
      level: "character",
      capabilities: capabilitiesFor("character"),
      preschool,
      reason:
        "Children's content: a character a young viewer follows must not change between scenes.",
    };
  }

  if (contentStyle && NARRATIVE_STYLES.has(contentStyle)) {
    return {
      level: "character",
      capabilities: capabilitiesFor("character"),
      preschool,
      reason: `${contentStyle} content follows characters across scenes.`,
    };
  }

  if (contentStyle && WORLD_STYLES.has(contentStyle)) {
    return {
      level: "world",
      capabilities: capabilitiesFor("world"),
      preschool,
      reason: `${contentStyle} content returns to the same places and look.`,
    };
  }

  if (contentStyle && STYLE_ONLY_STYLES.has(contentStyle)) {
    return {
      level: "style",
      capabilities: capabilitiesFor("style"),
      preschool,
      reason: `${contentStyle} content has one look to hold and no recurring cast.`,
    };
  }

  // Motion graphics has no photographic subject to be consistent about, so the
  // look is the whole contract even when the content style says otherwise.
  if (videoStyle === "motion-graphics") {
    return {
      level: "style",
      capabilities: capabilitiesFor("style"),
      preschool,
      reason: "Motion graphics: the palette and treatment are the continuity.",
    };
  }

  // AI generation with nothing else known. `style` rather than `off`: every
  // generated video benefits from a single look, and it is the cheapest level
  // that does anything.
  return {
    level: "style",
    capabilities: capabilitiesFor("style"),
    preschool,
    reason: "AI-generated video: holding one visual style across scenes.",
  };
}

export function isPreschoolAudience(audience: string | null): boolean {
  if (!audience) return false;
  const text = audience.toLowerCase();
  return PRESCHOOL_WORDS.some((word) => text.includes(word));
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Where pass, warn and fail sit on the 0–100 continuity score.
 *
 * A `warn` is recorded and shown but never blocks or spends money on a
 * regeneration; a `fail` is what §13 acts on. The gap between them is wide
 * deliberately — a narrow band would mean a one-point scoring change flipping a
 * video between "fine" and "regenerate three scenes", and regeneration costs real
 * provider calls.
 */
export interface ContinuityThresholds {
  /** At or above this, the check passes. */
  pass: number;
  /** Below this, the check fails and scenes are regenerated. */
  fail: number;
  /** Per-scene similarity above which two scenes are the same shot (0–1). */
  duplicate: number;
  /** Similarity above which a repeat is suspicious but not conclusive (0–1). */
  suspicious: number;
  /** Most scenes one continuity pass will regenerate. */
  maxRegenerations: number;
}

export const DEFAULT_THRESHOLDS: ContinuityThresholds = {
  pass: 75,
  fail: 55,
  duplicate: 0.9,
  suspicious: 0.75,
  /**
   * Four. Regeneration is a paid provider call per scene, and a video needing
   * more than four is not suffering from drift — its bible or its plan is wrong,
   * and regenerating twenty scenes would spend the money without fixing it.
   */
  maxRegenerations: 4,
};

/**
 * Thresholds for a plan.
 *
 * Preschool content tolerates far more repetition, because repetition is the
 * form: a song that repeats "clap your hands" over four verses is *supposed* to
 * show the same shot. Raising the duplicate mark to near-identity means only a
 * genuinely accidental copy is flagged.
 */
export function thresholdsFor(plan: ContinuityPlan): ContinuityThresholds {
  if (plan.preschool) {
    return { ...DEFAULT_THRESHOLDS, duplicate: 0.98, suspicious: 0.95 };
  }
  return DEFAULT_THRESHOLDS;
}

/**
 * The timeline document (§10, §15).
 *
 * A provider-neutral description of the finished video: which clip is on screen
 * when, where each narration segment sits, the music bed under it, and the caption
 * cues burned over the top. `render.ts` translates it into whichever provider's
 * schema is configured.
 *
 * Two properties this module is responsible for, both of which are what makes the
 * video watchable rather than merely produced:
 *
 *  1. **Every offset is measured.** Scene start times come from the *actual*
 *     lengths of the narration audio that was generated, accumulated in order.
 *     Nothing here divides a target duration by a scene count.
 *  2. **The visual track has no gaps.** A scene whose stock clip is shorter than
 *     its narration would leave black frames, so a short clip is held or looped to
 *     fill its slot. A gap in the visual track is the most obvious possible defect
 *     in an automated edit.
 *
 * The document is stored on `renders.timeline`, so a render that failed at the
 * provider can be inspected — and re-submitted — without regenerating a single
 * asset.
 */

/** 1080p at 30fps. YouTube's sweet spot for talking-head-plus-b-roll content. */
export const OUTPUT_WIDTH = 1920;
export const OUTPUT_HEIGHT = 1080;
export const OUTPUT_FPS = 30;

/** Cross-fade between scenes, in ms. Long enough to read as intentional. */
export const TRANSITION_MS = 400;

/**
 * Silence held after the last word before the video ends.
 *
 * Cutting on the final syllable feels like a dropped call. A beat of air lets the
 * end screen land.
 */
export const TAIL_PADDING_MS = 800;

/** Music fades in over this, and out over the same at the end. */
export const MUSIC_FADE_MS = 1_500;

export interface TimelineScene {
  index: number;
  label: string | null;
  /** Absolute offset from the start of the video. */
  startMs: number;
  durationMs: number;
  /** Storage key of the visual for this scene. */
  visualKey: string;
  visualKind: "stock_video" | "stock_image" | "generated_video" | "generated_image";
  /** Intrinsic clip length, when the source is video. Null for stills. */
  visualDurationMs: number | null;
  /** Storage key of this scene's narration audio. Null for a silent beat. */
  narrationKey: string | null;
  narrationDurationMs: number;
  onScreenText: string | null;
  transition: string;
}

export interface TimelineMusic {
  key: string;
  volume: number;
  duckUnderNarration: boolean;
  startMs: number;
  /** Intrinsic length; the renderer loops when it is shorter than the video. */
  durationMs: number | null;
}

export interface TimelineCaptionStyle {
  fontFamily: string;
  fontSizePx: number;
  color: string;
  backgroundColor: string | null;
  /** 0 = top, 1 = bottom. Captions sit low, clear of YouTube's own overlay. */
  verticalPosition: number;
}

export interface TimelineDocument {
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  scenes: TimelineScene[];
  music: TimelineMusic | null;
  captions: {
    burnedIn: boolean;
    style: TimelineCaptionStyle;
    cues: Array<{ startMs: number; endMs: number; text: string }>;
  } | null;
  brand: {
    primaryColor: string | null;
    secondaryColor: string | null;
    fontPreference: string | null;
  };
}

export interface SceneInput {
  index: number;
  label: string | null;
  onScreenText: string | null;
  transition: string | null;
  visualKey: string;
  visualKind: TimelineScene["visualKind"];
  visualDurationMs: number | null;
  narrationKey: string | null;
  /** Measured length of this scene's narration audio. */
  narrationDurationMs: number;
}

export interface BuildTimelineInput {
  scenes: readonly SceneInput[];
  music: TimelineMusic | null;
  captionCues: ReadonlyArray<{ startMs: number; endMs: number; text: string }>;
  burnCaptions: boolean;
  captionStyle?: Partial<TimelineCaptionStyle> | null;
  brand?: {
    primaryColor?: string | null;
    secondaryColor?: string | null;
    fontPreference?: string | null;
  } | null;
}

/**
 * The default caption look: Inter, high contrast, low on the frame.
 *
 * Chosen for legibility on a phone at 4 inches, which is where most of the
 * watch time is. The brand kit's `captionStyle` overrides any of it.
 */
const DEFAULT_CAPTION_STYLE: TimelineCaptionStyle = {
  fontFamily: "Inter",
  fontSizePx: 48,
  color: "#FFFFFF",
  backgroundColor: "#000000A6",
  verticalPosition: 0.82,
};

/**
 * A scene's minimum on-screen time.
 *
 * A one-word narration line ("Exactly.") is under a second of audio, and a cut
 * that fast reads as a glitch rather than as pacing.
 */
const MIN_SCENE_MS = 1_500;

/**
 * Assemble the document.
 *
 * Pure: no database, no storage, no network. Everything it needs is measured
 * already, which is what makes the offsets testable without generating audio.
 */
export function buildTimeline(input: BuildTimelineInput): TimelineDocument {
  const scenes: TimelineScene[] = [];
  let cursor = 0;

  for (const scene of [...input.scenes].sort((a, b) => a.index - b.index)) {
    // A silent scene still needs screen time, and a very short line still needs a
    // readable beat. Both resolve to the same floor.
    const durationMs = Math.max(MIN_SCENE_MS, Math.round(scene.narrationDurationMs));

    scenes.push({
      index: scene.index,
      label: scene.label,
      startMs: cursor,
      durationMs,
      visualKey: scene.visualKey,
      visualKind: scene.visualKind,
      visualDurationMs: scene.visualDurationMs,
      narrationKey: scene.narrationKey,
      narrationDurationMs: Math.round(scene.narrationDurationMs),
      onScreenText: scene.onScreenText,
      // The first scene cannot fade from anything, so it cuts.
      transition: scene.transition ?? (scene.index === 0 ? "none" : "fade"),
    });

    cursor += durationMs;
  }

  const durationMs = cursor > 0 ? cursor + TAIL_PADDING_MS : 0;

  const style: TimelineCaptionStyle = {
    ...DEFAULT_CAPTION_STYLE,
    ...pickStyle(input.captionStyle),
  };

  return {
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    fps: OUTPUT_FPS,
    durationMs,
    scenes,
    music: input.music,
    captions:
      input.captionCues.length > 0
        ? {
            burnedIn: input.burnCaptions,
            style,
            // Clipped to the video: a cue past the last frame is silently dropped
            // by some providers and errors on others.
            cues: input.captionCues
              .filter((c) => c.startMs < durationMs)
              .map((c) => ({
                startMs: Math.max(0, Math.round(c.startMs)),
                endMs: Math.min(durationMs, Math.round(c.endMs)),
                text: c.text,
              }))
              .filter((c) => c.endMs > c.startMs),
          }
        : null,
    brand: {
      primaryColor: input.brand?.primaryColor ?? null,
      secondaryColor: input.brand?.secondaryColor ?? null,
      fontPreference: input.brand?.fontPreference ?? null,
    },
  };
}

/**
 * Read a caption style out of the brand kit's free-form JSON.
 *
 * `brand_kits.caption_style` is `jsonb` a user's settings screen writes, so every
 * field is validated here rather than trusted: a `fontSizePx` of 4000 would
 * produce a render whose captions cover the frame, and the provider would accept
 * it happily.
 */
function pickStyle(
  raw: Partial<TimelineCaptionStyle> | null | undefined,
): Partial<TimelineCaptionStyle> {
  if (!raw || typeof raw !== "object") return {};

  const out: Partial<TimelineCaptionStyle> = {};

  if (typeof raw.fontFamily === "string" && raw.fontFamily.length <= 60) {
    out.fontFamily = raw.fontFamily;
  }
  if (
    typeof raw.fontSizePx === "number" &&
    Number.isFinite(raw.fontSizePx) &&
    raw.fontSizePx >= 20 &&
    raw.fontSizePx <= 120
  ) {
    out.fontSizePx = Math.round(raw.fontSizePx);
  }
  if (typeof raw.color === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(raw.color)) {
    out.color = raw.color;
  }
  if (
    raw.backgroundColor === null ||
    (typeof raw.backgroundColor === "string" &&
      /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(raw.backgroundColor))
  ) {
    out.backgroundColor = raw.backgroundColor;
  }
  if (
    typeof raw.verticalPosition === "number" &&
    raw.verticalPosition >= 0 &&
    raw.verticalPosition <= 1
  ) {
    out.verticalPosition = raw.verticalPosition;
  }

  return out;
}

/**
 * Per-scene narration offsets, in the shape `voiceovers.segments` stores.
 *
 * Derived from the same document the render uses, so the timeline the renderer
 * cut and the offsets the chapter list is built from cannot disagree.
 */
export function narrationSegments(
  document: TimelineDocument,
): Array<{ sceneIndex: number; startMs: number; durationMs: number }> {
  return document.scenes.map((scene) => ({
    sceneIndex: scene.index,
    startMs: scene.startMs,
    durationMs: scene.narrationDurationMs,
  }));
}

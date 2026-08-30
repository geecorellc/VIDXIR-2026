/**
 * Output format — the frame the whole pipeline targets (Phase 11 §16).
 *
 * Phases 1-10 had no format system. `OUTPUT_WIDTH`/`OUTPUT_HEIGHT` in
 * `timeline.ts` and `TARGET_WIDTH`/`TARGET_HEIGHT` in `providers/visuals.ts` were
 * both the constant 1920x1080, in two places, with no way to ask for anything
 * else. §16 says to reuse an existing format system if one is present; there was
 * none, so this is it, introduced additively:
 *
 *  - `landscape` is 1920x1080 and is the default everywhere. An existing project
 *    with no format recorded resolves to exactly the numbers it rendered with
 *    before, so nothing about Phases 1-10 changes.
 *  - `portrait` is 1080x1920, for Shorts.
 *  - `square` is 1080x1080.
 *
 * The format has to travel further than the renderer, which is why it lives in
 * its own dependency-free module rather than in `timeline.ts`. Three consumers
 * need it and two of them run before a timeline exists:
 *
 *  1. Stock selection ranks candidate clips against the target frame — a portrait
 *     clip in a landscape video letterboxes, and vice versa.
 *  2. An AI video provider takes an aspect ratio as a *generation parameter*.
 *     Asking Veo or Seedance for 16:9 and then cropping to 9:16 wastes the
 *     generation and loses the subject.
 *  3. The timeline and the renderer size the canvas.
 *
 * `aspectRatioLabel` exists because providers disagree on how to spell a ratio:
 * Runway wants pixel dimensions (`1920:1080`), the four backends behind Tally's own
 * models want the reduced form (`16:9`). Both are derived here so no provider module
 * invents its own.
 */

/** The formats Tally can render. */
export type VideoFormat = "landscape" | "portrait" | "square";

export const VIDEO_FORMATS = ["landscape", "portrait", "square"] as const;

/**
 * The format used when nothing has chosen one.
 *
 * Landscape, because that is what every pre-Phase-11 render produced. A default
 * of anything else would silently change the output of an existing project.
 */
export const DEFAULT_VIDEO_FORMAT: VideoFormat = "landscape";

export interface FormatSpec {
  format: VideoFormat;
  width: number;
  height: number;
  fps: number;
  /** Reduced ratio, e.g. "16:9" — the form the AI video backends accept. */
  ratio: string;
  /** Short label for the picker. */
  label: string;
  /** What this format is for, shown under the label. */
  description: string;
}

/**
 * 30fps for every format.
 *
 * Not because 30 is special, but because the voiceover, caption and music stages
 * all measure in milliseconds and the renderer is the only thing that cares about
 * frames. Varying it per format would change render cost with no visible benefit
 * and would make two projects' timelines incomparable.
 */
const FPS = 30;

const SPECS: Record<VideoFormat, FormatSpec> = {
  landscape: {
    format: "landscape",
    width: 1920,
    height: 1080,
    fps: FPS,
    ratio: "16:9",
    label: "Landscape 16:9",
    description: "Standard YouTube video, 1920x1080.",
  },
  portrait: {
    format: "portrait",
    width: 1080,
    height: 1920,
    fps: FPS,
    ratio: "9:16",
    label: "Portrait 9:16",
    description: "YouTube Shorts and vertical feeds, 1080x1920.",
  },
  square: {
    format: "square",
    width: 1080,
    height: 1080,
    fps: FPS,
    ratio: "1:1",
    label: "Square 1:1",
    description: "Square feed posts, 1080x1080.",
  },
};

/** True when a string is one of the known formats. */
export function isVideoFormat(value: unknown): value is VideoFormat {
  return (
    typeof value === "string" &&
    (VIDEO_FORMATS as readonly string[]).includes(value)
  );
}

/**
 * Resolve a format name to its frame.
 *
 * Accepts null/undefined/unknown and returns the default rather than throwing:
 * the value arrives from a nullable database column, and a project written before
 * this column existed is not an error — it is landscape.
 *
 * A value that is a *client-supplied string* must be validated by the route's
 * Zod schema before it gets here. This function's tolerance is for legacy rows,
 * not for unvalidated input.
 */
export function formatSpec(value: unknown): FormatSpec {
  return isVideoFormat(value) ? SPECS[value] : SPECS[DEFAULT_VIDEO_FORMAT];
}

/** Every format, for a picker. Safe to send to the client — no configuration. */
export function videoFormats(): FormatSpec[] {
  return VIDEO_FORMATS.map((format) => SPECS[format]);
}

/**
 * Pixel-dimension ratio label, e.g. "1920:1080".
 *
 * Runway's API takes the ratio in this form and rejects "16:9". Kept next to the
 * reduced form so a provider module picks the spelling its API wants instead of
 * hardcoding a pair of numbers.
 */
export function pixelRatioLabel(spec: FormatSpec): string {
  return `${spec.width}:${spec.height}`;
}

/**
 * How well a candidate clip's own frame fits the target.
 *
 * Returns 1 for an exact aspect match and falls towards 0 as the mismatch grows.
 * Used to rank stock results: a 1920x1080 clip in a portrait video is not
 * unusable — the renderer will crop it — but a clip already shot vertically is
 * always the better choice, and before Phase 11 nothing could express that
 * because there was only one target.
 *
 * Dimensions of zero or null return `null` — "unknown", which a caller must not
 * read as a bad fit. A stock provider that omits dimensions is common and its
 * clips should not be ranked last for it.
 */
export function aspectFit(
  spec: FormatSpec,
  width: number | null,
  height: number | null,
): number | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  const target = spec.width / spec.height;
  const actual = width / height;
  const ratio = target > actual ? actual / target : target / actual;
  return ratio;
}

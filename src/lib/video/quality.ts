/**
 * Generation quality — the resolution Vidxir AI asks a model for (§4, §16).
 *
 * `format.ts` answers "what shape is the frame". This answers "how many pixels",
 * and it is deliberately a separate axis because the two are chosen separately in
 * the UI and priced separately by every vendor: §9 makes credit cost a function of
 * *model + operation + resolution + duration*, so resolution has to be a first-class
 * value that the pricing table and the capability matrix can both key on.
 *
 * Two things this is not:
 *
 *  - **Not the render canvas.** The renderer still targets the format's frame
 *    (1920x1080 for landscape, and so on) and scales whatever it is given, exactly
 *    as it already does for stock clips that arrive at arbitrary sizes. Quality
 *    changes what we *ask the provider to generate*, not what FFmpeg outputs, which
 *    is what keeps §17's "existing renderer stays intact" true.
 *  - **Not a promise.** A quality listed here is only offered for a model whose
 *    capability matrix declares it (`providers/video-gen.ts`). §4 forbids showing an
 *    option the underlying model does not support, so this module defines the
 *    vocabulary and the models decide which words they answer to.
 *
 * `lines` is the **short edge**, which makes one number describe all three formats:
 * 1080p is 1920x1080 landscape, 1080x1920 portrait and 1080x1080 square. Vendors
 * spell their own tokens differently — DashScope wants `1920*1080`, MiniMax wants
 * `1080P`, Ark wants `--resolution 1080p` — and each adapter derives its spelling
 * from this rather than carrying its own idea of what "1080p" means.
 */
import { formatSpec, type VideoFormat } from "@/lib/video/format";

/** The resolutions Vidxir AI can ask for. */
export type VideoQuality = "draft" | "720p" | "1080p" | "2k";

export const VIDEO_QUALITIES = ["draft", "720p", "1080p", "2k"] as const;

/**
 * The quality used when nothing has chosen one.
 *
 * 1080p, which is what every pre-Phase-12 generation implicitly asked for — the
 * Phase 11 adapters sent a hardcoded `resolution: "1080p"`. A default of anything
 * else would silently change the output of an existing project.
 */
export const DEFAULT_VIDEO_QUALITY: VideoQuality = "1080p";

export interface QualitySpec {
  quality: VideoQuality;
  /** Short label for the picker. */
  label: string;
  /** What this tier is for, shown under the label. */
  description: string;
  /** Short edge in pixels. The number every vendor token is derived from. */
  lines: number;
  /**
   * True for the tier the UI marks "⭐ Recommended" (§4).
   *
   * A hint, not a default: `DEFAULT_VIDEO_QUALITY` is what an absent choice
   * resolves to, and the two are the same value on purpose.
   */
  recommended: boolean;
}

const SPECS: Record<VideoQuality, QualitySpec> = {
  draft: {
    quality: "draft",
    label: "Draft",
    description: "Cheapest and fastest. For checking a scene before committing.",
    lines: 480,
    recommended: false,
  },
  "720p": {
    quality: "720p",
    label: "720p",
    description: "Good enough for Shorts and high-volume publishing.",
    lines: 720,
    recommended: false,
  },
  "1080p": {
    quality: "1080p",
    label: "1080p",
    description: "Full HD. What most finished YouTube videos should use.",
    lines: 1080,
    recommended: true,
  },
  "2k": {
    quality: "2k",
    label: "2K",
    description: "Highest detail, highest cost. For hero scenes.",
    lines: 1440,
    recommended: false,
  },
};

/** True when a string is one of the known qualities. */
export function isVideoQuality(value: unknown): value is VideoQuality {
  return (
    typeof value === "string" &&
    (VIDEO_QUALITIES as readonly string[]).includes(value)
  );
}

/**
 * Resolve a quality name to its spec.
 *
 * Accepts null/undefined/unknown and returns the default rather than throwing, for
 * the same reason `formatSpec` does: the value arrives from a nullable column and a
 * project written before that column existed is not an error. Client-supplied
 * strings are validated by the route's Zod schema before they get here.
 */
export function qualitySpec(value: unknown): QualitySpec {
  return isVideoQuality(value) ? SPECS[value] : SPECS[DEFAULT_VIDEO_QUALITY];
}

/** Every quality, in ascending order. Safe to send to the client. */
export function videoQualities(): QualitySpec[] {
  return VIDEO_QUALITIES.map((quality) => SPECS[quality]);
}

/** Ascending index, so two qualities can be compared or sorted. */
export function qualityRank(quality: VideoQuality): number {
  return VIDEO_QUALITIES.indexOf(quality);
}

export interface QualityFrame {
  width: number;
  height: number;
}

/**
 * The pixel frame a format/quality pair asks for.
 *
 * Derived rather than tabulated so a new quality tier is one entry in `SPECS` and
 * nothing else. Widths are rounded to an even number because every video encoder in
 * the pipeline requires it — an odd dimension is rejected by libx264 outright.
 */
export function qualityFrame(
  format: VideoFormat,
  quality: VideoQuality,
): QualityFrame {
  const spec = formatSpec(format);
  const lines = SPECS[quality].lines;
  const long = even(Math.round((lines * Math.max(spec.width, spec.height)) / Math.min(spec.width, spec.height)));

  if (spec.width > spec.height) return { width: long, height: even(lines) };
  if (spec.width < spec.height) return { width: even(lines), height: long };
  return { width: even(lines), height: even(lines) };
}

function even(value: number): number {
  return value % 2 === 0 ? value : value + 1;
}

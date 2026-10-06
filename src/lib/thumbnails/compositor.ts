/**
 * Compositing a thumbnail image (§16, §22, §42).
 *
 * Takes a background frame and a concept, and returns the JPEG bytes YouTube will
 * receive. It is the only place in Vidxir AI that produces a picture a viewer sees
 * before the video itself, so the constraints are YouTube's, not ours:
 *
 *  - 1280×720, 16:9. Smaller is upscaled by YouTube and looks it.
 *  - Under 2MB, or the upload is rejected outright.
 *  - JPEG. PNG is accepted, but a photographic frame as PNG is several megabytes
 *    for no visible gain, and the 2MB ceiling is real.
 *
 * How the text gets there: ffmpeg's `drawtext`, reading the headline from a
 * **file** rather than an inline `text=` value. That is not a stylistic choice —
 * the headline is model-generated and may contain a colon, a quote, a percent
 * sign or a backslash, every one of which changes the meaning of a filter
 * argument. `textfile=` with `expansion=none` makes the text data instead of
 * syntax, which removes a whole class of failure (and a whole class of injection)
 * rather than trying to escape its way out.
 *
 * The same reasoning is then applied to the *paths*, and it is the reason ffmpeg is
 * spawned with `cwd` set to the working directory and the filter graph names bare
 * files. Escaping a path into a filter option is not reliably possible: measured
 * against ffmpeg 6.0, a colon needs one backslash inside quotes and two outside
 * them, and a path containing a comma or an apostrophe — `C:\Users\O'Brien, J\...`,
 * which is an ordinary Windows temp path — cannot be escaped into any form the
 * graph parser accepts. Every failure is a wrong graph rather than an error: the
 * observed symptom was `drawtext` reading half the path as its positional `text`
 * option and refusing "both text and text file". Naming files the compositor chose
 * itself, relative to a directory ffmpeg is already standing in, means the graph
 * contains no character that needs escaping at all. The operator's font is copied
 * in under a safe name for exactly the same reason.
 *
 * Layout is computed, not guessed. The wrap width comes from the character count
 * at the chosen size, and the scrim height from the number of lines that resulted,
 * so a four-word headline and a nine-word one both stay inside the frame.
 *
 * There is no "mock compositor". ffmpeg is a real encoder producing a real image,
 * exactly as the render stage treats it — with a mock background frame in
 * development, this still produces a genuine composited JPEG, so there is no state
 * where Vidxir AI claims a thumbnail exists that does not. When no font file can be
 * found the call throws `NotConfiguredError` naming `THUMBNAIL_FONT_FILE`; drawing
 * the headline in whatever face happened to be lying around is the silent
 * substitution §48 forbids.
 */
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NotConfiguredError, ProviderError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { ffmpegBinary } from "@/lib/media/ffmpeg";
import {
  FONT_ENV_VARS,
  FONT_HINT,
  thumbnailFonts,
  type ThumbnailFonts,
} from "@/lib/media/fonts";
import type { ThumbnailEmotion } from "@/lib/thumbnails/prompt";

const log = logger.child({ component: "thumbnail-compositor" });

/** YouTube's thumbnail dimensions. */
export const THUMBNAIL_WIDTH = 1280;
export const THUMBNAIL_HEIGHT = 720;

/** YouTube rejects a thumbnail over 2MB. */
export const MAX_THUMBNAIL_BYTES = 2 * 1_048_576;

/**
 * A composite is one frame. Sixty seconds is already pathological — it exists so
 * a wedged ffmpeg fails the job instead of holding a worker slot forever.
 */
const COMPOSITE_TIMEOUT_MS = 60_000;

/** Headline type size, in pixels of a 720-high frame. */
const HEADLINE_SIZE = 96;
const SUBLINE_SIZE = 40;

/** Left and right margin. */
const MARGIN_X = 56;

/**
 * Characters per headline line at `HEADLINE_SIZE`.
 *
 * Derived, not tuned by eye: a heavy sans averages ~0.55em per glyph, so a line
 * fits `(width - 2 * margin) / (size * 0.55)` characters. Slightly conservative,
 * because a line that overflows the frame is a ruined thumbnail while a line that
 * wraps early is merely a different, still-fine layout.
 */
const HEADLINE_CHARS_PER_LINE = Math.floor(
  (THUMBNAIL_WIDTH - 2 * MARGIN_X) / (HEADLINE_SIZE * 0.58),
);

const SUBLINE_CHARS_PER_LINE = Math.floor(
  (THUMBNAIL_WIDTH - 2 * MARGIN_X) / (SUBLINE_SIZE * 0.55),
);

/** Space between headline lines. */
const LINE_SPACING = 6;

/**
 * Accent colour per emotion, as ffmpeg colour literals.
 *
 * Vidxir AI red leads because it is the product's accent and the design direction
 * (§3) is not up for renegotiation by a thumbnail. The others are deliberately
 * few and deliberately high-contrast against a dark scrim: this is the subline
 * colour, read at 320px wide, not a palette.
 */
const ACCENT: Record<ThumbnailEmotion, string> = {
  curiosity: "0xE8332B",
  surprise: "0xFFC53D",
  urgency: "0xE8332B",
  confidence: "0x4ADE80",
  concern: "0xFFC53D",
  delight: "0x60A5FA",
};

/**
 * Filenames inside the working directory, referenced verbatim by the filter graph.
 *
 * Deliberately boring: lower case, no extension where none is needed, and not one
 * character that means anything to ffmpeg's graph parser. They are constants rather
 * than literals at each use so the name written and the name referenced cannot
 * drift — a mismatch produces "no such file" from inside a filter, which is a long
 * way from where the typo is.
 */
const FILES = {
  headlineText: "headline.txt",
  sublineText: "subline.txt",
  headlineFont: "headline-font",
  bodyFont: "body-font",
  output: "thumbnail.jpg",
} as const;

export interface CompositeRequest {
  /** The background frame. Any image or video ffmpeg can decode; frame 1 is used. */
  background: Buffer;
  /** Extension of `background`, so ffmpeg picks the right demuxer. */
  backgroundExtension: string;
  headline: string;
  subline: string | null;
  emotion: ThumbnailEmotion;
}

export interface CompositeResult {
  bytes: Buffer;
  mimeType: "image/jpeg";
  extension: "jpg";
  width: number;
  height: number;
  /** Which font files were actually used, recorded on the asset for provenance. */
  fonts: ThumbnailFonts;
}

/** True when a composite can be produced right now. */
export function isCompositorConfigured(): boolean {
  return ffmpegBinary() !== null && thumbnailFonts() !== null;
}

/** Env vars an operator must set to make compositing available. */
export function compositorMissingEnvVars(): string[] {
  const missing: string[] = [];
  if (ffmpegBinary() === null) missing.push("FFMPEG_PATH");
  if (thumbnailFonts() === null) missing.push("THUMBNAIL_FONT_FILE");
  return missing;
}

function requireConfigured(): { binary: string; fonts: ThumbnailFonts } {
  const binary = ffmpegBinary();
  const fonts = thumbnailFonts();

  if (!binary) {
    throw new NotConfiguredError(
      "Thumbnail compositor",
      ["FFMPEG_PATH"],
      "ffmpeg draws the headline onto the background frame. Run " +
        "`npm install ffmpeg-static` or set FFMPEG_PATH to a system ffmpeg.",
    );
  }

  if (!fonts) {
    throw new NotConfiguredError(
      "Thumbnail font",
      [...FONT_ENV_VARS],
      FONT_HINT,
    );
  }

  return { binary, fonts };
}

/**
 * Draw a concept onto a background and return a YouTube-ready JPEG.
 *
 * The quality ladder at the end is the interesting part. A 1280×720 photographic
 * JPEG at q2 is normally ~200-400KB, comfortably inside the 2MB limit — but a
 * noisy frame can exceed it, and a thumbnail that YouTube refuses is a publish
 * failure discovered at the worst moment. So the encode steps down through the
 * quality scale until the file fits, and reports which step it used. It never
 * returns bytes that would be rejected, and it never silently returns something
 * of a different size than requested.
 */
export async function composite(
  request: CompositeRequest,
): Promise<CompositeResult> {
  const { binary, fonts } = requireConfigured();

  const headline = normaliseHeadline(request.headline);
  if (!headline) {
    // Not a provider fault: the concept is unusable, and re-running ffmpeg with
    // the same empty string will not change that.
    throw new ProviderError("thumbnail", "the concept has no headline text", {
      retryable: false,
    });
  }

  const dir = await mkdtemp(join(tmpdir(), "vidxir-thumb-"));

  try {
    // The extension matters — it is how ffmpeg picks a demuxer for a still — but
    // the name does not, so it is sanitised down to letters and digits rather than
    // trusted. A provider-supplied extension reaches this function.
    const backgroundName = `background.${
      request.backgroundExtension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "png"
    }`;
    await writeFile(join(dir, backgroundName), request.background);

    const headlineLines = wrap(headline, HEADLINE_CHARS_PER_LINE);
    const sublineText = request.subline?.trim()
      ? normaliseSubline(request.subline)
      : null;
    const sublineLines = sublineText ? wrap(sublineText, SUBLINE_CHARS_PER_LINE) : [];

    // Text files rather than inline `text=`: see the module comment. Written as
    // UTF-8 with no BOM — ffmpeg renders a BOM as a visible glyph.
    await writeFile(join(dir, FILES.headlineText), headlineLines.join("\n"), "utf8");

    const hasSubline = sublineLines.length > 0;
    if (hasSubline) {
      await writeFile(join(dir, FILES.sublineText), sublineLines.join("\n"), "utf8");
    }

    /**
     * Copy the fonts in under safe names.
     *
     * `THUMBNAIL_FONT_FILE` is an operator's arbitrary path, and a font under
     * `C:\Users\O'Brien, J\Fonts\` cannot be expressed in a filter graph at all.
     * A ~200KB copy per composite is cheap next to an encode, and it is the only
     * way the graph is guaranteed parseable whatever the path.
     */
    await copyFile(fonts.headline, join(dir, FILES.headlineFont));
    if (hasSubline) {
      await copyFile(fonts.body, join(dir, FILES.bodyFont));
    }

    const layout = layoutFor(headlineLines.length, sublineLines.length);

    let bytes: Buffer | null = null;
    let quality = 2;

    // JPEG quality 2 (near-lossless) down to 12 (visibly soft but still usable).
    // Four steps is enough headroom for any 1280×720 frame; a frame that still
    // exceeds 2MB at q12 does not exist in practice, and if it did, failing is
    // more honest than shipping something YouTube will reject.
    for (const attempt of [2, 5, 8, 12]) {
      quality = attempt;
      await runFfmpeg(
        binary,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-i",
          backgroundName,
          // One frame, whether the input was a still or a video.
          "-frames:v",
          "1",
          "-vf",
          filterGraph({
            hasSubline,
            layout,
            accent: ACCENT[request.emotion],
          }),
          "-q:v",
          String(attempt),
          FILES.output,
        ],
        dir,
      );

      const encoded = await readFile(join(dir, FILES.output));
      if (encoded.byteLength === 0) {
        throw new ProviderError("thumbnail", "ffmpeg produced an empty image");
      }
      if (encoded.byteLength <= MAX_THUMBNAIL_BYTES) {
        bytes = encoded;
        break;
      }
      log.warn("composited thumbnail over the size limit, re-encoding", {
        bytes: encoded.byteLength,
        quality: attempt,
      });
    }

    if (!bytes) {
      throw new ProviderError(
        "thumbnail",
        `the composited image stayed above ${Math.round(
          MAX_THUMBNAIL_BYTES / 1024,
        )}KB, which YouTube rejects`,
        { retryable: false },
      );
    }

    log.info("thumbnail composited", {
      bytes: bytes.byteLength,
      quality,
      headlineLines: headlineLines.length,
      sublineLines: sublineLines.length,
    });

    return {
      bytes,
      mimeType: "image/jpeg",
      extension: "jpg",
      width: THUMBNAIL_WIDTH,
      height: THUMBNAIL_HEIGHT,
      fonts,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface Layout {
  /** Top of the darkened band behind the text. */
  scrimY: number;
  scrimHeight: number;
  headlineY: number;
  sublineY: number | null;
}

/**
 * Where the text sits.
 *
 * Bottom-anchored, because the background's subject is usually centred and upper
 * thirds carry it. The scrim is sized to the text it has to cover rather than
 * being a fixed band: a one-line headline under a full-height scrim looks like a
 * mistake, and a three-line headline over a short one is unreadable.
 */
export function layoutFor(headlineLines: number, sublineLines: number): Layout {
  const headlineHeight =
    headlineLines * HEADLINE_SIZE + (headlineLines - 1) * LINE_SPACING;
  const sublineHeight =
    sublineLines > 0
      ? sublineLines * SUBLINE_SIZE + (sublineLines - 1) * LINE_SPACING
      : 0;
  const gap = sublineLines > 0 ? 20 : 0;

  const padding = 28;
  const contentHeight = headlineHeight + gap + sublineHeight;
  const scrimHeight = Math.min(
    THUMBNAIL_HEIGHT,
    contentHeight + padding * 2,
  );
  const scrimY = Math.max(0, THUMBNAIL_HEIGHT - scrimHeight);

  const headlineY = scrimY + padding;
  const sublineY =
    sublineLines > 0 ? headlineY + headlineHeight + gap : null;

  return { scrimY, scrimHeight, headlineY, sublineY };
}

interface GraphInput {
  /** Whether a subline was written; `false` omits the second `drawtext` entirely. */
  hasSubline: boolean;
  layout: Layout;
  accent: string;
}

/**
 * The filter chain.
 *
 * `scale` + `crop` rather than `scale` + `pad`: a thumbnail with black bars is
 * worse than one that loses a little off the sides, and stock frames are usually
 * 16:9 already so the crop is a no-op in the common case.
 *
 * Every filename here is one of `FILES` and is resolved relative to the working
 * directory ffmpeg is spawned in, so the graph is a fixed string plus numbers. It
 * cannot be influenced by a font path, a temp directory or model output — see the
 * module comment for why escaping was not a workable alternative.
 *
 * Exported for tests. The argument list is the part that breaks — a missing colon
 * in a filter option produces a wrong image rather than an error — and asserting
 * on it does not require spawning an encoder.
 */
export function filterGraph(input: GraphInput): string {
  const { layout } = input;

  const parts = [
    `scale=${THUMBNAIL_WIDTH}:${THUMBNAIL_HEIGHT}:force_original_aspect_ratio=increase`,
    `crop=${THUMBNAIL_WIDTH}:${THUMBNAIL_HEIGHT}`,
    // The scrim. Without it, white text over a bright frame is illegible, which
    // is the single most common failure of an automated thumbnail.
    `drawbox=x=0:y=${layout.scrimY}:w=${THUMBNAIL_WIDTH}:h=${layout.scrimHeight}:` +
      `color=black@0.58:t=fill`,
    drawtext({
      fontFile: FILES.headlineFont,
      textFile: FILES.headlineText,
      size: HEADLINE_SIZE,
      colour: "white",
      y: layout.headlineY,
      // A border rather than a shadow: it survives being scaled down to 320px,
      // where a soft shadow disappears entirely.
      border: 5,
    }),
  ];

  if (input.hasSubline && layout.sublineY !== null) {
    parts.push(
      drawtext({
        fontFile: FILES.bodyFont,
        textFile: FILES.sublineText,
        size: SUBLINE_SIZE,
        colour: input.accent,
        y: layout.sublineY,
        border: 3,
      }),
    );
  }

  return parts.join(",");
}

function drawtext(options: {
  /** A name from `FILES`, relative to the working directory. Never a full path. */
  fontFile: string;
  textFile: string;
  size: number;
  colour: string;
  y: number;
  border: number;
}): string {
  return (
    `drawtext=fontfile=${options.fontFile}:` +
    `textfile=${options.textFile}:` +
    // The whole point: no `%{...}` expansion, no escape processing. Model-written
    // text is data.
    `expansion=none:` +
    `fontsize=${options.size}:` +
    `fontcolor=${options.colour}:` +
    `line_spacing=${LINE_SPACING}:` +
    `borderw=${options.border}:bordercolor=black@0.9:` +
    `x=${MARGIN_X}:y=${options.y}`
  );
}

// ---------------------------------------------------------------------------
// Text preparation
// ---------------------------------------------------------------------------

/**
 * Upper-case, collapse whitespace, strip characters that cannot be drawn.
 *
 * Casing happens here rather than in the prompt because the model was told not to
 * shout — the design uses caps as typography, and asking a model for ALL CAPS
 * also gets ALL CAPS punctuation and emphasis.
 *
 * Newlines are stripped before wrapping: they are the line separator in the text
 * file, so a headline containing one would break the computed layout.
 */
export function normaliseHeadline(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/** Same collapsing, but the subline keeps its casing — it is a sentence. */
export function normaliseSubline(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Greedy word wrap.
 *
 * A word longer than the line budget is left on its own line rather than
 * hyphenated or truncated: at thumbnail scale a broken word reads as a rendering
 * bug, and truncating changes what the headline says.
 */
export function wrap(text: string, charsPerLine: number): string[] {
  const words = text.split(" ").filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= charsPerLine) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  return lines;
}

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

/**
 * Spawn ffmpeg inside `cwd`.
 *
 * `cwd` is the whole reason the filter graph needs no escaping: every filename it
 * mentions is resolved from here. The binary is resolved to an absolute path first,
 * because changing the working directory would otherwise break a relative
 * `FFMPEG_PATH`.
 */
function runFfmpeg(
  binary: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  return new Promise((settleResolve, reject) => {
    const child = spawn(resolve(binary), [...args], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(
        new ProviderError(
          "thumbnail",
          `compositing did not finish within ${COMPOSITE_TIMEOUT_MS / 1000}s`,
          { retryable: false },
        ),
      );
    }, COMPOSITE_TIMEOUT_MS);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2_000);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new ProviderError("thumbnail", "ffmpeg could not be started", {
          retryable: false,
          cause: error,
        }),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code === 0) {
        settleResolve();
        return;
      }

      reject(
        new ProviderError(
          "thumbnail",
          `ffmpeg exited with code ${code}${
            stderr ? `: ${stderr.trim().split("\n").slice(-2).join(" ")}` : ""
          }`,
          // A bad filter graph or an undecodable background fails identically on
          // a second attempt.
          { retryable: false },
        ),
      );
    });
  });
}

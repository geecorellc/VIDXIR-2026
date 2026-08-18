/**
 * Locating a font file for burned-in text (§16, §48).
 *
 * A thumbnail's headline is drawn by ffmpeg's `drawtext`, which needs a font
 * *file* on disk. That is the difference from the caption path in `render.ts`,
 * which passes a font *name* to libass and lets fontconfig resolve it — a
 * thumbnail composite is a single frame with 100px type across it, and a
 * silently substituted fallback face changes the whole design.
 *
 * Nothing is bundled. Oswald and Inter reach the browser through a Google Fonts
 * `@import`, which is no help to a worker process, and committing a ~200KB TTF to
 * satisfy a filter would put a licensed binary in the repository. So this module
 * searches, and reports honestly when it finds nothing:
 *
 *   1. `THUMBNAIL_FONT_FILE` / `THUMBNAIL_FONT_FILE_BODY` — an operator's explicit
 *      choice, which wins because it is the only source that knows what the brand
 *      is supposed to look like.
 *   2. Well-known system directories, for the faces a headline actually wants: a
 *      heavy condensed or bold sans. On this Windows machine that is Impact or
 *      Arial Bold; on a Debian container it is DejaVu Sans Bold, which
 *      `fonts-dejavu-core` provides.
 *
 * When neither yields a file, `thumbnailFonts()` returns null and the capability
 * registry reports `not_configured` with the variable to set. A thumbnail with no
 * text is not a thumbnail, and drawing one in a face nobody chose is the quiet
 * substitution §42 rules out.
 */
import { existsSync, statSync } from "node:fs";

/**
 * Faces to try, best first, per role.
 *
 * Headline candidates are ordered by how well they hold up small: a YouTube
 * thumbnail is judged at 320px wide, where a condensed heavy face stays readable
 * and a regular weight turns to mush. Impact leads for that reason, not aesthetic
 * preference.
 */
const HEADLINE_CANDIDATES = [
  // Windows
  "C:/Windows/Fonts/impact.ttf",
  "C:/Windows/Fonts/arialbd.ttf",
  "C:/Windows/Fonts/segoeuib.ttf",
  "C:/Windows/Fonts/verdanab.ttf",
  // Linux — the package names an operator would install are in the README.
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  // macOS
  "/System/Library/Fonts/Supplemental/Impact.ttf",
  "/Library/Fonts/Arial Bold.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
] as const;

const BODY_CANDIDATES = [
  "C:/Windows/Fonts/arialbd.ttf",
  "C:/Windows/Fonts/tahomabd.ttf",
  "C:/Windows/Fonts/arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
] as const;

export interface ThumbnailFonts {
  /** The headline face. Heavy, and legible at 320px wide. */
  headline: string;
  /** The subline face. Falls back to the headline when nothing else is found. */
  body: string;
}

/** Env vars an operator sets to choose the faces explicitly. */
export const FONT_ENV_VARS = [
  "THUMBNAIL_FONT_FILE",
  "THUMBNAIL_FONT_FILE_BODY",
] as const;

export const FONT_HINT =
  "Set THUMBNAIL_FONT_FILE to a .ttf/.otf path (and optionally " +
  "THUMBNAIL_FONT_FILE_BODY for the subline). On Debian/Ubuntu images, " +
  "`apt-get install -y fonts-dejavu-core` provides one at " +
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf.";

function usable(path: string | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  try {
    // `existsSync` alone would accept a directory, and ffmpeg's error for that is
    // an unhelpful "Could not load font".
    return existsSync(trimmed) && statSync(trimmed).isFile() ? trimmed : null;
  } catch {
    return null;
  }
}

function firstUsable(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    const found = usable(candidate);
    if (found) return found;
  }
  return null;
}

/**
 * The fonts to composite with, or null when none is available.
 *
 * Not cached: a container that mounts a font volume, or an operator who installs
 * a package while the worker is running, should not have to restart the process
 * to be believed. The cost is a handful of `stat` calls per composite, against a
 * job that spends seconds in ffmpeg.
 *
 * A configured-but-missing `THUMBNAIL_FONT_FILE` deliberately does **not** fall
 * through to the system search. An operator who named a file meant that file, and
 * quietly drawing in Impact instead would produce a thumbnail that does not match
 * the brand while reporting success.
 */
export function thumbnailFonts(): ThumbnailFonts | null {
  const configured = process.env["THUMBNAIL_FONT_FILE"]?.trim();
  if (configured) {
    const headline = usable(configured);
    if (!headline) return null;
    const body =
      usable(process.env["THUMBNAIL_FONT_FILE_BODY"]) ??
      firstUsable(BODY_CANDIDATES) ??
      headline;
    return { headline, body };
  }

  const headline = firstUsable(HEADLINE_CANDIDATES);
  if (!headline) return null;

  return {
    headline,
    body:
      usable(process.env["THUMBNAIL_FONT_FILE_BODY"]) ??
      firstUsable(BODY_CANDIDATES) ??
      headline,
  };
}

/** True when text can be burned into an image. */
export function hasThumbnailFont(): boolean {
  return thumbnailFonts() !== null;
}

/**
 * Which of `FONT_ENV_VARS` an operator should set to fix an unavailable state.
 *
 * `THUMBNAIL_FONT_FILE` is named even when it is set but points at nothing: it is
 * still the variable that needs attention.
 */
export function fontMissingEnvVars(): string[] {
  return hasThumbnailFont() ? [] : ["THUMBNAIL_FONT_FILE"];
}

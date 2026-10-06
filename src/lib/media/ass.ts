/**
 * ASS subtitle generation, for burned-in text overlays.
 *
 * The editor's `text` track needs words on the frame at a position and a time the
 * document chose. ffmpeg offers two ways to do that and only one of them is safe here:
 *
 *  - `drawtext` needs a font **file**, and `fonts.ts` documents that it may not find
 *    one on a given machine. Its text is also a filter-graph value, so every comma,
 *    colon, quote and backslash in user-supplied copy has to survive two levels of
 *    escaping — and `filter.ts` already records that no escaping works for a path
 *    containing a comma or an apostrophe. Burning arbitrary user text through it is a
 *    quoting bug waiting for the first title with a colon in it.
 *  - `subtitles` reads a **file**, so the text never touches the filter graph, and it
 *    resolves a font by *name* through fontconfig. That is the path Vidxir AI's captions
 *    already take and the one the bundled ffmpeg is built for (libass, libfreetype,
 *    fontconfig and libfribidi are all present in the `ffmpeg-static` build).
 *
 * So overlays are generated as ASS and drawn by a second `subtitles` filter chained
 * after the caption one. Verified empirically: an ASS layer at `Alignment=8` chained
 * with an SRT layer at `Alignment=2` measured max luma 255 at the top of the frame and
 * 248 at the bottom against a base of ~101, so both layers really composite.
 *
 * Unlike the SRT path, the header here is ours, which is why `PlayResX`/`PlayResY` are
 * set to the real output frame: libass scales a script from its declared resolution, so
 * declaring the true frame makes `Fontsize` mean *pixels at that frame* rather than
 * points against libass's 384x288 default. That is the whole reason the caption path
 * has to multiply by 0.55 and this one does not.
 */

/** One line of overlay text and the window it holds for. */
export interface AssCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface AssOverlayInput {
  /** The real output frame, declared to libass so font sizes are in output pixels. */
  width: number;
  height: number;
  cues: readonly AssCue[];
  fontFamily: string;
  /** Size in output pixels, thanks to the declared `PlayRes`. */
  fontSizePx: number;
  /** `#RRGGBB` or `#RRGGBBAA`. */
  color: string;
  /**
   * Vertical placement: 0 = top of frame, 1 = bottom.
   *
   * Mapped onto ASS's alignment plus a margin rather than absolute drawing
   * coordinates, so libass keeps the text inside the title-safe area and wraps long
   * copy for us.
   */
  verticalPosition: number;
}

/**
 * `#RRGGBB[AA]` → ASS `&HAABBGGRR`.
 *
 * ASS reverses the channel order *and* inverts alpha — 0 is opaque, 255 is
 * transparent — so a naive translation produces invisible text.
 *
 * Lives here rather than in `render.ts` because both the caption `force_style` string
 * and the overlay script below need it, and two copies of an inversion this
 * counter-intuitive would eventually disagree.
 */
export function assColour(hex: string): string {
  const clean = hex.replace(/^#/, "");
  const r = clean.slice(0, 2) || "FF";
  const g = clean.slice(2, 4) || "FF";
  const b = clean.slice(4, 6) || "FF";
  const alpha = clean.slice(6, 8);
  const inverted = alpha
    ? (255 - parseInt(alpha, 16)).toString(16).padStart(2, "0")
    : "00";
  return `&H${inverted}${b}${g}${r}`.toUpperCase();
}

/** ASS timestamps are `H:MM:SS.cc` — centiseconds, and a single-digit hour. */
export function assTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const centis = Math.round((total % 1000) / 10);
  // A cue at 1.999s rounds to 200 centiseconds, which is not a legal field.
  const carry = centis === 100;
  return (
    `${hours}:${String(minutes).padStart(2, "0")}:` +
    `${String(carry ? seconds + 1 : seconds).padStart(2, "0")}.` +
    `${String(carry ? 0 : centis).padStart(2, "0")}`
  );
}

/**
 * Sanitise a line of user text for the `Text` field of a Dialogue event.
 *
 * `{` opens an override block in ASS and `\` starts a tag inside one, so copy
 * containing either would be interpreted rather than displayed — `{\an7}` typed into a
 * title would silently move it. Both are removed rather than escaped because ASS has no
 * escape for them. Real newlines are converted to ASS's own `\N`, since a literal
 * newline would end the event and shift every following field.
 *
 * Commas, colons, quotes and apostrophes are all safe: `Text` is the last field on the
 * line, and the script is a file rather than a filter argument.
 */
export function assText(raw: string): string {
  return raw
    .replace(/[{}\\]/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\\N");
}

/**
 * Build an ASS script that draws each cue over transparent video.
 *
 * Returns null when nothing would be drawn, so the caller can skip both the file and
 * the filter rather than chaining a `subtitles` that does nothing.
 */
export function buildAssOverlay(input: AssOverlayInput): string | null {
  const events = input.cues
    .map((cue) => ({ ...cue, body: assText(cue.text) }))
    .filter((cue) => cue.body.length > 0 && cue.endMs > cue.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  if (events.length === 0) return null;

  // 2 = bottom, 5 = middle, 8 = top in ASS's numpad-style alignment. The document's
  // 0..1 is bucketed rather than interpolated because ASS has no continuous vertical
  // anchor short of absolute positioning, which would defeat libass's wrapping.
  const alignment = input.verticalPosition <= 0.34 ? 8 : input.verticalPosition >= 0.67 ? 2 : 5;

  // Keep text clear of the frame edge and of YouTube's own controls. Proportional to
  // the frame so a 1080x1920 short and a 1920x1080 landscape both look deliberate.
  const marginV = Math.round(input.height * 0.06);
  const marginH = Math.round(input.width * 0.06);

  // An outline rather than a box: a title reads as a title, and a filled background
  // behind on-screen text competes with the caption bar underneath it.
  const outline = Math.max(2, Math.round(input.fontSizePx * 0.06));

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${Math.round(input.width)}`,
    `PlayResY: ${Math.round(input.height)}`,
    // 0 = smart wrapping, balanced lines. With the margins above, long copy wraps
    // instead of running off the frame.
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour," +
      " BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle," +
      " BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Overlay,${sanitiseFontName(input.fontFamily)},${Math.round(input.fontSizePx)},` +
      `${assColour(input.color)},${assColour(input.color)},${assColour("#000000")},` +
      `${assColour("#000000")},0,0,0,0,100,100,0,0,1,${outline},0,${alignment},` +
      `${marginH},${marginH},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const dialogue = events.map(
    (cue) =>
      `Dialogue: 0,${assTime(cue.startMs)},${assTime(cue.endMs)},Overlay,,0,0,0,,${cue.body}`,
  );

  return `${[...header, ...dialogue].join("\n")}\n`;
}

/**
 * A font name safe for the `Fontname` field.
 *
 * Commas would add fields to the Style line. Fontconfig resolves whatever is left, and
 * falls back to a default face when the name is not installed — the same behaviour the
 * caption path already relies on.
 */
function sanitiseFontName(name: string): string {
  const clean = name.replace(/[,{}\\\r\n]/g, "").trim();
  return clean.length > 0 ? clean : "Inter";
}

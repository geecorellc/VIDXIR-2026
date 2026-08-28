/**
 * ASS generation tests.
 *
 * The failure mode this module guards against is not an exception — it is text that
 * renders wrong, or moves, or vanishes. `assColour` inverting alpha the wrong way
 * produces invisible titles; a stray brace in user copy is interpreted as an override
 * tag; a literal newline in the `Text` field shifts every following field. All three
 * exit zero and produce a video, so they are asserted here rather than discovered.
 */
import { describe, expect, it } from "vitest";
import { assColour, assText, assTime, buildAssOverlay } from "@/lib/media/ass";

function overlay(
  cues: Array<{ startMs: number; endMs: number; text: string }>,
  overrides: Partial<Parameters<typeof buildAssOverlay>[0]> = {},
): string | null {
  return buildAssOverlay({
    width: 1920,
    height: 1080,
    cues,
    fontFamily: "Inter",
    fontSizePx: 72,
    color: "#FFFFFF",
    verticalPosition: 0.1,
    ...overrides,
  });
}

describe("assColour", () => {
  it("reverses the channel order", () => {
    // ASS is &HAABBGGRR, so red becomes 0000FF rather than FF0000. Getting this
    // backwards yields a blue title that nobody reads as a bug in a colour converter.
    expect(assColour("#FF0000")).toBe("&H000000FF");
    expect(assColour("#0000FF")).toBe("&H00FF0000");
  });

  it("inverts alpha, because ASS counts 0 as opaque", () => {
    // The naive translation produces fully transparent text on a video that encodes
    // perfectly. `A6` is 65% opaque in CSS terms, so ASS wants 255-166 = 89 = 0x59.
    expect(assColour("#000000A6")).toBe("&H59000000");
    // No alpha at all means fully opaque, which in ASS is 00.
    expect(assColour("#FFFFFF")).toBe("&H00FFFFFF");
  });
});

describe("assTime", () => {
  it("formats centiseconds with a single-digit hour", () => {
    expect(assTime(0)).toBe("0:00:00.00");
    expect(assTime(1_500)).toBe("0:00:01.50");
    expect(assTime(3_723_040)).toBe("1:02:03.04");
  });

  it("carries a rounding overflow into the seconds field", () => {
    // 1.999s rounds to 200 centiseconds, which is not a legal field — libass parses
    // it as zero and the cue appears at the wrong second.
    expect(assTime(1_999)).toBe("0:00:02.00");
  });

  it("clamps a negative offset", () => {
    expect(assTime(-500)).toBe("0:00:00.00");
  });
});

describe("assText", () => {
  it("removes override syntax rather than escaping it", () => {
    // ASS has no escape for a brace or a backslash, so `{\an7}` typed into a title
    // would silently reposition it.
    expect(assText("{\\an7}Hello")).toBe("an7Hello");
    expect(assText("100% \\N off")).toBe("100% N off");
  });

  it("converts real newlines to ASS line breaks", () => {
    // A literal newline ends the event, shifting every field after it.
    expect(assText("line one\nline two")).toBe("line one\\Nline two");
    expect(assText("crlf\r\nhandled")).toBe("crlf\\Nhandled");
  });

  it("drops blank lines and trims each line", () => {
    expect(assText("  spaced  \n\n\n  out  ")).toBe("spaced\\Nout");
  });

  it("leaves punctuation alone", () => {
    // Commas, colons and apostrophes are all safe: `Text` is the last field on the
    // line and this is a file, not a filter argument.
    const text = "Don't wait: 50% off, today only";
    expect(assText(text)).toBe(text);
  });
});

describe("buildAssOverlay", () => {
  it("declares the output frame so font size is in output pixels", () => {
    const script = overlay([{ startMs: 0, endMs: 2_000, text: "Hook" }]) as string;

    // Without a real PlayRes, libass scales the script from its 384x288 default and a
    // 72px font arrives at roughly a quarter of the intended size.
    expect(script).toContain("PlayResX: 1920");
    expect(script).toContain("PlayResY: 1080");
    expect(script).toContain("Style: Overlay,Inter,72,");
  });

  it("maps vertical position onto ASS alignment", () => {
    // 8 = top, 5 = middle, 2 = bottom in ASS's numpad-style alignment.
    expect(overlay([{ startMs: 0, endMs: 1_000, text: "t" }], { verticalPosition: 0 }))
      .toContain(",8,");
    expect(overlay([{ startMs: 0, endMs: 1_000, text: "t" }], { verticalPosition: 0.5 }))
      .toContain(",5,");
    expect(overlay([{ startMs: 0, endMs: 1_000, text: "t" }], { verticalPosition: 1 }))
      .toContain(",2,");
  });

  it("scales margins to the frame", () => {
    const portrait = overlay([{ startMs: 0, endMs: 1_000, text: "t" }], {
      width: 1080,
      height: 1920,
    }) as string;

    // 6% of each dimension, so a short and a landscape video both look deliberate.
    expect(portrait).toContain(",65,65,115,1");
  });

  it("writes one dialogue line per cue, in time order", () => {
    const script = overlay([
      { startMs: 4_000, endMs: 6_000, text: "second" },
      { startMs: 0, endMs: 2_000, text: "first" },
    ]) as string;

    const lines = script.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(lines).toEqual([
      "Dialogue: 0,0:00:00.00,0:00:02.00,Overlay,,0,0,0,,first",
      "Dialogue: 0,0:00:04.00,0:00:06.00,Overlay,,0,0,0,,second",
    ]);
  });

  it("returns null when nothing would be drawn", () => {
    expect(overlay([])).toBeNull();
    // Whitespace-only and zero-length cues are not text.
    expect(overlay([{ startMs: 0, endMs: 2_000, text: "   " }])).toBeNull();
    expect(overlay([{ startMs: 2_000, endMs: 2_000, text: "x" }])).toBeNull();
  });

  it("keeps a comma in a font name out of the style line", () => {
    // A comma would add a field to `Style:`, shifting every value after it — the font
    // size would be read as the primary colour.
    const script = overlay([{ startMs: 0, endMs: 1_000, text: "t" }], {
      fontFamily: "Helvetica, Arial",
    }) as string;

    expect(script).toContain("Style: Overlay,Helvetica Arial,72,");
  });

  it("falls back to Inter when the font name is empty after sanitising", () => {
    const script = overlay([{ startMs: 0, endMs: 1_000, text: "t" }], {
      fontFamily: ",,,",
    }) as string;

    expect(script).toContain("Style: Overlay,Inter,72,");
  });
});

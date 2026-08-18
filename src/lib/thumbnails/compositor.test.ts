/**
 * Layout, wrapping and the filter graph (§16).
 *
 * These are the parts that fail *silently*. A wrong `y` produces a thumbnail with
 * the headline off the bottom of the frame; a missing colon in a filter option
 * produces a different filter rather than an error; a wrap that measures wrongly
 * produces a line that runs off the side. All of them exit ffmpeg with code 0, so
 * only assertions on the computed values catch them.
 *
 * `composite()` itself — spawning a real encoder against real bytes — is
 * `compositor.smoke.test.ts`, for the same reason `render.test.ts` and
 * `render.smoke.test.ts` are separate files: argument assertions are cheap and run
 * everywhere, and encodes are seconds and need a binary.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_THUMBNAIL_BYTES,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_WIDTH,
  filterGraph,
  layoutFor,
  normaliseHeadline,
  normaliseSubline,
  wrap,
} from "@/lib/thumbnails/compositor";

describe("YouTube's constraints", () => {
  it("targets 1280x720 and the 2MB ceiling", () => {
    expect(THUMBNAIL_WIDTH).toBe(1280);
    expect(THUMBNAIL_HEIGHT).toBe(720);
    // 2 MiB. YouTube rejects the upload outright above this, so it is a hard
    // number rather than a guideline.
    expect(MAX_THUMBNAIL_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe("wrap", () => {
  it("keeps a short headline on one line", () => {
    expect(wrap("THREE SHORT WORDS", 22)).toEqual(["THREE SHORT WORDS"]);
  });

  it("breaks on the last word that fits", () => {
    expect(wrap("ONE TWO THREE FOUR", 9)).toEqual(["ONE TWO", "THREE", "FOUR"]);
  });

  it("never exceeds the budget on a line it could have broken", () => {
    const lines = wrap(
      "A HEADLINE LONG ENOUGH TO NEED SEVERAL LINES OF SPACE",
      12,
    );
    for (const line of lines) {
      // A word longer than the budget is the documented exception; nothing here
      // is.
      expect(line.length).toBeLessThanOrEqual(12);
    }
  });

  it("leaves an over-long word on its own line rather than hyphenating it", () => {
    // Truncating changes what the headline says and hyphenating reads as a
    // rendering bug at 320px, so the line is allowed to overflow visibly.
    expect(wrap("SHORT INDISTINGUISHABLE", 10)).toEqual([
      "SHORT",
      "INDISTINGUISHABLE",
    ]);
  });

  it("returns no lines for empty text, so the layout has nothing to size", () => {
    expect(wrap("", 20)).toEqual([]);
    expect(wrap("   ", 20)).toEqual([]);
  });
});

describe("normaliseHeadline", () => {
  it("upper-cases, because the design uses caps as typography", () => {
    // The prompt forbids the model from shouting — asking a model for ALL CAPS
    // also gets ALL CAPS punctuation.
    expect(normaliseHeadline("the cost of waiting")).toBe("THE COST OF WAITING");
  });

  it("strips newlines, which are the line separator in the text file", () => {
    // A headline containing one would break the computed layout: the file's line
    // count is what `layoutFor` sized the scrim against.
    expect(normaliseHeadline("two\nlines")).toBe("TWO LINES");
    expect(normaliseHeadline("tab\there")).toBe("TAB HERE");
  });

  it("collapses runs of whitespace", () => {
    expect(normaliseHeadline("  spaced    out  ")).toBe("SPACED OUT");
  });

  it("keeps punctuation that carries meaning", () => {
    // These are exactly the characters that would break an inline `text=`
    // argument, which is why the compositor writes a text file instead of
    // stripping them.
    expect(normaliseHeadline("it's 40%: a:b")).toBe("IT'S 40%: A:B");
  });

  it("returns empty for whitespace only, which the caller refuses", () => {
    expect(normaliseHeadline("   \n\t ")).toBe("");
  });
});

describe("normaliseSubline", () => {
  it("keeps its casing, because a subline is a sentence", () => {
    expect(normaliseSubline("What most people get wrong")).toBe(
      "What most people get wrong",
    );
  });

  it("collapses whitespace like the headline does", () => {
    expect(normaliseSubline(" a\nb\tc ")).toBe("a b c");
  });
});

describe("layoutFor", () => {
  it("bottom-anchors the scrim", () => {
    const layout = layoutFor(1, 0);
    expect(layout.scrimY + layout.scrimHeight).toBe(THUMBNAIL_HEIGHT);
  });

  it("keeps a single-line headline inside the frame", () => {
    const layout = layoutFor(1, 0);
    expect(layout.headlineY).toBeGreaterThan(0);
    expect(layout.headlineY).toBeLessThan(THUMBNAIL_HEIGHT);
    expect(layout.sublineY).toBeNull();
  });

  it("grows the scrim with the text it has to cover", () => {
    // A one-line headline under a full-height scrim looks like a mistake; a
    // three-line headline over a short one is unreadable.
    const one = layoutFor(1, 0);
    const three = layoutFor(3, 0);
    expect(three.scrimHeight).toBeGreaterThan(one.scrimHeight);
    expect(three.scrimY).toBeLessThan(one.scrimY);
  });

  it("places the subline below the headline block", () => {
    const layout = layoutFor(2, 1);
    expect(layout.sublineY).not.toBeNull();
    expect(layout.sublineY!).toBeGreaterThan(layout.headlineY);
  });

  it("starts the text inside the scrim, not above it", () => {
    for (const headlineLines of [1, 2, 3]) {
      for (const sublineLines of [0, 1, 2]) {
        const layout = layoutFor(headlineLines, sublineLines);
        expect(layout.headlineY).toBeGreaterThanOrEqual(layout.scrimY);
      }
    }
  });

  it("never lets the scrim exceed the frame, however much text there is", () => {
    // A pathological headline must produce a clamped scrim rather than a
    // `drawbox` taller than the image, which ffmpeg rejects.
    const layout = layoutFor(9, 4);
    expect(layout.scrimHeight).toBeLessThanOrEqual(THUMBNAIL_HEIGHT);
    expect(layout.scrimY).toBeGreaterThanOrEqual(0);
  });
});

describe("filterGraph", () => {
  const base = {
    hasSubline: false,
    layout: layoutFor(2, 0),
    accent: "0xE8332B",
  };

  it("scales and crops rather than padding", () => {
    const graph = filterGraph(base);
    // Black bars are worse than losing a little off the sides, and stock frames
    // are usually 16:9 so the crop is a no-op in the common case.
    expect(graph).toContain(
      `scale=${THUMBNAIL_WIDTH}:${THUMBNAIL_HEIGHT}:force_original_aspect_ratio=increase`,
    );
    expect(graph).toContain(`crop=${THUMBNAIL_WIDTH}:${THUMBNAIL_HEIGHT}`);
    expect(graph).not.toContain("pad=");
  });

  it("draws the scrim before the text, so the text is on top", () => {
    const graph = filterGraph(base);
    expect(graph.indexOf("drawbox=")).toBeLessThan(graph.indexOf("drawtext="));
  });

  /**
   * The load-bearing assertion of the whole module. `textfile=` plus
   * `expansion=none` is what makes a model-written headline *data*: an inline
   * `text=` would let a colon, quote, percent or backslash change the meaning of
   * the filter argument, and `%{...}` is drawtext's own expansion syntax.
   */
  it("reads text from a file with expansion disabled", () => {
    const graph = filterGraph(base);
    expect(graph).toContain("expansion=none");
    expect(graph).toContain("textfile=headline.txt");
    // No inline `text=`. Matched with a boundary so `drawtext=` does not count.
    expect(graph).not.toMatch(/(^|[:,])text=/);
  });

  /**
   * The escaping fix, asserted as an absence. Measured against ffmpeg 6.0, no
   * escaping of a full path works in every position — a colon needs one backslash
   * inside quotes and two outside, and a comma or apostrophe in the path (an
   * ordinary Windows temp path has both) cannot be escaped at all. So the graph
   * names files the compositor chose, relative to the directory ffmpeg is spawned
   * in, and contains nothing that needs escaping.
   */
  it("names bare files, so no path can be mis-parsed", () => {
    const graph = filterGraph({ ...base, hasSubline: true, layout: layoutFor(2, 1) });

    expect(graph).toContain("fontfile=headline-font");
    expect(graph).toContain("fontfile=body-font");
    expect(graph).toContain("textfile=subline.txt");

    // No drive letters, no absolute paths, no backslashes, no quotes — the
    // characters whose handling differs between filter contexts.
    expect(graph).not.toMatch(/[A-Za-z]:\//);
    expect(graph).not.toContain("\\");
    expect(graph).not.toContain("'");
  });

  it("omits the subline entirely when there is none", () => {
    const graph = filterGraph(base);
    expect(graph.match(/drawtext=/g)).toHaveLength(1);
    // Not merely absent from the graph: the compositor also skips writing the file
    // and copying the body font, so a stale name here would be a missing file.
    expect(graph).not.toContain("subline.txt");
    expect(graph).not.toContain("body-font");
  });

  it("adds a second drawtext for the subline, in the accent colour", () => {
    const graph = filterGraph({
      ...base,
      hasSubline: true,
      layout: layoutFor(2, 1),
      accent: "0x60A5FA",
    });

    expect(graph.match(/drawtext=/g)).toHaveLength(2);
    expect(graph).toContain("fontcolor=0x60A5FA");
  });

  it("draws the subline with the body font, not the headline face", () => {
    const graph = filterGraph({ ...base, hasSubline: true, layout: layoutFor(1, 1) });
    const [, headlinePart, sublinePart] = graph.split("drawtext=");

    expect(headlinePart).toContain("fontfile=headline-font");
    expect(sublinePart).toContain("fontfile=body-font");
  });

  it("borders the text rather than shadowing it", () => {
    // A soft shadow disappears entirely at 320px wide, which is how most viewers
    // see a thumbnail.
    const graph = filterGraph(base);
    expect(graph).toContain("borderw=");
    expect(graph).toContain("bordercolor=black@0.9");
  });

  it("joins filters with commas and produces no empty link", () => {
    const graph = filterGraph(base);
    expect(graph).not.toContain(",,");
    expect(graph.startsWith(",")).toBe(false);
    expect(graph.endsWith(",")).toBe(false);
  });
});

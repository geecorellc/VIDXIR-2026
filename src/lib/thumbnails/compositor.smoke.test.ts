/**
 * The compositor against a real encoder (§39, §42).
 *
 * `compositor.test.ts` asserts the filter graph, which catches a misspelled option
 * and costs milliseconds. It cannot catch the failure that actually matters here: a
 * graph that is perfectly well-formed and still will not encode, because `drawtext`
 * needs a font ffmpeg can load, `drawbox` rejects a box taller than the frame, and
 * a headline containing a colon or a quote can turn a valid filter into a different
 * one. So this file runs the production `composite()` and then parses the result as
 * a JPEG by hand.
 *
 * Parsing rather than trusting the exit code: asking ffmpeg whether ffmpeg produced
 * valid output is circular, and `ffmpeg-static` ships no ffprobe to ask instead.
 *
 * Skipped — not failed — when no font or no binary is available. That is the
 * `not_configured` state §48 defines, and there is nothing to assert about a
 * compositor that correctly reports it is unavailable. When both are present every
 * case below runs and must pass.
 */
import { describe, expect, it } from "vitest";
import { solidPng } from "@/lib/media/synthetic";
import {
  MAX_THUMBNAIL_BYTES,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_WIDTH,
  composite,
  isCompositorConfigured,
} from "@/lib/thumbnails/compositor";

/** A real encode plus four ffmpeg spawns is seconds, not the unit default of 5s. */
const ENCODE_TIMEOUT_MS = 90_000;

const suite = isCompositorConfigured() ? describe : describe.skip;

function background(seed: string) {
  // Not 1280x720: the scale+crop path should be exercised, not skipped.
  return solidPng({ width: 1600, height: 900, seed });
}

/**
 * Decode a JPEG's SOF0/SOF2 frame header to get the real dimensions.
 *
 * The marker walk is the point. A file that merely starts with FFD8 and is
 * non-empty proves nothing — a truncated encode looks exactly like that — whereas
 * finding a start-of-frame with sensible dimensions and a terminating EOI proves
 * an encoder actually finished.
 */
function jpegSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xd8);

  let offset = 2;
  while (offset < bytes.byteLength - 1) {
    if (bytes[offset] !== 0xff) {
      throw new Error(`expected a marker at ${offset}, found 0x${bytes[offset]?.toString(16)}`);
    }

    const marker = bytes[offset + 1]!;
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9) break;

    const length = bytes.readUInt16BE(offset + 2);

    // SOF0 baseline, SOF1 extended, SOF2 progressive.
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }

    // SOS: entropy-coded data follows, which is not marker-structured.
    if (marker === 0xda) break;

    offset += 2 + length;
  }

  throw new Error("no start-of-frame marker found");
}

suite("composite", () => {
  it(
    "produces a real JPEG at YouTube's dimensions",
    async () => {
      const result = await composite({
        background: background("plain"),
        backgroundExtension: "png",
        headline: "The cheapest fix",
        subline: "And why nobody tries it first",
        emotion: "curiosity",
      });

      expect(result.mimeType).toBe("image/jpeg");
      expect(result.extension).toBe("jpg");
      expect(jpegSize(result.bytes)).toEqual({
        width: THUMBNAIL_WIDTH,
        height: THUMBNAIL_HEIGHT,
      });
      // Terminated, so the encode finished rather than being killed mid-write.
      expect(result.bytes.subarray(-2).toString("hex")).toBe("ffd9");
      expect(result.bytes.byteLength).toBeLessThanOrEqual(MAX_THUMBNAIL_BYTES);
      // Recorded for provenance: a thumbnail that looks wrong is traceable to the
      // face that drew it rather than guessed at.
      expect(result.fonts.headline).toBeTruthy();
    },
    ENCODE_TIMEOUT_MS,
  );

  /**
   * The reason `textfile=` + `expansion=none` exists. Every character here changes
   * the meaning of an inline `text=` argument: `:` separates options, `'` quotes
   * one, `\` escapes, and `%{...}` is drawtext's own expansion syntax — which
   * would let model-written text execute a filter directive.
   */
  it(
    "renders text containing filter metacharacters as data",
    async () => {
      const result = await composite({
        background: background("hostile"),
        backgroundExtension: "png",
        headline: "it's 40%: a:b \\ 'quoted'",
        subline: "%{pts} : {expansion} 'test' \\",
        emotion: "urgency",
      });

      expect(jpegSize(result.bytes).width).toBe(THUMBNAIL_WIDTH);
    },
    ENCODE_TIMEOUT_MS,
  );

  it(
    "composites a headline long enough to wrap onto several lines",
    async () => {
      // The scrim grows with the line count, and a mis-sized `drawbox` taller than
      // the frame is rejected by ffmpeg rather than clamped.
      const result = await composite({
        background: background("wrapping"),
        backgroundExtension: "png",
        headline: "Everything wrong with the bench",
        subline: null,
        emotion: "concern",
      });

      expect(jpegSize(result.bytes)).toEqual({
        width: THUMBNAIL_WIDTH,
        height: THUMBNAIL_HEIGHT,
      });
    },
    ENCODE_TIMEOUT_MS,
  );

  it(
    "refuses a concept with no headline text rather than encoding a bare frame",
    async () => {
      // Not retryable, and not a silent success: a thumbnail with no text is not a
      // thumbnail, and re-running ffmpeg with the same empty string cannot help.
      await expect(
        composite({
          background: background("empty"),
          backgroundExtension: "png",
          headline: "   \n  ",
          subline: null,
          emotion: "delight",
        }),
      ).rejects.toMatchObject({ retryable: false });
    },
    ENCODE_TIMEOUT_MS,
  );

  it(
    "fails on an undecodable background instead of returning a blank image",
    async () => {
      await expect(
        composite({
          background: Buffer.from("this is not an image"),
          backgroundExtension: "png",
          headline: "Should not render",
          subline: null,
          emotion: "surprise",
        }),
      ).rejects.toMatchObject({ retryable: false });
    },
    ENCODE_TIMEOUT_MS,
  );
});

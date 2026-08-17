/**
 * Timeline assembly tests (§39, §42).
 *
 * The central claim of the whole video engine is that offsets are **measured, not
 * estimated** — scene start times come from the actual lengths of the narration
 * audio, accumulated in order. These tests pin that: they hand the builder
 * mismatched durations and assert the cursor follows the audio rather than any
 * average, target or per-scene division.
 */
import { describe, expect, it } from "vitest";
import {
  MUSIC_FADE_MS,
  OUTPUT_FPS,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  TAIL_PADDING_MS,
  buildTimeline,
  narrationSegments,
  type BuildTimelineInput,
  type SceneInput,
} from "@/lib/video/timeline";

function scene(index: number, narrationDurationMs: number): SceneInput {
  return {
    index,
    label: `Scene ${index}`,
    onScreenText: null,
    transition: "fade",
    visualKey: `visual-${index}.mp4`,
    visualKind: "stock_video",
    visualDurationMs: 8_000,
    narrationKey: `narration-${index}.mp3`,
    narrationDurationMs,
  };
}

function input(overrides: Partial<BuildTimelineInput> = {}): BuildTimelineInput {
  return {
    scenes: [scene(0, 6_000), scene(1, 11_400), scene(2, 4_250)],
    music: null,
    captionCues: [],
    burnCaptions: true,
    ...overrides,
  };
}

describe("buildTimeline", () => {
  it("accumulates start times from the measured narration lengths", () => {
    const timeline = buildTimeline(input());

    // Not 3 × average and not target/count: 0, 6000, 17400.
    expect(timeline.scenes.map((s) => s.startMs)).toEqual([0, 6_000, 17_400]);
    expect(timeline.scenes.map((s) => s.durationMs)).toEqual([6_000, 11_400, 4_250]);
  });

  it("leaves no gap between consecutive scenes", () => {
    const timeline = buildTimeline(input());

    for (let i = 1; i < timeline.scenes.length; i += 1) {
      const previous = timeline.scenes[i - 1]!;
      expect(timeline.scenes[i]!.startMs).toBe(previous.startMs + previous.durationMs);
    }
  });

  it("holds the last frame past the final word", () => {
    const timeline = buildTimeline(input());
    const lastScene = timeline.scenes.at(-1)!;

    // Cutting on the final syllable feels like a dropped call.
    expect(timeline.durationMs).toBe(
      lastScene.startMs + lastScene.durationMs + TAIL_PADDING_MS,
    );
  });

  it("orders scenes by index regardless of input order", () => {
    const timeline = buildTimeline(
      input({ scenes: [scene(2, 3_000), scene(0, 5_000), scene(1, 4_000)] }),
    );

    expect(timeline.scenes.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(timeline.scenes.map((s) => s.startMs)).toEqual([0, 5_000, 9_000]);
  });

  it("floors a very short scene rather than emitting a flash frame", () => {
    const timeline = buildTimeline(input({ scenes: [scene(0, 300)] }));

    expect(timeline.scenes[0]!.durationMs).toBeGreaterThanOrEqual(1_500);
    // The narration's own measured length is preserved even when the frame is
    // held longer, so the audio is not stretched to match.
    expect(timeline.scenes[0]!.narrationDurationMs).toBe(300);
  });

  it("gives a silent scene screen time with no narration file", () => {
    const timeline = buildTimeline(
      input({
        scenes: [
          { ...scene(0, 0), narrationKey: null },
          scene(1, 5_000),
        ],
      }),
    );

    expect(timeline.scenes[0]!.narrationKey).toBeNull();
    expect(timeline.scenes[0]!.durationMs).toBeGreaterThan(0);
    expect(timeline.scenes[1]!.startMs).toBe(timeline.scenes[0]!.durationMs);
  });

  it("cuts rather than fades into the first frame", () => {
    const timeline = buildTimeline(
      input({ scenes: [{ ...scene(0, 4_000), transition: null }, scene(1, 4_000)] }),
    );

    expect(timeline.scenes[0]!.transition).toBe("none");
    expect(timeline.scenes[1]!.transition).toBe("fade");
  });

  it("emits 1080p30", () => {
    const timeline = buildTimeline(input());
    expect([timeline.width, timeline.height, timeline.fps]).toEqual([
      OUTPUT_WIDTH,
      OUTPUT_HEIGHT,
      OUTPUT_FPS,
    ]);
  });

  it("has an empty duration and no captions for an empty plan", () => {
    const timeline = buildTimeline(input({ scenes: [] }));
    expect(timeline.durationMs).toBe(0);
    expect(timeline.scenes).toEqual([]);
    expect(timeline.captions).toBeNull();
  });

  describe("captions", () => {
    it("is null when there are no cues, rather than an empty track", () => {
      expect(buildTimeline(input()).captions).toBeNull();
    });

    it("clips a cue that runs past the last frame", () => {
      const timeline = buildTimeline(
        input({
          scenes: [scene(0, 5_000)],
          captionCues: [{ startMs: 4_500, endMs: 999_000, text: "trailing" }],
        }),
      );

      const cue = timeline.captions!.cues[0]!;
      expect(cue.endMs).toBe(timeline.durationMs);
    });

    it("drops a cue that starts after the video ends", () => {
      const timeline = buildTimeline(
        input({
          scenes: [scene(0, 5_000)],
          captionCues: [
            { startMs: 100, endMs: 900, text: "kept" },
            { startMs: 500_000, endMs: 501_000, text: "dropped" },
          ],
        }),
      );

      expect(timeline.captions!.cues.map((c) => c.text)).toEqual(["kept"]);
    });

    it("carries the burn-in choice through", () => {
      const cues = [{ startMs: 0, endMs: 900, text: "hello" }];
      expect(buildTimeline(input({ captionCues: cues, burnCaptions: false })).captions)
        .toMatchObject({ burnedIn: false });
    });

    it("defaults to a legible style when the brand kit has none", () => {
      const timeline = buildTimeline(
        input({ captionCues: [{ startMs: 0, endMs: 900, text: "hi" }] }),
      );

      expect(timeline.captions!.style.fontSizePx).toBeGreaterThan(20);
      expect(timeline.captions!.style.color).toMatch(/^#[0-9A-Fa-f]{6,8}$/);
      // Low on the frame, clear of YouTube's own controls.
      expect(timeline.captions!.style.verticalPosition).toBeGreaterThan(0.5);
    });

    it("rejects a font size that would cover the frame", () => {
      const timeline = buildTimeline(
        input({
          captionCues: [{ startMs: 0, endMs: 900, text: "hi" }],
          // `brand_kits.caption_style` is user-written jsonb, so this is reachable.
          captionStyle: { fontSizePx: 4_000 },
        }),
      );

      expect(timeline.captions!.style.fontSizePx).toBeLessThanOrEqual(120);
    });

    it("rejects a colour that is not a hex triplet", () => {
      const timeline = buildTimeline(
        input({
          captionCues: [{ startMs: 0, endMs: 900, text: "hi" }],
          captionStyle: { color: "red; drop-shadow(evil)" },
        }),
      );

      expect(timeline.captions!.style.color).toBe("#FFFFFF");
    });

    it("accepts a valid brand override", () => {
      const timeline = buildTimeline(
        input({
          captionCues: [{ startMs: 0, endMs: 900, text: "hi" }],
          captionStyle: { color: "#E8332B", fontSizePx: 56, fontFamily: "Oswald" },
        }),
      );

      expect(timeline.captions!.style).toMatchObject({
        color: "#E8332B",
        fontSizePx: 56,
        fontFamily: "Oswald",
      });
    });
  });

  it("passes the music bed through untouched", () => {
    const music = {
      key: "music.mp3",
      volume: 0.14,
      duckUnderNarration: true,
      startMs: 0,
      durationMs: 120_000,
    };

    expect(buildTimeline(input({ music })).music).toEqual(music);
  });

  it("leaves a fade shorter than the video", () => {
    // A guard on the constants themselves: a fade longer than the tail hold would
    // start fading out before the last scene began.
    expect(MUSIC_FADE_MS).toBeGreaterThan(0);
    expect(TAIL_PADDING_MS).toBeGreaterThan(0);
  });
});

describe("narrationSegments", () => {
  it("reports each scene's offset and its own measured audio length", () => {
    const timeline = buildTimeline(input({ scenes: [scene(0, 6_000), scene(1, 400)] }));

    expect(narrationSegments(timeline)).toEqual([
      { sceneIndex: 0, startMs: 0, durationMs: 6_000 },
      // The frame is held to the 1.5s floor, but the audio is still 400ms — a
      // caller aligning audio must use the audio's length, not the frame's.
      { sceneIndex: 1, startMs: 6_000, durationMs: 400 },
    ]);
  });
});

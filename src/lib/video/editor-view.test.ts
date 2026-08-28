/**
 * Tests for the editor's view geometry.
 *
 * `frameAt` carries most of the weight, because it is the function that makes "preview and
 * export represent the same edit document" true rather than aspirational. If it picked a
 * different visual than the compiler's stacking order does, or read a different part of a
 * source file than `sourceInMs` says, the preview would be a second renderer with its own
 * opinions — which is the outcome this architecture exists to prevent.
 *
 * The clip lists here come from `compileEditDocument` rather than being hand-written, so
 * the layers, gains and windows under test are the real ones the export uses.
 */

import { describe, expect, it } from "vitest";
import {
  compileEditDocument,
  type EditClip,
  type EditDocument,
  type EditTrack,
  type TrackKind,
} from "@/lib/video/edit-document";
import {
  DEFAULT_ZOOM_INDEX,
  frameAt,
  msToPx,
  orderedTracks,
  previewAspect,
  pxToMs,
  rulerTicks,
  snap,
  snapTargets,
  sourceTimeMs,
  tickStepMs,
  timecode,
  timelineSpanMs,
  trackLabel,
  ZOOM_LEVELS,
  zoomAt,
} from "@/lib/video/editor-view";

const ASSET = "11111111-1111-4111-8111-111111111111";

function clip(overrides: Partial<EditClip> & { id: string }): EditClip {
  return {
    startMs: 0,
    durationMs: 2_000,
    sourceInMs: null,
    sourceOutMs: null,
    volume: 1,
    text: null,
    label: null,
    transition: null,
    source: null,
    sceneIndex: null,
    ...overrides,
  };
}

function mediaClip(
  overrides: Partial<EditClip> & { id: string },
  key = "projects/p/video/a.mp4",
  sourceDurationMs: number | null = 10_000,
): EditClip {
  return clip({
    source: { assetId: ASSET, storageKey: key, kind: "generated_video", sourceDurationMs },
    ...overrides,
  });
}

function track(
  id: string,
  kind: TrackKind,
  clips: EditClip[],
  overrides: Partial<EditTrack> = {},
): EditTrack {
  return {
    id,
    kind,
    label: null,
    order: 0,
    muted: false,
    hidden: false,
    volume: 1,
    clips,
    ...overrides,
  };
}

function document(tracks: EditTrack[]): EditDocument {
  return {
    schemaVersion: 1,
    format: "portrait",
    tracks,
    captions: {
      burnedIn: true,
      style: {
        fontFamily: "Inter",
        fontSizePx: 48,
        color: "#ffffff",
        backgroundColor: null,
        verticalPosition: 0.8,
      },
    },
    music: { duckUnderNarration: true },
    brand: { primaryColor: null, secondaryColor: null, fontPreference: null },
  };
}

// ---------------------------------------------------------------------------
// Zoom and coordinates
// ---------------------------------------------------------------------------

describe("zoom", () => {
  it("clamps out-of-range indices to the ladder", () => {
    expect(zoomAt(-5)).toBe(ZOOM_LEVELS[0]);
    expect(zoomAt(999)).toBe(ZOOM_LEVELS[ZOOM_LEVELS.length - 1]);
    expect(zoomAt(DEFAULT_ZOOM_INDEX)).toBe(ZOOM_LEVELS[DEFAULT_ZOOM_INDEX]);
  });

  it("round-trips milliseconds through pixels", () => {
    const pxPerMs = zoomAt(DEFAULT_ZOOM_INDEX);
    expect(pxToMs(msToPx(5_000, pxPerMs), pxPerMs)).toBe(5_000);
  });

  it("treats a zero scale as the origin rather than dividing by it", () => {
    expect(pxToMs(400, 0)).toBe(0);
  });
});

describe("timelineSpanMs", () => {
  it("leaves room past the last clip so it can still be dragged later", () => {
    const doc = document([
      track("v", "video", [mediaClip({ id: "a", startMs: 0, durationMs: 30_000 })]),
    ]);
    expect(timelineSpanMs(doc)).toBeGreaterThan(30_000);
  });

  it("has a floor for an empty cut, so the ruler is never zero-width", () => {
    expect(timelineSpanMs(document([track("v", "video", [])]))).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// Ruler
// ---------------------------------------------------------------------------

describe("ruler", () => {
  it("chooses a coarser step as the view zooms out", () => {
    const fine = tickStepMs(ZOOM_LEVELS[ZOOM_LEVELS.length - 1] ?? 0.4);
    const coarse = tickStepMs(ZOOM_LEVELS[0] ?? 0.01);
    expect(coarse).toBeGreaterThan(fine);
  });

  it("never labels ticks closer together than the collision threshold", () => {
    for (const pxPerMs of ZOOM_LEVELS) {
      // The coarsest step is the fallback and can be narrower than the threshold at the
      // widest zoom; every other choice must clear it.
      const step = tickStepMs(pxPerMs);
      if (step !== 60_000) expect(step * pxPerMs).toBeGreaterThanOrEqual(68);
    }
  });

  it("starts at zero and stays within the span", () => {
    const ticks = rulerTicks(20_000, 0.04);
    expect(ticks[0]).toBe(0);
    expect(Math.max(...ticks)).toBeLessThanOrEqual(20_000);
  });
});

describe("timecode", () => {
  it("shows hundredths, so a sub-second trim is visible", () => {
    expect(timecode(64_300)).toBe("1:04.30");
    expect(timecode(0)).toBe("0:00.00");
    expect(timecode(999)).toBe("0:00.99");
  });

  it("does not render a negative or non-finite playhead", () => {
    expect(timecode(-500)).toBe("0:00.00");
    expect(timecode(Number.NaN)).toBe("0:00.00");
  });
});

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

describe("snapping", () => {
  const doc = document([
    track("v", "video", [
      mediaClip({ id: "a", startMs: 0, durationMs: 2_000 }),
      mediaClip({ id: "b", startMs: 5_000, durationMs: 2_000 }),
    ]),
  ]);

  it("offers clip edges, zero and the playhead but not the dragged clip's own edges", () => {
    const targets = snapTargets(doc, 3_300, "a");

    expect(targets).toContain(0);
    expect(targets).toContain(3_300);
    expect(targets).toContain(5_000);
    expect(targets).toContain(7_000);
    // `a` runs 0..2000; 2000 must not be offered, or it could never be dragged off it.
    expect(targets).not.toContain(2_000);
  });

  it("pulls a near miss onto the edge", () => {
    const pxPerMs = 0.04; // 7px tolerance ≈ 175ms
    expect(snap(4_900, [5_000], pxPerMs)).toBe(5_000);
  });

  it("leaves a distant value alone", () => {
    expect(snap(3_000, [5_000], 0.04)).toBe(3_000);
  });

  it("snaps by the trailing edge too, so a clip can be butted against the next one", () => {
    // A 2s clip dragged to 2960 has its tail at 4960 — 40ms short of the edge at 5000.
    // Snapping the tail puts the clip at 3000, which is the alignment the user aimed for.
    expect(snap(2_960, [5_000], 0.04, 2_000)).toBe(3_000);
  });

  it("never snaps to a negative start", () => {
    expect(snap(50, [0], 0.04, 2_000)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

describe("lanes", () => {
  it("orders picture above sound and keeps the compiler's stacking sense", () => {
    const doc = document([
      track("m", "music", []),
      track("c", "caption", []),
      track("v", "video", []),
      track("vo", "voiceover", []),
    ]);

    expect(orderedTracks(doc).map((t) => t.kind)).toEqual([
      "video",
      "caption",
      "voiceover",
      "music",
    ]);
  });

  it("falls back to the kind when a track has no label", () => {
    expect(trackLabel("voiceover", null)).toBe("Voiceover");
    expect(trackLabel("voiceover", "Narration A")).toBe("Narration A");
  });
});

// ---------------------------------------------------------------------------
// frameAt — the preview/export agreement
// ---------------------------------------------------------------------------

describe("frameAt", () => {
  function compiled(doc: EditDocument) {
    return compileEditDocument(doc).clips;
  }

  it("shows the clip covering the moment and nothing at a gap", () => {
    const clips = compiled(
      document([
        track("v", "video", [
          mediaClip({ id: "a", startMs: 0, durationMs: 2_000 }, "a.mp4"),
          mediaClip({ id: "b", startMs: 4_000, durationMs: 2_000 }, "b.mp4"),
        ]),
      ]),
    );

    expect(frameAt(clips, 1_000).visual?.storageKey).toBe("a.mp4");
    expect(frameAt(clips, 5_000).visual?.storageKey).toBe("b.mp4");
    expect(frameAt(clips, 3_000).visual).toBeNull();
  });

  it("shows exactly one visual at a cut", () => {
    const clips = compiled(
      document([
        track("v", "video", [
          mediaClip({ id: "a", startMs: 0, durationMs: 2_000 }, "a.mp4"),
          mediaClip({ id: "b", startMs: 2_000, durationMs: 2_000 }, "b.mp4"),
        ]),
      ]),
    );

    // Half-open intervals: at the boundary the outgoing clip is already gone. Anything
    // else would flash both shots for a frame at every cut.
    expect(frameAt(clips, 2_000).visual?.storageKey).toBe("b.mp4");
  });

  it("prefers the topmost visual, matching the compiler's stacking", () => {
    const clips = compiled(
      document([
        track("v", "video", [mediaClip({ id: "a", startMs: 0, durationMs: 4_000 }, "under.mp4")]),
        track("v2", "image", [mediaClip({ id: "b", startMs: 1_000, durationMs: 1_000 }, "over.mp4")], {
          order: 5,
        }),
      ]),
    );

    expect(frameAt(clips, 500).visual?.storageKey).toBe("under.mp4");
    expect(frameAt(clips, 1_500).visual?.storageKey).toBe("over.mp4");
  });

  it("leaves a hidden track out of the frame", () => {
    const clips = compiled(
      document([
        track("v", "video", [mediaClip({ id: "a", startMs: 0, durationMs: 4_000 })], {
          hidden: true,
        }),
      ]),
    );

    expect(frameAt(clips, 1_000).visual).toBeNull();
  });

  it("plays narration and music together", () => {
    const clips = compiled(
      document([
        track("vo", "voiceover", [mediaClip({ id: "n", startMs: 0, durationMs: 4_000 }, "vo.mp3")]),
        track("m", "music", [mediaClip({ id: "m", startMs: 0, durationMs: 8_000 }, "m.mp3")]),
      ]),
    );

    const frame = frameAt(clips, 1_000);
    expect(frame.audio.map((a) => a.storageKey).sort()).toEqual(["m.mp3", "vo.mp3"]);
  });

  it("reports a muted track at zero gain rather than dropping it", () => {
    const clips = compiled(
      document([
        track("m", "music", [mediaClip({ id: "m", startMs: 0, durationMs: 4_000 }, "m.mp3")], {
          muted: true,
        }),
      ]),
    );

    // Still on the timeline and still selectable — silence, not absence, which is what
    // the compiler exports too.
    expect(frameAt(clips, 1_000).audio[0]?.gain).toBe(0);
  });

  it("multiplies track and clip gain, as the export does", () => {
    const clips = compiled(
      document([
        track(
          "vo",
          "voiceover",
          [mediaClip({ id: "n", startMs: 0, durationMs: 4_000, volume: 0.5 }, "vo.mp3")],
          { volume: 0.5 },
        ),
      ]),
    );

    expect(frameAt(clips, 1_000).audio[0]?.gain).toBeCloseTo(0.25);
  });

  it("surfaces text and captions at the moment they cover", () => {
    const clips = compiled(
      document([
        // A visual is needed for the compiler to give the cut a duration, which is what
        // its cue clipping measures against.
        track("v", "video", [mediaClip({ id: "a", startMs: 0, durationMs: 6_000 })]),
        track("t", "text", [clip({ id: "t1", startMs: 500, durationMs: 2_000, text: "Hook" })]),
        track("c", "caption", [
          clip({ id: "c1", startMs: 0, durationMs: 1_000, text: "first line" }),
          clip({ id: "c2", startMs: 1_000, durationMs: 1_000, text: "second line" }),
        ]),
      ]),
    );

    expect(frameAt(clips, 700).texts).toEqual(["Hook"]);
    expect(frameAt(clips, 700).caption).toBe("first line");
    expect(frameAt(clips, 1_200).caption).toBe("second line");
    expect(frameAt(clips, 5_000).caption).toBeNull();
  });

  it("seeks into the source window rather than the clip's own start", () => {
    const clips = compiled(
      document([
        track("v", "video", [
          mediaClip({
            id: "a",
            startMs: 4_000,
            durationMs: 2_000,
            sourceInMs: 3_000,
            sourceOutMs: 5_000,
          }),
        ]),
      ]),
    );

    // One second into a clip that starts 3s into its file: 4s into the file, not 1s.
    expect(frameAt(clips, 5_000).visual?.sourceTimeSeconds).toBe(4);
  });

  it("freezes on the last frame of a window held longer than its material", () => {
    const held = compileEditDocument(
      document([
        track("v", "video", [
          mediaClip({
            id: "a",
            startMs: 0,
            durationMs: 5_000,
            sourceInMs: 0,
            sourceOutMs: 3_000,
          }),
        ]),
      ]),
    ).clips;

    const target = held[0];
    expect(target).toBeDefined();
    if (!target) return;
    // A 3s window held for 5s is legal, and the renderer holds the frame. Reading past
    // the window would show material the export does not contain.
    expect(sourceTimeMs(target, 4_500)).toBe(3_000);
  });

  it("marks a still as not time-based, so the preview does not try to seek it", () => {
    const clips = compiled(
      document([
        track("i", "image", [
          mediaClip({ id: "a", startMs: 0, durationMs: 3_000 }, "still.jpg", null),
        ]),
      ]),
    );

    expect(frameAt(clips, 1_000).visual?.timeBased).toBe(false);
  });
});

describe("previewAspect", () => {
  it("follows the document's format, not the source footage", () => {
    expect(previewAspect("portrait")).toBe("9 / 16");
    expect(previewAspect("landscape")).toBe("16 / 9");
    expect(previewAspect("square")).toBe("1 / 1");
  });
});

/**
 * Tests for the preview's gain reproduction.
 *
 * The property that matters is the one the component depends on and cannot assert for
 * itself without a browser: `elementVolume * boost` is the gain the document asked for, and
 * `elementVolume` alone — what plays if the Web Audio path is unavailable — is never
 * louder than a media element can legally be set to. Everything else here guards the
 * gating: a cut with no boosted clip must not cause an `AudioContext` or a `crossOrigin`
 * attribute to appear, because both can only make an ordinary preview worse.
 *
 * Documents are compiled through the real compiler rather than hand-written, so the gain
 * values under test are the same track×clip products the preview receives.
 */

import { describe, expect, it } from "vitest";
import {
  compileEditDocument,
  type EditClip,
  type EditDocument,
  type EditTrack,
} from "@/lib/video/edit-document";
import { parseEditDocument } from "@/lib/video/edit-document";
import {
  boostNotice,
  cutNeedsBoost,
  MAX_ELEMENT_VOLUME,
  MAX_GAIN,
  needsBoost,
  splitGain,
} from "@/lib/video/preview-audio";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function audioClip(id: string, startMs: number, volume: number): EditClip {
  return {
    id,
    startMs,
    durationMs: 2_000,
    sourceInMs: null,
    sourceOutMs: null,
    volume,
    text: null,
    label: null,
    transition: null,
    source: {
      assetId: "11111111-1111-4111-8111-111111111111",
      storageKey: `audio/${id}.mp3`,
      kind: null,
      sourceDurationMs: 10_000,
    },
    sceneIndex: null,
  };
}

function documentWith(options: {
  clipVolume: number;
  trackVolume?: number;
  hidden?: boolean;
  muted?: boolean;
}): EditDocument {
  const track: EditTrack = {
    id: "t-vo",
    kind: "voiceover",
    label: null,
    order: 0,
    muted: options.muted ?? false,
    hidden: options.hidden ?? false,
    volume: options.trackVolume ?? 1,
    clips: [audioClip("c1", 0, options.clipVolume)],
  };

  return {
    schemaVersion: 1,
    format: "landscape",
    tracks: [track],
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

const compiledClips = (doc: EditDocument) => compileEditDocument(doc).clips;

// ---------------------------------------------------------------------------

describe("splitGain", () => {
  it("reproduces the requested gain exactly", () => {
    // The whole contract: whatever the split, the two factors multiply back.
    for (const gain of [0, 0.25, 0.5, 1, 1.0001, 1.4, 1.75, 2]) {
      const { elementVolume, boost } = splitGain(gain);
      expect(elementVolume * boost, `gain ${gain}`).toBeCloseTo(gain, 10);
    }
  });

  it("never asks a media element for a volume it would reject", () => {
    // `HTMLMediaElement.volume` throws outside [0, 1] in some engines and clamps in
    // others; either way, only a legal value may ever be assigned.
    for (const gain of [-1, 0, 0.5, 1, 1.9, 2, 5, Number.POSITIVE_INFINITY, Number.NaN]) {
      const { elementVolume } = splitGain(gain);
      expect(elementVolume).toBeGreaterThanOrEqual(0);
      expect(elementVolume).toBeLessThanOrEqual(MAX_ELEMENT_VOLUME);
    }
  });

  it("degrades to the old clamped behaviour when the boost is not applied", () => {
    // What plays if Web Audio is unavailable. It must be the previous behaviour —
    // min(1, gain) — rather than silence, which is what an unrouted graph would give.
    expect(splitGain(1.8).elementVolume).toBe(1);
    expect(splitGain(0.4).elementVolume).toBe(0.4);
  });

  it("asks for no boost at or below unity, so no audio graph is built", () => {
    for (const gain of [0, 0.1, 0.9, 1]) {
      expect(splitGain(gain).boost, `gain ${gain}`).toBe(1);
      expect(needsBoost(gain)).toBe(false);
    }
    for (const gain of [1.01, 1.5, 2]) {
      expect(needsBoost(gain), `gain ${gain}`).toBe(true);
    }
  });

  it("treats a muted clip as silent rather than as a boost candidate", () => {
    // The compiler emits gain 0 for a muted or inaudible track, and 0 must stay 0 — a
    // boost node on a silent clip would make it audible.
    expect(splitGain(0)).toEqual({ elementVolume: 0, boost: 1 });
    expect(needsBoost(0)).toBe(false);
  });

  it("refuses to amplify past the document's own ceiling", () => {
    // A gain the schema would never accept cannot arrive here, but if one did, the preview
    // must not be louder than the export — which clamps at 2 in `render-edit`.
    expect(splitGain(9).boost).toBe(MAX_GAIN);
    expect(splitGain(9).elementVolume * splitGain(9).boost).toBe(MAX_GAIN);
  });

  it("survives the values that are not numbers at all", () => {
    for (const gain of [Number.NaN, Number.POSITIVE_INFINITY, -0.5]) {
      expect(splitGain(gain)).toEqual({ elementVolume: 0, boost: 1 });
    }
  });

  it("stays in step with the schema's gain ceiling", () => {
    // Pins `MAX_GAIN` to what the document actually accepts, so the two cannot drift: the
    // schema is the authority and this constant is a mirror of it.
    const doc = documentWith({ clipVolume: MAX_GAIN });
    expect(() => parseEditDocument(doc)).not.toThrow();

    const tooLoud = documentWith({ clipVolume: MAX_GAIN });
    tooLoud.tracks[0]!.clips[0]!.volume = MAX_GAIN + 0.1;
    expect(() => parseEditDocument(tooLoud)).toThrow();
  });
});

describe("cutNeedsBoost", () => {
  it("is false for an ordinary cut, so the boost path never engages", () => {
    // Every cut the pipeline seeds is in this shape. It must take no AudioContext and no
    // crossOrigin attribute — both of which can only add failure modes.
    expect(cutNeedsBoost(compiledClips(documentWith({ clipVolume: 1 })))).toBe(false);
    expect(cutNeedsBoost(compiledClips(documentWith({ clipVolume: 0.5 })))).toBe(false);
  });

  it("is true once any audible clip is boosted", () => {
    expect(cutNeedsBoost(compiledClips(documentWith({ clipVolume: 1.5 })))).toBe(true);
  });

  it("sees a boost produced by the track gain, not just the clip's", () => {
    // The compiler multiplies the two, and it is the product the element has to play.
    const doc = documentWith({ clipVolume: 0.9, trackVolume: 1.8 });
    expect(cutNeedsBoost(compiledClips(doc))).toBe(true);
  });

  it("ignores a hidden or muted track", () => {
    // Both compile to gain 0 or are left out of the frame, so there is nothing to boost
    // and no reason to build a graph.
    expect(cutNeedsBoost(compiledClips(documentWith({ clipVolume: 1.9, hidden: true })))).toBe(
      false,
    );
    expect(cutNeedsBoost(compiledClips(documentWith({ clipVolume: 1.9, muted: true })))).toBe(
      false,
    );
  });

  it("ignores visual and text clips, which carry no sound", () => {
    const doc = documentWith({ clipVolume: 1 });
    // A text track with a nonsense gain must not trigger the audio path.
    doc.tracks.push({
      id: "t-text",
      kind: "text",
      label: null,
      order: 1,
      muted: false,
      hidden: false,
      volume: 2,
      clips: [{ ...audioClip("t1", 0, 2), source: null, text: "hello" }],
    });
    expect(cutNeedsBoost(compiledClips(doc))).toBe(false);
  });
});

describe("boostNotice", () => {
  it("says nothing when there is nothing to report", () => {
    expect(boostNotice("off")).toBeNull();
  });

  it("never claims the preview matches the export when it does not", () => {
    const unavailable = boostNotice("unavailable");
    expect(unavailable).toBeTruthy();
    // The user has to learn two things: what they are hearing, and that the file differs.
    expect(unavailable).toMatch(/100%/);
    expect(unavailable).toMatch(/export/i);
  });

  it("confirms the real level when the boost is live", () => {
    expect(boostNotice("boosted")).toMatch(/real level/i);
  });
});

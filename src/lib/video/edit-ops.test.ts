/**
 * Tests for the editing operations.
 *
 * The bar these hold: **every operation produces a document the server will accept, and
 * an operation the user cannot see the effect of does not change the document.** Both
 * halves matter. The first is why nearly every test ends by re-parsing through
 * `EditDocumentSchema` — the autosave posts whatever these functions return, and a
 * document that fails validation there would surface as a 400 mid-edit rather than as a
 * refused gesture. The second is why refusals assert `toBe(document)` by identity rather
 * than merely checking that nothing looks different: returning a fresh-but-equal object
 * would make the undo stack grow on every no-op drag.
 *
 * The split tests carry the most weight, because a split is the one operation that can
 * silently change the video: two halves whose source windows do not adjoin play
 * different material than the clip they replaced, and nothing downstream would notice.
 */

import { describe, expect, it } from "vitest";
import {
  EditDocumentSchema,
  MIN_MEDIA_CLIP_MS,
  type EditClip,
  type EditDocument,
  type EditTrack,
  type TrackKind,
} from "@/lib/video/edit-document";
import {
  applyOperation,
  clipEndMs,
  contentEndMs,
  deleteClip,
  duplicateClip,
  findClip,
  moveClip,
  moveClipToTrack,
  orderedClips,
  setClipText,
  setClipVolume,
  splitClip,
  trimClipEnd,
  trimClipStart,
} from "@/lib/video/edit-ops";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

/** A clip that plays a file, which is what makes `MIN_MEDIA_CLIP_MS` apply to it. */
function mediaClip(
  overrides: Partial<EditClip> & { id: string },
  sourceDurationMs: number | null = 10_000,
): EditClip {
  return clip({
    source: {
      assetId: ASSET,
      storageKey: "projects/p/video/a.mp4",
      kind: "generated_video",
      sourceDurationMs,
    },
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

/**
 * The invariant every operation must preserve.
 *
 * Asserted through the real schema rather than by hand-checking fields, so an operation
 * that violates a rule the schema gained later fails here rather than at the API.
 */
function expectValid(value: EditDocument): EditDocument {
  const result = EditDocumentSchema.safeParse(value);
  expect(
    result.success ? null : result.error.issues.map((i) => i.message),
    "the operation must produce a document the server accepts",
  ).toBeNull();
  return value;
}

/** Two abutting 2s shots on one video track, which is the seeded shape in miniature. */
function twoShots(): EditDocument {
  return document([
    track("video-0", "video", [
      mediaClip({ id: "a", startMs: 0, durationMs: 2_000, sourceInMs: 0, sourceOutMs: 2_000 }),
      mediaClip({ id: "b", startMs: 2_000, durationMs: 2_000, sourceInMs: 0, sourceOutMs: 2_000 }),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------

describe("moveClip", () => {
  it("moves a clip into free space", () => {
    const before = document([
      track("video-0", "video", [mediaClip({ id: "a", startMs: 0, durationMs: 1_000 })]),
    ]);

    const after = expectValid(moveClip(before, "a", 5_000));

    expect(findClip(after, "a")?.clip.startMs).toBe(5_000);
    expect(before.tracks[0]?.clips[0]?.startMs, "the input is not mutated").toBe(0);
  });

  it("stops against the previous clip rather than overlapping it", () => {
    // Dragged far past its neighbour's start. A clamp is the point: the gesture should
    // feel like the clip hitting a wall, not like it refusing to move at all.
    const after = expectValid(moveClip(twoShots(), "b", 0));

    expect(findClip(after, "b")?.clip.startMs).toBe(2_000);
  });

  it("stops against the following clip", () => {
    const after = expectValid(moveClip(twoShots(), "a", 9_999));

    // `b` starts at 2000 and `a` is 2000 long, so the furthest `a` can start is 0.
    expect(findClip(after, "a")?.clip.startMs).toBe(0);
  });

  it("returns the same document when there is no room to move", () => {
    const before = twoShots();
    // `a` is pinned between 0 and `b`; any requested offset clamps back onto 0.
    expect(moveClip(before, "a", 1)).toBe(before);
  });

  it("ignores an unknown clip id", () => {
    const before = twoShots();
    expect(moveClip(before, "nope", 100)).toBe(before);
  });

  it("clamps a negative offset to the start of the timeline", () => {
    const before = document([
      track("video-0", "video", [mediaClip({ id: "a", startMs: 3_000 })]),
    ]);

    expect(expectValid(moveClip(before, "a", -9_000)).tracks[0]?.clips[0]?.startMs).toBe(0);
  });
});

describe("moveClipToTrack", () => {
  it("moves a clip between two visual tracks", () => {
    const before = document([
      track("video-0", "video", [mediaClip({ id: "a", startMs: 0, durationMs: 1_000 })]),
      track("video-1", "video", [], { order: 1 }),
    ]);

    const after = expectValid(moveClipToTrack(before, "a", "video-1", 2_000));

    expect(after.tracks[0]?.clips).toHaveLength(0);
    expect(after.tracks[1]?.clips[0]?.startMs).toBe(2_000);
  });

  it("refuses a move to an incompatible track kind", () => {
    // A voiceover clip on the caption track would compile to a cue with no text.
    const before = document([
      track("voiceover-0", "voiceover", [mediaClip({ id: "a" })]),
      track("caption-0", "caption", [], { order: 2 }),
    ]);

    expect(moveClipToTrack(before, "a", "caption-0", 0)).toBe(before);
  });

  it("refuses rather than clamping when the destination slot is occupied", () => {
    const before = document([
      track("video-0", "video", [mediaClip({ id: "a", startMs: 0, durationMs: 2_000 })]),
      track("video-1", "video", [mediaClip({ id: "x", startMs: 0, durationMs: 5_000 })], {
        order: 1,
      }),
    ]);

    expect(moveClipToTrack(before, "a", "video-1", 1_000)).toBe(before);
  });

  it("allows a move onto a track whose clips leave a gap", () => {
    const before = document([
      track("video-0", "video", [mediaClip({ id: "a", startMs: 0, durationMs: 1_000 })]),
      track("video-1", "video", [mediaClip({ id: "x", startMs: 0, durationMs: 1_000 })], {
        order: 1,
      }),
    ]);

    // Abuts `x` exactly. Half-open intervals mean this is legal, and the schema agrees.
    const after = expectValid(moveClipToTrack(before, "a", "video-1", 1_000));
    expect(after.tracks[1]?.clips).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Trim
// ---------------------------------------------------------------------------

describe("trimClipStart", () => {
  it("advances the source in-point by the same amount as the start", () => {
    const before = document([
      track("video-0", "video", [
        mediaClip({
          id: "a",
          startMs: 1_000,
          durationMs: 4_000,
          sourceInMs: 500,
          sourceOutMs: 4_500,
        }),
      ]),
    ]);

    const after = expectValid(trimClipStart(before, "a", 2_000));
    const trimmed = findClip(after, "a")?.clip;

    // This is the assertion that separates a trim from a slide: the clip starts 1000ms
    // later, is 1000ms shorter, and begins 1000ms further into its material.
    expect(trimmed?.startMs).toBe(2_000);
    expect(trimmed?.durationMs).toBe(3_000);
    expect(trimmed?.sourceInMs).toBe(1_500);
    expect(trimmed?.sourceOutMs, "the tail frame is unchanged").toBe(4_500);
    expect(clipEndMs(trimmed as EditClip), "the end does not move").toBe(5_000);
  });

  it("stops at the previous clip's end", () => {
    const after = expectValid(trimClipStart(twoShots(), "b", 0));
    expect(findClip(after, "b")?.clip.startMs).toBe(2_000);
  });

  it("will not trim a media clip below the minimum media length", () => {
    const before = document([
      track("video-0", "video", [
        mediaClip({ id: "a", startMs: 0, durationMs: 1_000, sourceInMs: 0, sourceOutMs: 1_000 }),
      ]),
    ]);

    const after = expectValid(trimClipStart(before, "a", 999));
    expect(findClip(after, "a")?.clip.durationMs).toBe(MIN_MEDIA_CLIP_MS);
  });

  it("refuses when the trim would invert the source window", () => {
    // Only 200ms of material behind the in-point, so a 900ms head trim has nowhere to go.
    const before = document([
      track("video-0", "video", [
        mediaClip({ id: "a", startMs: 0, durationMs: 1_000, sourceInMs: 0, sourceOutMs: 200 }),
      ]),
    ]);

    expect(trimClipStart(before, "a", 900)).toBe(before);
  });

  it("trims a caption clip below the media floor, which has no frames to decode", () => {
    // Whisper emits cues far shorter than MIN_MEDIA_CLIP_MS; flooring them would retime
    // captions that were merely opened.
    const before = document([
      track("caption-0", "caption", [
        clip({ id: "c", startMs: 0, durationMs: 200, text: "a" }),
      ]),
    ]);

    const after = expectValid(trimClipStart(before, "c", 150));
    expect(findClip(after, "c")?.clip.durationMs).toBe(50);
  });
});

describe("trimClipEnd", () => {
  it("shortens the clip and its source window together", () => {
    const before = document([
      track("video-0", "video", [
        mediaClip({ id: "a", startMs: 0, durationMs: 4_000, sourceInMs: 1_000, sourceOutMs: 5_000 }),
      ]),
    ]);

    const after = expectValid(trimClipEnd(before, "a", 2_500));
    const trimmed = findClip(after, "a")?.clip;

    expect(trimmed?.startMs, "the head does not move").toBe(0);
    expect(trimmed?.durationMs).toBe(2_500);
    expect(trimmed?.sourceInMs, "the first frame is unchanged").toBe(1_000);
    expect(trimmed?.sourceOutMs).toBe(3_500);
  });

  it("caps the source out-point at the length of the material while letting the clip hold", () => {
    // 3s of footage held for 5s: legitimate per edit-document.ts, and the renderer holds
    // or loops. The window must not claim frames past the end of the file.
    const before = document([
      track(
        "video-0",
        "video",
        [mediaClip({ id: "a", startMs: 0, durationMs: 2_000, sourceInMs: 0, sourceOutMs: 2_000 }, 3_000)],
      ),
    ]);

    const after = expectValid(trimClipEnd(before, "a", 5_000));
    const held = findClip(after, "a")?.clip;

    expect(held?.durationMs, "the clip occupies the full 5s").toBe(5_000);
    expect(held?.sourceOutMs, "but only 3s of material exists").toBe(3_000);
  });

  it("stops at the following clip's start", () => {
    const after = expectValid(trimClipEnd(twoShots(), "a", 9_999));
    expect(clipEndMs(findClip(after, "a")?.clip as EditClip)).toBe(2_000);
  });

  it("returns the same document when the length would not change", () => {
    const before = twoShots();
    expect(trimClipEnd(before, "a", 2_000)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Split — the operation that can silently change the video
// ---------------------------------------------------------------------------

describe("splitClip", () => {
  it("produces two halves that together occupy the original span and play the original material", () => {
    const before = document([
      track("video-0", "video", [
        mediaClip({
          id: "a",
          startMs: 1_000,
          durationMs: 4_000,
          sourceInMs: 500,
          sourceOutMs: 4_500,
        }),
      ]),
    ]);

    const after = expectValid(splitClip(before, "a", 3_000));
    const clips = orderedClips(after.tracks[0] as EditTrack);
    const [left, right] = clips;

    expect(clips).toHaveLength(2);

    // Span: the pair covers exactly 1000..5000 with no gap and no overlap.
    expect(left?.startMs).toBe(1_000);
    expect(left?.durationMs).toBe(2_000);
    expect(right?.startMs).toBe(3_000);
    expect(right?.durationMs).toBe(2_000);
    expect(clipEndMs(right as EditClip)).toBe(clipEndMs(before.tracks[0]?.clips[0] as EditClip));

    // Material: the windows adjoin at 2500, so the same frames play in the same order.
    // Without this the two halves would each replay the clip's opening — the silent
    // change this test exists to catch.
    expect(left?.sourceInMs).toBe(500);
    expect(left?.sourceOutMs).toBe(2_500);
    expect(right?.sourceInMs).toBe(2_500);
    expect(right?.sourceOutMs).toBe(4_500);
  });

  it("gives the halves distinct ids and keeps the original's id on the left", () => {
    const after = splitClip(twoShots(), "a", 1_000);
    const ids = (after.tracks[0]?.clips ?? []).map((c) => c.id);

    expect(ids).toContain("a");
    expect(new Set(ids).size, "ids must stay unique").toBe(ids.length);
  });

  it("does not put a transition in the middle of continuous material", () => {
    const before = document([
      track("video-0", "video", [
        mediaClip({ id: "a", startMs: 0, durationMs: 4_000, transition: "fade" }),
      ]),
    ]);

    const after = expectValid(splitClip(before, "a", 2_000));
    const clips = orderedClips(after.tracks[0] as EditTrack);

    expect(clips[0]?.transition, "the shot still fades in").toBe("fade");
    expect(clips[1]?.transition, "its continuation does not").toBeNull();
  });

  it("refuses a cut at or outside the clip's own bounds", () => {
    const before = twoShots();
    expect(splitClip(before, "a", 0)).toBe(before);
    expect(splitClip(before, "a", 2_000)).toBe(before);
    expect(splitClip(before, "a", 5_000)).toBe(before);
  });

  it("refuses a cut that would leave a media half too short to decode", () => {
    const before = document([
      track("video-0", "video", [mediaClip({ id: "a", startMs: 0, durationMs: 150 })]),
    ]);

    // Either half would be under MIN_MEDIA_CLIP_MS.
    expect(splitClip(before, "a", 75)).toBe(before);
  });

  it("splits repeatedly without producing an id the schema rejects", () => {
    // Ids are bounded at 64 chars; a naive suffix would grow past it.
    let doc = document([
      track("video-0", "video", [mediaClip({ id: "a", startMs: 0, durationMs: 8_000 })]),
    ]);

    for (let at = 500; at <= 4_000; at += 500) {
      doc = expectValid(splitClip(doc, "a", at));
    }

    for (const c of doc.tracks[0]?.clips ?? []) {
      expect(c.id.length).toBeLessThanOrEqual(64);
    }
  });
});

// ---------------------------------------------------------------------------
// Delete / duplicate
// ---------------------------------------------------------------------------

describe("deleteClip", () => {
  it("removes the clip and leaves the others where they were", () => {
    // A ripple delete would desync the narration and captions that were not deleted.
    const after = expectValid(deleteClip(twoShots(), "a"));

    expect(after.tracks[0]?.clips).toHaveLength(1);
    expect(after.tracks[0]?.clips[0]?.startMs, "the gap stays open").toBe(2_000);
  });

  it("empties a track rather than removing it", () => {
    const before = document([
      track("video-0", "video", [mediaClip({ id: "a" })], { label: "Video", volume: 0.5 }),
    ]);

    const after = expectValid(deleteClip(before, "a"));

    expect(after.tracks).toHaveLength(1);
    expect(after.tracks[0]?.label, "the track keeps its settings").toBe("Video");
    expect(after.tracks[0]?.volume).toBe(0.5);
  });
});

describe("duplicateClip", () => {
  it("places the copy in the first gap after the original", () => {
    const before = document([
      track("video-0", "video", [
        mediaClip({ id: "a", startMs: 0, durationMs: 1_000 }),
        mediaClip({ id: "b", startMs: 5_000, durationMs: 1_000 }),
      ]),
    ]);

    const after = expectValid(duplicateClip(before, "a"));
    const copy = orderedClips(after.tracks[0] as EditTrack)[1];

    expect(after.tracks[0]?.clips).toHaveLength(3);
    expect(copy?.startMs, "immediately after the original").toBe(1_000);
    expect(copy?.id).not.toBe("a");
  });

  it("skips a gap too small to hold the copy", () => {
    const before = document([
      track("video-0", "video", [
        mediaClip({ id: "a", startMs: 0, durationMs: 2_000 }),
        mediaClip({ id: "b", startMs: 2_500, durationMs: 1_000 }),
      ]),
    ]);

    // The 500ms gap at 2000 cannot hold a 2000ms copy, so it lands after `b`.
    const after = expectValid(duplicateClip(before, "a"));
    expect(orderedClips(after.tracks[0] as EditTrack)[2]?.startMs).toBe(3_500);
  });

  it("copies the source window so the duplicate plays the same material", () => {
    const before = document([
      track("video-0", "video", [
        mediaClip({ id: "a", startMs: 0, durationMs: 1_000, sourceInMs: 400, sourceOutMs: 1_400 }),
      ]),
    ]);

    const copy = orderedClips(
      expectValid(duplicateClip(before, "a")).tracks[0] as EditTrack,
    )[1];

    expect(copy?.sourceInMs).toBe(400);
    expect(copy?.sourceOutMs).toBe(1_400);
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("clip properties", () => {
  it("clamps volume into the schema's range instead of rejecting it", () => {
    const before = document([
      track("voiceover-0", "voiceover", [mediaClip({ id: "a" })]),
    ]);

    expect(expectValid(setClipVolume(before, "a", 9)).tracks[0]?.clips[0]?.volume).toBe(2);
    expect(expectValid(setClipVolume(before, "a", -1)).tracks[0]?.clips[0]?.volume).toBe(0);
  });

  it("edits text on a caption clip", () => {
    const before = document([
      track("caption-0", "caption", [clip({ id: "c", text: "befor" })]),
    ]);

    expect(expectValid(setClipText(before, "c", "after")).tracks[0]?.clips[0]?.text).toBe(
      "after",
    );
  });

  it("refuses text on a clip that plays an asset", () => {
    // Nothing renders `text` on a video clip, so storing it would have no effect.
    const before = document([track("video-0", "video", [mediaClip({ id: "a" })])]);
    expect(setClipText(before, "a", "hello")).toBe(before);
  });

  it("truncates pasted text at the schema's bound", () => {
    const before = document([track("text-0", "text", [clip({ id: "t", text: "x" })])]);

    const after = expectValid(setClipText(before, "t", "y".repeat(900)));
    expect(after.tracks[0]?.clips[0]?.text).toHaveLength(500);
  });
});

// ---------------------------------------------------------------------------
// Dispatch and geometry
// ---------------------------------------------------------------------------

describe("applyOperation", () => {
  it("dispatches every operation kind to something that returns a valid document", () => {
    const before = document([
      track("video-0", "video", [
        mediaClip({ id: "a", startMs: 0, durationMs: 4_000, sourceInMs: 0, sourceOutMs: 4_000 }),
      ]),
      track("music-0", "music", [mediaClip({ id: "m", startMs: 0, durationMs: 4_000 })], {
        order: 1,
      }),
      track("caption-0", "caption", [clip({ id: "c", text: "hi" })], { order: 2 }),
    ]);

    const operations = [
      { type: "moveClip", clipId: "a", startMs: 500 },
      { type: "trimClipStart", clipId: "a", startMs: 200 },
      { type: "trimClipEnd", clipId: "a", endMs: 3_000 },
      { type: "splitClip", clipId: "a", atMs: 1_500 },
      { type: "duplicateClip", clipId: "c" },
      { type: "setClipVolume", clipId: "m", volume: 0.3 },
      { type: "setClipText", clipId: "c", text: "there" },
      { type: "setTrackVolume", trackId: "music-0", volume: 0.5 },
      { type: "setTrackMuted", trackId: "music-0", muted: true },
      { type: "setTrackHidden", trackId: "video-0", hidden: true },
      { type: "setCaptionsBurnedIn", burnedIn: false },
      { type: "setDuckUnderNarration", duck: false },
      { type: "deleteClip", clipId: "a" },
    ] as const;

    // Applied cumulatively rather than each against the fixture: that is how a session
    // actually runs, and it is where an operation that corrupts state for the next one
    // would show up.
    let doc = before;
    for (const operation of operations) {
      doc = expectValid(applyOperation(doc, operation));
    }

    expect(doc.captions.burnedIn).toBe(false);
    expect(doc.music.duckUnderNarration).toBe(false);
    expect(doc.tracks.find((t) => t.id === "music-0")?.muted).toBe(true);
  });
});

describe("contentEndMs", () => {
  it("takes the furthest clip end across every track", () => {
    const doc = document([
      track("video-0", "video", [mediaClip({ id: "a", startMs: 0, durationMs: 2_000 })]),
      track("music-0", "music", [mediaClip({ id: "m", startMs: 0, durationMs: 9_000 })], {
        order: 1,
      }),
    ]);

    // The music bed outlasting the picture is the normal seeded shape, and the ruler has
    // to cover it or the clip would be undraggable past the visual end.
    expect(contentEndMs(doc)).toBe(9_000);
  });

  it("is zero for a document with no clips", () => {
    expect(contentEndMs(document([track("video-0", "video", [])]))).toBe(0);
  });
});

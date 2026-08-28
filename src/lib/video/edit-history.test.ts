/**
 * Tests for undo/redo and the coalescing rule.
 *
 * The interesting cases are not "undo goes back one step" — they are the three places a
 * history stack usually leaks: a refused gesture that still grows the stack, a redo that
 * survives a new edit and reapplies an abandoned branch, and a drag that costs fifty
 * undo presses because every pointer move was its own entry. Each has a test here.
 *
 * Documents are built by applying real operations rather than by hand-writing variants, so
 * the identity behaviour these rely on (`applyOperation` returning its input when it
 * refuses) is the same behaviour the editor gets.
 */

import { describe, expect, it } from "vitest";
import type {
  EditClip,
  EditDocument,
  EditTrack,
} from "@/lib/video/edit-document";
import {
  canRedo,
  canUndo,
  conflictSummary,
  HISTORY_LIMIT,
  initHistory,
  pushHistory,
  redo,
  resetHistory,
  undo,
} from "@/lib/video/edit-history";
import { applyOperation, findClip, type EditOperation } from "@/lib/video/edit-ops";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function clip(id: string, startMs: number, durationMs: number): EditClip {
  return {
    id,
    startMs,
    durationMs,
    sourceInMs: null,
    sourceOutMs: null,
    volume: 1,
    text: "a line",
    label: null,
    transition: null,
    source: null,
    sceneIndex: null,
  };
}

function baseDocument(): EditDocument {
  const track: EditTrack = {
    id: "t-text",
    kind: "text",
    label: null,
    order: 0,
    muted: false,
    hidden: false,
    volume: 1,
    clips: [clip("c1", 0, 2_000), clip("c2", 4_000, 2_000)],
  };

  return {
    schemaVersion: 1,
    format: "portrait",
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

/** Apply an operation and record it, the way the editor's dispatcher does. */
function edit(
  state: ReturnType<typeof initHistory>,
  operation: EditOperation,
): ReturnType<typeof initHistory> {
  return pushHistory(state, applyOperation(state.present, operation), operation);
}

function startOf(document: EditDocument, clipId: string): number | undefined {
  return findClip(document, clipId)?.clip.startMs;
}

// ---------------------------------------------------------------------------

describe("history", () => {
  it("starts with nothing to undo or redo", () => {
    const state = initHistory(baseDocument());

    expect(canUndo(state)).toBe(false);
    expect(canRedo(state)).toBe(false);
  });

  it("undo restores the document from before the edit", () => {
    const state = edit(initHistory(baseDocument()), {
      type: "moveClip",
      clipId: "c1",
      startMs: 2_000,
    });

    expect(startOf(state.present, "c1")).toBe(2_000);
    expect(canUndo(state)).toBe(true);

    const back = undo(state);
    expect(startOf(back.present, "c1")).toBe(0);
    expect(canUndo(back)).toBe(false);
    expect(canRedo(back)).toBe(true);
  });

  it("redo replays the undone edit", () => {
    const state = edit(initHistory(baseDocument()), {
      type: "splitClip",
      clipId: "c2",
      atMs: 5_000,
    });
    const again = redo(undo(state));

    expect(again.present).toBe(state.present);
    expect(canRedo(again)).toBe(false);
  });

  it("does not record a refused gesture", () => {
    const state = initHistory(baseDocument());

    // A split outside the clip is refused, so `applyOperation` returns the same document
    // by identity — the stack must not grow on a gesture the user saw no result from.
    const after = edit(state, { type: "splitClip", clipId: "c2", atMs: 100 });

    expect(after).toBe(state);
    expect(canUndo(after)).toBe(false);
  });

  it("a new edit discards the redo future", () => {
    const moved = edit(initHistory(baseDocument()), {
      type: "moveClip",
      clipId: "c1",
      startMs: 1_000,
    });
    const undone = undo(moved);
    expect(canRedo(undone)).toBe(true);

    const diverged = edit(undone, { type: "deleteClip", clipId: "c2" });

    expect(canRedo(diverged)).toBe(false);
    // The branch that was undone must not come back through the delete's own undo.
    expect(startOf(undo(diverged).present, "c1")).toBe(0);
  });

  it("collapses one drag into one undo step", () => {
    let state = initHistory(baseDocument());
    for (const startMs of [200, 400, 600, 800, 1_000]) {
      state = edit(state, { type: "moveClip", clipId: "c1", startMs });
    }

    expect(startOf(state.present, "c1")).toBe(1_000);
    expect(state.past).toHaveLength(1);
    // One press returns to where the drag began, not to 800ms.
    expect(startOf(undo(state).present, "c1")).toBe(0);
  });

  it("keeps drags of different clips as separate steps", () => {
    let state = edit(initHistory(baseDocument()), {
      type: "moveClip",
      clipId: "c1",
      startMs: 1_000,
    });
    state = edit(state, { type: "moveClip", clipId: "c2", startMs: 3_000 });

    expect(state.past).toHaveLength(2);
    expect(startOf(undo(state).present, "c2")).toBe(4_000);
  });

  it("does not coalesce discrete edits with each other", () => {
    let state = edit(initHistory(baseDocument()), {
      type: "duplicateClip",
      clipId: "c1",
    });
    state = edit(state, { type: "deleteClip", clipId: "c2" });

    expect(state.past).toHaveLength(2);
  });

  it("does not coalesce across an undo", () => {
    let state = edit(initHistory(baseDocument()), {
      type: "setClipText",
      clipId: "c1",
      text: "one",
    });
    state = undo(state);
    state = edit(state, { type: "setClipText", clipId: "c1", text: "two" });

    // Coalescing here would have merged into the entry the undo just walked out of,
    // making the edit unundoable.
    expect(canUndo(state)).toBe(true);
    expect(findClip(undo(state).present, "c1")?.clip.text).toBe("a line");
  });

  it("bounds the stack at the limit and keeps the newest steps", () => {
    const total = HISTORY_LIMIT + 20;
    let state = initHistory(baseDocument());
    // Alternating clips so nothing coalesces, giving one entry per edit.
    for (let i = 0; i < total; i += 1) {
      state = edit(state, {
        type: "setClipText",
        clipId: i % 2 === 0 ? "c1" : "c2",
        text: `line ${i}`,
      });
    }

    expect(state.past).toHaveLength(HISTORY_LIMIT);

    // The newest edit is still undoable — the limit drops the *oldest* history, so one
    // press reverts the last change rather than doing nothing.
    const last = total - 1;
    const lastClip = last % 2 === 0 ? "c1" : "c2";
    expect(findClip(state.present, lastClip)?.clip.text).toBe(`line ${last}`);
    expect(findClip(undo(state).present, lastClip)?.clip.text).toBe(
      `line ${last - 2}`,
    );
  });

  it("reset clears both stacks", () => {
    const state = edit(initHistory(baseDocument()), {
      type: "deleteClip",
      clipId: "c1",
    });
    const server = baseDocument();
    const fresh = resetHistory(undo(state), server);

    expect(fresh.present).toBe(server);
    expect(canUndo(fresh)).toBe(false);
    expect(canRedo(fresh)).toBe(false);
  });

  it("undo and redo at the ends of the stack are no-ops", () => {
    const state = initHistory(baseDocument());

    expect(undo(state)).toBe(state);
    expect(redo(state)).toBe(state);
  });
});

/**
 * The conflict banner's wording.
 *
 * Tested because it is the fix for the confusing part of a save conflict, not because
 * strings usually deserve tests. Two claims: the user is told how much is unsaved, and the
 * copy never suggests overwriting — retrying with a bumped version is precisely the silent
 * clobber the version check prevents, so it must not be offered even in prose.
 */
describe("conflictSummary", () => {
  it("counts the unsaved changes so the editor does not look like it is working", () => {
    expect(conflictSummary(1)).toMatch(/^One change here has not been saved\./);
    expect(conflictSummary(4)).toMatch(/^4 changes here have not been saved\./);
  });

  it("says reloading discards them, rather than calling it a refresh", () => {
    expect(conflictSummary(2)).toMatch(/discards them/);
    expect(conflictSummary(2)).toMatch(/Download/);
  });

  it("never offers to overwrite the other tab's cut", () => {
    for (const count of [1, 3, 40]) {
      expect(conflictSummary(count)).not.toMatch(/overwrite|force|anyway/i);
    }
  });

  it("still reads correctly for the degenerate counts", () => {
    // The banner only renders while conflicted, where at least the losing document is at
    // stake — so zero and nonsense both floor to one rather than saying "0 changes".
    expect(conflictSummary(0)).toMatch(/^One change/);
    expect(conflictSummary(-5)).toMatch(/^One change/);
    expect(conflictSummary(Number.NaN)).toMatch(/^One change/);
    expect(conflictSummary(2.7)).toMatch(/^2 changes/);
  });
});

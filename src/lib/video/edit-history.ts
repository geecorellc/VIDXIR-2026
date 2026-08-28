/**
 * Undo/redo and autosave scheduling for the editor.
 *
 * Pure, and separate from the React component, for one reason: this is the logic that is
 * actually easy to get wrong — a redo stack that survives a new edit, a debounce that
 * never fires while the user keeps typing, a save that races its own response — and none
 * of it needs a DOM to test.
 *
 * History is a stack of whole documents rather than a stack of operations. Inverse
 * operations would be smaller, but every one of them would need writing and testing
 * (what is the inverse of a split whose halves were then trimmed?), and a document is a
 * few kilobytes of plain JSON. At `HISTORY_LIMIT` entries the memory is trivial and the
 * correctness is free: undo cannot drift from the document because it *is* the document.
 *
 * The coalescing rule is the other decision worth stating. A drag emits a `moveClip` per
 * pointer move, and pushing each onto the stack would make undo useless — fifty
 * presses to get back to where the drag started. So consecutive operations of the same
 * kind on the same target collapse into one entry, which makes one gesture one undo.
 */

import type { EditDocument } from "@/lib/video/edit-document";
import type { EditOperation } from "@/lib/video/edit-ops";

/**
 * How many steps back the editor can go.
 *
 * Fifty is well past what anyone reaches for and bounds the memory a long session holds
 * at a few megabytes of JSON in the worst case.
 */
export const HISTORY_LIMIT = 50;

export interface HistoryState {
  /** The cut as it stands. Always the document the UI renders and the autosave posts. */
  present: EditDocument;
  past: readonly EditDocument[];
  future: readonly EditDocument[];
  /**
   * What produced `present`, for coalescing.
   *
   * Null after an undo, a redo or a reload, which deliberately breaks any coalescing
   * run: the next operation starts a fresh entry rather than merging into whatever was
   * there before the user pressed undo.
   */
  lastLabel: string | null;
}

export function initHistory(document: EditDocument): HistoryState {
  return { present: document, past: [], future: [], lastLabel: null };
}

/**
 * The coalescing key for an operation.
 *
 * Same key on consecutive operations means one gesture. Drags and continuous controls
 * (volume, text) are keyed by kind *and* target, so dragging clip A then clip B is two
 * undo steps while dragging A twice is one. Discrete operations — split, delete,
 * duplicate — get a unique key so they never merge with anything, including with each
 * other.
 */
function labelOf(operation: EditOperation): string {
  switch (operation.type) {
    case "moveClip":
    case "moveClipToTrack":
    case "trimClipStart":
    case "trimClipEnd":
    case "setClipVolume":
    case "setClipText":
      return `${operation.type}:${operation.clipId}`;
    case "setTrackVolume":
      return `${operation.type}:${operation.trackId}`;
    // Discrete edits. `null` is the "never coalesce" signal; see `pushHistory`.
    default:
      return "";
  }
}

/**
 * Record a new document in the history.
 *
 * `next` is the already-computed result of applying `operation` — this function does not
 * apply anything, so history cannot disagree with the document the caller is about to
 * render.
 *
 * Three properties:
 *
 *  - **A no-op does not touch the stack.** `applyOperation` returns its input by
 *    identity when a gesture is refused, so the identity check here is what keeps a drag
 *    against a wall from filling the undo stack with fifty copies of the same document.
 *  - **A new edit clears the redo future.** Standard, and the alternative is a redo that
 *    reapplies a document from an abandoned branch.
 *  - **Consecutive same-gesture edits replace rather than append.** The prior `present`
 *    is discarded instead of pushed, so the whole drag collapses to the state before it.
 */
export function pushHistory(
  state: HistoryState,
  next: EditDocument,
  operation: EditOperation,
): HistoryState {
  if (next === state.present) return state;

  const label = labelOf(operation);
  const coalesce = label !== "" && label === state.lastLabel;

  const past = coalesce
    ? state.past
    : [...state.past, state.present].slice(-HISTORY_LIMIT);

  return {
    present: next,
    past,
    future: [],
    lastLabel: label === "" ? null : label,
  };
}

/**
 * Replace the document without recording history — a reload, or a conflict resolution.
 *
 * Clears both stacks: after the server hands back a document written by another tab,
 * the local history describes a cut that no longer exists, and letting undo walk back
 * into it would resurrect the overwritten edit.
 */
export function resetHistory(
  _state: HistoryState,
  document: EditDocument,
): HistoryState {
  return initHistory(document);
}

export function canUndo(state: HistoryState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: HistoryState): boolean {
  return state.future.length > 0;
}

export function undo(state: HistoryState): HistoryState {
  const previous = state.past[state.past.length - 1];
  if (!previous) return state;

  return {
    present: previous,
    past: state.past.slice(0, -1),
    future: [state.present, ...state.future].slice(0, HISTORY_LIMIT),
    // Breaks any coalescing run: the next edit starts a new entry.
    lastLabel: null,
  };
}

export function redo(state: HistoryState): HistoryState {
  const next = state.future[0];
  if (!next) return state;

  return {
    present: next,
    past: [...state.past, state.present].slice(-HISTORY_LIMIT),
    future: state.future.slice(1),
    lastLabel: null,
  };
}

// ---------------------------------------------------------------------------
// Autosave state
// ---------------------------------------------------------------------------

/**
 * What the editor tells the user about saving.
 *
 *  - `saved` — the server holds this exact document.
 *  - `dirty` — there are unsaved changes and a save is scheduled.
 *  - `saving` — a request is in flight.
 *  - `conflict` — another tab won; the user must reload. Not retryable, because
 *    retrying would be the silent overwrite the version check exists to prevent.
 *  - `error` — the save failed for some other reason and will be retried.
 */
export type SaveState = "saved" | "dirty" | "saving" | "conflict" | "error";

/**
 * How long after the last change a save fires.
 *
 * 900ms: past the gap between keystrokes in a caption, so typing a line is one save
 * rather than thirty, and short enough that a user who drags a clip and looks away sees
 * "Saved" almost immediately.
 */
export const AUTOSAVE_DEBOUNCE_MS = 900;

/**
 * How long to wait before retrying a failed save.
 *
 * Longer than the debounce so a server that is briefly down does not get a request per
 * keystroke, and short enough that a recovered connection saves without the user acting.
 * Not applied to a conflict, which is not retryable.
 */
export const AUTOSAVE_RETRY_MS = 4_000;

/**
 * What a conflicted editor tells the user is at stake.
 *
 * Pure, and here rather than inline in the banner, because the wording is the entire fix
 * for the confusing part of a conflict: the save is terminal, so gestures made afterwards
 * still apply on screen, still enter the undo stack, and will never be persisted. Without
 * a count the editor looks like it is working normally. Without the warning, "reload"
 * reads as a refresh rather than as discarding those edits.
 *
 * Deliberately never offers to overwrite. Retrying with a bumped version is the silent
 * clobber optimistic concurrency exists to prevent, so the two honest actions are keeping
 * a copy and reloading.
 */
export function conflictSummary(editsSinceConflict: number): string {
  const count = Number.isFinite(editsSinceConflict)
    ? Math.max(1, Math.floor(editsSinceConflict))
    : 1;
  const changes =
    count === 1 ? "One change here has not been saved." : `${count} changes here have not been saved.`;

  return (
    `${changes} Reloading replaces what is on screen with the saved version and ` +
    "discards them. Download them first if you want a copy."
  );
}

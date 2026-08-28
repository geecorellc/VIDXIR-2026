"use client";

/**
 * The editor's single source of truth, wired to the API.
 *
 * One document, one history stack, one autosave. Every gesture goes through `dispatch`,
 * which applies a pure operation from `edit-ops` and records it — so there is no second
 * state model that could drift from `project_edits`. Selection, playhead and zoom live in
 * the component instead, because none of them describe the video.
 *
 * The save discipline, which is the part with teeth:
 *
 *  - Debounced, coalescing. A drag or a line of typing is one PUT, not fifty.
 *  - Serialised. One request at a time, tracked in a ref rather than in state, because a
 *    second save racing the first would send the same `expectedVersion` twice and the
 *    loser would look like a conflict when nothing was actually concurrent.
 *  - Versioned. `expectedVersion` is what the server last acknowledged. A `conflict` is
 *    terminal until the user reloads: retrying with a bumped version is exactly the
 *    silent overwrite optimistic concurrency exists to prevent.
 *  - Flushed on unload, best-effort, so closing the tab mid-debounce does not lose the
 *    last edit.
 *
 * A conflict being terminal has a consequence worth naming, because it was the confusing
 * part: `schedule` returns early once conflicted, so every gesture after that point still
 * applies to the on-screen document and still lands in the undo stack, but will never be
 * persisted. The editor looks like it is working and is not. `editsSinceConflict` counts
 * those gestures so the banner can say how much is at stake, and so reloading can warn
 * before discarding them rather than throwing them away silently.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_RETRY_MS,
  canRedo as historyCanRedo,
  canUndo as historyCanUndo,
  initHistory,
  pushHistory,
  redo as historyRedo,
  resetHistory,
  undo as historyUndo,
  type HistoryState,
  type SaveState,
} from "@/lib/video/edit-history";
import type { EditDocument } from "@/lib/video/edit-document";
import { applyOperation, type EditOperation } from "@/lib/video/edit-ops";
import { ApiError, api, messageOf } from "@/services/api-client";

/** The `GET`/`PUT` response shape from `/api/video/edit`. */
export interface EditPayload {
  projectId: string;
  version: number;
  document: EditDocument;
  durationMs: number;
  seeded: boolean;
  lastRenderedAt: string | null;
  updatedAt: string;
  assetUrls: Record<string, string> | null;
}

export interface EditorDocumentState {
  document: EditDocument | null;
  /** Signed playback URLs by storage key. Empty until the document loads. */
  assetUrls: Record<string, string>;
  loading: boolean;
  /** A load failure, or a save failure worth showing. Null when healthy. */
  error: string | null;
  saveState: SaveState;
  canUndo: boolean;
  canRedo: boolean;
  version: number;
  lastRenderedAt: string | null;
  /** True when the cut was created from the project's scenes on this open. */
  seeded: boolean;
  /**
   * Gestures applied since the conflict, none of which can be saved.
   *
   * Zero unless `saveState` is `conflict`. The UI uses it to say what reloading will
   * discard, so the choice is informed rather than a leap.
   */
  editsSinceConflict: number;
  dispatch: (operation: EditOperation) => void;
  undo: () => void;
  redo: () => void;
  /** Save now rather than waiting out the debounce — used before an export. */
  flush: () => Promise<void>;
  /** Re-read the server's document, discarding local history. Resolves a conflict. */
  reload: () => Promise<void>;
  /**
   * The conflicted cut as JSON, for the user to keep before reloading.
   *
   * Deliberately not an "overwrite anyway" button: that is the silent clobber the version
   * check exists to prevent. This is the honest alternative — the work is recoverable
   * outside the app, and the other tab's cut stays intact.
   */
  conflictedDocumentJson: () => string | null;
}

export function useEditorDocument(projectId: string): EditorDocumentState {
  const [history, setHistory] = useState<HistoryState | null>(null);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [version, setVersion] = useState(0);
  const [lastRenderedAt, setLastRenderedAt] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);
  const [editsSinceConflict, setEditsSinceConflict] = useState(0);

  /**
   * Refs, not state, for everything the save loop reads.
   *
   * A timer callback closes over the values from the render that scheduled it. Reading
   * the document from state there would save a stale cut — the classic debounce bug — so
   * the pending document, the acknowledged version and the in-flight flag are all refs
   * that the callback reads at the moment it fires.
   */
  const pendingRef = useRef<EditDocument | null>(null);
  const versionRef = useRef(0);
  const savingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conflictRef = useRef(false);
  /** A document the server rejected on shape, so the retry loop stops re-sending it. */
  const rejectedRef = useRef<EditDocument | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // -------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------

  const adopt = useCallback((payload: EditPayload) => {
    versionRef.current = payload.version;
    pendingRef.current = null;
    conflictRef.current = false;
    rejectedRef.current = null;
    setVersion(payload.version);
    setAssetUrls(payload.assetUrls ?? {});
    setLastRenderedAt(payload.lastRenderedAt);
    setSeeded(payload.seeded);
    setEditsSinceConflict(0);
    setHistory((current) =>
      current ? resetHistory(current, payload.document) : initHistory(payload.document),
    );
    setSaveState("saved");
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const payload = await api.get<EditPayload>(
          `/api/video/edit?projectId=${encodeURIComponent(projectId)}`,
          { signal },
        );
        if (!mountedRef.current) return;
        adopt(payload);
      } catch (e) {
        // An abort is the effect cleaning up, not a failure to report.
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (!mountedRef.current) return;
        setError(messageOf(e));
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [adopt, projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // -------------------------------------------------------------------------
  // Save
  // -------------------------------------------------------------------------

  /**
   * Send the pending document, if any.
   *
   * Returns rather than queueing when a save is already in flight: `save` is called again
   * from the completion path below, so a change made mid-request is not dropped — it goes
   * out immediately after the current one acknowledges, with the version it returned.
   */
  const save = useCallback(async () => {
    if (savingRef.current || conflictRef.current) return;
    const document = pendingRef.current;
    if (!document) return;
    // The exact document the server already refused. Sending it again would fail
    // identically; see the `validation_failed` branch below.
    if (document === rejectedRef.current) return;

    savingRef.current = true;
    pendingRef.current = null;
    if (mountedRef.current) setSaveState("saving");

    try {
      const payload = await api.put<EditPayload>("/api/video/edit", {
        projectId,
        expectedVersion: versionRef.current,
        document,
      });

      versionRef.current = payload.version;
      if (mountedRef.current) {
        setVersion(payload.version);
        setLastRenderedAt(payload.lastRenderedAt);
        // Only "saved" if nothing changed while the request was out; otherwise the very
        // next tick sends the newer document and this would flicker a false "Saved".
        setSaveState(pendingRef.current ? "dirty" : "saved");
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "conflict") {
        // Another tab or window wrote first. Terminal: the user reloads to see that cut.
        conflictRef.current = true;
        pendingRef.current = null;
        if (mountedRef.current) {
          setSaveState("conflict");
          // The document that lost is still on screen, so it counts as the first edit at
          // stake: reloading will discard it along with anything done afterwards.
          setEditsSinceConflict((count) => Math.max(1, count));
          setError(
            "This video was edited somewhere else — in another tab or window — and that " +
              "version is now the saved one. Nothing here has been lost yet, but nothing " +
              "further can be saved until you reload.",
          );
        }
        return;
      }

      // Put back rather than dropped, whatever the cause: a failed save must not lose
      // work, and the document is the only copy of it.
      pendingRef.current = document;
      if (mountedRef.current) {
        setSaveState("error");
        setError(messageOf(e));
      }

      // A rejected *shape* is not transient — the same bytes will never be accepted, so
      // retrying is an endless loop against the route. Held instead until the document
      // changes: `schedule` clears this, so an undo or any further edit tries again with
      // something different. Every gesture is supposed to preserve the schema's
      // invariants, so reaching here at all means a bug worth seeing rather than hiding
      // behind a spinner.
      if (e instanceof ApiError && e.code === "validation_failed") {
        rejectedRef.current = document;
      }
    } finally {
      savingRef.current = false;
      // Drain: either a change arrived mid-flight, or a retry is due.
      if (
        pendingRef.current &&
        pendingRef.current !== rejectedRef.current &&
        mountedRef.current &&
        !conflictRef.current
      ) {
        const delay = saveStateWasError() ? AUTOSAVE_RETRY_MS : 0;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => void save(), delay);
      }
    }

    /** Whether the attempt just made failed, read without a state round-trip. */
    function saveStateWasError(): boolean {
      return pendingRef.current === document;
    }
  }, [projectId]);

  const schedule = useCallback(
    (document: EditDocument) => {
      if (conflictRef.current) {
        // Still refused — see the note at the top of the file — but counted, so the banner
        // can say how many unsaveable edits have piled up instead of letting the user keep
        // working into a void.
        setEditsSinceConflict((count) => count + 1);
        return;
      }
      // A different document than the refused one, so the hold is lifted.
      rejectedRef.current = null;
      pendingRef.current = document;
      setSaveState("dirty");
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void save(), AUTOSAVE_DEBOUNCE_MS);
    },
    [save],
  );

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await save();
  }, [save]);

  /**
   * Best-effort save when the tab goes away.
   *
   * `keepalive` rather than `sendBeacon`: the route expects a JSON body on `PUT` and a
   * beacon can only POST. Failure here is silent by necessity — the page is unloading and
   * there is nobody left to tell — which is why the debounce is short enough that this
   * path is rare.
   */
  useEffect(() => {
    function onHide() {
      const document = pendingRef.current;
      if (!document || conflictRef.current) return;
      if (document === rejectedRef.current) return;
      void fetch("/api/video/edit", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        keepalive: true,
        body: JSON.stringify({
          projectId,
          expectedVersion: versionRef.current,
          document,
        }),
      }).catch(() => undefined);
    }

    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [projectId]);

  // -------------------------------------------------------------------------
  // Gestures
  // -------------------------------------------------------------------------

  const dispatch = useCallback(
    (operation: EditOperation) => {
      setHistory((current) => {
        if (!current) return current;
        const next = applyOperation(current.present, operation);
        // A refused gesture changes nothing, so it must not mark the document dirty or
        // trigger a save that would rewrite the row for no reason.
        if (next === current.present) return current;
        schedule(next);
        return pushHistory(current, next, operation);
      });
    },
    [schedule],
  );

  const undo = useCallback(() => {
    setHistory((current) => {
      if (!current) return current;
      const next = historyUndo(current);
      if (next === current) return current;
      schedule(next.present);
      return next;
    });
  }, [schedule]);

  const redo = useCallback(() => {
    setHistory((current) => {
      if (!current) return current;
      const next = historyRedo(current);
      if (next === current) return current;
      schedule(next.present);
      return next;
    });
  }, [schedule]);

  const reload = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    conflictRef.current = false;
    await load();
  }, [load]);

  /**
   * The on-screen cut, serialised, so a conflicted user can keep it.
   *
   * Reads the history's `present` rather than `pendingRef`, which the conflict cleared —
   * the document the user is looking at is the one worth keeping.
   */
  const conflictedDocumentJson = useCallback(() => {
    const document = history?.present;
    return document ? JSON.stringify(document, null, 2) : null;
  }, [history]);

  return {
    document: history?.present ?? null,
    assetUrls,
    loading,
    error,
    saveState,
    canUndo: history ? historyCanUndo(history) : false,
    canRedo: history ? historyCanRedo(history) : false,
    version,
    lastRenderedAt,
    seeded,
    editsSinceConflict: saveState === "conflict" ? editsSinceConflict : 0,
    dispatch,
    undo,
    redo,
    flush,
    reload,
    conflictedDocumentJson,
  };
}

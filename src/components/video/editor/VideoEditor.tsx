"use client";

/**
 * The editor shell.
 *
 * Owns the three things that are genuinely view state — playhead, selection, zoom — and
 * nothing else. The cut itself lives in `useEditorDocument`, which is a thin wrapper over
 * the `project_edits` document; every gesture is an `EditOperation` applied by
 * `edit-ops`. Preview, timeline and properties all read that one document through
 * `compileEditDocument`, so there is nothing here that could describe a different video
 * than the export produces.
 *
 * The playback clock is a `requestAnimationFrame` loop over `performance.now()`, not a
 * media element's `currentTime`. The timeline is the clock and elements are slaved to it —
 * see `Preview`. That is what makes playback continue across a gap where no element exists
 * to ask.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  Copy,
  Download,
  Pause,
  Play,
  Redo2,
  RefreshCw,
  Scissors,
  Trash2,
  Undo2,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Btn } from "@/components/ui/Btn";
import { Card } from "@/components/ui/Card";
import { ClipProperties } from "@/components/video/editor/ClipProperties";
import { ExportPanel } from "@/components/video/editor/ExportPanel";
import { Preview } from "@/components/video/editor/Preview";
import { Timeline } from "@/components/video/editor/Timeline";
import { useEditorDocument } from "@/components/video/editor/useEditorDocument";
import { color, font, radius } from "@/lib/design/tokens";
import { compileEditDocument } from "@/lib/video/edit-document";
import { clipEndMs, contentEndMs, findClip } from "@/lib/video/edit-ops";
import { conflictSummary, type SaveState } from "@/lib/video/edit-history";
import { boostNotice, type BoostMode } from "@/lib/video/preview-audio";
import {
  DEFAULT_ZOOM_INDEX,
  timecode,
  ZOOM_LEVELS,
  zoomAt,
} from "@/lib/video/editor-view";

export interface VideoEditorProps {
  projectId: string;
  projectTitle: string | null;
}

export function VideoEditor({ projectId, projectTitle }: VideoEditorProps) {
  const router = useRouter();
  const editor = useEditorDocument(projectId);
  const { document: doc, dispatch } = editor;

  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const [muted, setMuted] = useState(false);
  /** What the preview managed to do about gains above 100%; see `preview-audio`. */
  const [boostMode, setBoostMode] = useState<BoostMode>("off");

  const pxPerMs = zoomAt(zoomIndex);

  /**
   * The compiled cut.
   *
   * Memoised on the document identity, which is safe precisely because the operations are
   * pure — a document that has not been replaced has not changed. This is what the preview
   * reads and what the export will render.
   */
  const compiled = useMemo(() => (doc ? compileEditDocument(doc) : null), [doc]);
  const durationMs = doc ? contentEndMs(doc) : 0;

  const selected = useMemo(
    () => (doc && selectedClipId ? findClip(doc, selectedClipId) : null),
    [doc, selectedClipId],
  );

  // A clip removed by a delete, an undo or a reload must not stay selected, or the
  // properties panel would render a clip that is no longer in the cut.
  useEffect(() => {
    if (selectedClipId && !selected) setSelectedClipId(null);
  }, [selected, selectedClipId]);

  // -------------------------------------------------------------------------
  // Playback clock
  // -------------------------------------------------------------------------

  const rafRef = useRef<number | null>(null);
  /** Wall clock and playhead at the moment play started, so drift cannot accumulate. */
  const clockRef = useRef<{ startedAt: number; fromMs: number } | null>(null);

  useEffect(() => {
    if (!playing) {
      clockRef.current = null;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }

    clockRef.current = { startedAt: performance.now(), fromMs: playheadMs };

    function tick(now: number) {
      const clock = clockRef.current;
      if (!clock) return;
      const next = clock.fromMs + (now - clock.startedAt);
      if (next >= durationMs) {
        // Stop at the end rather than looping: an editor that loops makes it impossible
        // to see what the last frame actually is.
        setPlayheadMs(durationMs);
        setPlaying(false);
        return;
      }
      setPlayheadMs(next);
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // `playheadMs` is deliberately excluded: it changes on every frame, and including it
    // would tear down and restart the loop each time. The value at play time is captured
    // into `clockRef`, and a seek while playing re-enters through `seek` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, durationMs]);

  const seek = useCallback(
    (ms: number) => {
      const clamped = Math.max(0, Math.min(durationMs, Math.round(ms)));
      setPlayheadMs(clamped);
      // Re-base the clock so playback continues from the new position instead of jumping
      // back to where it was when play began.
      if (clockRef.current) {
        clockRef.current = { startedAt: performance.now(), fromMs: clamped };
      }
    },
    [durationMs],
  );

  const togglePlay = useCallback(() => {
    setPlaying((current) => {
      // Pressing play at the end restarts rather than doing nothing.
      if (!current && playheadMs >= durationMs) setPlayheadMs(0);
      return !current;
    });
  }, [durationMs, playheadMs]);

  // -------------------------------------------------------------------------
  // Gestures
  // -------------------------------------------------------------------------

  const splitAtPlayhead = useCallback(() => {
    if (!selected) return;
    if (playheadMs <= selected.clip.startMs || playheadMs >= clipEndMs(selected.clip)) return;
    dispatch({ type: "splitClip", clipId: selected.clip.id, atMs: playheadMs });
  }, [dispatch, playheadMs, selected]);

  const deleteSelected = useCallback(() => {
    if (!selected) return;
    dispatch({ type: "deleteClip", clipId: selected.clip.id });
    setSelectedClipId(null);
  }, [dispatch, selected]);

  const duplicateSelected = useCallback(() => {
    if (!selected) return;
    dispatch({ type: "duplicateClip", clipId: selected.clip.id });
  }, [dispatch, selected]);

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Never steal a key from a field the user is typing in — the caption editor is a
      // textarea sitting inside this same view.
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }

      const mod = event.metaKey || event.ctrlKey;

      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) editor.redo();
        else editor.undo();
        return;
      }
      if (mod && event.key.toLowerCase() === "y") {
        event.preventDefault();
        editor.redo();
        return;
      }
      if (mod && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelected();
        return;
      }
      if (mod) return;

      switch (event.key) {
        case " ":
          event.preventDefault();
          togglePlay();
          break;
        case "s":
          splitAtPlayhead();
          break;
        case "Delete":
        case "Backspace":
          event.preventDefault();
          deleteSelected();
          break;
        case "ArrowLeft":
          event.preventDefault();
          // A frame at 30fps, or a second with shift — the two steps an edit needs.
          seek(playheadMs - (event.shiftKey ? 1_000 : 33));
          break;
        case "ArrowRight":
          event.preventDefault();
          seek(playheadMs + (event.shiftKey ? 1_000 : 33));
          break;
        case "Home":
          event.preventDefault();
          seek(0);
          break;
        case "End":
          event.preventDefault();
          seek(durationMs);
          break;
        case "Escape":
          setSelectedClipId(null);
          break;
        default:
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    deleteSelected,
    duplicateSelected,
    durationMs,
    editor,
    playheadMs,
    seek,
    splitAtPlayhead,
    togglePlay,
  ]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (editor.loading) {
    return (
      <Card>
        <p style={{ margin: 0, fontSize: 13, color: color.textDim }}>Opening the editor…</p>
      </Card>
    );
  }

  if (!doc || !compiled) {
    return (
      <Card tone="warning">
        <p style={{ margin: 0, fontSize: 13, color: color.warning, lineHeight: 1.6 }}>
          {editor.error ?? "This video could not be opened for editing."}
        </p>
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <Btn size="sm" variant="ghost" onClick={() => void editor.reload()}>
            Try again
          </Btn>
          <Btn
            size="sm"
            variant="ghost"
            onClick={() => router.push(`/dashboard/video?project=${projectId}`)}
          >
            Back to the video
          </Btn>
        </div>
      </Card>
    );
  }

  const conflicted = editor.saveState === "conflict";

  /**
   * Save the unsaveable cut to a file.
   *
   * The honest alternative to an "overwrite anyway" button, which would be exactly the
   * silent clobber the version check exists to prevent. A blob download rather than a
   * request: the server must not be asked to accept this document, and the user's work
   * still ends up somewhere they can get at it.
   */
  function downloadConflictedCut() {
    const json = editor.conflictedDocumentJson();
    if (!json) return;
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `tally-cut-${projectId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Header: identity, save state, undo/redo. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Btn
            size="sm"
            variant="ghost"
            icon={<ChevronLeft size={14} />}
            onClick={() => router.push(`/dashboard/video?project=${projectId}`)}
          >
            Video
          </Btn>
          <span style={{ fontSize: 13, color: color.textDim }}>
            {projectTitle ?? "Untitled video"}
          </span>
          <SaveBadge state={editor.saveState} />
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <Btn
            size="sm"
            variant="ghost"
            icon={<Undo2 size={14} />}
            disabled={!editor.canUndo}
            onClick={editor.undo}
            aria-label="Undo"
          >
            Undo
          </Btn>
          <Btn
            size="sm"
            variant="ghost"
            icon={<Redo2 size={14} />}
            disabled={!editor.canRedo}
            onClick={editor.redo}
            aria-label="Redo"
          >
            Redo
          </Btn>
        </div>
      </div>

      {conflicted && (
        <Card tone="warning" pad={13}>
          <p style={{ margin: 0, fontSize: 12.5, color: color.warning, lineHeight: 1.6 }}>
            {editor.error}
          </p>
          <p
            style={{
              margin: "7px 0 0",
              fontSize: 12,
              color: color.textDim,
              lineHeight: 1.6,
            }}
          >
            {/*
              The count is the point. A conflict is terminal, so every gesture since it
              happened is applied on screen and unsaveable — without saying how many, the
              editor looks like it is still working. Composed in `edit-history` so the
              wording is covered by a test rather than only by reading it here.
            */}
            {conflictSummary(editor.editsSinceConflict)}
          </p>
          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn
              size="sm"
              variant="ghost"
              icon={<Download size={13} />}
              onClick={downloadConflictedCut}
            >
              Download this cut
            </Btn>
            <Btn
              size="sm"
              variant="ghost"
              icon={<RefreshCw size={13} />}
              onClick={() => void editor.reload()}
            >
              Discard and load the saved cut
            </Btn>
          </div>
        </Card>
      )}

      {editor.error && !conflicted && (
        <Card tone="warning" pad={13}>
          <p style={{ margin: 0, fontSize: 12.5, color: color.warning, lineHeight: 1.6 }}>
            {editor.error}
          </p>
        </Card>
      )}

      <div
        style={{
          display: "grid",
          // Preview and panel side by side on a wide screen, stacked below it. No media
          // query needed: the panel column collapses when there is no room for 300px.
          gridTemplateColumns: "minmax(0, 1fr) minmax(260px, 300px)",
          gap: 14,
          alignItems: "start",
        }}
      >
        <Card pad={14}>
          <div style={{ containerType: "inline-size" }}>
            <Preview
              document={doc}
              clips={compiled.clips}
              assetUrls={editor.assetUrls}
              playheadMs={playheadMs}
              playing={playing}
              muted={muted}
              onBoostMode={setBoostMode}
            />
          </div>

          {/* Transport. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 12,
              flexWrap: "wrap",
            }}
          >
            <Btn
              size="sm"
              onClick={togglePlay}
              icon={playing ? <Pause size={13} /> : <Play size={13} />}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? "Pause" : "Play"}
            </Btn>

            <span
              style={{
                fontFamily: font.mono,
                fontSize: 12,
                color: color.textBright,
                minWidth: 108,
              }}
            >
              {timecode(playheadMs)} / {timecode(durationMs)}
            </span>

            <input
              type="range"
              min={0}
              max={Math.max(1, durationMs)}
              step={10}
              value={Math.min(playheadMs, durationMs)}
              aria-label="Playhead"
              onChange={(event) => seek(Number(event.target.value))}
              style={{ flex: 1, minWidth: 120, accentColor: color.accent }}
            />

            <button
              type="button"
              onClick={() => setMuted((m) => !m)}
              aria-label={muted ? "Unmute preview" : "Mute preview"}
              aria-pressed={muted}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 28,
                height: 28,
                background: "transparent",
                border: `1px solid ${color.border}`,
                borderRadius: radius.sm,
                color: muted ? color.accent : color.textDim,
                cursor: "pointer",
              }}
            >
              {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
          </div>

          <p
            style={{
              margin: "10px 0 0",
              fontSize: 11,
              color: color.textFaint,
              lineHeight: 1.55,
            }}
          >
            Preview timing, order, trims and levels are exactly what the export will
            render. Text and captions are laid out by the browser here and drawn by the
            renderer in the export, so a long line may wrap at a different word and sit a
            line higher or lower. The words, the timing and the position on screen are the
            same.
            {boostNotice(boostMode) ? ` ${boostNotice(boostMode)}` : ""}
          </p>
        </Card>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Card pad={14}>
            <PanelTitle>Properties</PanelTitle>
            {selected ? (
              <ClipProperties
                clip={selected.clip}
                track={selected.track}
                playheadMs={playheadMs}
                dispatch={dispatch}
                onDelete={deleteSelected}
              />
            ) : (
              <p style={{ margin: 0, fontSize: 12.5, color: color.textFaint, lineHeight: 1.6 }}>
                Select a clip in the timeline to see and change its properties.
              </p>
            )}
          </Card>

          <Card pad={14}>
            <PanelTitle>Export</PanelTitle>
            <ExportPanel
              projectId={projectId}
              saveState={editor.saveState}
              flush={editor.flush}
            />
          </Card>
        </div>
      </div>

      {/* Timeline toolbar. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Btn
          size="sm"
          variant="ghost"
          icon={<Scissors size={13} />}
          disabled={!selected}
          onClick={splitAtPlayhead}
        >
          Split
        </Btn>
        <Btn
          size="sm"
          variant="ghost"
          icon={<Copy size={13} />}
          disabled={!selected}
          onClick={duplicateSelected}
        >
          Duplicate
        </Btn>
        <Btn
          size="sm"
          variant="danger"
          icon={<Trash2 size={13} />}
          disabled={!selected}
          onClick={deleteSelected}
        >
          Delete
        </Btn>

        <div style={{ flex: 1 }} />

        <Btn
          size="sm"
          variant="ghost"
          icon={<ZoomOut size={13} />}
          disabled={zoomIndex === 0}
          onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
          aria-label="Zoom out"
        />
        <span style={{ fontSize: 11, color: color.textFaint, fontFamily: font.mono }}>
          {zoomIndex + 1}/{ZOOM_LEVELS.length}
        </span>
        <Btn
          size="sm"
          variant="ghost"
          icon={<ZoomIn size={13} />}
          disabled={zoomIndex === ZOOM_LEVELS.length - 1}
          onClick={() => setZoomIndex((i) => Math.min(ZOOM_LEVELS.length - 1, i + 1))}
          aria-label="Zoom in"
        />
      </div>

      <Timeline
        document={doc}
        pxPerMs={pxPerMs}
        playheadMs={playheadMs}
        selectedClipId={selectedClipId}
        onSelect={setSelectedClipId}
        onSeek={seek}
        dispatch={dispatch}
      />

      <p style={{ margin: 0, fontSize: 11, color: color.textFaint, lineHeight: 1.6 }}>
        Space plays · S splits at the playhead · Delete removes the selected clip ·
        Ctrl/Cmd+Z undoes · Ctrl/Cmd+Shift+Z redoes · arrows step a frame, with Shift a
        second
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PanelTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: font.display,
        fontSize: 11,
        letterSpacing: 1.3,
        textTransform: "uppercase",
        color: color.textFaint,
        marginBottom: 11,
      }}
    >
      {children}
    </div>
  );
}

/** Save state, in words. Never claims "Saved" while a request is still out. */
function SaveBadge({ state }: { state: SaveState }) {
  const label: Record<SaveState, string> = {
    saved: "Saved",
    dirty: "Unsaved changes",
    saving: "Saving…",
    conflict: "Edited elsewhere",
    error: "Save failed — retrying",
  };

  const tone: Record<SaveState, string> = {
    saved: color.positive,
    dirty: color.textFaint,
    saving: color.info,
    conflict: color.danger,
    error: color.warning,
  };

  return (
    <span
      role="status"
      aria-live="polite"
      style={{
        fontSize: 11,
        color: tone[state],
        border: `1px solid ${color.border}`,
        borderRadius: radius.pill,
        padding: "2px 9px",
        whiteSpace: "nowrap",
      }}
    >
      {label[state]}
    </span>
  );
}

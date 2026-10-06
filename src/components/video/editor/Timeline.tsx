"use client";

/**
 * The multi-track timeline.
 *
 * Lanes are the document's tracks in display order; clips are positioned by the same
 * milliseconds the compiler hands ffmpeg. There is no timeline model — this component
 * reads the document and emits operations, so what is drawn and what is exported cannot
 * disagree.
 *
 * Drag is implemented with pointer events and pointer capture rather than a drag-and-drop
 * library. Three reasons: HTML5 drag-and-drop cannot report continuous positions, pointer
 * capture means a fast drag that leaves the clip does not drop it, and it gives touch and
 * mouse the same code path. The gesture is resolved against the *document at gesture
 * start* held in a ref, so each pointer move is an absolute placement rather than an
 * accumulation of deltas — that is what stops a drag from creeping when a move is clamped
 * or refused.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { EyeOff, Volume, VolumeX } from "lucide-react";
import { color, font, radius, trackFill } from "@/lib/design/tokens";
import {
  isAudioTrack,
  isVisualTrack,
  type EditClip,
  type EditDocument,
  type EditTrack,
} from "@/lib/video/edit-document";
import {
  clipEndMs,
  findClip,
  minDurationFor,
  orderedClips,
  type EditOperation,
} from "@/lib/video/edit-ops";
import {
  laneHeight,
  msToPx,
  orderedTracks,
  pxToMs,
  rulerTicks,
  snap,
  snapTargets,
  timecode,
  timelineSpanMs,
  trackLabel,
} from "@/lib/video/editor-view";

/** Width of the lane-label gutter. */
const GUTTER_PX = 96;

/** Height of the time ruler. */
const RULER_PX = 26;

/** Hit area of a trim handle. Wide enough to grab, narrow enough not to eat the clip body. */
const HANDLE_PX = 8;

/** Below this width a clip has no room for handles or a label, so it draws as a sliver. */
const MIN_LABEL_PX = 26;

type Gesture =
  | { kind: "move"; clipId: string; trackId: string; grabOffsetMs: number }
  | { kind: "trimStart"; clipId: string }
  | { kind: "trimEnd"; clipId: string }
  | { kind: "scrub" };

export interface TimelineProps {
  document: EditDocument;
  pxPerMs: number;
  playheadMs: number;
  selectedClipId: string | null;
  onSelect: (clipId: string | null) => void;
  onSeek: (ms: number) => void;
  dispatch: (operation: EditOperation) => void;
}

export function Timeline({
  document: doc,
  pxPerMs,
  playheadMs,
  selectedClipId,
  onSelect,
  onSeek,
  dispatch,
}: TimelineProps) {
  const laneAreaRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  /**
   * The document as it was when the gesture began.
   *
   * Gestures resolve against this rather than against the live document so a clamped or
   * refused move does not shift the frame of reference mid-drag. Without it, dragging a
   * clip into a wall and back out again would leave it offset by however far the clamp
   * moved it.
   */
  const originRef = useRef<EditDocument>(doc);
  const [dragging, setDragging] = useState(false);

  const spanMs = timelineSpanMs(doc);
  const contentWidth = Math.max(320, msToPx(spanMs, pxPerMs));
  const tracks = orderedTracks(doc);

  /** Pointer x within the lane area, in milliseconds. */
  const msAtPointer = useCallback(
    (clientX: number): number => {
      const element = laneAreaRef.current;
      if (!element) return 0;
      const rect = element.getBoundingClientRect();
      return Math.max(0, pxToMs(clientX - rect.left + element.scrollLeft, pxPerMs));
    },
    [pxPerMs],
  );

  const endGesture = useCallback(() => {
    gestureRef.current = null;
    setDragging(false);
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (!gesture) return;

      const pointerMs = msAtPointer(event.clientX);
      const origin = originRef.current;

      if (gesture.kind === "scrub") {
        onSeek(pointerMs);
        return;
      }

      const located = findClip(origin, gesture.clipId);
      if (!located) return;
      const { clip } = located;

      const targets = snapTargets(origin, playheadMs, gesture.clipId);

      if (gesture.kind === "move") {
        const raw = Math.max(0, pointerMs - gesture.grabOffsetMs);
        dispatch({
          type: "moveClip",
          clipId: gesture.clipId,
          startMs: snap(raw, targets, pxPerMs, clip.durationMs),
        });
        return;
      }

      if (gesture.kind === "trimStart") {
        // Bounded here as well as in the operation so the snap cannot pull the handle past
        // the clip's tail and produce a refusal the user reads as a stuck handle.
        const limit = clipEndMs(clip) - minDurationFor(clip);
        dispatch({
          type: "trimClipStart",
          clipId: gesture.clipId,
          startMs: Math.min(limit, snap(pointerMs, targets, pxPerMs)),
        });
        return;
      }

      const floor = clip.startMs + minDurationFor(clip);
      dispatch({
        type: "trimClipEnd",
        clipId: gesture.clipId,
        endMs: Math.max(floor, snap(pointerMs, targets, pxPerMs)),
      });
    },
    [dispatch, msAtPointer, onSeek, playheadMs, pxPerMs],
  );

  function beginGesture(
    event: ReactPointerEvent<HTMLDivElement>,
    gesture: Gesture,
  ) {
    // Left button / primary contact only: a right-click drag would otherwise move a clip
    // with the context menu open.
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    originRef.current = doc;
    gestureRef.current = gesture;
    setDragging(true);
  }

  /** Escape abandons a drag in progress by undoing back to where it started. */
  useEffect(() => {
    if (!dragging) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") endGesture();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dragging, endGesture]);

  return (
    <div
      style={{
        border: `1px solid ${color.border}`,
        borderRadius: radius.lg,
        background: color.card,
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex" }}>
        {/* Gutter: lane names, mute and hide. Fixed while the lanes scroll. */}
        <div
          style={{
            width: GUTTER_PX,
            flexShrink: 0,
            borderRight: `1px solid ${color.border}`,
            background: color.inputBg,
          }}
        >
          <div
            style={{
              height: RULER_PX,
              borderBottom: `1px solid ${color.border}`,
              display: "flex",
              alignItems: "center",
              padding: "0 8px",
              fontFamily: font.mono,
              fontSize: 10.5,
              color: color.textFaint,
            }}
          >
            {timecode(playheadMs)}
          </div>
          {tracks.map((track) => (
            <LaneGutter key={track.id} track={track} dispatch={dispatch} />
          ))}
        </div>

        {/* Lanes. One scroll container, so the ruler and every lane stay aligned. */}
        <div
          ref={laneAreaRef}
          onPointerMove={onPointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
          style={{
            flex: 1,
            overflowX: "auto",
            overflowY: "hidden",
            position: "relative",
            // Stops a touch drag from scrolling the page while a clip is being moved.
            touchAction: dragging ? "none" : "pan-x",
            cursor: dragging ? "grabbing" : undefined,
          }}
        >
          <div style={{ width: contentWidth, position: "relative" }}>
            <Ruler
              spanMs={spanMs}
              pxPerMs={pxPerMs}
              onPointerDown={(event) => {
                onSeek(msAtPointer(event.clientX));
                beginGesture(event, { kind: "scrub" });
              }}
            />

            {tracks.map((track) => (
              <div
                key={track.id}
                onPointerDown={() => onSelect(null)}
                style={{
                  position: "relative",
                  height: laneHeight(track.kind),
                  borderBottom: `1px solid ${color.borderFaint}`,
                  background:
                    track.hidden || track.muted ? color.inputBg : undefined,
                }}
              >
                {orderedClips(track).map((clip) => (
                  <ClipBox
                    key={clip.id}
                    clip={clip}
                    track={track}
                    pxPerMs={pxPerMs}
                    selected={clip.id === selectedClipId}
                    onSelect={onSelect}
                    onBeginMove={(event, grabOffsetMs) =>
                      beginGesture(event, {
                        kind: "move",
                        clipId: clip.id,
                        trackId: track.id,
                        grabOffsetMs,
                      })
                    }
                    onBeginTrimStart={(event) =>
                      beginGesture(event, { kind: "trimStart", clipId: clip.id })
                    }
                    onBeginTrimEnd={(event) =>
                      beginGesture(event, { kind: "trimEnd", clipId: clip.id })
                    }
                  />
                ))}
              </div>
            ))}

            {/* Playhead, drawn over every lane. */}
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: msToPx(playheadMs, pxPerMs),
                width: 1,
                background: color.accent,
                pointerEvents: "none",
                boxShadow: `0 0 6px ${color.accent}`,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Ruler({
  spanMs,
  pxPerMs,
  onPointerDown,
}: {
  spanMs: number;
  pxPerMs: number;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      role="presentation"
      style={{
        position: "relative",
        height: RULER_PX,
        borderBottom: `1px solid ${color.border}`,
        background: color.inputBg,
        cursor: "text",
        userSelect: "none",
      }}
    >
      {rulerTicks(spanMs, pxPerMs).map((ms) => (
        <div
          key={ms}
          style={{
            position: "absolute",
            left: msToPx(ms, pxPerMs),
            top: 0,
            bottom: 0,
            borderLeft: `1px solid ${color.border}`,
            paddingLeft: 4,
            fontFamily: font.mono,
            fontSize: 9.5,
            color: color.textFaint,
            lineHeight: `${RULER_PX}px`,
            pointerEvents: "none",
          }}
        >
          {timecode(ms)}
        </div>
      ))}
    </div>
  );
}

function LaneGutter({
  track,
  dispatch,
}: {
  track: EditTrack;
  dispatch: (operation: EditOperation) => void;
}) {
  const audio = isAudioTrack(track.kind);
  const visual = isVisualTrack(track.kind);

  return (
    <div
      style={{
        height: laneHeight(track.kind),
        borderBottom: `1px solid ${color.borderFaint}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 4,
        padding: "0 6px 0 8px",
      }}
    >
      <span
        style={{
          fontFamily: font.display,
          fontSize: 9.5,
          letterSpacing: 1,
          textTransform: "uppercase",
          color: color.textDim,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {trackLabel(track.kind, track.label)}
      </span>

      {audio && (
        <button
          type="button"
          onClick={() => dispatch({ type: "setTrackMuted", trackId: track.id, muted: !track.muted })}
          aria-label={`${track.muted ? "Unmute" : "Mute"} ${trackLabel(track.kind, track.label)}`}
          aria-pressed={track.muted}
          style={iconButtonStyle(track.muted)}
        >
          {track.muted ? <VolumeX size={12} /> : <Volume size={12} />}
        </button>
      )}

      {visual && (
        <button
          type="button"
          onClick={() =>
            dispatch({ type: "setTrackHidden", trackId: track.id, hidden: !track.hidden })
          }
          aria-label={`${track.hidden ? "Show" : "Hide"} ${trackLabel(track.kind, track.label)}`}
          aria-pressed={track.hidden}
          style={iconButtonStyle(track.hidden)}
        >
          <EyeOff size={12} />
        </button>
      )}
    </div>
  );
}

function iconButtonStyle(active: boolean) {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 20,
    height: 20,
    flexShrink: 0,
    background: "transparent",
    border: "none",
    borderRadius: radius.sm,
    cursor: "pointer",
    color: active ? color.accent : color.textFaint,
  } as const;
}

// ---------------------------------------------------------------------------

/**
 * Lane tints, so a glance tells picture from sound from text.
 *
 * The values live in the token layer because each theme needs its own set:
 * the dark tints would read as mud on a light bed.
 */
const KIND_TINT: Record<EditTrack["kind"], string> = trackFill;

function ClipBox({
  clip,
  track,
  pxPerMs,
  selected,
  onSelect,
  onBeginMove,
  onBeginTrimStart,
  onBeginTrimEnd,
}: {
  clip: EditClip;
  track: EditTrack;
  pxPerMs: number;
  selected: boolean;
  onSelect: (clipId: string) => void;
  onBeginMove: (event: ReactPointerEvent<HTMLDivElement>, grabOffsetMs: number) => void;
  onBeginTrimStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onBeginTrimEnd: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const left = msToPx(clip.startMs, pxPerMs);
  const width = Math.max(2, msToPx(clip.durationMs, pxPerMs));
  const roomy = width >= MIN_LABEL_PX;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${trackLabel(track.kind, track.label)} clip at ${timecode(clip.startMs)}`}
      aria-pressed={selected}
      onPointerDown={(event) => {
        onSelect(clip.id);
        // Where in the clip the pointer grabbed it, so the clip does not jump its own
        // left edge to the cursor on the first move.
        const rect = event.currentTarget.getBoundingClientRect();
        onBeginMove(event, pxToMs(event.clientX - rect.left, pxPerMs));
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(clip.id);
        }
      }}
      style={{
        position: "absolute",
        left,
        top: 3,
        width,
        bottom: 3,
        background: KIND_TINT[track.kind],
        border: `1px solid ${selected ? color.accent : color.borderLight}`,
        borderRadius: radius.sm,
        boxShadow: selected ? `0 0 0 1px ${color.accent}` : undefined,
        cursor: "grab",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        padding: roomy ? "0 8px" : 0,
        opacity: track.hidden ? 0.45 : 1,
        touchAction: "none",
      }}
    >
      {roomy && (
        <span
          style={{
            fontSize: 10.5,
            color: color.textBright,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            pointerEvents: "none",
          }}
        >
          {clipCaption(clip, track)}
        </span>
      )}

      {roomy && (
        <>
          <TrimHandle side="start" onPointerDown={onBeginTrimStart} />
          <TrimHandle side="end" onPointerDown={onBeginTrimEnd} />
        </>
      )}
    </div>
  );
}

/**
 * What a clip says on its face.
 *
 * Text and caption clips show their content — that is what identifies them. Everything
 * else shows its storyboard label, falling back to the lane name, because a storage key is
 * not something a user recognises.
 */
function clipCaption(clip: EditClip, track: EditTrack): string {
  if (clip.text) return clip.text;
  if (clip.label) return clip.label;
  return trackLabel(track.kind, track.label);
}

function TrimHandle({
  side,
  onPointerDown,
}: {
  side: "start" | "end";
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="presentation"
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        [side === "start" ? "left" : "right"]: 0,
        width: HANDLE_PX,
        cursor: "ew-resize",
        background: "transparent",
        touchAction: "none",
      }}
    />
  );
}

/**
 * View geometry for the editor — milliseconds to pixels, and "what is on screen at t".
 *
 * Everything here is pure and derived from a compiled document. That is the point: the
 * preview, the timeline and the properties panel all answer their questions through these
 * functions, so none of them keeps a copy of the cut that could fall out of step with the
 * document. There is no editor state model — selection, playhead and zoom are the only
 * things the component owns, and none of them describe the video.
 *
 * The preview is HTML: real `<video>`, `<img>` and `<audio>` elements positioned by the
 * same numbers `compileEditDocument` hands the ffmpeg builder. It is not a second
 * renderer — it cannot be, because it has no rules of its own. `frameAt` decides what is
 * visible and audible at a moment, and it reads only compiled clips.
 */

import {
  isAudioTrack,
  isVisualTrack,
  type CompiledClip,
  type EditDocument,
  type TrackKind,
} from "@/lib/video/edit-document";
import { contentEndMs } from "@/lib/video/edit-ops";

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

/**
 * Zoom levels, in pixels per millisecond.
 *
 * A discrete ladder rather than a continuous scale so the zoom buttons are predictable
 * and a rounding error cannot leave the timeline at 0.0000001 px/ms. The range spans a
 * ten-minute video fitting on screen (0.01 — 600 px/s) up to individual frames being
 * distinguishable (0.4 — a 33ms frame is 13px wide).
 */
export const ZOOM_LEVELS: readonly number[] = [
  0.01, 0.02, 0.04, 0.08, 0.15, 0.25, 0.4,
];

/** Where a freshly opened editor sits: a 60s video is about 900px of timeline. */
export const DEFAULT_ZOOM_INDEX = 2;

export function zoomAt(index: number): number {
  const clamped = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, index));
  return ZOOM_LEVELS[clamped] ?? 0.04;
}

export function msToPx(ms: number, pxPerMs: number): number {
  return ms * pxPerMs;
}

export function pxToMs(px: number, pxPerMs: number): number {
  if (pxPerMs <= 0) return 0;
  return Math.round(px / pxPerMs);
}

/**
 * How wide the scrollable timeline is.
 *
 * The content's own extent plus a trailing margin, so there is always somewhere to drag a
 * clip *to*. Without the margin the last clip could never be moved later, because the
 * canvas would end exactly where it does.
 */
export const TRAILING_MARGIN_MS = 4_000;

export function timelineSpanMs(document: EditDocument): number {
  return Math.max(10_000, contentEndMs(document) + TRAILING_MARGIN_MS);
}

// ---------------------------------------------------------------------------
// Ruler
// ---------------------------------------------------------------------------

/** Tick steps in ms, coarse to fine. Chosen so labels read as round times. */
const TICK_STEPS: readonly number[] = [
  60_000, 30_000, 15_000, 10_000, 5_000, 2_000, 1_000, 500, 250, 100,
];

/** Below this many pixels apart, tick labels collide. */
const MIN_TICK_PX = 68;

/**
 * The tick step to draw at a given zoom.
 *
 * The *finest* step whose ticks are still at least `MIN_TICK_PX` apart, so zooming in
 * reveals more detail without the labels ever overlapping. Scanned fine-to-coarse for
 * that reason: taking the first coarse step that happens to clear the threshold would
 * label a fully zoomed-in timeline once a minute.
 *
 * Falls back to the coarsest step when even a minute is too narrow to label, which is the
 * only case where labels may crowd — the alternative is a ruler with no marks at all.
 */
export function tickStepMs(pxPerMs: number): number {
  for (let i = TICK_STEPS.length - 1; i >= 0; i -= 1) {
    const step = TICK_STEPS[i];
    if (step !== undefined && step * pxPerMs >= MIN_TICK_PX) return step;
  }
  return TICK_STEPS[0] ?? 60_000;
}

export function rulerTicks(spanMs: number, pxPerMs: number): number[] {
  const step = tickStepMs(pxPerMs);
  const ticks: number[] = [];
  // Bounded independently of `spanMs` so a pathological document cannot make the ruler
  // allocate an unbounded array during a render.
  for (let ms = 0; ms <= spanMs && ticks.length < 2_000; ms += step) {
    ticks.push(ms);
  }
  return ticks;
}

/**
 * A timecode with hundredths — `1:04.30`.
 *
 * `formatMs` from the dashboard is second-resolution, which is right for a video length
 * and wrong for a playhead: an editor trimming a 200ms gap needs to see it change.
 */
export function timecode(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  const hundredths = Math.floor((safe % 1_000) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

/** How close, in pixels, a drag has to be to snap. Pixels, not ms, so it feels the same at every zoom. */
export const SNAP_PX = 7;

/**
 * The edges a drag snaps to: every clip boundary, plus zero and the playhead.
 *
 * The dragged clip's own edges are excluded — snapping a clip to itself would pin it in
 * place. Deduplicated and sorted so the caller can scan it cheaply on every pointer move.
 */
export function snapTargets(
  document: EditDocument,
  playheadMs: number,
  excludeClipId: string | null,
): number[] {
  const edges = new Set<number>([0, Math.round(playheadMs)]);
  for (const track of document.tracks) {
    for (const clip of track.clips) {
      if (clip.id === excludeClipId) continue;
      edges.add(clip.startMs);
      edges.add(clip.startMs + clip.durationMs);
    }
  }
  return [...edges].sort((a, b) => a - b);
}

/**
 * Pull a value onto the nearest target within tolerance.
 *
 * Returns the value unchanged when nothing is close, so the caller can apply this
 * unconditionally. `durationMs` lets a *move* snap by either edge: dragging a clip so its
 * tail meets the next clip's head is the common gesture, and snapping only the head would
 * make that alignment impossible to hit.
 */
export function snap(
  valueMs: number,
  targets: readonly number[],
  pxPerMs: number,
  durationMs = 0,
): number {
  const tolerance = pxPerMs > 0 ? SNAP_PX / pxPerMs : 0;
  let best = valueMs;
  let bestDistance = tolerance;

  for (const target of targets) {
    const head = Math.abs(target - valueMs);
    if (head <= bestDistance) {
      bestDistance = head;
      best = target;
    }
    if (durationMs > 0) {
      const tail = Math.abs(target - (valueMs + durationMs));
      if (tail <= bestDistance) {
        bestDistance = tail;
        best = target - durationMs;
      }
    }
  }

  return Math.max(0, Math.round(best));
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

/** Row height for a lane in the timeline. Visual lanes are taller — they carry thumbnails. */
export function laneHeight(kind: TrackKind): number {
  return isVisualTrack(kind) ? 56 : 36;
}

/** The gutter label for a track, falling back to the kind when unnamed. */
const KIND_LABEL: Record<TrackKind, string> = {
  video: "Video",
  image: "B-roll",
  text: "Text",
  caption: "Captions",
  voiceover: "Voiceover",
  music: "Music",
};

export function trackLabel(kind: TrackKind, label: string | null): string {
  return label ?? KIND_LABEL[kind];
}

/**
 * Display order for the lanes.
 *
 * `TRACK_KINDS` order, which puts picture above sound — the convention every editor
 * follows, and the same order the compiler stacks in, so what is on top in the timeline
 * is what is on top in the frame. Ties broken by the track's own `order` then its
 * document position, which keeps the list stable across renders.
 */
const KIND_RANK: Record<TrackKind, number> = {
  video: 0,
  image: 1,
  text: 2,
  caption: 3,
  voiceover: 4,
  music: 5,
};

export function orderedTracks(document: EditDocument): EditDocument["tracks"] {
  return [...document.tracks].sort((a, b) => {
    const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (byKind !== 0) return byKind;
    return a.order - b.order;
  });
}

// ---------------------------------------------------------------------------
// What is on screen at a moment
// ---------------------------------------------------------------------------

/** A media clip the preview should have playing, and where in the file it should be. */
export interface ActiveMedia {
  clipId: string;
  storageKey: string;
  trackKind: TrackKind;
  /** Seconds into the source file, for a media element's `currentTime`. */
  sourceTimeSeconds: number;
  /** Gain the element should play at. Zero on a muted track. */
  gain: number;
  /** True when the source is time-based and can therefore be seeked and played. */
  timeBased: boolean;
}

export interface EditorFrame {
  /**
   * The visual on screen, or null in a gap.
   *
   * Topmost wins: clips are compared by `layer`, which is the compiler's own stacking
   * value, so the preview picks the same clip the renderer would paint last.
   */
  visual: ActiveMedia | null;
  /** On-screen text at this moment, topmost first. */
  texts: string[];
  /** The caption line at this moment, if any. */
  caption: string | null;
  /** Every audible clip at this moment — narration and music play together. */
  audio: ActiveMedia[];
}

/**
 * Whether a clip covers a moment.
 *
 * Half-open, matching the schema's overlap rule and the compiler's cue clipping: a clip
 * ending at 2000ms is not on screen at 2000ms, which is exactly when the next one starts.
 * Without this the preview would show two visuals for one millisecond at every cut.
 */
function covers(clip: CompiledClip, timeMs: number): boolean {
  return timeMs >= clip.startMs && timeMs < clip.startMs + clip.durationMs;
}

/**
 * Where in the source file a clip is at a given timeline moment.
 *
 * `sourceInMs` plus the elapsed part of the clip. When the window is shorter than the
 * clip — a 3s shot held for 5s, which the schema allows — the position is clamped to the
 * window's end rather than reading past it, so a held shot freezes on its last frame
 * instead of drifting into the following material.
 */
export function sourceTimeMs(clip: CompiledClip, timeMs: number): number {
  const elapsed = Math.max(0, timeMs - clip.startMs);
  const base = clip.sourceInMs ?? 0;
  if (clip.sourceOutMs !== null && clip.sourceOutMs > base) {
    return Math.min(base + elapsed, clip.sourceOutMs);
  }
  return base + elapsed;
}

function toActiveMedia(clip: CompiledClip, timeMs: number): ActiveMedia | null {
  if (!clip.storageKey) return null;
  return {
    clipId: clip.clipId,
    storageKey: clip.storageKey,
    trackKind: clip.trackKind,
    sourceTimeSeconds: sourceTimeMs(clip, timeMs) / 1000,
    gain: clip.gain,
    // A still has no length to seek into. Told apart by the recorded duration rather
    // than by guessing from the key, the same way the compiler does it.
    timeBased: clip.sourceDurationMs !== null && clip.sourceDurationMs > 0,
  };
}

/**
 * Resolve the frame at a moment.
 *
 * The one function the preview reads. Given the compiler's clip list it decides what to
 * show and what to hear — no separate playback model, no per-track state, nothing to keep
 * in sync. Called on every animation frame, so it stays a single linear pass.
 */
export function frameAt(
  clips: readonly CompiledClip[],
  timeMs: number,
): EditorFrame {
  let visual: CompiledClip | null = null;
  const texts: Array<{ layer: number; text: string }> = [];
  let caption: CompiledClip | null = null;
  const audio: ActiveMedia[] = [];

  for (const clip of clips) {
    if (!covers(clip, timeMs)) continue;

    if (clip.trackKind === "caption") {
      if (clip.text && (!caption || clip.layer >= caption.layer)) caption = clip;
      continue;
    }

    if (clip.trackKind === "text") {
      if (clip.text) texts.push({ layer: clip.layer, text: clip.text });
      continue;
    }

    if (isAudioTrack(clip.trackKind)) {
      const active = toActiveMedia(clip, timeMs);
      if (active) audio.push(active);
      continue;
    }

    if (isVisualTrack(clip.trackKind) && !clip.hidden && clip.storageKey) {
      if (!visual || clip.layer >= visual.layer) visual = clip;
    }
  }

  return {
    visual: visual ? toActiveMedia(visual, timeMs) : null,
    texts: texts.sort((a, b) => b.layer - a.layer).map((entry) => entry.text),
    caption: caption?.text ?? null,
    audio,
  };
}

/**
 * The aspect ratio the preview box should hold, as a CSS `aspect-ratio` value.
 *
 * Read from the document's format rather than from the first asset's own dimensions: the
 * export is the format's frame, and a preview shaped like the source footage would show a
 * composition the finished video does not have.
 */
export function previewAspect(format: EditDocument["format"]): string {
  if (format === "portrait") return "9 / 16";
  if (format === "square") return "1 / 1";
  return "16 / 9";
}

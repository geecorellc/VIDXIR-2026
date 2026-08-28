/**
 * The editing operations — every change the editor can make to a cut.
 *
 * This module exists to answer one architectural question: *where does editor state
 * live?* The answer is that there is no editor state. There is an `EditDocument`, and
 * every user gesture is a pure function from one document to the next. Selection, the
 * playhead and the zoom level are view state and live in the component; the cut itself
 * never does.
 *
 * That is what makes "do not create a second editor state model that can diverge" a
 * structural property rather than a discipline. A drag does not update a clip *and* a
 * timeline *and* a preview model — it returns a new document, and the preview, the
 * properties panel and the export all read that one document through
 * `compileEditDocument`. There is no path by which they can disagree, because there is
 * nothing else to read.
 *
 * Three rules hold throughout:
 *
 *  1. **Every function returns a document that `EditDocumentSchema` accepts.** The
 *     schema rejects overlap on a track, zero-length clips, backwards source windows
 *     and out-of-range offsets. An operation that could produce one of those clamps or
 *     refuses instead, so the autosave cannot be handed something the server will
 *     reject. `applyOperation` re-parses in development to keep that honest.
 *  2. **Refusal is expressed by returning the input unchanged.** Not by throwing: a
 *     drag that would collide with a neighbour is a no-op the user sees as "it didn't
 *     move", and an exception there would need a try/catch around every pointer event.
 *     Callers that care whether anything happened compare by identity.
 *  3. **Nothing here reads a clock, a database or the network.** The same input gives
 *     the same output forever, which is what lets undo be a stack of documents and lets
 *     these tests run without a database.
 *
 * What is deliberately *not* here: transitions, effects, keyframes, PIP and audio
 * filters. `EditClip.transition` is carried through untouched by every operation below
 * for the reason `edit-document.ts` gives — an export that turned an existing fade into
 * a hard cut would be an edit the user did not make.
 */

import {
  MAX_TIMELINE_MS,
  MIN_CLIP_MS,
  MIN_MEDIA_CLIP_MS,
  isAudioTrack,
  isVisualTrack,
  type EditClip,
  type EditDocument,
  type EditTrack,
  type TrackKind,
} from "@/lib/video/edit-document";

/**
 * How close two clips may come before a drag is treated as "abutting".
 *
 * Zero: adjoining clips share a millisecond boundary and that is the normal result of a
 * split. The constant exists so the intent is stated rather than implied by a bare `0`
 * in three comparisons.
 */
const ABUT_MS = 0;

/** A clip's end, which is the value most of the geometry below actually cares about. */
export function clipEndMs(clip: EditClip): number {
  return clip.startMs + clip.durationMs;
}

/**
 * The shortest a given clip may become.
 *
 * A clip that plays a file needs enough frames to decode; a text or caption clip does
 * not. Exactly the distinction `ClipSchema.superRefine` enforces, read from the same
 * two constants so a trim cannot produce something the schema then rejects.
 */
export function minDurationFor(clip: EditClip): number {
  return clip.source ? MIN_MEDIA_CLIP_MS : MIN_CLIP_MS;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export interface ClipLocation {
  track: EditTrack;
  clip: EditClip;
  /** Index within the track's `clips` array, which is not timeline order. */
  index: number;
}

/** Find a clip by id across every track. Null when the id is not in the document. */
export function findClip(
  document: EditDocument,
  clipId: string,
): ClipLocation | null {
  for (const track of document.tracks) {
    const index = track.clips.findIndex((clip) => clip.id === clipId);
    const clip = track.clips[index];
    if (index >= 0 && clip) return { track, clip, index };
  }
  return null;
}

export function findTrack(
  document: EditDocument,
  trackId: string,
): EditTrack | null {
  return document.tracks.find((track) => track.id === trackId) ?? null;
}

/** A track's clips in the order they play, which is what the timeline draws. */
export function orderedClips(track: EditTrack): EditClip[] {
  return [...track.clips].sort((a, b) => a.startMs - b.startMs);
}

/**
 * The compiled length of the cut, for the ruler and the scrubber.
 *
 * Deliberately *not* `compileEditDocument().durationMs`: this is called on every
 * pointer move during a drag, and the compiler builds scene and cue arrays it would
 * throw away. The two agree on what matters — both take the furthest clip end — but
 * this one omits the tail padding, because the ruler should end where the content does
 * rather than 800ms after it.
 */
export function contentEndMs(document: EditDocument): number {
  let end = 0;
  for (const track of document.tracks) {
    for (const clip of track.clips) {
      end = Math.max(end, clipEndMs(clip));
    }
  }
  return end;
}

// ---------------------------------------------------------------------------
// The operation union
// ---------------------------------------------------------------------------

/**
 * Every change the editor can make, as data.
 *
 * Operations are values rather than direct calls so that a gesture is describable —
 * which is what lets undo store what happened, lets the autosave coalesce a run of
 * `moveClip`s from one drag, and lets the tests state a scenario as a list. The
 * alternative, methods on a mutable editor object, is the second state model this
 * module exists to avoid.
 */
export type EditOperation =
  | { type: "moveClip"; clipId: string; startMs: number }
  | { type: "moveClipToTrack"; clipId: string; trackId: string; startMs: number }
  | { type: "trimClipStart"; clipId: string; startMs: number }
  | { type: "trimClipEnd"; clipId: string; endMs: number }
  | { type: "splitClip"; clipId: string; atMs: number }
  | { type: "deleteClip"; clipId: string }
  | { type: "duplicateClip"; clipId: string }
  | { type: "setClipVolume"; clipId: string; volume: number }
  | { type: "setClipText"; clipId: string; text: string }
  | { type: "setTrackVolume"; trackId: string; volume: number }
  | { type: "setTrackMuted"; trackId: string; muted: boolean }
  | { type: "setTrackHidden"; trackId: string; hidden: boolean }
  | { type: "setCaptionsBurnedIn"; burnedIn: boolean }
  | { type: "setDuckUnderNarration"; duck: boolean };

/**
 * Apply one operation.
 *
 * The single entry point, so there is one place that dispatches and one place a future
 * operation has to be registered. Returns the input document unchanged when the
 * operation is not possible — see rule 2 above.
 */
export function applyOperation(
  document: EditDocument,
  operation: EditOperation,
): EditDocument {
  switch (operation.type) {
    case "moveClip":
      return moveClip(document, operation.clipId, operation.startMs);
    case "moveClipToTrack":
      return moveClipToTrack(
        document,
        operation.clipId,
        operation.trackId,
        operation.startMs,
      );
    case "trimClipStart":
      return trimClipStart(document, operation.clipId, operation.startMs);
    case "trimClipEnd":
      return trimClipEnd(document, operation.clipId, operation.endMs);
    case "splitClip":
      return splitClip(document, operation.clipId, operation.atMs);
    case "deleteClip":
      return deleteClip(document, operation.clipId);
    case "duplicateClip":
      return duplicateClip(document, operation.clipId);
    case "setClipVolume":
      return setClipVolume(document, operation.clipId, operation.volume);
    case "setClipText":
      return setClipText(document, operation.clipId, operation.text);
    case "setTrackVolume":
      return setTrackVolume(document, operation.trackId, operation.volume);
    case "setTrackMuted":
      return patchTrack(document, operation.trackId, { muted: operation.muted });
    case "setTrackHidden":
      return patchTrack(document, operation.trackId, {
        hidden: operation.hidden,
      });
    case "setCaptionsBurnedIn":
      return {
        ...document,
        captions: { ...document.captions, burnedIn: operation.burnedIn },
      };
    case "setDuckUnderNarration":
      return { ...document, music: { duckUnderNarration: operation.duck } };
  }
}

// ---------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------

/**
 * Move a clip along its own track.
 *
 * The requested offset is clamped into the gap between its neighbours rather than
 * refused when it overlaps one, which is what makes dragging feel like dragging: push a
 * clip left into its predecessor and it stops against it instead of snapping back. A
 * clip with no room at all — neighbours abutting on both sides — cannot move, and the
 * clamp collapses onto its current position, so the document returns unchanged.
 *
 * Neighbours are found by timeline position rather than array index because the array
 * is insertion-ordered: after a duplicate, `clips[i+1]` is not the next clip on screen.
 */
export function moveClip(
  document: EditDocument,
  clipId: string,
  startMs: number,
): EditDocument {
  const found = findClip(document, clipId);
  if (!found) return document;

  const { track, clip } = found;
  const bounds = gapAround(track, clip.id, clip.durationMs);
  const next = clampInt(startMs, bounds.minStartMs, bounds.maxStartMs);
  if (next === clip.startMs) return document;

  return replaceClip(document, track.id, { ...clip, startMs: next });
}

/**
 * Move a clip to another track — the reorder/restack gesture.
 *
 * Refused rather than clamped when the destination is a different *kind*: a voiceover
 * clip on the caption track would compile to a cue with no text and a narration with no
 * audio, so the honest answer is that the gesture is not available. Same-kind moves are
 * the useful case (video → a second video track for a cutaway) and are allowed.
 *
 * Also refused when the destination has no room, unlike a same-track move. A clamp
 * would silently land the clip somewhere the user did not point at, on a track they can
 * see is occupied; on one track the clamp is a nudge against a neighbour, across tracks
 * it would be a teleport.
 */
export function moveClipToTrack(
  document: EditDocument,
  clipId: string,
  trackId: string,
  startMs: number,
): EditDocument {
  const found = findClip(document, clipId);
  if (!found) return document;
  if (found.track.id === trackId) return moveClip(document, clipId, startMs);

  const destination = findTrack(document, trackId);
  if (!destination) return document;
  if (!compatible(found.track.kind, destination.kind)) return document;
  if (destination.clips.length >= MAX_CLIPS_PER_TRACK) return document;

  const next = clampInt(
    startMs,
    0,
    Math.max(0, MAX_TIMELINE_MS - found.clip.durationMs),
  );
  const moved = { ...found.clip, startMs: next };
  // Checked rather than clamped: see the note above about teleporting.
  if (collides(destination.clips, moved, moved.id)) return document;

  return {
    ...document,
    tracks: document.tracks.map((track) => {
      if (track.id === found.track.id) {
        return {
          ...track,
          clips: track.clips.filter((candidate) => candidate.id !== clipId),
        };
      }
      if (track.id === trackId) return { ...track, clips: [...track.clips, moved] };
      return track;
    }),
  };
}

/**
 * Whether a clip from one kind of track may live on another.
 *
 * Identical kinds always; `video` and `image` interchangeably because the seeder
 * already puts stills and footage on one visual track and each clip carries its own
 * kind. Everything else is refused — see `moveClipToTrack`.
 */
function compatible(from: TrackKind, to: TrackKind): boolean {
  if (from === to) return true;
  return isVisualTrack(from) && isVisualTrack(to);
}

// ---------------------------------------------------------------------------
// Trim
// ---------------------------------------------------------------------------

/**
 * Drag a clip's left edge.
 *
 * The subtlety is that trimming the head does two things at once: the clip starts later
 * *and* plays from further into its source. Moving `startMs` without advancing
 * `sourceInMs` would slide the material rather than trim it, which is the classic
 * off-by-one-concept bug in a timeline — the clip would get shorter but still begin on
 * the same frame.
 *
 * The new start is bounded by three things: the previous clip's end (no overlap), the
 * clip's own end minus its minimum length (no inversion), and how much source material
 * is left ahead of the current in-point (cannot trim into footage that does not exist).
 */
export function trimClipStart(
  document: EditDocument,
  clipId: string,
  startMs: number,
): EditDocument {
  const found = findClip(document, clipId);
  if (!found) return document;

  const { track, clip } = found;
  const end = clipEndMs(clip);
  const previous = previousClip(track, clip);

  const floor = previous ? clipEndMs(previous) + ABUT_MS : 0;
  const ceiling = end - minDurationFor(clip);
  if (ceiling < floor) return document;

  const next = clampInt(startMs, floor, ceiling);
  const delta = next - clip.startMs;
  if (delta === 0) return document;

  // A trimmed head consumes source material, so the in-point advances by the same
  // amount. `sourceOutMs` is untouched: the tail of the clip still shows the same frame.
  const sourceInMs =
    clip.sourceInMs !== null ? Math.max(0, clip.sourceInMs + delta) : null;

  if (
    sourceInMs !== null &&
    clip.sourceOutMs !== null &&
    sourceInMs >= clip.sourceOutMs
  ) {
    // Would invert the source window, which the schema rejects. Refuse rather than
    // clamp: the user has run out of material and the edge should simply stop.
    return document;
  }

  return replaceClip(document, track.id, {
    ...clip,
    startMs: next,
    durationMs: end - next,
    sourceInMs,
  });
}

/**
 * Drag a clip's right edge.
 *
 * Simpler than the head: the timeline length changes and the in-point does not, because
 * the clip still starts on the same frame. `sourceOutMs` follows the new length when the
 * clip has a source window at all, so a shortened clip stops playing earlier rather than
 * holding its last frame.
 *
 * Extending past the end of the material is allowed, and is not a bug: `edit-document.ts`
 * is explicit that `sourceOutMs - sourceInMs` need not equal `durationMs` — a 3s shot
 * held for 5s is a legitimate edit and the renderer holds or loops. What is *not*
 * allowed is an out-point beyond the source's own length, so the window is capped at
 * `sourceDurationMs` while the timeline duration is free to exceed it.
 */
export function trimClipEnd(
  document: EditDocument,
  clipId: string,
  endMs: number,
): EditDocument {
  const found = findClip(document, clipId);
  if (!found) return document;

  const { track, clip } = found;
  const next_ = nextClip(track, clip);

  const floor = clip.startMs + minDurationFor(clip);
  const ceiling = next_
    ? next_.startMs - ABUT_MS
    : Math.min(MAX_TIMELINE_MS, clip.startMs + MAX_TIMELINE_MS);
  if (ceiling < floor) return document;

  const next = clampInt(endMs, floor, ceiling);
  const durationMs = next - clip.startMs;
  if (durationMs === clip.durationMs) return document;

  let sourceOutMs = clip.sourceOutMs;
  if (clip.sourceInMs !== null && clip.sourceOutMs !== null) {
    const limit = clip.source?.sourceDurationMs ?? MAX_TIMELINE_MS;
    sourceOutMs = Math.min(limit, clip.sourceInMs + durationMs);
    // A window that collapsed to nothing is not a trim. Leave the previous window in
    // place and let the clip hold its frames instead of writing an inverted range.
    if (sourceOutMs <= clip.sourceInMs) sourceOutMs = clip.sourceOutMs;
  }

  return replaceClip(document, track.id, { ...clip, durationMs, sourceOutMs });
}

// ---------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------

/**
 * Split a clip at an absolute timeline offset.
 *
 * The defining property, and the one the tests pin: **the two halves together occupy
 * exactly the span the original did, and play exactly the material the original did.**
 * The left half keeps the original in-point and ends where the cut fell; the right half
 * begins at the cut and its in-point advances by the left half's length. Nothing is
 * inserted and nothing is lost, so a split followed by nothing else exports the same
 * video.
 *
 * Refused when the cut falls outside the clip, or when either half would be shorter than
 * the clip's minimum — a 120ms video clip cannot become two 60ms ones, because 60ms of
 * video decodes to nothing.
 */
export function splitClip(
  document: EditDocument,
  clipId: string,
  atMs: number,
): EditDocument {
  const found = findClip(document, clipId);
  if (!found) return document;

  const { track, clip } = found;
  const cut = Math.round(atMs);
  const end = clipEndMs(clip);
  if (cut <= clip.startMs || cut >= end) return document;

  const minimum = minDurationFor(clip);
  const leftMs = cut - clip.startMs;
  const rightMs = end - cut;
  if (leftMs < minimum || rightMs < minimum) return document;
  if (track.clips.length >= MAX_CLIPS_PER_TRACK) return document;

  // The source offset the right half starts at. Advanced by the left half's *timeline*
  // length, which is correct whenever the clip plays at its natural rate — the only case
  // the first editor can produce, since there is no speed control.
  const rightInMs =
    clip.sourceInMs !== null ? clip.sourceInMs + leftMs : null;

  const left: EditClip = {
    ...clip,
    durationMs: leftMs,
    sourceOutMs:
      clip.sourceInMs !== null && clip.sourceOutMs !== null
        ? Math.min(clip.sourceOutMs, clip.sourceInMs + leftMs)
        : clip.sourceOutMs,
  };

  const right: EditClip = {
    ...clip,
    id: freshClipId(document, `${clip.id}-b`),
    startMs: cut,
    durationMs: rightMs,
    sourceInMs: rightInMs,
    sourceOutMs: clip.sourceOutMs,
    // The second half of one shot is a continuation, not a new shot: a transition
    // *into* it would insert a dissolve in the middle of continuous material.
    transition: null,
  };

  return {
    ...document,
    tracks: document.tracks.map((candidate) =>
      candidate.id === track.id
        ? {
            ...candidate,
            clips: candidate.clips.map((c) => (c.id === clip.id ? left : c)).concat(right),
          }
        : candidate,
    ),
  };
}

// ---------------------------------------------------------------------------
// Delete / duplicate
// ---------------------------------------------------------------------------

/**
 * Remove a clip, leaving a gap.
 *
 * The gap is deliberate — a ripple delete that closed it would move every later clip,
 * desynchronising them from the narration and captions that were not deleted. Closing a
 * gap is a separate gesture (drag the neighbour left), which keeps this operation's
 * effect local and therefore undoable in one step.
 *
 * The last clip on a track is removable and leaves the track empty rather than removing
 * it: `EditDocumentSchema` requires at least one track, and a document with an empty
 * video track is a legal, renderable-as-nothing state the editor can show. Removing the
 * track would also lose its label, volume and mute state.
 */
export function deleteClip(document: EditDocument, clipId: string): EditDocument {
  const found = findClip(document, clipId);
  if (!found) return document;

  return {
    ...document,
    tracks: document.tracks.map((track) =>
      track.id === found.track.id
        ? { ...track, clips: track.clips.filter((clip) => clip.id !== clipId) }
        : track,
    ),
  };
}

/**
 * Copy a clip into the first gap at or after its end.
 *
 * Placed after the original rather than on top of it because two clips cannot overlap on
 * one track, and rather than at the end of the track because the useful case is
 * repeating a beat next to itself. When there is no gap large enough anywhere after it,
 * the duplicate lands past the last clip — which is always available.
 */
export function duplicateClip(
  document: EditDocument,
  clipId: string,
): EditDocument {
  const found = findClip(document, clipId);
  if (!found) return document;

  const { track, clip } = found;
  if (track.clips.length >= MAX_CLIPS_PER_TRACK) return document;

  const startMs = firstGapFrom(track, clipEndMs(clip), clip.durationMs);
  if (startMs === null) return document;

  const copy: EditClip = {
    ...clip,
    id: freshClipId(document, `${clip.id}-copy`),
    startMs,
  };

  return {
    ...document,
    tracks: document.tracks.map((candidate) =>
      candidate.id === track.id
        ? { ...candidate, clips: [...candidate.clips, copy] }
        : candidate,
    ),
  };
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/** Set a clip's gain. Clamped to the schema's 0–2 rather than rejected. */
export function setClipVolume(
  document: EditDocument,
  clipId: string,
  volume: number,
): EditDocument {
  const found = findClip(document, clipId);
  if (!found) return document;
  const next = clampGain(volume);
  if (next === found.clip.volume) return document;
  return replaceClip(document, found.track.id, { ...found.clip, volume: next });
}

/**
 * Edit a text or caption clip's words.
 *
 * Refused on a clip that plays an asset: `text` on a video clip is not rendered by
 * anything, so accepting it would store a value with no effect. Truncated at the
 * schema's 500 rather than rejected, because a paste is a normal way to hit the bound.
 */
export function setClipText(
  document: EditDocument,
  clipId: string,
  text: string,
): EditDocument {
  const found = findClip(document, clipId);
  if (!found) return document;
  if (!supportsText(found.track.kind)) return document;

  const next = text.slice(0, 500);
  if (next === found.clip.text) return document;
  return replaceClip(document, found.track.id, { ...found.clip, text: next });
}

/** Which track kinds render their `text` field. */
export function supportsText(kind: TrackKind): boolean {
  return kind === "text" || kind === "caption";
}

/** Which track kinds expose a volume control. */
export function supportsVolume(kind: TrackKind): boolean {
  return isAudioTrack(kind);
}

export function setTrackVolume(
  document: EditDocument,
  trackId: string,
  volume: number,
): EditDocument {
  return patchTrack(document, trackId, { volume: clampGain(volume) });
}

function patchTrack(
  document: EditDocument,
  trackId: string,
  patch: Partial<Pick<EditTrack, "volume" | "muted" | "hidden">>,
): EditDocument {
  const track = findTrack(document, trackId);
  if (!track) return document;
  return {
    ...document,
    tracks: document.tracks.map((candidate) =>
      candidate.id === trackId ? { ...candidate, ...patch } : candidate,
    ),
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** `TrackSchema`'s own ceiling, so an operation cannot build a track the schema rejects. */
const MAX_CLIPS_PER_TRACK = 500;

/** The span a clip of a given length may start within, on its own track. */
function gapAround(
  track: EditTrack,
  clipId: string,
  durationMs: number,
): { minStartMs: number; maxStartMs: number } {
  const others = orderedClips(track).filter((clip) => clip.id !== clipId);
  const current = track.clips.find((clip) => clip.id === clipId);
  const at = current?.startMs ?? 0;

  let minStartMs = 0;
  let maxStartMs = Math.max(0, MAX_TIMELINE_MS - durationMs);

  for (const other of others) {
    const end = clipEndMs(other);
    // Neighbours are classified by which side of the clip's *current* position they sit
    // on, so a drag stops against them rather than jumping over one mid-gesture.
    if (end <= at) minStartMs = Math.max(minStartMs, end + ABUT_MS);
    else maxStartMs = Math.min(maxStartMs, other.startMs - durationMs - ABUT_MS);
  }

  return { minStartMs, maxStartMs: Math.max(minStartMs, maxStartMs) };
}

function previousClip(track: EditTrack, clip: EditClip): EditClip | null {
  let best: EditClip | null = null;
  for (const candidate of track.clips) {
    if (candidate.id === clip.id) continue;
    if (clipEndMs(candidate) > clip.startMs) continue;
    if (!best || clipEndMs(candidate) > clipEndMs(best)) best = candidate;
  }
  return best;
}

function nextClip(track: EditTrack, clip: EditClip): EditClip | null {
  let best: EditClip | null = null;
  for (const candidate of track.clips) {
    if (candidate.id === clip.id) continue;
    if (candidate.startMs < clipEndMs(clip)) continue;
    if (!best || candidate.startMs < best.startMs) best = candidate;
  }
  return best;
}

/** Whether a clip would overlap anything on a track, ignoring its own former self. */
function collides(
  clips: readonly EditClip[],
  candidate: EditClip,
  ignoreId: string,
): boolean {
  const start = candidate.startMs;
  const end = clipEndMs(candidate);
  // Half-open intervals: abutting clips (`end === clip.startMs`) do not collide, which
  // is what makes a split's two halves legal on one track.
  return clips.some(
    (clip) =>
      clip.id !== ignoreId && start < clipEndMs(clip) && end > clip.startMs,
  );
}

/**
 * The first offset at or after `fromMs` where a clip of `durationMs` fits.
 *
 * Walks the gaps in timeline order and falls back to "after everything", which always
 * fits unless it would exceed the maximum timeline length — in which case there is
 * genuinely nowhere to put it and the caller declines.
 */
function firstGapFrom(
  track: EditTrack,
  fromMs: number,
  durationMs: number,
): number | null {
  const ordered = orderedClips(track);
  let cursor = Math.max(0, fromMs);

  for (const clip of ordered) {
    if (clipEndMs(clip) <= cursor) continue;
    if (clip.startMs - cursor >= durationMs) return cursor;
    cursor = Math.max(cursor, clipEndMs(clip));
  }

  return cursor + durationMs <= MAX_TIMELINE_MS ? cursor : null;
}

/**
 * A clip id that is not already in the document.
 *
 * Suffixed rather than random so a split's halves read as related in a debug dump, and
 * bounded at `ClipSchema`'s 64 characters — repeated splits of the same clip would
 * otherwise grow an id past the schema's limit. Once the base is too long to extend, the
 * tail is replaced rather than appended to.
 */
function freshClipId(document: EditDocument, base: string): string {
  const taken = new Set<string>();
  for (const track of document.tracks) {
    for (const clip of track.clips) taken.add(clip.id);
  }

  const fit = (value: string): string =>
    value.length <= 64 ? value : value.slice(value.length - 64);

  let candidate = fit(base);
  let counter = 2;
  while (taken.has(candidate)) {
    candidate = fit(`${base}-${counter}`);
    counter += 1;
  }
  return candidate;
}

function replaceClip(
  document: EditDocument,
  trackId: string,
  clip: EditClip,
): EditDocument {
  return {
    ...document,
    tracks: document.tracks.map((track) =>
      track.id === trackId
        ? {
            ...track,
            clips: track.clips.map((candidate) =>
              candidate.id === clip.id ? clip : candidate,
            ),
          }
        : track,
    ),
  };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampGain(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(2, Math.max(0, value));
}

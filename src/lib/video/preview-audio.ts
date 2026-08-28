/**
 * How the preview reproduces a gain, including the ones a media element cannot.
 *
 * `HTMLMediaElement.volume` is defined over [0, 1], but the edit document allows gains up
 * to 2 because a quiet voiceover genuinely needs boosting and ffmpeg's `volume` filter
 * applies >1 exactly (measured in `render-edit.ts`'s header notes). So a clip at 1.6 used
 * to *play* at 1.0 while exporting at 1.6 — the preview quietly disagreed with the render.
 *
 * The fix is a Web Audio gain node in front of the destination. The split below is the
 * whole idea:
 *
 *   element.volume = min(1, gain)        // what the element can do on its own
 *   gainNode.gain   = gain > 1 ? gain : 1 // the rest, and 1 (a no-op) when unneeded
 *
 * and the two multiply, because the element's own volume is applied *before* the media
 * element source node. Which gives the property that matters: if Web Audio is
 * unavailable, or refuses, or is never engaged, the element alone still plays
 * `min(1, gain)` — exactly the old clamped behaviour. The boost is additive to a working
 * preview rather than load-bearing for it, so the failure mode is the previous behaviour
 * rather than silence.
 *
 * The CORS constraint is the reason any of this needs care. `createMediaElementSource` on
 * a cross-origin resource yields silence unless the element opted in with
 * `crossOrigin="anonymous"` *and* the response carried `Access-Control-Allow-Origin` —
 * and setting that attribute against a bucket which does *not* send the header makes the
 * media fail to load altogether. Preview assets are signed S3/MinIO URLs on another
 * origin, so whether this is safe is a property of the deployment's bucket policy, not
 * something to assume. Hence `boostMode`: the attribute is only ever set once a boost is
 * actually needed, and `onError` on a boosted element reports back so the component can
 * drop to the clamped path instead of leaving the user with a dead audio element.
 */

import type { CompiledClip } from "@/lib/video/edit-document";

/** The loudest an `HTMLMediaElement` can play on its own. */
export const MAX_ELEMENT_VOLUME = 1;

/**
 * The document's own ceiling, mirrored from `edit-document`'s `Gain` schema.
 *
 * Duplicated as a constant rather than imported because that one is a Zod schema and not
 * a number; the pair is pinned together by a test so this cannot drift.
 */
export const MAX_GAIN = 2;

export interface GainSplit {
  /** Assigned to `element.volume`. Always within [0, 1], so always legal. */
  elementVolume: number;
  /**
   * Assigned to the gain node, when there is one. 1 means "nothing to add", which is the
   * signal that no audio graph is needed for this clip at all.
   */
  boost: number;
}

/**
 * Split a compiled gain into what the element can do and what needs a gain node.
 *
 * Total reproduced level is `elementVolume * boost`, which equals the requested gain for
 * every legal input — and degrades to `elementVolume` alone if the boost never gets
 * applied.
 */
export function splitGain(gain: number): GainSplit {
  if (!Number.isFinite(gain) || gain <= 0) {
    return { elementVolume: 0, boost: 1 };
  }

  const clamped = Math.min(MAX_GAIN, gain);
  if (clamped <= MAX_ELEMENT_VOLUME) {
    return { elementVolume: clamped, boost: 1 };
  }

  return { elementVolume: MAX_ELEMENT_VOLUME, boost: clamped };
}

/** Whether a gain is louder than an element can play unaided. */
export function needsBoost(gain: number): boolean {
  return splitGain(gain).boost > 1;
}

/**
 * Whether any audible clip in the cut is boosted.
 *
 * Drives whether the audio graph is built at all. A cut that never asks for more than 1 —
 * which is every cut the pipeline seeds — takes no `AudioContext`, no `crossOrigin`
 * attribute and no new failure modes.
 */
export function cutNeedsBoost(clips: readonly CompiledClip[]): boolean {
  return clips.some(
    (clip) =>
      !clip.hidden &&
      (clip.trackKind === "voiceover" || clip.trackKind === "music") &&
      needsBoost(clip.gain),
  );
}

/**
 * What the preview is doing about boosted gains, for the note under the player.
 *
 *  - `off` — nothing in the cut is boosted, so there is nothing to say.
 *  - `boosted` — the graph is live and the preview is playing the real level.
 *  - `unavailable` — a boost was wanted but could not be applied, so playback is capped
 *    and the user needs telling, because the export will still be louder.
 */
export type BoostMode = "off" | "boosted" | "unavailable";

/**
 * The sentence shown under the player, or null when there is nothing to report.
 *
 * Pure so the wording is testable — the point of this string is that it never claims the
 * preview matches the export when it does not.
 */
export function boostNotice(mode: BoostMode): string | null {
  switch (mode) {
    case "boosted":
      return "Clips boosted above 100% are previewed at their real level.";
    case "unavailable":
      return (
        "This browser or storage setup cannot preview levels above 100%, so boosted " +
        "clips are playing at 100%. The export still applies the full value."
      );
    case "off":
      return null;
  }
}

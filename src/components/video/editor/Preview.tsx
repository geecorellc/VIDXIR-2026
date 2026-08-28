"use client";

/**
 * The preview.
 *
 * HTML elements — `<video>`, `<img>`, `<audio>` — positioned and seeked by the numbers
 * `compileEditDocument` produces, which are the same numbers the ffmpeg builder receives.
 * That is what "preview and export represent the same edit document" means in practice:
 * `frameAt` is the only thing deciding what is on screen, and it reads compiled clips.
 *
 * What this is honest about: it is a preview, not a render. Transitions are deferred and
 * therefore not drawn; text and captions are laid out with CSS rather than by ffmpeg's
 * drawtext, so a long line may wrap at a different word. Timing, ordering, trims, gains,
 * mutes and hides are exact. The banner in `EditorShell` says so, because a preview that
 * implies pixel fidelity it does not have is worse than one that admits the gap.
 *
 * Playback is driven by one `requestAnimationFrame` loop advancing a clock, not by the
 * media elements' own `currentTime`. The clock is the timeline; elements are slaved to it.
 * The alternative — treating the active video as the clock — breaks at every gap, where
 * there is no element to ask.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { color, font, radius } from "@/lib/design/tokens";
import type { CompiledClip, EditDocument } from "@/lib/video/edit-document";
import { frameAt, previewAspect, type ActiveMedia } from "@/lib/video/editor-view";
import { cutNeedsBoost, splitGain, type BoostMode } from "@/lib/video/preview-audio";

/**
 * How far out of step a media element may drift before it is re-seeked.
 *
 * Seeking is expensive and visibly stutters, so it is only worth doing when the error is
 * bigger than the drift the browser accumulates on its own. 180ms is under a fifth of a
 * second — past what anyone notices in sync terms, and well above normal jitter.
 */
const RESYNC_TOLERANCE_S = 0.18;

export interface PreviewProps {
  document: EditDocument;
  clips: readonly CompiledClip[];
  assetUrls: Record<string, string>;
  playheadMs: number;
  playing: boolean;
  /** Overall preview mute, for editing in a shared space. Clip gains still apply. */
  muted: boolean;
  /**
   * Reports what happened to gains above 100%, so the shell can say so under the player.
   * Called with `unavailable` if the audio graph could not be built or a boosted element
   * failed to load, in which case playback has fallen back to the 100% cap.
   */
  onBoostMode?: (mode: BoostMode) => void;
}

export function Preview({
  document: doc,
  clips,
  assetUrls,
  playheadMs,
  playing,
  muted,
  onBoostMode,
}: PreviewProps) {
  const frame = frameAt(clips, playheadMs);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  /**
   * One audio element per storage key, kept across renders.
   *
   * Keyed by storage key rather than clip id so a split does not tear down and re-create
   * the element — which would restart the download and drop out for a moment at the cut.
   */
  const audioRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  /**
   * The Web Audio graph that reproduces gains above 100%, built lazily and once.
   *
   * One `AudioContext`, and one source + gain node per audio element. A media element may
   * only ever be passed to `createMediaElementSource` once — a second call throws and
   * leaves the element silent — so the nodes are cached by storage key and never rebuilt.
   */
  const audioGraphRef = useRef<{
    context: AudioContext;
    nodes: Map<string, GainNode>;
  } | null>(null);
  /**
   * Latched once a boost proves impossible, so it is not retried on every frame.
   *
   * A ref *and* a state flag: the ref is what `syncElement` reads on the next frame without
   * waiting for a re-render, and the state is what drops `crossOrigin` off the elements.
   * Dropping it is the part that matters — an element which failed to load *because* of
   * that attribute has to be re-created without it, or the track stays silent for the rest
   * of the session instead of falling back to the 100% cap.
   */
  const boostFailedRef = useRef(false);
  const [boostFailed, setBoostFailed] = useState(false);

  /**
   * Whether this cut asks for any level above 100% — and can still have it.
   *
   * Gates the whole boost path. A cut that does not need one — which is every cut the
   * pipeline seeds — builds no `AudioContext` and sets no `crossOrigin` attribute, so the
   * machinery cannot introduce a failure into the ordinary case. Goes false again after a
   * failure, which is what drops the attribute and restores plain playback.
   */
  const wantsBoost = cutNeedsBoost(clips) && !boostFailed;

  const visualUrl = frame.visual ? (assetUrls[frame.visual.storageKey] ?? null) : null;

  /**
   * Tell the shell what happened to boosted gains — once per distinct answer.
   *
   * De-duplicated through a ref because `syncElement` runs on every animation frame while
   * playing, and calling the parent's setter thirty times a second would re-render the
   * whole editor for a string that has not changed.
   */
  const reportedRef = useRef<BoostMode | null>(null);
  const reportBoost = useCallback(
    (mode: BoostMode) => {
      if (reportedRef.current === mode) return;
      reportedRef.current = mode;
      onBoostMode?.(mode);
    },
    [onBoostMode],
  );

  /**
   * The gain node for one audio element, creating the context and the graph on first need.
   *
   * Returns null when a boost is impossible — no Web Audio, or the browser refused to wire
   * the element up. That is not an error state for the preview: the caller has already set
   * `element.volume`, so the clip still plays at the 100% cap and the only consequence is
   * the notice under the player.
   */
  const boostNodeFor = useCallback(
    (key: string, element: HTMLAudioElement): GainNode | null => {
      if (boostFailedRef.current) return null;

      try {
        let graph = audioGraphRef.current;
        if (!graph) {
          // `webkitAudioContext` is not in the DOM lib and is still what older Safari
          // exposes; narrowed rather than cast to `any`, which the lint config forbids.
          const Ctor =
            typeof AudioContext !== "undefined"
              ? AudioContext
              : (globalThis as { webkitAudioContext?: typeof AudioContext })
                  .webkitAudioContext;
          if (!Ctor) {
            // No Web Audio at all. Reported like any other failure — the user still needs
            // to know the level they are hearing is not the level being exported.
            boostFailedRef.current = true;
            setBoostFailed(true);
            reportBoost("unavailable");
            return null;
          }
          graph = { context: new Ctor(), nodes: new Map() };
          audioGraphRef.current = graph;
        }

        const existing = graph.nodes.get(key);
        if (existing) return existing;

        const source = graph.context.createMediaElementSource(element);
        const gain = graph.context.createGain();
        source.connect(gain).connect(graph.context.destination);
        graph.nodes.set(key, gain);
        return gain;
      } catch {
        // A throw here means this browser will not route the element — most often because
        // it is cross-origin without CORS. Latched, so every later clip takes the capped
        // path immediately rather than throwing once per frame.
        boostFailedRef.current = true;
        setBoostFailed(true);
        reportBoost("unavailable");
        return null;
      }
    },
    [reportBoost],
  );

  /**
   * Slave one media element to the timeline.
   *
   * Only seeks past the tolerance, and only plays when the clock is running. A still is
   * never seeked: `timeBased` is false for it and `currentTime` on an image element does
   * not exist.
   *
   * `key` is present only for audio elements, which are the only ones that can be boosted;
   * the visual element carries `gain: 0` on every seeded cut and is not routed.
   */
  const syncElement = useCallback(
    (
      element: HTMLMediaElement,
      active: ActiveMedia,
      isPlaying: boolean,
      key?: string,
    ) => {
      if (active.timeBased && element.readyState > 0) {
        const drift = Math.abs(element.currentTime - active.sourceTimeSeconds);
        if (drift > RESYNC_TOLERANCE_S) {
          element.currentTime = active.sourceTimeSeconds;
        }
      }

      /**
       * The element takes what it can; a gain node makes up the rest.
       *
       * `element.volume` is set unconditionally and first, so if the boost below is
       * unavailable the clip still plays at `min(1, gain)` — the previous behaviour —
       * rather than at nothing.
       */
      const split = splitGain(active.gain);
      element.volume = split.elementVolume;
      element.muted = muted || active.gain === 0;

      if (key !== undefined && element instanceof HTMLAudioElement) {
        if (split.boost > 1) {
          const node = boostNodeFor(key, element);
          if (node) {
            node.gain.value = split.boost;
            reportBoost("boosted");
          }
        } else {
          // Back to a normal level: the node has to be reset to unity or the clip would
          // keep whatever boost it was last given.
          audioGraphRef.current?.nodes.get(key)?.gain.setValueAtTime(
            1,
            audioGraphRef.current.context.currentTime,
          );
        }
      }

      if (isPlaying && active.timeBased) {
        // An `AudioContext` starts suspended until a gesture; playing is that gesture, so
        // this is where it is safe to resume. Ignored on failure for the same reason
        // `play()` is: there is nothing useful to do, and the capped path still works.
        void audioGraphRef.current?.context.resume().catch(() => undefined);
        // A play() rejection is routine — autoplay policy, or a seek landing mid-call —
        // and there is nothing useful to do about it, so the preview simply stays paused.
        void element.play().catch(() => undefined);
      } else if (!element.paused) {
        element.pause();
      }
    },
    [boostNodeFor, muted, reportBoost],
  );

  // Visual element.
  useEffect(() => {
    const element = videoRef.current;
    if (!element || !frame.visual) return;
    syncElement(element, frame.visual, playing);
  }, [frame.visual, playing, syncElement]);

  // Audio elements: sync the active ones, pause everything else.
  useEffect(() => {
    const active = new Map(frame.audio.map((clip) => [clip.storageKey, clip]));

    for (const [key, element] of audioRef.current) {
      const clip = active.get(key);
      if (!clip) {
        if (!element.paused) element.pause();
        continue;
      }
      syncElement(element, clip, playing, key);
    }
  }, [frame.audio, playing, syncElement]);

  /**
   * Report the "nothing to say" case, and close the context on unmount.
   *
   * An `AudioContext` is a real audio device handle; browsers cap how many a page may
   * hold, so leaving one open per editor visit would eventually stop the boost working.
   */
  // Guarded on `boostFailed` as well: after a failure `wantsBoost` is false by design, and
  // reporting "off" there would clear the very notice that explains the fallback.
  useEffect(() => {
    if (!wantsBoost && !boostFailed) reportBoost("off");
  }, [wantsBoost, boostFailed, reportBoost]);

  useEffect(() => {
    return () => {
      const graph = audioGraphRef.current;
      audioGraphRef.current = null;
      if (graph) void graph.context.close().catch(() => undefined);
    };
  }, []);

  // Pausing must silence audio for clips the frame no longer covers as well as the ones it
  // does, so this runs on every `playing` change rather than only inside the sync above.
  useEffect(() => {
    if (playing) return;
    const element = videoRef.current;
    if (element && !element.paused) element.pause();
    for (const audio of audioRef.current.values()) {
      if (!audio.paused) audio.pause();
    }
  }, [playing]);

  const registerAudio = useCallback(
    (key: string) => (element: HTMLAudioElement | null) => {
      if (element) {
        audioRef.current.set(key, element);
        return;
      }
      audioRef.current.delete(key);
      // The gain node was bound to the element that just went away — a source node cannot
      // be re-pointed — so it is dropped too. Otherwise a re-created element would find a
      // cached node wired to a dead source and play nothing.
      audioGraphRef.current?.nodes.delete(key);
    },
    [],
  );

  return (
    <div
      style={{
        background: "#000",
        borderRadius: radius.md,
        aspectRatio: previewAspect(doc.format),
        maxHeight: "52vh",
        margin: "0 auto",
        position: "relative",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {frame.visual && visualUrl ? (
        frame.visual.timeBased ? (
          <video
            // Keyed by URL so switching shots swaps the source rather than mutating it,
            // which would leave the old frame on screen until the new one decodes.
            key={frame.visual.storageKey}
            ref={videoRef}
            src={visualUrl}
            playsInline
            preload="auto"
            // `contain`: the preview shows the whole frame the export will produce,
            // letterboxing included, rather than cropping to fill the box.
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived storage URL
          <img
            key={frame.visual.storageKey}
            src={visualUrl}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        )
      ) : (
        <span
          style={{
            fontFamily: font.body,
            fontSize: 12.5,
            color: color.textFaint,
          }}
        >
          {frame.visual && !visualUrl
            ? "This clip's asset could not be loaded."
            : "Nothing on the visual track at this point."}
        </span>
      )}

      {/* On-screen text. CSS layout, so wrapping may differ from the render. */}
      {frame.texts.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: "8%",
            left: "6%",
            right: "6%",
            textAlign: "center",
            fontFamily: font.display,
            fontSize: "clamp(14px, 4.2cqw, 34px)",
            letterSpacing: 0.5,
            textTransform: "uppercase",
            color: "#fff",
            textShadow: "0 2px 12px rgba(0,0,0,0.85)",
            pointerEvents: "none",
          }}
        >
          {frame.texts.map((text, index) => (
            <div key={`${index}-${text}`}>{text}</div>
          ))}
        </div>
      )}

      {/* Caption, positioned and styled from the document's own caption style. */}
      {frame.caption && doc.captions.burnedIn && (
        <div
          style={{
            position: "absolute",
            left: "5%",
            right: "5%",
            top: `${doc.captions.style.verticalPosition * 100}%`,
            transform: "translateY(-50%)",
            textAlign: "center",
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              display: "inline-block",
              fontFamily: doc.captions.style.fontFamily,
              // Scaled to the preview box rather than used as raw pixels: the style's
              // size is in output pixels, and the preview is a fraction of that.
              fontSize: `clamp(11px, ${doc.captions.style.fontSizePx / 12}cqw, 28px)`,
              fontWeight: 600,
              lineHeight: 1.3,
              color: doc.captions.style.color,
              background: doc.captions.style.backgroundColor ?? "transparent",
              padding: doc.captions.style.backgroundColor ? "3px 10px" : 0,
              borderRadius: radius.sm,
              textShadow: doc.captions.style.backgroundColor
                ? undefined
                : "0 2px 10px rgba(0,0,0,0.9)",
            }}
          >
            {frame.caption}
          </span>
        </div>
      )}

      {/*
        Audio. Rendered for every audio clip in the cut, not just the active ones, so an
        element exists and is buffered before its clip is reached — otherwise narration
        would start a beat late at each cut.
      */}
      {audioKeys(clips).map((key) => {
        const url = assetUrls[key];
        if (!url) return null;
        return (
          <audio
            // The CORS mode is part of the key, so turning the boost off after a failure
            // re-creates the element rather than mutating the attribute on a live one —
            // which would not retry the request that already failed.
            key={`${key}:${wantsBoost ? "cors" : "plain"}`}
            ref={registerAudio(key)}
            src={url}
            preload="auto"
            /**
             * Only when the cut actually needs a boost.
             *
             * `createMediaElementSource` on a cross-origin element that did not opt in
             * yields silence, so routing requires this. But the attribute is not free:
             * against a bucket that does not return `Access-Control-Allow-Origin` it makes
             * the media fail to load outright. Setting it only when a boost is wanted means
             * an ordinary cut can never be broken by it, and `onError` below catches the
             * deployment where it is wanted but unavailable.
             */
            {...(wantsBoost ? { crossOrigin: "anonymous" as const } : {})}
            onError={() => {
              // A boosted element that will not load is the CORS case: the bucket does not
              // allow this origin. Fall back to the capped path and say so, rather than
              // leaving the user with a silent track.
              if (!wantsBoost || boostFailedRef.current) return;
              boostFailedRef.current = true;
              // Drops `crossOrigin`, which re-mounts the element against a plain request.
              setBoostFailed(true);
              reportBoost("unavailable");
            }}
          />
        );
      })}
    </div>
  );
}

/** Every distinct audio source in the cut. */
function audioKeys(clips: readonly CompiledClip[]): string[] {
  const keys = new Set<string>();
  for (const clip of clips) {
    if (clip.storageKey && (clip.trackKind === "voiceover" || clip.trackKind === "music")) {
      keys.add(clip.storageKey);
    }
  }
  return [...keys];
}

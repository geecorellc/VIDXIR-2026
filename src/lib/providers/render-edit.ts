/**
 * The edit document becomes an ffmpeg filter graph (Phase B).
 *
 * `render.ts`'s original builder assembles a *sequence*: one visual per scene, scaled
 * to the frame, `concat`enated in order. That is the right shape for a pipeline that
 * only ever appends whole scenes, and it is kept exactly as it was — a project with no
 * saved cut still renders through it, byte-identical.
 *
 * An edited timeline is not a sequence. It has trims, gaps, clips that overlap on
 * stacked tracks, and clips whose position is a number the user dragged rather than the
 * sum of everything before them. `concat` cannot express any of that: it has no concept
 * of a start time, and it demands that segment N+1 begin exactly where N ended.
 *
 * So this module composites instead. Every visual clip is scaled, trimmed, shifted to
 * its own start time with `setpts`, and painted onto a black base with `overlay`. The
 * base is what makes a gap black rather than an error, the paint order is what makes an
 * overlap resolve to the higher track, and `setpts` is what makes position absolute.
 *
 * Each mechanism below was measured against the bundled binary before it was written,
 * by decoding the result and reading pixels — not by trusting an exit code:
 *
 *  - **positioning and gaps** — three 1s stills at 0s, 1s and 2s over a black base
 *    decoded to exactly 30 red, 30 green and 30 blue frames, with no black seam at a
 *    boundary and no blended frame anywhere.
 *  - **gaps** — clips at 0-1s and 1.5-2.5s produced red, then true black across
 *    1-1.5s, then green. `eof_action=pass` is what stops a finished clip's last frame
 *    sticking for the rest of the video.
 *  - **trim** — `-ss 3.000 -t 2.000` on a gradient source landed the expected frames
 *    (gray 138 at clip-time 0.5s, gray 179 at 1.5s), so the seek is frame-accurate.
 *  - **overlap** — with two clips overlapping 1-2s, the one painted later won every
 *    frame of the overlap.
 *  - **gain** — `volume=1.000/0.500/0.250` measured RMS 0.0625/0.0312/0.0156: exactly
 *    linear, so a gain is a gain and not an approximation.
 *  - **text over captions** — a generated ASS layer chained after the caption
 *    `subtitles` filter measured max luma 255 at the top of the frame and 248 at the
 *    bottom against a base of ~101, so both layers really composite.
 *
 * What is deliberately *not* here: transitions, effects, picture-in-picture and
 * keyframes. `CompiledClip.transition` is read and preserved by the compiler and
 * ignored here, and the per-clip label structure below is what a future cross-fade
 * would hang off (it needs two clips' labels and an `xfade` between them, which this
 * shape already provides). Implementing one now would be inventing a feature the editor
 * cannot yet express.
 */
import { RenderError } from "@/lib/errors";
import { buildAssOverlay, assColour } from "@/lib/media/ass";
import { secondsArg } from "@/lib/media/ffmpeg";
import { escapeFilterPath } from "@/lib/media/filter";
import {
  isAudioTrack,
  isVisualTrack,
  type CompiledClip,
  type CompiledEdit,
} from "@/lib/video/edit-document";
import { MUSIC_FADE_MS } from "@/lib/video/timeline";

/**
 * A gain for the `volume` filter.
 *
 * Ceiling of 2 rather than `render.ts`'s 1, matching the document's own `Gain` bound: a
 * quiet voiceover genuinely needs boosting, and the editor lets a user ask for it. An
 * unedited document's music sits at 0.14 and lands identically under either clamp.
 */
function gainArg(gain: number): string {
  const value = Number.isFinite(gain) ? Math.min(2, Math.max(0, gain)) : 0;
  return value.toFixed(3);
}

export interface EditFfmpegInput {
  edit: CompiledEdit;
  /** Every file pulled to disk, in input order. */
  inputs: readonly string[];
  /** `clipId` → index in `inputs`, for clips whose media was downloaded. */
  clipInputIndex: ReadonlyMap<string, number>;
  /** Generated SRT for burned-in captions, or null. */
  subtitlePath: string | null;
  /** Generated ASS for the text track, or null. */
  overlayPath: string | null;
  output: string;
}

/** The graph plus the arguments that must agree with it. */
export interface EditFfmpegPlan {
  args: string[];
  /** The `-filter_complex` value, exposed so it can be written to a script file. */
  filterGraph: string;
}

/**
 * Which clips this renderer will actually draw or play.
 *
 * Exported so the render path can download exactly the files the graph references —
 * and no others. A hidden track's footage is not fetched, which on a project with a
 * disabled b-roll track is the difference between one download and forty.
 */
export function editRenderClips(edit: CompiledEdit): {
  visuals: CompiledClip[];
  audio: CompiledClip[];
  texts: CompiledClip[];
} {
  const visuals = edit.clips
    .filter(
      (clip) =>
        isVisualTrack(clip.trackKind) && clip.storageKey !== null && !clip.hidden,
    )
    // Paint order: **layer first**, then start time. Layer-major is what makes a
    // higher track win an overlap regardless of which clip starts earlier — sorting by
    // start first would let a late clip on a low track paint over an early clip on a
    // high one, which is the opposite of what the editor shows.
    .sort((a, b) => a.layer - b.layer || a.startMs - b.startMs);

  const audio = edit.clips.filter(
    (clip) => isAudioTrack(clip.trackKind) && clip.storageKey !== null,
  );

  const texts = edit.clips
    .filter((clip) => clip.trackKind === "text" && clip.text !== null && !clip.hidden)
    .sort((a, b) => a.startMs - b.startMs);

  return { visuals, audio, texts };
}

/**
 * The ASS script for the text track, or null when there is nothing to draw.
 *
 * Sizing: the text track is a *title*, not a subtitle, so it is set larger than the
 * caption style — 1.6x, floored at 44px — and drawn at the top of the frame, which is
 * where the pipeline's own on-screen text has always gone (`shotstackEdit` uses
 * `position: "top"` for exactly these clips) and clear of the caption bar underneath.
 */
export function editOverlayScript(edit: CompiledEdit): string | null {
  const { texts } = editRenderClips(edit);
  if (texts.length === 0) return null;

  const style = edit.timeline.captions?.style;
  const primary = edit.timeline.brand.primaryColor;

  return buildAssOverlay({
    width: edit.timeline.width,
    height: edit.timeline.height,
    cues: texts.map((clip) => ({
      startMs: clip.startMs,
      endMs: clip.startMs + clip.durationMs,
      text: clip.text as string,
    })),
    fontFamily: edit.timeline.brand.fontPreference ?? style?.fontFamily ?? "Inter",
    fontSizePx: Math.max(44, Math.round((style?.fontSizePx ?? 48) * 1.6)),
    // The brand's primary colour when it is a plain hex — `assColour` needs one, and
    // `brand_kits.primary_color` is a free-form string a settings screen wrote.
    color: primary && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(primary)
      ? primary
      : "#FFFFFF",
    verticalPosition: 0.1,
  });
}

/**
 * Build the argument list for an edited timeline.
 *
 * Mirrors `ffmpegArgs`'s contract deliberately — same flags, same encoder settings,
 * same `-progress pipe:1` — so `runFfmpeg` needs no knowledge of which builder produced
 * the arguments, and a render's output settings do not change just because the project
 * was opened in the editor.
 */
export function editFfmpegArgs(input: EditFfmpegInput): EditFfmpegPlan {
  const { edit } = input;
  const { width, height, fps } = edit.timeline;
  const { visuals, audio } = editRenderClips(edit);

  const withInput = visuals.filter((clip) => {
    const index = input.clipInputIndex.get(clip.clipId);
    return index !== undefined && input.inputs[index] !== undefined;
  });

  if (withInput.length === 0) {
    throw new RenderError("the edit has no visible clips to render", {
      retryable: false,
    });
  }

  // See `ffmpegArgs` for why `-xerror` is load-bearing: a still that never decodes
  // makes `-t` unreachable, and without this ffmpeg re-reads it until the timeout.
  const args: string[] = ["-y", "-nostdin", "-hide_banner", "-xerror"];

  /** Input arguments, in the same order the filter graph will reference them. */
  const ordered: Array<{ clip: CompiledClip; input: number; holdMs: number }> = [];

  for (const clip of withInput) {
    const path = input.inputs[input.clipInputIndex.get(clip.clipId) as number] as string;
    const still = isStillClip(clip);
    const window = sourceWindowMs(clip);

    let holdMs = 0;

    if (still) {
      // A still has no timeline of its own; it becomes exactly as many frames as the
      // clip is long. Trim fields are meaningless here and are ignored rather than
      // rejected — a still dragged by its edge is a duration change, not a seek.
      args.push(
        "-loop",
        "1",
        "-framerate",
        String(fps),
        "-t",
        secondsArg(clip.durationMs),
        "-i",
        path,
      );
    } else if (window !== null) {
      // A **trimmed** clip: the user chose this window of the material, so only this
      // window plays. `-ss` before `-i` is the frame-accurate, fast form — ffmpeg seeks
      // the demuxer and decodes from the preceding keyframe.
      const playMs = Math.min(window, clip.durationMs);
      // A window shorter than the slot holds its last frame rather than looping.
      // Looping a window the user deliberately chose would replay material they cut;
      // holding is what an NLE does and what reads as intentional.
      holdMs = clip.durationMs - playMs;
      args.push(
        "-ss",
        secondsArg(clip.sourceInMs ?? 0),
        "-t",
        secondsArg(playMs),
        "-i",
        path,
      );
    } else {
      // Untrimmed footage: loop to fill the slot, which is exactly what the original
      // builder does. An unedited document therefore reaches ffmpeg with the same
      // input flags it always did.
      const seek = clip.sourceInMs !== null && clip.sourceInMs > 0;
      if (seek) args.push("-ss", secondsArg(clip.sourceInMs as number));
      args.push("-stream_loop", "-1", "-t", secondsArg(clip.durationMs), "-i", path);
    }

    ordered.push({ clip, input: inputCount(args), holdMs });
  }

  /** Audio inputs, after every visual input. */
  const audioOrdered: Array<{ clip: CompiledClip; input: number }> = [];

  for (const clip of audio) {
    const index = input.clipInputIndex.get(clip.clipId);
    if (index === undefined) continue;
    const path = input.inputs[index];
    if (!path) continue;

    // Every audio clip is a plain input. Looping, where the bed needs it, happens in
    // the filter graph rather than here — see `aloop` below for why `-stream_loop`
    // cannot be used on an input that feeds `amix`.
    args.push("-i", path);

    audioOrdered.push({ clip, input: inputCount(args) });
  }

  const filters: string[] = [];

  /**
   * The composite's length: the end of the last visible clip.
   *
   * The tail of silence past it is added by `tpad` below rather than by extending the
   * base, so the final frame holds instead of cutting to black — the behaviour the
   * original builder has always had.
   */
  const visualEndMs = withInput.reduce(
    (end, clip) => Math.max(end, clip.startMs + clip.durationMs),
    0,
  );

  // The black canvas every clip paints onto. Generated inside the graph rather than as
  // a `-f lavfi` input so the input indices above stay contiguous with the downloads.
  filters.push(
    `color=c=black:s=${width}x${height}:r=${fps}:d=${secondsArg(visualEndMs)},` +
      `format=yuv420p,setsar=1[base]`,
  );

  /**
   * Half a frame of slack on each end of a clip's `enable` window.
   *
   * `enable` is evaluated against a floating-point timestamp, and a clip starting at
   * 100ms wants a frame whose time is 3/30 — a value no binary double represents
   * exactly. Comparing against a bare boundary can therefore miss the first frame or
   * keep one frame too many, which shows up as a one-frame black flash at a cut.
   * Widening by half a frame puts every comparison in the middle of a frame interval
   * instead of on its edge. Measured: with this slack, three adjacent 1s clips decode
   * to exactly 30 frames each.
   *
   * The overlap it introduces at a boundary is resolved by paint order — the later
   * clip wins — which is the same rule that resolves a deliberate overlap.
   */
  const epsilon = 0.5 / fps;

  ordered.forEach(({ clip, input: index, holdMs }, position) => {
    const label = `c${position}`;
    const chain = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      // Even dimensions: H.264's 4:2:0 chroma cannot encode an odd width, and ffmpeg
      // fails at the very end of the pass if one slips through.
      `pad=${width}:${height}:-1:-1:color=black`,
      `setsar=1`,
      `fps=${fps}`,
      `format=yuv420p`,
    ];

    // Hold before trimming: `trim=duration` measures the stream *after* padding, so
    // the held frames are what fill the slot.
    if (holdMs > 0) {
      chain.push(`tpad=stop_mode=clone:stop_duration=${secondsArg(holdMs)}`);
    }

    chain.push(`trim=duration=${secondsArg(clip.durationMs)}`);
    // The line that makes position absolute: shift this clip's timestamps to where the
    // document says it starts, rather than to wherever the previous clip ended.
    chain.push(`setpts=PTS-STARTPTS+${secondsArg(clip.startMs)}/TB`);

    filters.push(`[${index}:v]${chain.join(",")}[${label}]`);
  });

  let videoOut = "base";
  ordered.forEach(({ clip }, position) => {
    const from = videoOut;
    const to = position === ordered.length - 1 ? "vcomp" : `s${position}`;
    const startSec = clip.startMs / 1000;
    const endSec = (clip.startMs + clip.durationMs) / 1000;

    filters.push(
      `[${from}][c${position}]overlay=eof_action=pass:` +
        // `enable` rather than relying on the clip's own extent alone: without it a
        // clip whose decoder emits a frame late could paint outside its window.
        `enable='${enableWindow(startSec - epsilon, endSec + epsilon)}'[${to}]`,
    );
    videoOut = to;
  });

  // The tail: hold the last frame rather than cutting to black.
  const tailMs = edit.durationMs - visualEndMs;
  if (tailMs > 0) {
    filters.push(
      `[${videoOut}]tpad=stop_mode=clone:stop_duration=${secondsArg(tailMs)}[vpad]`,
    );
    videoOut = "vpad";
  }

  // Captions first, then the text track, so a title paints over a caption if a user
  // ever puts them in the same place. Both are `subtitles` filters reading a file, so
  // no user-supplied text ever reaches the filter graph as an argument.
  if (input.subtitlePath) {
    const style = edit.timeline.captions?.style;
    const styleArg =
      `FontName=${(style?.fontFamily ?? "Inter").replace(/[,:'\\]/g, "")},` +
      `FontSize=${Math.round((style?.fontSizePx ?? 48) * 0.55)},` +
      `PrimaryColour=${assColour(style?.color ?? "#FFFFFF")},` +
      `BorderStyle=${style?.backgroundColor ? 4 : 1},` +
      `BackColour=${assColour(style?.backgroundColor ?? "#000000A6")},` +
      `Outline=2,Shadow=0,Alignment=2,MarginV=60`;

    filters.push(
      `[${videoOut}]subtitles=${escapeFilterPath(input.subtitlePath)}:` +
        `force_style='${styleArg}'[vsub]`,
    );
    videoOut = "vsub";
  }

  if (input.overlayPath) {
    // No `force_style`: the generated script carries its own, including the real
    // `PlayRes` so its font size is in output pixels.
    filters.push(
      `[${videoOut}]subtitles=${escapeFilterPath(input.overlayPath)}[vtext]`,
    );
    videoOut = "vtext";
  }

  const audioLabels: string[] = [];

  audioOrdered.forEach(({ clip, input: index }, position) => {
    const label = `a${position}`;
    const window = sourceWindowMs(clip);
    const chain = [
      `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo`,
    ];

    // A trimmed audio clip is cut in the filter rather than with `-ss`: audio seeking
    // is sample-accurate here and costs nothing, and it keeps the input flags uniform.
    if (window !== null) {
      chain.push(
        `atrim=start=${secondsArg(clip.sourceInMs ?? 0)}:` +
          `end=${secondsArg((clip.sourceInMs ?? 0) + window)}`,
        `asetpts=PTS-STARTPTS`,
      );
    } else if (needsAudioLoop(clip)) {
      /**
       * The bed loops to fill its slot, **in the graph**.
       *
       * `-stream_loop -1` on the input is the obvious way to do this and is what the
       * sequential builder uses, but it deadlocks `amix` whenever the source is shorter
       * than the output and therefore has to wrap: ffmpeg stops producing frames and
       * the process hangs until it is killed. It is not the infinite count — a finite
       * `-stream_loop 3` hangs identically — and it is specific to `amix`, since the
       * same looping input encodes fine when it is the only stream. A bed longer than
       * the video never wraps, which is why the sequential path has not hit this.
       *
       * `aloop` runs inside the graph, so `amix` sees an ordinary filter that keeps
       * delivering samples, and `atrim` below still decides the length. `size` is the
       * loop's buffer in samples; the whole clip has to fit in it or only the first
       * `size` samples repeat, so it is the slot length at this chain's 48kHz.
       */
      chain.push(`aloop=loop=-1:size=${audioLoopSamples(clip)}`, `asetpts=N/SR/TB`);
    }

    // Length: the clip's slot. This is what keeps a shortened voiceover from bleeding
    // into the next clip and what cuts the looping music bed at the end of its clip.
    chain.push(`atrim=duration=${secondsArg(clip.durationMs)}`, `asetpts=PTS-STARTPTS`);

    chain.push(`volume=${gainArg(clip.gain)}`);

    if (clip.trackKind === "music") {
      // The bed's own fades, computed against the clip rather than the video: a bed the
      // user dragged shorter fades in and out at its own edges.
      const fade = Math.min(MUSIC_FADE_MS, Math.floor(clip.durationMs / 4)) / 1000;
      const clipSeconds = clip.durationMs / 1000;
      chain.push(
        `afade=t=in:st=0:d=${fade.toFixed(2)}`,
        `afade=t=out:st=${Math.max(0, clipSeconds - fade).toFixed(2)}:d=${fade.toFixed(2)}`,
      );
    }

    // Position, last: everything above operates on a stream starting at zero.
    if (clip.startMs > 0) {
      const delay = Math.round(clip.startMs);
      chain.push(`adelay=${delay}|${delay}`);
    }

    filters.push(`[${index}:a]${chain.join(",")}[${label}]`);
    audioLabels.push(label);
  });

  let audioOut: string;
  if (audioLabels.length === 0) {
    /**
     * Silence, generated **inside the graph**.
     *
     * A video with no audio track at all confuses some players, and a cut can genuinely
     * have none — every voiceover deleted, no bed. The sequential builder appends
     * `-f lavfi -i anullsrc` for this, which only works because nothing is mapped from
     * it; here it would have to come before `-filter_complex` to be a legal input, and
     * an extra input would shift every filter index. `anullsrc` is also a filter source,
     * so the graph can simply make its own.
     */
    filters.push(
      `anullsrc=r=48000:cl=stereo:d=${secondsArg(edit.durationMs)},` +
        `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[asilence]`,
    );
    audioOut = "asilence";
  } else if (audioLabels.length === 1) {
    audioOut = audioLabels[0] as string;
  } else {
    filters.push(
      `${audioLabels.map((l) => `[${l}]`).join("")}` +
        // The original builder's flags, unchanged and for the same reason: without
        // `dropout_transition=0` and `normalize=0`, amix lifts the music every time the
        // narration pauses, which sounds like a fault rather than like a mix.
        `amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0[amix]`,
    );
    audioOut = "amix";
  }

  const filterGraph = filters.join(";");

  args.push("-filter_complex", filterGraph);
  args.push("-map", `[${videoOut}]`, "-map", `[${audioOut}]`);

  args.push(
    "-t",
    secondsArg(edit.durationMs),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "22",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(fps * 2),
    "-movflags",
    "+faststart",
    // Always an audio track, because the graph always produces one — silence when the
    // cut has no audio of its own.
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
  );

  args.push("-progress", "pipe:1", "-loglevel", "error", input.output);

  return { args, filterGraph };
}

/**
 * A clip's source window, or null when it plays from the start untrimmed.
 *
 * Both ends must be set for this to be a window: the schema allows `sourceInMs` alone,
 * which means "start here and play on" — a seek, not a trim, and the two want different
 * input flags.
 */
function sourceWindowMs(clip: CompiledClip): number | null {
  if (clip.sourceInMs === null || clip.sourceOutMs === null) return null;
  const window = clip.sourceOutMs - clip.sourceInMs;
  return window > 0 ? window : null;
}

/**
 * Whether an untrimmed audio clip has to repeat to fill its slot.
 *
 * Only the music bed loops. A voiceover that runs out is silence for the remainder —
 * repeating a sentence would be worse than the gap, and it is the gap the user can see
 * on the timeline. A bed with no measured duration is assumed to need it: looping
 * material that turns out to be long enough is a no-op, whereas not looping material
 * that was too short leaves audible silence under the tail.
 */
function needsAudioLoop(clip: CompiledClip): boolean {
  if (clip.trackKind !== "music") return false;
  if (clip.sourceDurationMs === null || clip.sourceDurationMs <= 0) return true;
  return clip.sourceDurationMs < clip.durationMs;
}

/**
 * `aloop`'s buffer size, in samples at the graph's 48kHz.
 *
 * The filter repeats the first `size` samples it buffers, so anything smaller than the
 * clip repeats a fragment of the bed instead of the bed. One slot's worth is the
 * smallest value that is always correct.
 */
function audioLoopSamples(clip: CompiledClip): number {
  return Math.max(1, Math.ceil((clip.durationMs / 1000) * 48_000));
}

/**
 * Whether this clip's source is a still.
 *
 * The same test `render.ts`'s `isVideo` makes, against the compiled clip's kind. A clip
 * whose kind was never recorded falls back to its measured duration, since a source
 * with a length is time-based and one without is an image.
 *
 * Exported because the render path names its temp files by kind, and the two must agree:
 * a still written as `.mp4` and then read with `-loop 1` would probe as a broken video.
 */
export function isStillClip(clip: CompiledClip): boolean {
  if (clip.sourceKind === "stock_image" || clip.sourceKind === "generated_image") {
    return true;
  }
  if (clip.sourceKind === "stock_video" || clip.sourceKind === "generated_video") {
    return false;
  }
  return clip.sourceDurationMs === null || clip.sourceDurationMs <= 0;
}

/** `enable` expression for a half-open window, clamped at zero. */
function enableWindow(startSec: number, endSec: number): string {
  const from = Math.max(0, startSec);
  return `gte(t,${from.toFixed(4)})*lt(t,${Math.max(from, endSec).toFixed(4)})`;
}

/**
 * How many inputs `args` declares so far.
 *
 * Counted from the argument list rather than tracked in a variable, so an input added
 * above without a matching counter bump cannot silently shift every filter's index —
 * the failure mode would be a graph that references the wrong file and still encodes.
 */
function inputCount(args: readonly string[]): number {
  let count = -1;
  for (const arg of args) if (arg === "-i") count += 1;
  return count;
}

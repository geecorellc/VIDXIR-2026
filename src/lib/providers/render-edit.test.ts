/**
 * Edit-aware renderer tests (Phase B).
 *
 * The same approach `render.test.ts` takes and for the same reason: the filter graph is
 * the most intricate thing here and the most expensive to debug by running it. Each
 * capability the editor exposes is asserted on the generated arguments, and the smoke
 * test then proves a real encode of the same graph produces a real MP4.
 *
 * These assertions are pedantic on purpose. `setpts=PTS-STARTPTS+X/TB` is what makes a
 * clip's position absolute; paint order is what resolves an overlap; `eof_action=pass` is
 * what stops a finished clip's last frame sticking for the rest of the video; and
 * `normalize=0` is what stops the music lifting whenever the narration pauses. Each one
 * corresponds to a specific way an edited render goes wrong while still exiting zero.
 */
import { describe, expect, it } from "vitest";
import {
  editFfmpegArgs,
  editOverlayScript,
  editRenderClips,
} from "@/lib/providers/render-edit";
import {
  compileEditDocument,
  parseEditDocument,
  type EditClip,
  type EditDocument,
  type EditTrack,
  type TrackKind,
} from "@/lib/video/edit-document";
import { resolveCaptionStyle } from "@/lib/video/timeline";

let sourceCounter = 0;

function clip(overrides: Partial<EditClip> & { id: string }): EditClip {
  return {
    startMs: 0,
    durationMs: 5_000,
    sourceInMs: null,
    sourceOutMs: null,
    volume: 1,
    text: null,
    label: null,
    transition: null,
    source: null,
    sceneIndex: null,
    ...overrides,
  };
}

/** A clip that plays footage. */
function videoClip(overrides: Partial<EditClip> & { id: string }): EditClip {
  sourceCounter += 1;
  return clip({
    source: {
      assetId: `00000000-0000-4000-8000-${String(sourceCounter).padStart(12, "0")}`,
      storageKey: `${overrides.id}.mp4`,
      kind: "stock_video",
      sourceDurationMs: 20_000,
    },
    ...overrides,
  });
}

function track(
  id: string,
  kind: TrackKind,
  clips: EditClip[],
  overrides: Partial<EditTrack> = {},
): EditTrack {
  return {
    id,
    kind,
    label: null,
    order: 0,
    muted: false,
    hidden: false,
    volume: 1,
    clips,
    ...overrides,
  };
}

function document(tracks: EditTrack[], overrides: Partial<EditDocument> = {}): EditDocument {
  // Through the real parser, so no test can assert on a document the API would reject.
  return parseEditDocument({
    schemaVersion: 1,
    format: "landscape",
    tracks,
    captions: { burnedIn: true, style: resolveCaptionStyle(null) },
    music: { duckUnderNarration: true },
    brand: { primaryColor: null, secondaryColor: null, fontPreference: null },
    ...overrides,
  });
}

interface PlanCase {
  subtitlePath?: string | null;
  overlay?: boolean;
}

/** Build a plausible invocation the way `ffmpegRenderEdit` builds one. */
function plan(doc: EditDocument, options: PlanCase = {}) {
  const edit = compileEditDocument(doc);
  const { visuals, audio } = editRenderClips(edit);

  // Inputs are laid out exactly as the render path lays them out: visuals in paint
  // order, then audio, one input per clip.
  const inputs: string[] = [];
  const clipInputIndex = new Map<string, number>();

  for (const c of [...visuals, ...audio]) {
    clipInputIndex.set(c.clipId, inputs.length);
    inputs.push(`/tmp/${c.clipId}.bin`);
  }

  const overlayPath = options.overlay && editOverlayScript(edit) ? "/tmp/overlay.ass" : null;

  return {
    edit,
    ...editFfmpegArgs({
      edit,
      inputs,
      clipInputIndex,
      subtitlePath: options.subtitlePath ?? null,
      overlayPath,
      output: "/tmp/out.mp4",
    }),
  };
}

/** The four flags every invocation opens with, which belong to no input. */
const GLOBAL_FLAGS = 4;

/**
 * Each input declaration, in order: its per-input flags plus `-i <path>`.
 *
 * The index of a group here is the index a filter label refers to, so asserting on
 * these is asserting that `[3:v]` really is the file the builder thought it was.
 * Stops at `-filter_complex`, since the `anullsrc` silence source is appended after the
 * graph and is not something the graph references.
 */
function inputArgs(args: readonly string[]): string[][] {
  const upto = args.indexOf("-filter_complex");
  const relevant = args.slice(GLOBAL_FLAGS, upto < 0 ? undefined : upto);

  const groups: string[][] = [];
  let current: string[] = [];
  for (const arg of relevant) {
    current.push(arg);
    if (current[current.length - 2] === "-i") {
      groups.push(current);
      current = [];
    }
  }
  return groups;
}

/** The output `-t`, which is the one after the filter graph. */
function outputDuration(args: readonly string[]): string | undefined {
  const from = args.indexOf("-filter_complex");
  const at = args.indexOf("-t", from);
  return at < 0 ? undefined : args[at + 1];
}

describe("editFfmpegArgs — clip positioning and gaps (§Phase B.3, B.8)", () => {
  it("shifts each clip to its own absolute start rather than concatenating", () => {
    const { filterGraph } = plan(
      document([
        track("video-0", "video", [
          videoClip({ id: "a", startMs: 0, durationMs: 2_000 }),
          videoClip({ id: "b", startMs: 5_000, durationMs: 2_000 }),
        ]),
      ]),
    );

    // The mechanism that makes position absolute. `concat` cannot express this at all:
    // it has no start time and demands segment N+1 begin where N ended.
    expect(filterGraph).toContain("setpts=PTS-STARTPTS+0.000/TB");
    expect(filterGraph).toContain("setpts=PTS-STARTPTS+5.000/TB");
    expect(filterGraph).not.toContain("concat=");
  });

  it("paints onto a black base sized to the frame, so a gap is black not an error", () => {
    const { filterGraph } = plan(
      document([
        track("video-0", "video", [
          videoClip({ id: "a", startMs: 0, durationMs: 2_000 }),
          // 3s of nothing between the clips.
          videoClip({ id: "b", startMs: 5_000, durationMs: 2_000 }),
        ]),
      ]),
    );

    expect(filterGraph).toContain("color=c=black:s=1920x1080:r=30:d=7.000");
    // Two overlays onto the base — the gap is simply where neither is enabled.
    expect(filterGraph.match(/overlay=/g)).toHaveLength(2);
  });

  it("stops a finished clip's last frame sticking for the rest of the video", () => {
    const { filterGraph } = plan(
      document([
        track("video-0", "video", [
          videoClip({ id: "a", startMs: 0, durationMs: 2_000 }),
          videoClip({ id: "b", startMs: 5_000, durationMs: 2_000 }),
        ]),
      ]),
    );

    // Without this the first clip's final frame persists across the gap and under
    // everything after it, which decodes as a video with no gap at all.
    for (const overlay of filterGraph.match(/overlay=[^[]*/g) ?? []) {
      expect(overlay).toContain("eof_action=pass");
    }
  });

  it("gates each clip to its own window with half a frame of slack", () => {
    const { filterGraph } = plan(
      document([
        track("video-0", "video", [
          videoClip({ id: "a", startMs: 0, durationMs: 2_000 }),
          videoClip({ id: "b", startMs: 2_000, durationMs: 2_000 }),
        ]),
      ]),
    );

    // Half a frame at 30fps is 0.0167s. The slack keeps every `enable` comparison in
    // the middle of a frame interval rather than on its edge, which is what stops a
    // one-frame black flash at a cut. Measured: three adjacent 1s clips decode to
    // exactly 30 frames each with this, and to 29/31 without.
    expect(filterGraph).toContain("enable='gte(t,0.0000)*lt(t,2.0167)'");
    expect(filterGraph).toContain("enable='gte(t,1.9833)*lt(t,4.0167)'");
  });

  it("holds the last frame through the tail rather than cutting to black", () => {
    const { edit, filterGraph } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "a", startMs: 0, durationMs: 4_000 })]),
      ]),
    );

    // The compiler adds the same 800ms tail `buildTimeline` adds.
    expect(edit.durationMs).toBe(4_800);
    expect(filterGraph).toContain("tpad=stop_mode=clone:stop_duration=0.800");
  });
});

describe("editFfmpegArgs — trim and split (§Phase B.1, B.2)", () => {
  it("seeks and limits a trimmed clip with -ss/-t before the input", () => {
    const { args } = plan(
      document([
        track("video-0", "video", [
          videoClip({
            id: "a",
            startMs: 0,
            durationMs: 3_000,
            sourceInMs: 4_000,
            sourceOutMs: 7_000,
          }),
        ]),
      ]),
    );

    // `-ss` *before* `-i` is the frame-accurate, fast form: ffmpeg seeks the demuxer
    // and decodes from the preceding keyframe. After `-i` it decodes and discards
    // everything up to the seek point, which on a 20s source is the whole cost.
    expect(inputArgs(args)).toEqual([
      ["-ss", "4.000", "-t", "3.000", "-i", "/tmp/a.bin"],
    ]);
  });

  it("gives the two halves of a split adjoining source windows and separate inputs", () => {
    // A split is exactly this: one asset, two clips, adjoining windows. There is no
    // separate "split" operation in the renderer, which is why the document models it
    // this way.
    const source = {
      assetId: "00000000-0000-4000-8000-00000000ffff",
      storageKey: "shared.mp4",
      kind: "stock_video" as const,
      sourceDurationMs: 20_000,
    };

    const { args, filterGraph } = plan(
      document([
        track("video-0", "video", [
          clip({ id: "left", startMs: 0, durationMs: 2_000, sourceInMs: 0, sourceOutMs: 2_000, source }),
          clip({ id: "right", startMs: 2_000, durationMs: 3_000, sourceInMs: 2_000, sourceOutMs: 5_000, source }),
        ]),
      ]),
    );

    // Two inputs over one file: the halves seek to different offsets, so they cannot
    // share a decoder.
    expect(inputArgs(args)).toEqual([
      ["-ss", "0.000", "-t", "2.000", "-i", "/tmp/left.bin"],
      ["-ss", "2.000", "-t", "3.000", "-i", "/tmp/right.bin"],
    ]);
    // Adjacent on the output timeline, so the cut is invisible.
    expect(filterGraph).toContain("setpts=PTS-STARTPTS+0.000/TB");
    expect(filterGraph).toContain("setpts=PTS-STARTPTS+2.000/TB");
  });

  it("holds a window shorter than its slot instead of replaying cut material", () => {
    const { args, filterGraph } = plan(
      document([
        track("video-0", "video", [
          videoClip({
            id: "a",
            startMs: 0,
            durationMs: 5_000,
            // Only 2s of material for a 5s slot.
            sourceInMs: 1_000,
            sourceOutMs: 3_000,
          }),
        ]),
      ]),
    );

    expect(inputArgs(args)).toEqual([
      ["-ss", "1.000", "-t", "2.000", "-i", "/tmp/a.bin"],
    ]);
    // Looping would replay material the user deliberately trimmed away. Holding is what
    // an NLE does and what reads as intentional.
    expect(filterGraph).toContain("tpad=stop_mode=clone:stop_duration=3.000");
    expect(args).not.toContain("-stream_loop");
  });

  it("loops untrimmed footage to fill its slot, as the sequential builder does", () => {
    const { args } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "a", startMs: 0, durationMs: 9_000 })]),
      ]),
    );

    // No trim means the pipeline's own behaviour: a short clip loops rather than
    // cutting to black. An unedited document therefore reaches ffmpeg with the input
    // flags it always had.
    expect(inputArgs(args)).toEqual([
      ["-stream_loop", "-1", "-t", "9.000", "-i", "/tmp/a.bin"],
    ]);
  });

  it("treats a still as exactly its slot length and ignores trim fields", () => {
    const { args } = plan(
      document([
        track("video-0", "video", [
          clip({
            id: "a",
            startMs: 0,
            durationMs: 4_000,
            source: {
              assetId: "00000000-0000-4000-8000-0000000000aa",
              storageKey: "still.png",
              kind: "stock_image",
              sourceDurationMs: null,
            },
          }),
        ]),
      ]),
    );

    // A still has no timeline of its own to seek into; dragging its edge is a duration
    // change, not a trim.
    expect(inputArgs(args)).toEqual([
      ["-loop", "1", "-framerate", "30", "-t", "4.000", "-i", "/tmp/a.bin"],
    ]);
  });
});

describe("editFfmpegArgs — stacked tracks and overlap (§Phase B.5)", () => {
  it("paints a higher-order track later, so it wins an overlap", () => {
    const { filterGraph } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "under", startMs: 0, durationMs: 6_000 })], {
          order: 0,
        }),
        // A cutaway sitting on top of the main track for two seconds.
        track("video-1", "video", [videoClip({ id: "over", startMs: 2_000, durationMs: 2_000 })], {
          order: 5,
        }),
      ]),
    );

    // Paint order is the only thing that resolves an overlap, so it has to be
    // layer-major: the base takes `under` first, then `over` on top of the result.
    const underAt = filterGraph.indexOf("[base][c0]");
    const overAt = filterGraph.indexOf("[c1]overlay");
    expect(underAt).toBeGreaterThanOrEqual(0);
    expect(overAt).toBeGreaterThan(underAt);
  });

  it("orders by layer before start time, so a late low clip cannot cover an early high one", () => {
    const { visuals } = editRenderClips(
      compileEditDocument(
        document([
          // Starts later, but on the lower track.
          track("video-0", "video", [videoClip({ id: "low-late", startMs: 4_000, durationMs: 2_000 })], {
            order: 0,
          }),
          track("video-1", "video", [videoClip({ id: "high-early", startMs: 0, durationMs: 2_000 })], {
            order: 9,
          }),
        ]),
      ),
    );

    // Start-major ordering would paint `high-early` first and let `low-late` cover it.
    expect(visuals.map((c) => c.clipId)).toEqual(["low-late", "high-early"]);
  });

  it("omits a hidden track's clips entirely", () => {
    const doc = document([
      track("video-0", "video", [videoClip({ id: "shown", startMs: 0, durationMs: 3_000 })]),
      track("video-1", "video", [videoClip({ id: "hidden", startMs: 0, durationMs: 3_000 })], {
        order: 4,
        hidden: true,
      }),
    ]);

    const { visuals } = editRenderClips(compileEditDocument(doc));
    expect(visuals.map((c) => c.clipId)).toEqual(["shown"]);

    // And its footage is never even downloaded — on a project with a disabled b-roll
    // track that is the difference between one transfer and forty.
    const { args } = plan(doc);
    expect(inputArgs(args)).toHaveLength(1);
  });

  it("refuses an edit with nothing visible rather than encoding black", () => {
    const doc = document([
      track("video-0", "video", [videoClip({ id: "a", startMs: 0, durationMs: 3_000 })], {
        hidden: true,
      }),
    ]);

    expect(() => plan(doc)).toThrow(/no visible clips/);
  });
});

describe("editFfmpegArgs — per-clip audio (§Phase B.4, B.9)", () => {
  it("applies each clip's own gain linearly", () => {
    const { filterGraph } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 6_000 })]),
        track("voiceover-0", "voiceover", [
          audioClip("vo-quiet", { startMs: 0, durationMs: 2_000, volume: 0.5 }),
          audioClip("vo-boost", { startMs: 2_000, durationMs: 2_000, volume: 1.75 }),
        ]),
      ]),
    );

    // Measured against the real binary: volume=1.000/0.500/0.250 produced RMS
    // 0.0625/0.0312/0.0156 — exactly linear, so a gain is a gain.
    expect(filterGraph).toContain("volume=0.500");
    // Above 1 is allowed to 2, matching the document's own bound: a quiet voiceover
    // genuinely needs boosting.
    expect(filterGraph).toContain("volume=1.750");
  });

  it("multiplies track gain into clip gain", () => {
    const { filterGraph } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 4_000 })]),
        track("voiceover-0", "voiceover", [audioClip("vo", { durationMs: 4_000, volume: 0.5 })], {
          volume: 0.5,
        }),
      ]),
    );

    expect(filterGraph).toContain("volume=0.250");
  });

  it("exports a muted track at gain zero rather than dropping it", () => {
    const { filterGraph } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 4_000 })]),
        track("voiceover-0", "voiceover", [audioClip("vo", { durationMs: 4_000 })], {
          muted: true,
        }),
      ]),
    );

    // Still on the timeline, still selectable in the editor, silent in the export.
    expect(filterGraph).toContain("volume=0.000");
  });

  it("delays a clip to its own start and cuts it to its own length", () => {
    const { filterGraph } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 8_000 })]),
        track("voiceover-0", "voiceover", [
          audioClip("vo", { startMs: 3_500, durationMs: 2_000 }),
        ]),
      ]),
    );

    // `atrim` before `adelay`: everything upstream operates on a stream starting at
    // zero, and the delay is what positions it. Reversed, the trim would cut the
    // silence rather than the audio.
    expect(filterGraph).toContain("atrim=duration=2.000");
    expect(filterGraph).toContain("adelay=3500|3500");
    expect(filterGraph.indexOf("atrim=duration=2.000")).toBeLessThan(
      filterGraph.indexOf("adelay=3500|3500"),
    );
  });

  it("trims audio inside the filter graph when the clip has a source window", () => {
    const { args, filterGraph } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 6_000 })]),
        track("voiceover-0", "voiceover", [
          audioClip("vo", { startMs: 0, durationMs: 2_000, sourceInMs: 1_500, sourceOutMs: 3_500 }),
        ]),
      ]),
    );

    // Sample-accurate and free here, and it keeps the audio input flags uniform —
    // unlike video, there is no keyframe to seek to.
    expect(filterGraph).toContain("atrim=start=1.500:end=3.500");
    expect(filterGraph).toContain("asetpts=PTS-STARTPTS");
    // So no `-ss` on the audio input.
    expect(inputArgs(args).at(-1)).toEqual(["-i", "/tmp/vo.bin"]);
  });

  it("preserves the existing mix flags exactly", () => {
    const { filterGraph } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 6_000 })]),
        track("voiceover-0", "voiceover", [audioClip("vo", { durationMs: 4_000 })]),
        track("music-0", "music", [audioClip("music", { durationMs: 6_800, volume: 0.14 })], {
          order: 1,
        }),
      ]),
    );

    // Without `dropout_transition=0` and `normalize=0`, amix lifts the music every time
    // the narration pauses, which sounds like a fault rather than like a mix. This is
    // the sequential builder's line, unchanged.
    expect(filterGraph).toContain(
      "amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[amix]",
    );
  });

  it("fades the bed at its own edges", () => {
    const { filterGraph } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 20_000 })]),
        track("music-0", "music", [
          audioClip("music", { durationMs: 20_800, volume: 0.14, sourceDurationMs: 30_000 }),
        ]),
      ]),
    );

    expect(filterGraph).toContain("afade=t=in:st=0:d=1.50");
    // Out over the last 1.5s of the *clip*: a bed dragged shorter fades at its own end.
    expect(filterGraph).toContain("afade=t=out:st=19.30:d=1.50");
  });

  it("loops a bed shorter than its clip, in the graph rather than on the input", () => {
    const { args, filterGraph } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 20_000 })]),
        track("music-0", "music", [
          audioClip("music", { durationMs: 20_000, volume: 0.14, sourceDurationMs: 8_000 }),
        ]),
      ]),
    );

    // `-stream_loop -1` is the obvious way to do this and is what the sequential builder
    // uses, but it *deadlocks* `amix` whenever the source actually has to wrap: ffmpeg
    // stops producing frames and the render hangs until it is killed. Measured on the
    // bundled build; a finite `-stream_loop 3` hangs identically, so this is not about
    // the infinite count. The sequential path has never hit it because its bed is
    // normally longer than the video and so never wraps.
    // The bed's own input carries no loop flag. Video inputs still use `-stream_loop`
    // and are unaffected — measured: a looping video input encodes fine alongside the
    // very mix that hangs on a looping audio one.
    expect(inputArgs(args).at(-1)).toEqual(["-i", "/tmp/music.bin"]);
    // `size` must cover the whole clip at 48kHz, or only the first `size` samples of
    // the bed repeat and the loop plays a fragment instead of the music.
    expect(filterGraph).toContain("aloop=loop=-1:size=960000");
  });

  it("does not loop a bed that is already long enough", () => {
    const { filterGraph } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 6_000 })]),
        track("music-0", "music", [
          audioClip("music", { durationMs: 6_000, volume: 0.14, sourceDurationMs: 30_000 }),
        ]),
      ]),
    );

    expect(filterGraph).not.toContain("aloop");
  });

  it("never loops a voiceover, however short", () => {
    const { filterGraph } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 10_000 })]),
        track("voiceover-0", "voiceover", [
          audioClip("vo", { durationMs: 10_000, sourceDurationMs: 1_000 }),
        ]),
      ]),
    );

    // Repeating a sentence to fill the slot would be worse than the silence, and the
    // silence is what the user can see on the timeline.
    expect(filterGraph).not.toContain("aloop");
  });

  it("encodes silence when the cut has no audio at all", () => {
    const { args, filterGraph } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 3_000 })]),
      ]),
    );

    // A video with no audio track confuses some players, and there is genuinely
    // nothing to encode. Generated in the graph rather than as an `-f lavfi` input:
    // an extra input would have to precede `-filter_complex` to be legal, and would
    // shift every filter index by one.
    // 3.800, not the 3.000 clip: the silence spans the whole output, including the
    // held tail, so the audio track does not end early.
    expect(filterGraph).toContain("anullsrc=r=48000:cl=stereo:d=3.800");
    expect(args).not.toContain("-shortest");
    // Mapped and encoded like any other audio, because here it *is* the audio.
    expect(args).toContain("-c:a");
  });
});

describe("editFfmpegArgs — text and captions (§Phase B.6, B.7)", () => {
  it("burns captions through the existing subtitles filter and style", () => {
    const { filterGraph } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 4_000 })]),
        track("caption-0", "caption", [
          clip({ id: "cue-0", startMs: 0, durationMs: 900, text: "hello there" }),
        ]),
      ]),
      { subtitlePath: "/tmp/captions.srt" },
    );

    expect(filterGraph).toContain("subtitles=/tmp/captions.srt:force_style='");
    // The caption path's 0.55 factor, unchanged: libass scales an SRT against its own
    // 384x288 default rather than the output frame.
    expect(filterGraph).toContain("FontSize=26");
    expect(filterGraph).toContain("Alignment=2");
  });

  it("chains the text overlay after the captions so a title paints over one", () => {
    const { filterGraph } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 4_000 })]),
        track("text-0", "text", [
          clip({ id: "t", startMs: 0, durationMs: 2_000, text: "Hook" }),
        ]),
        track("caption-0", "caption", [
          clip({ id: "cue-0", startMs: 0, durationMs: 900, text: "hello" }),
        ]),
      ]),
      { subtitlePath: "/tmp/captions.srt", overlay: true },
    );

    // Two `subtitles` filters in series. Verified against the real binary: an ASS layer
    // at the top chained with an SRT layer at the bottom measured max luma 255 and 248
    // against a base of ~101, so both really composite.
    expect(filterGraph.indexOf("captions.srt")).toBeLessThan(
      filterGraph.indexOf("overlay.ass"),
    );
    expect(filterGraph).toContain("[vsub]subtitles=/tmp/overlay.ass[vtext]");
  });

  it("escapes a Windows subtitle path so the graph still parses", () => {
    const { filterGraph } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 4_000 })]),
      ]),
      { subtitlePath: "C:\\Users\\dev\\AppData\\Local\\Temp\\tally\\captions.srt" },
    );

    // An unescaped colon silently becomes a *different filter option* rather than
    // erroring, which is why this is asserted rather than assumed.
    expect(filterGraph).toContain("C\\\\:/Users/dev/AppData/Local/Temp/tally/captions.srt");
  });

  it("omits both filters when there is nothing to draw", () => {
    const { filterGraph } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 4_000 })]),
      ]),
    );

    expect(filterGraph).not.toContain("subtitles=");
  });
});

describe("editOverlayScript", () => {
  it("declares the real frame so font size is in output pixels", () => {
    const script = editOverlayScript(
      compileEditDocument(
        document([
          track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 4_000 })]),
          track("text-0", "text", [
            clip({ id: "t", startMs: 500, durationMs: 2_000, text: "Hook" }),
          ]),
        ]),
      ),
    );

    expect(script).toContain("PlayResX: 1920");
    expect(script).toContain("PlayResY: 1080");
    // 48 * 1.6 = 77: a title, not a subtitle, and larger than the caption bar under it.
    expect(script).toContain(",77,");
    // Centiseconds, single-digit hour.
    expect(script).toContain("Dialogue: 0,0:00:00.50,0:00:02.50,Overlay,,0,0,0,,Hook");
  });

  it("strips ASS override syntax out of user text", () => {
    const script = editOverlayScript(
      compileEditDocument(
        document([
          track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 4_000 })]),
          track("text-0", "text", [
            // `{\an7}` typed into a title would silently move it; ASS has no escape
            // for a brace, so both are removed rather than escaped.
            clip({ id: "t", startMs: 0, durationMs: 2_000, text: "{\\an7}Buy now: 50% off" }),
          ]),
        ]),
      ),
    );

    expect(script).toContain("an7Buy now: 50% off");
    expect(script).not.toContain("{");
    // A colon and a comma are safe: `Text` is the last field, and this is a file
    // rather than a filter argument.
    expect(script).toContain("now: 50%");
  });

  it("returns null when the text track is empty", () => {
    const script = editOverlayScript(
      compileEditDocument(
        document([
          track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 4_000 })]),
        ]),
      ),
    );

    expect(script).toBeNull();
  });
});

describe("editFfmpegArgs — output settings match the sequential builder", () => {
  it("uses the same encoder flags, so opening the editor does not change the encode", () => {
    const { args } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 4_000 })]),
      ]),
    );

    expect(args.slice(0, 4)).toEqual(["-y", "-nostdin", "-hide_banner", "-xerror"]);
    expect(args).toContain("libx264");
    expect(args).toContain("veryfast");
    expect(args).toContain("22");
    expect(args).toContain("yuv420p");
    // Every 2s at 30fps: YouTube's recommended keyframe interval.
    expect(args).toContain("60");
    // The one flag that makes an MP4 playable before it is fully downloaded.
    expect(args).toContain("+faststart");
    // Real progress comes from ffmpeg's own `out_time_ms` and nowhere else (§42).
    expect(args).toContain("-progress");
    expect(args.at(-1)).toBe("/tmp/out.mp4");
  });

  it("bounds the output to the compiled duration", () => {
    const { args, edit } = plan(
      document([
        track("video-0", "video", [videoClip({ id: "v", startMs: 0, durationMs: 4_000 })]),
        // Music running past the last visual is part of the video, not a mistake.
        track("music-0", "music", [audioClip("music", { durationMs: 9_000, volume: 0.2 })]),
      ]),
    );

    expect(edit.durationMs).toBe(9_000);
    expect(outputDuration(args)).toBe("9.000");
  });
});

/** An audio clip with a source, since the schema requires one for a media clip. */
function audioClip(
  id: string,
  overrides: Partial<EditClip> & { sourceDurationMs?: number } = {},
): EditClip {
  sourceCounter += 1;
  // Hoisted out of `overrides` because it belongs to the clip's *source*, and whether
  // the bed has to loop is decided from it.
  const { sourceDurationMs = 30_000, ...rest } = overrides;
  return clip({
    id,
    durationMs: 4_000,
    source: {
      assetId: `00000000-0000-4000-8000-${String(sourceCounter).padStart(12, "0")}`,
      storageKey: `${id}.mp3`,
      kind: null,
      sourceDurationMs,
    },
    ...rest,
  });
}

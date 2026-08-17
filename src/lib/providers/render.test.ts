/**
 * Local renderer tests (§39).
 *
 * The filter graph is the most intricate thing in the codebase and the most
 * expensive to debug by running it: a misspelled label fails after ffmpeg has
 * already demuxed every input. So the argument list is asserted directly.
 *
 * Several of these assertions look pedantic and are not. `normalize=0` on `amix`,
 * even output dimensions, `+faststart`, and the Windows path escaping each
 * correspond to a specific way a render goes wrong — silently loud music, a pass
 * that fails at 99%, a preview that will not play until fully downloaded, and a
 * filter graph that will not parse on the machine this is being developed on.
 */
import { describe, expect, it } from "vitest";
import { ffmpegArgs, toSrt, toVtt } from "@/lib/providers/render";
import { buildTimeline, type SceneInput } from "@/lib/video/timeline";

function scene(index: number, overrides: Partial<SceneInput> = {}): SceneInput {
  return {
    index,
    label: `Scene ${index}`,
    onScreenText: null,
    transition: "fade",
    visualKey: `visual-${index}.mp4`,
    visualKind: "stock_video",
    visualDurationMs: 8_000,
    narrationKey: `narration-${index}.mp3`,
    narrationDurationMs: 5_000,
    ...overrides,
  };
}

interface ArgsCase {
  scenes?: SceneInput[];
  music?: boolean;
  subtitlePath?: string | null;
  captionCues?: Array<{ startMs: number; endMs: number; text: string }>;
  captionStyle?: Record<string, unknown>;
}

/** Build a plausible ffmpeg invocation for a timeline. */
function args(options: ArgsCase = {}): string[] {
  const scenes = options.scenes ?? [scene(0), scene(1)];

  const timeline = buildTimeline({
    scenes,
    music: options.music
      ? {
          key: "music.mp3",
          volume: 0.14,
          duckUnderNarration: true,
          startMs: 0,
          durationMs: 180_000,
        }
      : null,
    captionCues: options.captionCues ?? [],
    burnCaptions: true,
    captionStyle: options.captionStyle ?? null,
  });

  // Inputs are laid out the way `ffmpegRender` lays them out: visuals, then
  // narration, then music.
  const inputs: string[] = [];
  const sceneInputIndex = new Map<number, number>();
  const narrationInputIndex = new Map<number, number>();

  for (const s of scenes) {
    sceneInputIndex.set(s.index, inputs.length);
    inputs.push(`/tmp/visual-${s.index}.mp4`);
  }
  for (const s of scenes) {
    if (!s.narrationKey) continue;
    narrationInputIndex.set(s.index, inputs.length);
    inputs.push(`/tmp/narration-${s.index}.mp3`);
  }

  let musicIndex: number | null = null;
  if (options.music) {
    musicIndex = inputs.length;
    inputs.push("/tmp/music.mp3");
  }

  return ffmpegArgs({
    timeline,
    inputs,
    sceneInputIndex,
    narrationInputIndex,
    musicIndex,
    subtitlePath: options.subtitlePath ?? null,
    output: "/tmp/out.mp4",
  });
}

/** The single `-filter_complex` value. */
function graph(list: readonly string[]): string {
  const index = list.indexOf("-filter_complex");
  expect(index).toBeGreaterThan(-1);
  return list[index + 1]!;
}

describe("ffmpegArgs", () => {
  it("overwrites without prompting and never waits on stdin", () => {
    // A worker has no terminal; ffmpeg asking "overwrite? [y/N]" would hang the
    // job until the timeout killed it.
    const list = args();
    expect(list).toContain("-y");
    expect(list).toContain("-nostdin");
  });

  it("loops a video clip to fill its slot rather than cutting to black", () => {
    const list = args({ scenes: [scene(0, { narrationDurationMs: 12_000 })] });
    const at = list.indexOf("-stream_loop");
    expect(at).toBeGreaterThan(-1);
    expect(list[at + 1]).toBe("-1");
  });

  it("turns a still into a clip of exactly the slot length", () => {
    const list = args({
      scenes: [
        scene(0, {
          visualKind: "stock_image",
          visualDurationMs: null,
          narrationDurationMs: 7_500,
        }),
      ],
    });

    const at = list.indexOf("-loop");
    expect(at).toBeGreaterThan(-1);
    expect(list[at + 1]).toBe("1");
    // The -t that bounds the still, before the -i it applies to.
    expect(list.slice(at, list.indexOf("-i")).join(" ")).toContain("7.500");
  });

  it("pads to even 1080p dimensions on every scene", () => {
    // H.264 4:2:0 cannot encode an odd dimension, and ffmpeg only fails at the
    // end of the pass.
    const g = graph(args());
    const scales = g.match(/scale=1920:1080/g) ?? [];
    expect(scales).toHaveLength(2);
    expect(g).toContain("pad=1920:1080");
    expect(g).toContain("setsar=1");
    expect(g).toContain("format=yuv420p");
  });

  it("concatenates the scenes in order", () => {
    const g = graph(args({ scenes: [scene(0), scene(1), scene(2)] }));
    expect(g).toContain("[v0][v1][v2]concat=n=3:v=1:a=0[vconcat]");
  });

  it("renames rather than concatenating a single scene", () => {
    const g = graph(args({ scenes: [scene(0)] }));
    expect(g).toContain("null[vconcat]");
    expect(g).not.toContain("concat=n=1");
  });

  it("holds the last frame for the tail instead of cutting to black", () => {
    const g = graph(args());
    expect(g).toContain("tpad=stop_mode=clone");
  });

  it("delays each narration segment to its measured offset", () => {
    const g = graph(
      args({
        scenes: [
          scene(0, { narrationDurationMs: 6_000 }),
          scene(1, { narrationDurationMs: 4_000 }),
        ],
      }),
    );

    // Scene 0 at 0ms, scene 1 at 6000ms — the accumulated audio length, not a
    // division of the total.
    expect(g).toContain("adelay=0|0");
    expect(g).toContain("adelay=6000|6000");
  });

  it("mixes without normalising, so the music does not swell in the pauses", () => {
    const g = graph(args({ music: true }));
    expect(g).toContain("normalize=0");
    expect(g).toContain("dropout_transition=0");
    expect(g).toContain("duration=longest");
  });

  it("fades the music in and out", () => {
    const g = graph(args({ music: true }));
    expect(g).toContain("afade=t=in:st=0");
    expect(g).toMatch(/afade=t=out:st=\d+\.\d\d/);
  });

  it("keeps the music bed quiet under the narration", () => {
    const g = graph(args({ music: true }));
    const match = /volume=(\d\.\d+)/.exec(g);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeLessThanOrEqual(0.3);
  });

  it("mixes nothing when there is only narration", () => {
    const g = graph(args({ scenes: [scene(0)] }));
    expect(g).not.toContain("amix");
  });

  it("encodes silence when there is no audio at all", () => {
    const list = args({
      scenes: [scene(0, { narrationKey: null, narrationDurationMs: 0 })],
    });

    // A track-less MP4 confuses some players, and there is genuinely no audio.
    expect(list.join(" ")).toContain("anullsrc");
    expect(list).toContain("-shortest");
  });

  it("burns in subtitles above the visuals when a path is given", () => {
    const g = graph(
      args({
        subtitlePath: "/tmp/captions.srt",
        captionCues: [{ startMs: 0, endMs: 1_000, text: "hello" }],
      }),
    );

    expect(g).toContain("subtitles=");
    expect(g).toContain("force_style=");
    // The subtitle filter consumes the padded video and produces the final label.
    expect(g).toContain("[vout]");
  });

  it("escapes a Windows path in the subtitles filter", () => {
    // `C:\Users\...` contains both the filter option separator and the filter
    // escape character; unescaped it is a parse error, not a wrong-looking video.
    const g = graph(
      args({
        subtitlePath: "C:\\Users\\SPECTRE\\AppData\\Local\\Temp\\tally\\captions.srt",
        captionCues: [{ startMs: 0, endMs: 1_000, text: "hello" }],
      }),
    );

    const filter = /subtitles=([^:]*(?::[^:]*)*?):force_style/.exec(g);
    expect(filter).not.toBeNull();
    expect(filter![1]).not.toBe(
      "C:\\Users\\SPECTRE\\AppData\\Local\\Temp\\tally\\captions.srt",
    );
    expect(filter![1]).toContain("captions.srt");
  });

  it("applies the brand caption colour to the burned-in style", () => {
    const g = graph(
      args({
        subtitlePath: "/tmp/captions.srt",
        captionCues: [{ startMs: 0, endMs: 1_000, text: "hello" }],
        captionStyle: { color: "#E8332B" },
      }),
    );

    // ASS is &HAABBGGRR — reversed channels and inverted alpha. Tally red is
    // R=E8 G=33 B=2B, so BBGGRR is 2B33E8.
    expect(g).toContain("PrimaryColour=&H002B33E8");
  });

  it("produces a faststart H.264 MP4 at a YouTube-friendly keyframe interval", () => {
    const list = args();
    expect(list).toContain("libx264");
    expect(list).toContain("yuv420p");
    // Playable before it is fully downloaded — the studio preview depends on it.
    expect(list[list.indexOf("-movflags") + 1]).toBe("+faststart");
    expect(list[list.indexOf("-g") + 1]).toBe("60");
  });

  it("encodes AAC stereo at 48kHz when there is audio", () => {
    const list = args();
    expect(list).toContain("aac");
    expect(list[list.indexOf("-ar") + 1]).toBe("48000");
    expect(list[list.indexOf("-ac") + 1]).toBe("2");
  });

  it("reports progress on stdout and puts the output path last", () => {
    const list = args();
    // The progress stream is how `renders.progress` gets a real number (§42).
    expect(list).toContain("-progress");
    expect(list[list.indexOf("-progress") + 1]).toBe("pipe:1");
    expect(list.at(-1)).toBe("/tmp/out.mp4");
  });

  it("bounds the output to the timeline duration", () => {
    const list = args();
    const at = list.lastIndexOf("-t");
    expect(at).toBeGreaterThan(-1);
    expect(Number(list[at + 1])).toBeGreaterThan(0);
  });

  it("refuses a timeline with no usable visual instead of encoding nothing", () => {
    expect(() =>
      ffmpegArgs({
        timeline: buildTimeline({
          scenes: [scene(0)],
          music: null,
          captionCues: [],
          burnCaptions: true,
        }),
        inputs: [],
        sceneInputIndex: new Map(),
        narrationInputIndex: new Map(),
        musicIndex: null,
        subtitlePath: null,
        output: "/tmp/out.mp4",
      }),
    ).toThrow(/no scene produced a video stream/);
  });
});

describe("toSrt", () => {
  const cues = [
    { startMs: 0, endMs: 1_500, text: "First line" },
    { startMs: 1_500, endMs: 3_250, text: "Second line" },
  ];

  it("numbers cues from one with comma-separated milliseconds", () => {
    // Blocks are separated by a blank line and the file ends with one, which is
    // what the format requires and what ffmpeg's subtitles filter expects.
    expect(toSrt(cues)).toBe(
      "1\n" +
        "00:00:00,000 --> 00:00:01,500\n" +
        "First line\n" +
        "\n" +
        "2\n" +
        "00:00:01,500 --> 00:00:03,250\n" +
        "Second line\n" +
        "\n",
    );
  });

  it("pads hours past an hour of video", () => {
    expect(toSrt([{ startMs: 3_723_456, endMs: 3_724_000, text: "late" }])).toContain(
      "01:02:03,456 --> 01:02:04,000",
    );
  });

  it("collapses a blank line inside a cue that would end it early", () => {
    const srt = toSrt([{ startMs: 0, endMs: 1_000, text: "one\n\n\ntwo" }]);
    expect(srt).toContain("one\ntwo");
  });

  it("returns just a newline for no cues rather than an invalid file", () => {
    expect(toSrt([])).toBe("\n");
  });
});

describe("toVtt", () => {
  it("starts with the WEBVTT signature and uses dotted milliseconds", () => {
    const vtt = toVtt([{ startMs: 500, endMs: 2_000, text: "Hello" }]);
    // A VTT without the signature is rejected outright by YouTube's endpoint.
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:00.500 --> 00:00:02.000");
    expect(vtt).not.toContain(",500");
  });

  it("is still a valid file with no cues", () => {
    expect(toVtt([])).toBe("WEBVTT\n\n");
  });
});

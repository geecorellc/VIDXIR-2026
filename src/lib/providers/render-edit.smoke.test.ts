/**
 * End-to-end encoder smoke tests for the edit compositor (Phase B).
 *
 * `render-edit.test.ts` asserts the argument list, which catches a misspelled label
 * cheaply. It cannot catch the failure that matters most here: a graph that is perfectly
 * well-formed, encodes without complaint, exits zero — and puts the wrong thing on screen
 * at the wrong time. An edit is *about* what is where and when, so a test that only
 * checks "an MP4 exists" would pass on a renderer that ignored every trim and gap.
 *
 * So these tests **decode the result and read pixels**. Each source still is a distinct
 * solid colour, the produced MP4 is sampled at chosen timestamps, and the colour at each
 * timestamp is compared against the clip the document says should be there. That is what
 * proves positioning, gaps, trims, stacking order and z-order rather than asserting they
 * were requested.
 *
 * Independent of Postgres, Redis and MinIO, like the sequential smoke suite: assets are
 * generated in-process into a temp directory, so a run needs no services.
 *
 * The MP4 assertions parse the box tree by hand. Trusting ffmpeg's exit code to prove
 * ffmpeg produced valid output would be circular, and `ffmpeg-static` ships no ffprobe.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpegBinary } from "@/lib/media/ffmpeg";
import { silentWav, solidPng } from "@/lib/media/synthetic";
import {
  editFfmpegArgs,
  editOverlayScript,
  editRenderClips,
} from "@/lib/providers/render-edit";
import { toSrt } from "@/lib/providers/render";
import {
  compileEditDocument,
  parseEditDocument,
  type EditClip,
  type EditDocument,
  type EditTrack,
  type TrackKind,
} from "@/lib/video/edit-document";
import { resolveCaptionStyle } from "@/lib/video/timeline";

/**
 * The same environment gate the sequential smoke suite uses: `ffmpeg-static` is a
 * declared dependency, and resolves to null only when its postinstall download was
 * skipped by policy — the condition that makes `render: not_configured` honest (§48).
 * When the binary exists every test below runs and must pass.
 */
const binary = ffmpegBinary();
const suite = binary ? describe : describe.skip;

const ENCODE_TIMEOUT_MS = 90_000;

/**
 * A small frame. The compositor's cost is per-pixel and these tests encode several
 * videos; 320x180 exercises the identical graph at a fraction of the time, and the
 * dimensions are asserted from the file rather than assumed.
 */
const FRAME = { width: 320, height: 180 } as const;

/** Mock visuals are smaller than the frame, so every test exercises scale-and-pad. */
const SOURCE = { width: 160, height: 90 } as const;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vidxir-edit-smoke-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

interface RunResult {
  code: number | null;
  stderr: string;
}

/** Spawn ffmpeg the way `runFfmpeg` does, with a hard kill so a stall fails the test. */
function run(args: readonly string[], killAfterMs = ENCODE_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary as string, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, killAfterMs);

    // Both pipes must be drained; a full stderr buffer blocks the child.
    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8_000);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error(`ffmpeg did not exit; stderr tail: ${stderr.slice(-500)}`));
        return;
      }
      resolve({ code, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Pixel probing — what makes these tests about the edit rather than the encode
// ---------------------------------------------------------------------------

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * The average colour of one frame, sampled at `atMs`.
 *
 * Scaled to 1x1 so the value is the frame's mean rather than one corner's pixel: the
 * compositor pads to the frame with black, so a corner would read black on every frame
 * and prove nothing. `-ss` before `-i` seeks to the nearest frame at or after the time.
 */
async function frameAt(path: string, atMs: number): Promise<Rgb> {
  const raw = join(dir, `probe-${probeCounter()}.raw`);
  const result = await run([
    "-y",
    "-nostdin",
    "-hide_banner",
    "-ss",
    (atMs / 1000).toFixed(3),
    "-i",
    path,
    "-frames:v",
    "1",
    "-vf",
    "scale=1:1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    raw,
  ]);
  expect(result.code, `probe at ${atMs}ms: ${result.stderr.slice(-300)}`).toBe(0);

  const bytes = await readFile(raw);
  expect(bytes.byteLength, "one rgb24 pixel").toBe(3);
  return { r: bytes[0] as number, g: bytes[1] as number, b: bytes[2] as number };
}

let probes = 0;
function probeCounter(): number {
  probes += 1;
  return probes;
}

/** The mean colour of a source PNG, measured the same way, so the two are comparable. */
async function sourceColour(path: string): Promise<Rgb> {
  return frameAt(path, 0);
}

/**
 * Assert two colours match within a tolerance.
 *
 * Tolerant because the value has been through scale-and-pad, a yuv420p round trip and a
 * crf-22 encode. Generous enough to survive that, far tighter than the ~90-unit gaps
 * between the distinct source colours these tests use, so a wrong clip cannot pass.
 */
function expectColour(actual: Rgb, expected: Rgb, label: string, tolerance = 18): void {
  const delta =
    Math.abs(actual.r - expected.r) +
    Math.abs(actual.g - expected.g) +
    Math.abs(actual.b - expected.b);
  expect(
    delta,
    `${label}: expected rgb(${expected.r},${expected.g},${expected.b}), ` +
      `got rgb(${actual.r},${actual.g},${actual.b})`,
  ).toBeLessThanOrEqual(tolerance * 3);
}

function expectBlack(actual: Rgb, label: string): void {
  expectColour(actual, { r: 0, g: 0, b: 0 }, label, 10);
}

// ---------------------------------------------------------------------------
// MP4 structure — the same hand-rolled parser the sequential suite uses
// ---------------------------------------------------------------------------

interface Box {
  type: string;
  payload: Buffer;
}

function boxes(buffer: Buffer): Box[] {
  const found: Box[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.byteLength) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    let header = 8;

    if (size === 1) {
      if (offset + 16 > buffer.byteLength) break;
      size = Number(buffer.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = buffer.byteLength - offset;
    }

    if (size < header || offset + size > buffer.byteLength) break;
    found.push({ type, payload: buffer.subarray(offset + header, offset + size) });
    offset += size;
  }

  return found;
}

const CONTAINERS = new Map([
  ["moov", 0],
  ["trak", 0],
  ["mdia", 0],
  ["minf", 0],
  ["stbl", 0],
  ["edts", 0],
  ["udta", 0],
  // 4 bytes version+flags, then a 4-byte entry count.
  ["stsd", 8],
]);

function findBoxes(buffer: Buffer, type: string, depth = 0): Buffer[] {
  if (depth > 8) return [];
  const hits: Buffer[] = [];

  for (const box of boxes(buffer)) {
    if (box.type === type) hits.push(box.payload);
    const prefix = CONTAINERS.get(box.type);
    if (prefix !== undefined) {
      hits.push(...findBoxes(box.payload.subarray(prefix), type, depth + 1));
    }
  }

  return hits;
}

function handlerTypes(mp4: Buffer): string[] {
  return findBoxes(mp4, "hdlr").map((payload) => payload.toString("ascii", 8, 12));
}

function movieDurationMs(mp4: Buffer): number {
  const [mvhd] = findBoxes(mp4, "mvhd");
  expect(mvhd, "mvhd box").toBeDefined();

  const version = (mvhd as Buffer)[0];
  if (version === 1) {
    const timescale = (mvhd as Buffer).readUInt32BE(20);
    const duration = Number((mvhd as Buffer).readBigUInt64BE(24));
    return (duration / timescale) * 1000;
  }

  const timescale = (mvhd as Buffer).readUInt32BE(12);
  const duration = (mvhd as Buffer).readUInt32BE(16);
  return (duration / timescale) * 1000;
}

function codedSize(mp4: Buffer): { width: number; height: number } {
  const [avc1] = findBoxes(mp4, "avc1");
  expect(avc1, "avc1 sample entry").toBeDefined();
  return {
    width: (avc1 as Buffer).readUInt16BE(24),
    height: (avc1 as Buffer).readUInt16BE(26),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let assetCounter = 0;

function assetId(): string {
  assetCounter += 1;
  return `00000000-0000-4000-8000-${String(assetCounter).padStart(12, "0")}`;
}

function clip(overrides: Partial<EditClip> & { id: string }): EditClip {
  return {
    startMs: 0,
    durationMs: 1_000,
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

function document(tracks: EditTrack[]): EditDocument {
  // Through the real parser, so no test asserts on a document the API would reject.
  return parseEditDocument({
    schemaVersion: 1,
    // 320x180 is `landscape` scaled down for test speed; the format enum has no
    // arbitrary size, so the frame is overridden on the compiled timeline below.
    format: "landscape",
    tracks,
    captions: { burnedIn: true, style: resolveCaptionStyle({ fontSizePx: 40 }) },
    music: { duckUnderNarration: true },
    brand: { primaryColor: "#FFE0A3", secondaryColor: null, fontPreference: null },
  });
}

/** A still on disk, plus everything a clip needs to reference it. */
async function still(slug: string): Promise<{ path: string; source: EditClip["source"] }> {
  const path = join(dir, `${slug}.img`);
  await writeFile(path, solidPng({ ...SOURCE, seed: slug }));
  return {
    path,
    source: {
      assetId: assetId(),
      storageKey: `${slug}.png`,
      kind: "stock_image",
      sourceDurationMs: null,
    },
  };
}

/** A silent WAV on disk, plus its clip source. */
async function audio(slug: string, durationMs: number): Promise<EditClip["source"]> {
  const path = join(dir, `${slug}.audio`);
  await writeFile(path, silentWav(durationMs));
  audioPaths.set(`${slug}.wav`, path);
  return {
    assetId: assetId(),
    storageKey: `${slug}.wav`,
    kind: null,
    sourceDurationMs: durationMs,
  };
}

const audioPaths = new Map<string, string>();
const visualPaths = new Map<string, string>();

/**
 * Encode a document, the way `ffmpegRenderEdit` does.
 *
 * Deliberately mirrors that function's input layout — visuals in paint order then audio,
 * one input per clip — and calls the same production builder, so what is encoded here is
 * what production encodes. The frame is overridden to `FRAME` for speed.
 */
async function encode(
  slug: string,
  doc: EditDocument,
  options: { captions?: boolean; overlay?: boolean; viaScript?: boolean } = {},
): Promise<{ output: string; durationMs: number; graph: string }> {
  const compiled = compileEditDocument(doc);
  const edit = {
    ...compiled,
    timeline: { ...compiled.timeline, width: FRAME.width, height: FRAME.height },
  };

  const { visuals, audio: audioClips } = editRenderClips(edit);

  const inputs: string[] = [];
  const clipInputIndex = new Map<string, number>();

  for (const c of [...visuals, ...audioClips]) {
    const key = c.storageKey as string;
    const path = visualPaths.get(key) ?? audioPaths.get(key);
    if (!path) throw new Error(`no file was prepared for ${key}`);
    clipInputIndex.set(c.clipId, inputs.length);
    inputs.push(path);
  }

  let subtitlePath: string | null = null;
  const cues = edit.timeline.captions?.cues ?? [];
  if (options.captions && cues.length > 0) {
    subtitlePath = join(dir, `${slug}-captions.srt`);
    await writeFile(subtitlePath, toSrt(cues), "utf8");
  }

  let overlayPath: string | null = null;
  const overlay = editOverlayScript(edit);
  if (options.overlay && overlay) {
    overlayPath = join(dir, `${slug}-overlay.ass`);
    await writeFile(overlayPath, overlay, "utf8");
  }

  const output = join(dir, `${slug}-output.mp4`);
  const plan = editFfmpegArgs({
    edit,
    inputs,
    clipInputIndex,
    subtitlePath,
    overlayPath,
    output,
  });

  /**
   * The production delivery: the graph in a file, via `-filter_complex_script`.
   *
   * `ffmpegRenderEdit` always does this, because a cut with a few hundred clips produces
   * a `-filter_complex` value past Windows' ~32KB command-line limit. Passing `plan.args`
   * as-is — what every other case here does — exercises the graph but not the rewrite,
   * and the rewrite is where an escaped subtitle path could break: inside a file, ffmpeg
   * tokenises the value itself instead of the shell handing it over intact.
   *
   * Kept as the identical two-step transformation `render.ts` performs, so this covers
   * that code rather than an approximation of it.
   */
  let args = plan.args;
  if (options.viaScript) {
    const graphPath = join(dir, `${slug}-graph.txt`);
    await writeFile(graphPath, plan.filterGraph, "utf8");
    args = plan.args.map((arg, index) =>
      plan.args[index - 1] === "-filter_complex" ? graphPath : arg,
    );
    const complexAt = args.indexOf("-filter_complex");
    if (complexAt >= 0) args[complexAt] = "-filter_complex_script";
    expect(args, "the rewrite must have happened").toContain("-filter_complex_script");
  }

  const result = await run(args);
  expect(result.code, `encode failed: ${result.stderr.slice(-600)}`).toBe(0);

  return { output, durationMs: edit.durationMs, graph: plan.filterGraph };
}

/** Register a still so `encode` can find its file by storage key. */
async function visual(slug: string): Promise<EditClip["source"]> {
  const { path, source } = await still(slug);
  visualPaths.set((source as { storageKey: string }).storageKey, path);
  return source;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite("edited timeline → real MP4", () => {
  it(
    "produces a valid, playable MP4 from an edited document",
    async () => {
      const a = await visual("valid-a");
      const b = await visual("valid-b");
      const narration = await audio("valid-vo", 1_500);

      const { output, durationMs } = await encode(
        "valid",
        document([
          track("video-0", "video", [
            clip({ id: "a", startMs: 0, durationMs: 1_000, source: a }),
            clip({ id: "b", startMs: 1_000, durationMs: 1_500, source: b }),
          ]),
          track("voiceover-0", "voiceover", [
            clip({ id: "vo", startMs: 0, durationMs: 1_500, volume: 0.9, source: narration }),
          ]),
        ]),
      );

      const mp4 = await readFile(output);
      expect(mp4.byteLength).toBeGreaterThan(1_000);

      // A real container, parsed rather than assumed.
      const top = boxes(mp4).map((box) => box.type);
      expect(top).toContain("ftyp");
      expect(top).toContain("moov");
      expect(top).toContain("mdat");

      // `+faststart`: moov before mdat is what makes it playable while downloading.
      expect(top.indexOf("moov")).toBeLessThan(top.indexOf("mdat"));

      // Both streams present — a video with no audio track confuses some players.
      expect(handlerTypes(mp4)).toContain("vide");
      expect(handlerTypes(mp4)).toContain("soun");

      // 2.5s of clips plus the 800ms tail.
      expect(durationMs).toBe(3_300);
      expect(movieDurationMs(mp4)).toBeGreaterThan(3_000);
      expect(movieDurationMs(mp4)).toBeLessThan(3_600);

      expect(codedSize(mp4)).toEqual({ width: FRAME.width, height: FRAME.height });
    },
    ENCODE_TIMEOUT_MS,
  );

  it(
    "places each clip at its own start, leaves a gap black, and holds the tail",
    async () => {
      const a = await visual("pos-a");
      const b = await visual("pos-b");

      const { output } = await encode(
        "pos",
        document([
          track("video-0", "video", [
            clip({ id: "a", startMs: 0, durationMs: 1_000, source: a }),
            // 1s of nothing between them — the thing `concat` cannot express.
            clip({ id: "b", startMs: 2_000, durationMs: 1_000, source: b }),
          ]),
        ]),
      );

      const [colourA, colourB] = await Promise.all([
        sourceColour(visualPaths.get("pos-a.png") as string),
        sourceColour(visualPaths.get("pos-b.png") as string),
      ]);

      expectColour(await frameAt(output, 500), colourA, "first clip at 0.5s");
      // The gap: genuinely black, not the previous clip's last frame held over.
      expectBlack(await frameAt(output, 1_500), "gap at 1.5s");
      expectColour(await frameAt(output, 2_500), colourB, "second clip at 2.5s");
      // The 800ms tail holds the final frame rather than cutting to black.
      expectColour(await frameAt(output, 3_400), colourB, "tail at 3.4s");
    },
    ENCODE_TIMEOUT_MS,
  );

  it(
    "resolves an overlap in favour of the higher track",
    async () => {
      const under = await visual("z-under");
      const over = await visual("z-over");

      const { output } = await encode(
        "z",
        document([
          track("video-0", "video", [
            clip({ id: "under", startMs: 0, durationMs: 3_000, source: under }),
          ]),
          // A cutaway on top for the middle second.
          track("video-1", "video", [
            clip({ id: "over", startMs: 1_000, durationMs: 1_000, source: over }),
          ], { order: 5 }),
        ]),
      );

      const [colourUnder, colourOver] = await Promise.all([
        sourceColour(visualPaths.get("z-under.png") as string),
        sourceColour(visualPaths.get("z-over.png") as string),
      ]);

      expectColour(await frameAt(output, 500), colourUnder, "base before the cutaway");
      // The whole point of stacking: the higher track wins where they overlap.
      expectColour(await frameAt(output, 1_500), colourOver, "cutaway during the overlap");
      expectColour(await frameAt(output, 2_500), colourUnder, "base after the cutaway");
    },
    ENCODE_TIMEOUT_MS,
  );

  it(
    "plays only the trimmed window of a source, and holds it for the rest of the slot",
    async () => {
      // A three-part source: each second a different colour, so a wrong seek shows up as
      // the wrong colour rather than as a plausible-looking frame.
      const parts = await Promise.all([
        visual("trim-part-0"),
        visual("trim-part-1"),
        visual("trim-part-2"),
      ]);

      const stripPath = join(dir, "trim-strip.mp4");
      const stripArgs = [
        "-y",
        "-nostdin",
        "-hide_banner",
        ...parts.flatMap((_, index) => [
          "-loop",
          "1",
          "-framerate",
          "30",
          "-t",
          "1.000",
          "-i",
          visualPaths.get(`trim-part-${index}.png`) as string,
        ]),
        "-filter_complex",
        `[0:v][1:v][2:v]concat=n=3:v=1:a=0,scale=${SOURCE.width}:${SOURCE.height}[v]`,
        "-map",
        "[v]",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        // Lossless, so the probe measures the source colour rather than the encoder's.
        "-qp",
        "0",
        "-pix_fmt",
        "yuv420p",
        stripPath,
      ];
      const strip = await run(stripArgs);
      expect(strip.code, `strip build failed: ${strip.stderr.slice(-400)}`).toBe(0);

      const source: EditClip["source"] = {
        assetId: assetId(),
        storageKey: "trim-strip.mp4",
        kind: "stock_video",
        sourceDurationMs: 3_000,
      };
      visualPaths.set("trim-strip.mp4", stripPath);

      const { output } = await encode(
        "trim",
        document([
          track("video-0", "video", [
            clip({
              id: "trimmed",
              startMs: 0,
              // A 2s slot for a 1s window: the middle second plays, then holds.
              durationMs: 2_000,
              sourceInMs: 1_000,
              sourceOutMs: 2_000,
              source,
            }),
          ]),
        ]),
      );

      // The middle second of the strip is what the trim selected.
      const expected = await frameAt(stripPath, 1_500);
      const first = await frameAt(stripPath, 500);

      expectColour(await frameAt(output, 500), expected, "trimmed window at 0.5s");
      // Held, not looped: looping would replay material the user cut away, so the
      // strip's *first* second must not reappear.
      const held = await frameAt(output, 1_500);
      expectColour(held, expected, "held frame at 1.5s");
      expect(
        Math.abs(held.r - first.r) + Math.abs(held.g - first.g) + Math.abs(held.b - first.b),
        "the trimmed-away first second must not reappear",
      ).toBeGreaterThan(20);
    },
    ENCODE_TIMEOUT_MS,
  );

  it(
    "burns captions and text overlays over the composited frame",
    async () => {
      const base = await visual("text-base");

      const { output, graph } = await encode(
        "text",
        document([
          track("video-0", "video", [
            clip({ id: "v", startMs: 0, durationMs: 2_000, source: base }),
          ]),
          track("text-0", "text", [
            clip({ id: "t", startMs: 0, durationMs: 2_000, text: "BIG BOLD HOOK" }),
          ], { order: 1 }),
          track("caption-0", "caption", [
            clip({ id: "cue", startMs: 0, durationMs: 1_900, text: "spoken words here" }),
          ], { order: 2 }),
        ]),
        { captions: true, overlay: true },
      );

      // Two `subtitles` filters in series, captions first.
      expect(graph.indexOf("captions.srt")).toBeLessThan(graph.indexOf("overlay.ass"));

      // Both layers must actually mark the frame. Sampled per horizontal band rather
      // than as a 1x1 average: text covers a small fraction of the frame, so a
      // whole-frame statistic would not move measurably when a title is drawn.
      const rows = await rowLuma(output, 1_000);
      const flat = await rowLuma(
        (await encode(
          "text-plain",
          document([
            track("video-0", "video", [
              clip({ id: "v", startMs: 0, durationMs: 2_000, source: base }),
            ]),
          ]),
        )).output,
        1_000,
      );
      // The same document with the caption track only. Without this control, "the top
      // of the frame changed" is also satisfied by a caption layer drawn in the wrong
      // place, and the overlay could be doing nothing at all.
      const captionsOnly = await rowLuma(
        (await encode(
          "text-captions-only",
          document([
            track("video-0", "video", [
              clip({ id: "v", startMs: 0, durationMs: 2_000, source: base }),
            ]),
            track("caption-0", "caption", [
              clip({ id: "cue", startMs: 0, durationMs: 1_900, text: "spoken words here" }),
            ], { order: 2 }),
          ]),
          { captions: true },
        )).output,
        1_000,
      );

      /**
       * How far a band moved from the undrawn frame, in either direction.
       *
       * Not "brighter": white glyphs carry a black outline, and averaged across a band
       * over an already-bright still the outline can outweigh the fill and come out
       * *darker*. Which way a band moves depends on the base colour, the font and the
       * copy — none of which this test is asserting. That something was drawn where
       * nothing was drawn before is the actual claim, so the metric is the magnitude of
       * the change.
       */
      const moved = (a: number[], b: number[], from: number, to: number) =>
        Math.max(...a.slice(from, to).map((v, i) => Math.abs(v - (b[from + i] as number))));

      // Captions mark the bottom of the frame, and only the bottom: the caption style
      // is anchored there, and a caption layer that drifted upward would be a
      // regression this is the only assertion positioned to catch.
      expect(
        moved(captionsOnly, flat, 11, 15),
        "captions mark the bottom of the frame",
      ).toBeGreaterThan(12);
      expect(
        moved(captionsOnly, flat, 0, 6),
        "captions leave the top of the frame alone",
      ).toBeLessThan(8);

      // The title marks the top, over and above whatever the captions already did.
      // Bands rather than the whole frame, so a title rendered at the bottom — the
      // ASS default alignment, and what a dropped `verticalPosition` would produce —
      // fails instead of passing on the captions' own contribution.
      expect(
        moved(rows, captionsOnly, 1, 6),
        "the title marks the top of the frame",
      ).toBeGreaterThan(12);
    },
    ENCODE_TIMEOUT_MS,
  );

  it(
    "burns captions and overlays when the graph is delivered as a script file",
    async () => {
      const base = await visual("script-base");
      const bed = await audio("script-bed", 800);

      /**
       * The production path, which every other case here skips.
       *
       * `ffmpegRenderEdit` never passes the graph on the command line — it always writes
       * it to a file and switches to `-filter_complex_script`. Two things only break in
       * that form: an escaped Windows subtitle path, which ffmpeg re-tokenises itself when
       * it reads the file rather than receiving it intact from the shell, and a graph over
       * the ~32KB limit, which is what makes the rewrite mandatory rather than an
       * optimisation. Burned captions plus an overlay is the case with two escaped
       * absolute paths in one graph.
       *
       * The music bed is deliberately shorter than the video, so the in-graph `aloop`
       * that replaced `-stream_loop` is exercised in this form too — a bed that has to
       * wrap while feeding `amix` is what used to hang the encoder outright.
       */
      const scripted = document([
        track("video-0", "video", [
          clip({ id: "v", startMs: 0, durationMs: 2_000, source: base }),
        ]),
        track("text-0", "text", [
          clip({ id: "t", startMs: 0, durationMs: 2_000, text: "SCRIPTED HOOK" }),
        ], { order: 1 }),
        track("caption-0", "caption", [
          clip({ id: "cue", startMs: 0, durationMs: 1_900, text: "spoken words here" }),
        ], { order: 2 }),
        track("music-0", "music", [
          clip({ id: "m", startMs: 0, durationMs: 2_000, volume: 0.14, source: bed }),
        ], { order: 3 }),
      ]);

      const { output, graph } = await encode("script", scripted, {
        captions: true,
        overlay: true,
        viaScript: true,
      });

      // The graph really did contain both escaped paths and the loop, so a pass here is
      // about delivery rather than about a graph that quietly dropped them.
      expect(graph).toContain("captions.srt");
      expect(graph).toContain("overlay.ass");
      expect(graph).toContain("aloop=loop=-1");

      // A real, playable file with both streams — not just exit zero.
      const mp4 = await readFile(output);
      expect(handlerTypes(mp4).sort()).toEqual(["soun", "vide"]);
      expect(codedSize(mp4)).toEqual({ width: FRAME.width, height: FRAME.height });
      expect(movieDurationMs(mp4)).toBeGreaterThan(1_800);

      /**
       * The decisive assertion: the two delivery mechanisms must produce the same frame.
       *
       * Asserting *where* the layers land is the sibling test's job and it already does it
       * against a caption-only control. What is unproven until here is that moving the
       * identical graph into a file does not change the result — an escaping bug would
       * show up as a subtitle filter that silently drew nothing, or drew somewhere else.
       * Comparing band-for-band against the inline encode of the same document catches
       * both, and cannot pass on a frame with no text at all, because the third assertion
       * below requires the bands to have moved off the bare video.
       */
      const viaScript = await rowLuma(output, 1_000);
      const inline = await rowLuma(
        (await encode("script-inline", scripted, {
          captions: true,
          overlay: true,
        })).output,
        1_000,
      );
      const flat = await rowLuma(
        (await encode(
          "script-plain",
          document([
            track("video-0", "video", [
              clip({ id: "v", startMs: 0, durationMs: 2_000, source: base }),
            ]),
          ]),
        )).output,
        1_000,
      );

      viaScript.forEach((value, band) => {
        // Tolerant by one step: both went through an independent crf-22 encode.
        expect(
          Math.abs(value - (inline[band] as number)),
          `band ${band} must match the inline encode`,
        ).toBeLessThanOrEqual(2);
      });

      // And both differ from the bare video, so the comparison above is not two identical
      // frames of undrawn footage agreeing with each other.
      const drawn = Math.max(
        ...viaScript.map((v, band) => Math.abs(v - (flat[band] as number))),
      );
      expect(drawn, "text was burned in at all").toBeGreaterThan(12);
    },
    ENCODE_TIMEOUT_MS,
  );

  it(
    "mixes several audio clips at their own gains and offsets",
    async () => {
      const base = await visual("mix-base");
      const vo = await audio("mix-vo", 1_000);
      const bed = await audio("mix-bed", 4_000);

      const { output } = await encode(
        "mix",
        document([
          track("video-0", "video", [
            clip({ id: "v", startMs: 0, durationMs: 3_000, source: base }),
          ]),
          track("voiceover-0", "voiceover", [
            clip({ id: "vo-a", startMs: 0, durationMs: 1_000, volume: 1, source: vo }),
            // A second clip on the same track, later — a cut voiceover.
            clip({ id: "vo-b", startMs: 1_500, durationMs: 1_000, volume: 0.5, source: vo }),
          ]),
          track("music-0", "music", [
            clip({ id: "bed", startMs: 0, durationMs: 3_800, volume: 0.14, source: bed }),
          ], { order: 1 }),
        ]),
      );

      const mp4 = await readFile(output);
      // Three audio clips reduced to one stereo AAC track, which is what `amix` is for.
      expect(handlerTypes(mp4).filter((h) => h === "soun")).toHaveLength(1);
      expect(handlerTypes(mp4)).toContain("vide");
      // The mix must not truncate the video: 3s of visual plus the tail.
      expect(movieDurationMs(mp4)).toBeGreaterThan(3_400);
    },
    ENCODE_TIMEOUT_MS,
  );

  it(
    "encodes an unedited document to the same duration the pipeline would",
    async () => {
      // The compatibility case: a document nobody has edited must still compile and
      // encode, and land on `buildTimeline`'s own duration — scene lengths plus the
      // 800ms tail.
      const a = await visual("plain-a");
      const b = await visual("plain-b");

      const { output, durationMs } = await encode(
        "plain",
        document([
          track("video-0", "video", [
            clip({ id: "a", startMs: 0, durationMs: 1_500, source: a }),
            clip({ id: "b", startMs: 1_500, durationMs: 1_500, source: b }),
          ]),
        ]),
      );

      expect(durationMs).toBe(3_800);

      const mp4 = await readFile(output);
      expect(movieDurationMs(mp4)).toBeGreaterThan(3_500);
      expect(movieDurationMs(mp4)).toBeLessThan(4_100);
      // No audio anywhere in the document, so the silent track is what gets encoded.
      expect(handlerTypes(mp4)).toContain("vide");
    },
    ENCODE_TIMEOUT_MS,
  );
});

/**
 * Mean luma per horizontal band of one frame.
 *
 * Scaled to 1x16 so each value is a band's average brightness: text occupies a small
 * fraction of the frame, so a whole-frame mean would not move measurably when a title is
 * drawn, but the band containing it does.
 */
async function rowLuma(path: string, atMs: number): Promise<number[]> {
  const raw = join(dir, `rows-${probeCounter()}.raw`);
  const result = await run([
    "-y",
    "-nostdin",
    "-hide_banner",
    "-ss",
    (atMs / 1000).toFixed(3),
    "-i",
    path,
    "-frames:v",
    "1",
    "-vf",
    "scale=1:16",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    raw,
  ]);
  expect(result.code, `row probe: ${result.stderr.slice(-300)}`).toBe(0);

  const bytes = await readFile(raw);
  expect(bytes.byteLength).toBe(16);
  return [...bytes];
}

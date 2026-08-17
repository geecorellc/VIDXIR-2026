/**
 * End-to-end encoder smoke tests (§39, §42).
 *
 * `render.test.ts` asserts the *argument list*, which is cheap and catches
 * misspelled filter labels. It cannot catch the class of failure that actually
 * cost time here: an argument list that is perfectly well-formed and still cannot
 * encode, because a real ffmpeg build rejects the real bytes our mock providers
 * produce. That gap is what this file closes — synthetic PNG and synthetic WAV,
 * through the production argument builder, into a file that is then parsed as an
 * MP4 rather than merely being non-empty.
 *
 * Deliberately independent of Postgres, Redis and MinIO: the assets are generated
 * in-process and written to a temp directory with exactly the names and
 * extensions `ffmpegRender` uses, so a run needs no services and no credentials.
 *
 * The MP4 assertions parse the box tree by hand. Trusting ffmpeg's exit code to
 * prove ffmpeg produced valid output would be circular, and `ffmpeg-static` ships
 * no ffprobe to ask instead.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentWav, solidPng, wavDurationMs } from "@/lib/media/synthetic";
import { ffmpegBinary } from "@/lib/media/ffmpeg";
import { ffmpegArgs, toSrt } from "@/lib/providers/render";
import { buildTimeline, type SceneInput } from "@/lib/video/timeline";

/**
 * `ffmpeg-static` is a declared dependency, so the binary is normally present.
 * It resolves to null only when the postinstall download was skipped by policy,
 * which is the same condition that makes `render: not_configured` the honest
 * state (§48) — there is nothing to assert about an encoder that is not
 * installed. This is an environment gate, not a way to duck a failure: when the
 * binary exists, every test below runs and must pass.
 */
const binary = ffmpegBinary();
const suite = binary ? describe : describe.skip;

/**
 * Real encodes are seconds, not milliseconds, and the unit project's default
 * budget is 5s. This is not a hang-concealing timeout: the whole point of the
 * `-xerror` case below is that an unencodable input now fails in well under a
 * second instead of spinning, and every passing case here has been measured at
 * ~1-3s. A single 1080p pass on a cold Windows filesystem needs more headroom
 * than 5s to be reliable without being generous enough to hide a stall.
 */
const ENCODE_TIMEOUT_MS = 90_000;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tally-smoke-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

interface RunResult {
  code: number | null;
  stderr: string;
  elapsedMs: number;
}

/**
 * Spawn ffmpeg the way `runFfmpeg` does — stdin ignored, both output streams
 * drained — with a hard kill so a regression of the spin bug fails the test
 * instead of wedging the suite.
 */
function run(args: readonly string[], killAfterMs = ENCODE_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint();
    const child = spawn(binary!, [...args], { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, killAfterMs);

    // Both pipes must be consumed. A full stderr buffer blocks the child, which
    // would look exactly like the bug under investigation.
    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8_000);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (killed) {
        reject(
          new Error(
            `ffmpeg did not exit within ${killAfterMs}ms; stderr tail: ${stderr.slice(-500)}`,
          ),
        );
        return;
      }
      resolve({ code, stderr, elapsedMs });
    });
  });
}

// ---------------------------------------------------------------------------
// MP4 structure
// ---------------------------------------------------------------------------

interface Box {
  type: string;
  payload: Buffer;
}

/** Top-level boxes, in file order. */
function boxes(buffer: Buffer): Box[] {
  const found: Box[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.byteLength) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    let header = 8;

    // size 1 means a 64-bit length follows the type; 0 means "to end of file".
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

/** Every box of `type` anywhere in the tree, searched depth-first. */
function findBoxes(buffer: Buffer, type: string, depth = 0): Buffer[] {
  if (depth > 8) return [];
  const hits: Buffer[] = [];

  for (const box of boxes(buffer)) {
    if (box.type === type) hits.push(box.payload);

    // Container boxes hold child boxes; leaf boxes will simply not parse into
    // anything, which the length checks in `boxes` reject. A few containers
    // carry their own fields first — `stsd` has version/flags and an entry
    // count ahead of the sample entries — so the offset is per type.
    const prefix = CONTAINERS.get(box.type);
    if (prefix !== undefined) {
      hits.push(...findBoxes(box.payload.subarray(prefix), type, depth + 1));
    }
  }

  return hits;
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

/** The `hdlr` handler types present, e.g. `vide` and `soun`. */
function handlerTypes(mp4: Buffer): string[] {
  return findBoxes(mp4, "hdlr").map((payload) => payload.toString("ascii", 8, 12));
}

/** Duration in milliseconds from `mvhd`. */
function movieDurationMs(mp4: Buffer): number {
  const [mvhd] = findBoxes(mp4, "mvhd");
  expect(mvhd, "mvhd box").toBeDefined();

  const version = mvhd![0];
  if (version === 1) {
    const timescale = mvhd!.readUInt32BE(20);
    const duration = Number(mvhd!.readBigUInt64BE(24));
    return (duration / timescale) * 1000;
  }

  const timescale = mvhd!.readUInt32BE(12);
  const duration = mvhd!.readUInt32BE(16);
  return (duration / timescale) * 1000;
}

/** Coded dimensions from the `avc1` sample entry. */
function codedSize(mp4: Buffer): { width: number; height: number } {
  const [avc1] = findBoxes(mp4, "avc1");
  expect(avc1, "avc1 sample entry").toBeDefined();
  return { width: avc1!.readUInt16BE(24), height: avc1!.readUInt16BE(26) };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The mock visual, at the size `mockVisual` actually produces.
 *
 * 480x270 rather than 1920x1080 on purpose: it is what the mock provider emits,
 * so this exercises the upscale-and-pad path a real render takes.
 */
const VISUAL = { width: 480, height: 270 } as const;

function scene(index: number, narrationMs: number): SceneInput {
  return {
    index,
    label: `Scene ${index}`,
    onScreenText: null,
    transition: "fade",
    visualKey: `scene-${index}.png`,
    visualKind: "stock_image",
    visualDurationMs: null,
    narrationKey: `narration-${index}.wav`,
    narrationDurationMs: narrationMs,
  };
}

/**
 * Write a timeline's assets to disk under exactly the names `ffmpegRender` uses
 * and return the argument list for it.
 *
 * The `.img` and `.audio` extensions are not a detail to be tidied away: the
 * production renderer writes them because it does not know the container a
 * provider returned, and this is the test that proves ffmpeg's content sniffing
 * accepts them.
 */
async function prepare(options: {
  slug: string;
  scenes: readonly { index: number; narrationMs: number }[];
  music?: boolean;
  captions?: Array<{ startMs: number; endMs: number; text: string }>;
  /** Damage each visual's deflate stream, leaving its chunk CRCs valid. */
  corruptVisuals?: boolean;
}): Promise<{ args: string[]; output: string; timeline: ReturnType<typeof buildTimeline> }> {
  const inputs: string[] = [];
  const sceneInputIndex = new Map<number, number>();
  const narrationInputIndex = new Map<number, number>();

  const sceneInputs = options.scenes.map((s) => scene(s.index, s.narrationMs));

  for (const s of options.scenes) {
    let bytes = solidPng({ ...VISUAL, seed: `${options.slug}:${s.index}` });
    if (options.corruptVisuals) bytes = corruptDeflate(bytes);

    const path = join(dir, `${options.slug}-scene-${s.index}.img`);
    await writeFile(path, bytes);
    sceneInputIndex.set(s.index, inputs.length);
    inputs.push(path);
  }

  for (const s of options.scenes) {
    const path = join(dir, `${options.slug}-narration-${s.index}.audio`);
    await writeFile(path, silentWav(s.narrationMs));
    narrationInputIndex.set(s.index, inputs.length);
    inputs.push(path);
  }

  let musicIndex: number | null = null;
  if (options.music) {
    const path = join(dir, `${options.slug}-music.audio`);
    await writeFile(path, silentWav(30_000));
    musicIndex = inputs.length;
    inputs.push(path);
  }

  const captionCues = options.captions ?? [];
  let subtitlePath: string | null = null;
  if (captionCues.length > 0) {
    subtitlePath = join(dir, `${options.slug}-captions.srt`);
    await writeFile(subtitlePath, toSrt(captionCues), "utf8");
  }

  const timeline = buildTimeline({
    scenes: sceneInputs,
    music: options.music
      ? {
          key: "music.wav",
          volume: 0.14,
          duckUnderNarration: true,
          startMs: 0,
          durationMs: 30_000,
        }
      : null,
    captionCues,
    burnCaptions: captionCues.length > 0,
    captionStyle: { color: "#E8332B" },
  });

  const output = join(dir, `${options.slug}-output.mp4`);

  return {
    timeline,
    output,
    args: ffmpegArgs({
      timeline,
      inputs,
      sceneInputIndex,
      narrationInputIndex,
      musicIndex,
      subtitlePath,
      output,
    }),
  };
}

/**
 * Break the compressed image data while leaving every chunk CRC correct.
 *
 * This is the realistic corruption: a truncated or altered download whose
 * structure still parses, so the failure surfaces in the decoder rather than in
 * a header check. A PNG with a bad CRC would be rejected earlier and would not
 * reproduce the bug this guards.
 */
function corruptDeflate(png: Buffer): Buffer {
  const copy = Buffer.from(png);
  let offset = 8;

  while (offset + 12 <= copy.byteLength) {
    const length = copy.readUInt32BE(offset);
    const type = copy.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT" && length > 12) {
      // Past the zlib header, inside the deflate stream itself. Read and write
      // explicitly: `length > 12` guarantees both offsets are in range, but
      // `noUncheckedIndexedAccess` cannot know that.
      for (const at of [offset + 8 + 6, offset + 8 + 10]) {
        copy.writeUInt8(copy.readUInt8(at) ^ 0xff, at);
      }
      // Re-CRC so the chunk remains structurally valid.
      copy.writeUInt32BE(
        crc32(copy.subarray(offset + 4, offset + 8 + length)),
        offset + 8 + length,
      );
      return copy;
    }
    offset += 12 + length;
  }

  throw new Error("no IDAT chunk to corrupt");
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite("synthetic assets through ffmpeg", () => {
  it(
    "encodes a synthetic PNG and WAV into a playable MP4",
    async () => {
      const { args, output, timeline } = await prepare({
        slug: "still",
        scenes: [
          { index: 0, narrationMs: 1_200 },
          { index: 1, narrationMs: 1_500 },
        ],
      });

      const result = await run(args);
      expect(result.code, `ffmpeg stderr: ${result.stderr.slice(-800)}`).toBe(0);

      const mp4 = await readFile(output);
      expect(mp4.byteLength).toBeGreaterThan(1_000);

      // Parsed, not merely non-empty: an MP4 that fails to demux is not a render.
      const top = boxes(mp4);
      expect(top[0]?.type).toBe("ftyp");
      expect(top.map((b) => b.type)).toContain("moov");
      expect(top.map((b) => b.type)).toContain("mdat");

      // Both streams present — a silent video or a black audio-only file would
      // otherwise pass an "is it a file" check.
      expect(handlerTypes(mp4)).toContain("vide");
      expect(handlerTypes(mp4)).toContain("soun");

      // Upscaled from the mock's 480x270 to the timeline's output size, padded
      // to even dimensions H.264 can actually encode.
      expect(codedSize(mp4)).toEqual({ width: timeline.width, height: timeline.height });

      // Within a frame or so of the timeline the pipeline computed.
      expect(movieDurationMs(mp4)).toBeGreaterThan(timeline.durationMs - 250);
      expect(movieDurationMs(mp4)).toBeLessThan(timeline.durationMs + 250);
    },
    ENCODE_TIMEOUT_MS,
  );

  it(
    "puts moov before mdat so the studio preview can stream",
    async () => {
      // `+faststart` is asserted as a flag in render.test.ts; this is the
      // observable consequence of it, which is what actually matters.
      const { args, output } = await prepare({
        slug: "faststart",
        scenes: [{ index: 0, narrationMs: 1_200 }],
      });

      expect((await run(args)).code).toBe(0);

      const types = boxes(await readFile(output)).map((b) => b.type);
      expect(types.indexOf("moov")).toBeGreaterThan(-1);
      expect(types.indexOf("moov")).toBeLessThan(types.indexOf("mdat"));
    },
    ENCODE_TIMEOUT_MS,
  );

  it(
    "encodes a synthetic WAV into a real AAC track of the right length",
    async () => {
      // The WAV leg on its own: if `silentWav` were malformed, this is where it
      // shows up as a wrong duration rather than as a failed render.
      const wav = silentWav(2_000);
      expect(wavDurationMs(wav)).toBe(2_000);

      const source = join(dir, "audio-only.audio");
      const output = join(dir, "audio-only.m4a");
      await writeFile(source, wav);

      const result = await run([
        "-y",
        "-nostdin",
        "-hide_banner",
        "-xerror",
        "-i",
        source,
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
        output,
      ]);
      expect(result.code, result.stderr.slice(-800)).toBe(0);

      const m4a = await readFile(output);
      expect(handlerTypes(m4a)).toContain("soun");
      expect(findBoxes(m4a, "mp4a").length).toBeGreaterThan(0);
      expect(movieDurationMs(m4a)).toBeGreaterThan(1_900);
      expect(movieDurationMs(m4a)).toBeLessThan(2_100);
    },
    ENCODE_TIMEOUT_MS,
  );

  it(
    "mixes a music bed without failing the pass",
    async () => {
      // `amix` with `normalize=0` is only ever exercised for real here; the
      // argument test cannot tell whether the filter chain actually runs.
      const { args, output } = await prepare({
        slug: "music",
        scenes: [{ index: 0, narrationMs: 1_500 }],
        music: true,
      });

      const result = await run(args);
      expect(result.code, result.stderr.slice(-800)).toBe(0);
      expect(handlerTypes(await readFile(output))).toContain("soun");
    },
    ENCODE_TIMEOUT_MS,
  );

  it(
    "burns in captions from a real SRT on this platform's paths",
    async () => {
      // The subtitles filter takes a *path* through a filter-graph parser, so on
      // Windows the escaping in `ffmpegArgs` is the difference between a render
      // and a parse error. render.test.ts asserts the escaping; this asserts
      // libass is present and the escaped path resolves to a readable file.
      const { args, output } = await prepare({
        slug: "captions",
        scenes: [{ index: 0, narrationMs: 1_500 }],
        captions: [
          { startMs: 0, endMs: 900, text: "Tally renders captions" },
          { startMs: 900, endMs: 1_500, text: "on this machine" },
        ],
      });

      expect(args.join(" ")).toContain("subtitles=");

      const result = await run(args);
      expect(result.code, result.stderr.slice(-800)).toBe(0);
      expect(handlerTypes(await readFile(output))).toContain("vide");
    },
    ENCODE_TIMEOUT_MS,
  );

  it(
    "fails fast on an undecodable visual instead of encoding forever",
    async () => {
      /**
       * The regression test for the bug that prompted this file.
       *
       * A still is read with `-loop 1 -t <slot>`, and `-t` counts *output* time.
       * An image that never decodes produces no frames, so output time never
       * advances, `-t` never fires, and ffmpeg re-reads the file indefinitely.
       * Measured before the fix: 18MB of `inflate returned error -3` on stderr,
       * nothing at all on `-progress`, and a worker pinned until the 45-minute
       * ceiling. `-xerror` in `ffmpegArgs` turns that into an immediate exit.
       *
       * The 20s kill is far below the old behaviour and far above the ~0.1s the
       * fixed path takes, so it distinguishes the two without being a tuned
       * threshold.
       */
      const { args } = await prepare({
        slug: "corrupt",
        scenes: [{ index: 0, narrationMs: 1_200 }],
        corruptVisuals: true,
      });

      expect(args).toContain("-xerror");

      const result = await run(args, 20_000);
      expect(result.code).not.toBe(0);
      // The message an operator sees must name the decode failure.
      expect(result.stderr).toMatch(/inflate|decod|Invalid|error/i);
      expect(result.elapsedMs).toBeLessThan(15_000);
    },
    ENCODE_TIMEOUT_MS,
  );
});

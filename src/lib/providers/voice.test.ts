/**
 * MP3 duration measurement tests (§39, §42).
 *
 * Every scene offset in the timeline is the accumulated length of the narration
 * audio, and this function is where that length comes from. If it were wrong by a
 * few percent, captions and b-roll would drift steadily out of sync over a
 * ten-minute video — the exact failure the segment-per-scene design exists to
 * avoid. So the frame arithmetic is asserted against hand-built MP3 frames rather
 * than trusted.
 */
import { beforeAll, describe, expect, it } from "vitest";

const TEST_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://vidxir:vidxir@127.0.0.1:5432/vidxir_test",
  REDIS_URL: "redis://127.0.0.1:6379",
  S3_BUCKET: "vidxir-test",
  S3_ACCESS_KEY_ID: "test",
  S3_SECRET_ACCESS_KEY: "test",
  ENCRYPTION_KEY: "a".repeat(64),
  SESSION_SECRET: "b".repeat(64),
} as const;

let mp3DurationMs: typeof import("@/lib/providers/voice")["mp3DurationMs"];

beforeAll(async () => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    process.env[key] = value;
  }
  ({ mp3DurationMs } = await import("@/lib/providers/voice"));
});

/**
 * MPEG-1 Layer III, 128 kbps, 44.1 kHz — what ElevenLabs returns by default.
 *
 * 0xFF 0xFB is the sync word plus MPEG-1/Layer III/no-CRC; 0x90 is bitrate index
 * 9 (128 kbps) with sample-rate index 0 (44.1 kHz) and no padding.
 */
const FRAME_BYTES = Math.floor((144 * 128_000) / 44_100); // 417
const FRAME_MS = (1152 / 44_100) * 1000; // 26.1224…

function mp3(frames: number): Buffer {
  const frame = Buffer.alloc(FRAME_BYTES);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

/** An ID3v2 tag of `bytes` payload, with a syncsafe 28-bit size. */
function id3(payload: Buffer): Buffer {
  const header = Buffer.alloc(10);
  header.write("ID3", 0, "ascii");
  header[3] = 3; // v2.3
  const size = payload.byteLength;
  header[6] = (size >> 21) & 0x7f;
  header[7] = (size >> 14) & 0x7f;
  header[8] = (size >> 7) & 0x7f;
  header[9] = size & 0x7f;
  return Buffer.concat([header, payload]);
}

describe("mp3DurationMs", () => {
  it("sums frame durations exactly", () => {
    // 40 frames at 1152 samples / 44.1kHz.
    expect(mp3DurationMs(mp3(40), "ignored")).toBe(Math.round(40 * FRAME_MS));
    expect(mp3DurationMs(mp3(40), "ignored")).toBe(1_045);
  });

  it("scales linearly with the frame count", () => {
    const short = mp3DurationMs(mp3(50), "ignored");
    const long = mp3DurationMs(mp3(100), "ignored");
    expect(long / short).toBeCloseTo(2, 2);
  });

  it("measures a minute of narration to within a frame", () => {
    const frames = Math.round(60_000 / FRAME_MS);
    expect(mp3DurationMs(mp3(frames), "ignored")).toBeGreaterThan(59_970);
    expect(mp3DurationMs(mp3(frames), "ignored")).toBeLessThan(60_030);
  });

  it("skips an ID3v2 tag instead of counting it as audio", () => {
    // The tag deliberately contains bytes that look like frame headers. Counting
    // them would inflate every offset after this segment.
    const fake = Buffer.concat(
      Array.from({ length: 10 }, () => {
        const f = Buffer.alloc(FRAME_BYTES);
        f[0] = 0xff;
        f[1] = 0xfb;
        f[2] = 0x90;
        return f;
      }),
    );

    const withTag = Buffer.concat([id3(fake), mp3(40)]);
    expect(mp3DurationMs(withTag, "ignored")).toBe(mp3DurationMs(mp3(40), "ignored"));
  });

  it("resyncs past leading junk rather than giving up", () => {
    const withJunk = Buffer.concat([Buffer.alloc(200, 0x41), mp3(40)]);
    expect(mp3DurationMs(withJunk, "ignored")).toBe(mp3DurationMs(mp3(40), "ignored"));
  });

  it("ignores a frame header with a reserved bitrate", () => {
    // Bitrate index 0 and 15 are "free" and "bad"; a frame length cannot be
    // derived from either, and treating one as zero-length would loop.
    const bad = Buffer.alloc(FRAME_BYTES);
    bad[0] = 0xff;
    bad[1] = 0xfb;
    bad[2] = 0xf0; // bitrate index 15
    const buffer = Buffer.concat([bad, mp3(40)]);

    expect(mp3DurationMs(buffer, "ignored")).toBeGreaterThan(0);
    expect(Number.isFinite(mp3DurationMs(buffer, "ignored"))).toBe(true);
  });

  it("estimates from the word count when there is no parseable audio", () => {
    // 150 words at 150 wpm is a minute. Better a caption a fraction of a second
    // off than a failed video over an unreadable header.
    const text = Array.from({ length: 150 }, () => "word").join(" ");
    expect(mp3DurationMs(Buffer.from("not audio at all"), text)).toBe(60_000);
  });

  it("treats a handful of sync-like bytes as noise, not audio", () => {
    // Three frames is far too few to be a narration line; that pattern is much
    // more likely to be junk that happened to contain 0xFFFB.
    const text = Array.from({ length: 75 }, () => "word").join(" ");
    expect(mp3DurationMs(mp3(3), text)).toBe(30_000);
  });

  it("never returns zero, so a scene always gets screen time", () => {
    expect(mp3DurationMs(Buffer.alloc(0), "")).toBeGreaterThanOrEqual(500);
    expect(mp3DurationMs(Buffer.alloc(0), "hi")).toBeGreaterThanOrEqual(500);
  });
});

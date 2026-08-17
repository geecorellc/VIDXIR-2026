/**
 * Development-mock encoder tests (§39, §40).
 *
 * These two functions exist so that a mock build carries **real bytes** through
 * real code — the checksum, the upload, the duration on the asset row, the
 * timeline offsets. That only holds if the files are actually valid, which is
 * exactly what a hand-written encoder can get subtly wrong: a WAV whose declared
 * data length disagrees with its payload, or a PNG with a bad chunk CRC. Both
 * would be accepted by our own code and rejected by ffmpeg, halfway through a
 * render.
 */
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { silentWav, solidPng, wavDurationMs } from "@/lib/media/synthetic";

describe("silentWav", () => {
  it("writes a RIFF/WAVE header ffmpeg will accept", () => {
    const wav = silentWav(1_000);

    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    // PCM, mono, 16-bit, 44.1kHz.
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(44_100);
    expect(wav.readUInt16LE(34)).toBe(16);
  });

  it("declares a size that matches the bytes actually present", () => {
    // A header claiming more data than the file holds truncates on decode; one
    // claiming less silently drops the tail of the narration.
    const wav = silentWav(2_500);
    expect(wav.readUInt32LE(4)).toBe(wav.byteLength - 8);
    expect(wav.readUInt32LE(40)).toBe(wav.byteLength - 44);
  });

  it("is the requested length, measured back out of the file", () => {
    for (const ms of [700, 1_000, 5_500, 30_000]) {
      expect(wavDurationMs(silentWav(ms))).toBe(ms);
    }
  });

  it("still produces a playable file for a zero-length request", () => {
    // Reachable: a scene whose narration is a single short word.
    const wav = silentWav(0);
    expect(wav.byteLength).toBeGreaterThan(44);
    expect(wavDurationMs(wav)).toBeGreaterThanOrEqual(0);
  });

  it("contains silence rather than noise", () => {
    const wav = silentWav(100);
    expect(wav.subarray(44).every((byte) => byte === 0)).toBe(true);
  });
});

describe("wavDurationMs", () => {
  it("refuses something that is not a WAV instead of returning a number", () => {
    expect(() => wavDurationMs(Buffer.from("not audio"))).toThrow(/not a WAV/);
    expect(() => wavDurationMs(Buffer.alloc(0))).toThrow(/not a WAV/);
  });
});

/** PNG chunks in order, with their CRCs verified. */
function pngChunks(png: Buffer): Array<{ type: string; data: Buffer }> {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const chunks: Array<{ type: string; data: Buffer }> = [];
  let offset = 8;

  while (offset + 12 <= png.byteLength) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const declared = png.readUInt32BE(offset + 8 + length);

    // Independent CRC implementation, so a bug in the encoder's table cannot
    // agree with itself and pass.
    expect(crc32(png.subarray(offset + 4, offset + 8 + length)), type).toBe(declared);

    chunks.push({ type, data });
    offset += 12 + length;
  }

  expect(offset).toBe(png.byteLength);
  return chunks;
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

describe("solidPng", () => {
  it("emits signature, IHDR, IDAT and IEND with valid CRCs", () => {
    const chunks = pngChunks(solidPng({ width: 8, height: 4, seed: "scene-0" }));
    expect(chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  it("declares the requested dimensions as 8-bit truecolour", () => {
    const [ihdr] = pngChunks(solidPng({ width: 480, height: 270, seed: "s" }));

    expect(ihdr!.data.readUInt32BE(0)).toBe(480);
    expect(ihdr!.data.readUInt32BE(4)).toBe(270);
    expect(ihdr!.data[8]).toBe(8); // bit depth
    expect(ihdr!.data[9]).toBe(2); // truecolour
    expect(ihdr!.data[12]).toBe(0); // not interlaced
  });

  it("carries one filter byte per scanline and a full row of pixels", () => {
    const width = 5;
    const height = 3;
    const chunks = pngChunks(solidPng({ width, height, seed: "row" }));
    const raw = inflateSync(chunks[1]!.data);

    // A stride miscount is the classic hand-rolled-PNG bug: it decodes to a
    // skewed image rather than failing.
    expect(raw.byteLength).toBe((width * 3 + 1) * height);

    for (let y = 0; y < height; y += 1) {
      const rowStart = y * (width * 3 + 1);
      expect(raw[rowStart]).toBe(0); // filter: None
      const firstPixel = [raw[rowStart + 1], raw[rowStart + 2], raw[rowStart + 3]];
      for (let x = 0; x < width; x += 1) {
        const p = rowStart + 1 + x * 3;
        expect([raw[p], raw[p + 1], raw[p + 2]]).toEqual(firstPixel);
      }
    }
  });

  it("gives each seed its own colour, so a mis-ordered timeline is visible", () => {
    const pixel = (seed: string) => {
      const raw = inflateSync(pngChunks(solidPng({ width: 2, height: 1, seed }))[1]!.data);
      return [raw[1], raw[2], raw[3]].join(",");
    };

    const seeds = ["scene-0", "scene-1", "scene-2", "scene-3", "scene-4", "scene-5"];
    expect(new Set(seeds.map(pixel)).size).toBe(seeds.length);
  });

  it("keeps every channel mid-tone so overlay text stays legible", () => {
    for (const seed of ["a", "b", "long-seed-value", "0"]) {
      const raw = inflateSync(pngChunks(solidPng({ width: 1, height: 1, seed }))[1]!.data);
      for (const channel of [raw[1]!, raw[2]!, raw[3]!]) {
        expect(channel).toBeGreaterThanOrEqual(40);
        expect(channel).toBeLessThan(200);
      }
    }
  });

  it("is deterministic for a given seed", () => {
    const a = solidPng({ width: 16, height: 16, seed: "same" });
    const b = solidPng({ width: 16, height: 16, seed: "same" });
    expect(a.equals(b)).toBe(true);
  });
});

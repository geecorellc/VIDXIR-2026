/**
 * Real files for the development mocks (§40).
 *
 * When `TALLY_USE_MOCK_PROVIDERS=true` the voice, visuals and music providers
 * must still produce **actual media** — a valid WAV of a known length, a valid
 * PNG of known dimensions — because everything downstream is real code operating
 * on real bytes: the checksum, the storage upload, the duration recorded on the
 * asset row, the timeline offsets, the caption cues.
 *
 * This is not the same thing as faking success. §42's prohibition is against
 * reporting work that did not happen; a mock asset is labelled `provider: "mock"`
 * on its row, the capability registry reports `state: "mock"`, and the Video
 * screen prints "· mock" under the affected card. What the mock removes is the
 * provider bill, not the honesty.
 *
 * Both encoders are written by hand rather than pulled in as dependencies. A WAV
 * header is 44 bytes of documented layout and a single-colour PNG is one deflate
 * call, so a package would be more risk than code.
 */
import { deflateSync } from "node:zlib";

const WAV_SAMPLE_RATE = 44_100;
const WAV_CHANNELS = 1;
const WAV_BITS = 16;

/**
 * A silent, playable, correctly-sized mono WAV.
 *
 * Silence rather than a tone: a tone under every mock render would be worse than
 * useless, and the file's job here is to carry a real duration through the
 * timeline rather than to be listened to.
 */
export function silentWav(durationMs: number): Buffer {
  const ms = Math.max(1, Math.round(durationMs));
  const frames = Math.round((ms / 1000) * WAV_SAMPLE_RATE);
  const bytesPerFrame = WAV_CHANNELS * (WAV_BITS / 8);
  const dataBytes = frames * bytesPerFrame;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4); // file size minus the first 8 bytes
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk length
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(WAV_CHANNELS, 22);
  header.writeUInt32LE(WAV_SAMPLE_RATE, 24);
  header.writeUInt32LE(WAV_SAMPLE_RATE * bytesPerFrame, 28); // byte rate
  header.writeUInt16LE(bytesPerFrame, 32); // block align
  header.writeUInt16LE(WAV_BITS, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);

  // Zeroed PCM is silence for signed 16-bit.
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

/** Duration of a WAV produced by `silentWav`, read back from its header. */
export function wavDurationMs(buffer: Buffer): number {
  if (buffer.byteLength < 44 || buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("not a WAV file");
  }
  const byteRate = buffer.readUInt32LE(28);
  const dataBytes = buffer.readUInt32LE(40);
  if (byteRate === 0) throw new Error("WAV header has a zero byte rate");
  return Math.round((dataBytes / byteRate) * 1000);
}

/**
 * A single-colour PNG at the requested size.
 *
 * Used as a mock b-roll frame. The colour is derived from the caller's seed so a
 * six-scene storyboard is visibly six different cards rather than one repeated —
 * which is what makes a wrongly-ordered timeline obvious on inspection.
 */
export function solidPng(options: {
  width: number;
  height: number;
  /** Any string; hashed to a hue. */
  seed: string;
}): Buffer {
  const { width, height } = options;
  const [r, g, b] = colourFor(options.seed);

  // Raw scanlines: one filter byte (0 = None) then RGB triples.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const p = rowStart + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

let crcTable: number[] | undefined;

function crc32(buffer: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Deterministic mid-tone RGB from a string. */
function colourFor(seed: string): [number, number, number] {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Keep every channel in 40–200 so text would be legible over it either way.
  const channel = (shift: number) => 40 + (Math.abs(hash >> shift) % 160);
  return [channel(0), channel(8), channel(16)];
}

/**
 * Locating the encoder — under the module system the worker actually uses.
 *
 * This test exists because of a bug Vitest structurally could not catch.
 * `ffmpegBinary()` used a bare `require("ffmpeg-static")`, which is undefined
 * under ESM; the surrounding `catch` read that as "the postinstall was skipped"
 * and returned null. So the standalone worker — the only process that renders
 * anything — reported `render: not_configured` on a machine with a working
 * binary, while every test agreed the encoder was present, because Vitest
 * transpiles to CJS where the bare form works.
 *
 * The in-process cases below are therefore not sufficient on their own. The last
 * one spawns a real `node --import tsx` and asserts the resolution there, which is
 * the environment `npm run worker` runs in. A test that only ran in Vitest would
 * reintroduce exactly the blind spot that hid the original defect.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ffmpegBinary, hasFfmpeg } from "@/lib/media/ffmpeg";

const original = process.env["FFMPEG_PATH"];

afterEach(() => {
  if (original === undefined) delete process.env["FFMPEG_PATH"];
  else process.env["FFMPEG_PATH"] = original;
});

describe("ffmpegBinary", () => {
  it("prefers FFMPEG_PATH so an operator can point at a system build", () => {
    process.env["FFMPEG_PATH"] = "/opt/ffmpeg/bin/ffmpeg";
    expect(ffmpegBinary()).toBe("/opt/ffmpeg/bin/ffmpeg");
    expect(hasFfmpeg()).toBe(true);
  });

  it("trims the configured path, because a trailing newline is unspawnable", () => {
    process.env["FFMPEG_PATH"] = "  /opt/ffmpeg/bin/ffmpeg\n";
    expect(ffmpegBinary()).toBe("/opt/ffmpeg/bin/ffmpeg");
  });

  it("ignores an empty FFMPEG_PATH and falls back to the bundled binary", () => {
    process.env["FFMPEG_PATH"] = "   ";
    // An operator who blanked the variable meant "use the default", not
    // "render is unavailable".
    expect(ffmpegBinary()).not.toBe("   ");
  });

  it("resolves the bundled ffmpeg-static binary to a file that exists", () => {
    delete process.env["FFMPEG_PATH"];
    const resolved = ffmpegBinary();

    // Skipping rather than asserting non-null: an install that legitimately
    // disallows postinstall scripts has no bundled binary, and `not_configured`
    // is the correct answer there (§48).
    if (resolved === null) return;
    expect(existsSync(resolved)).toBe(true);
  });

  /**
   * The one that matters. Runs the resolution in a fresh ESM process, the way
   * `npm run worker` does, and fails if the binary resolves here but not there.
   */
  it("resolves the same way in a standalone ESM process, as the worker runs", () => {
    delete process.env["FFMPEG_PATH"];
    const inVitest = ffmpegBinary();

    const probe = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        [
          "const m = await import('./src/lib/media/ffmpeg.ts');",
          "process.stdout.write(String(m.ffmpegBinary()));",
        ].join(""),
      ],
      { encoding: "utf8", cwd: process.cwd(), timeout: 60_000 },
    );

    if (probe.status !== 0) {
      throw new Error(
        `ESM probe exited ${String(probe.status)}: ${probe.stderr || probe.stdout}`,
      );
    }

    const inNode = probe.stdout.trim() === "null" ? null : probe.stdout.trim();
    expect(inNode).toBe(inVitest);
  }, 90_000);
});

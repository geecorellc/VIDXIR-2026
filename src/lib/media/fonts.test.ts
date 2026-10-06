/**
 * Font resolution for burned-in thumbnail text (§16, §48).
 *
 * The behaviour worth locking down is the *refusal*: a `THUMBNAIL_FONT_FILE` that
 * points at nothing must report unavailable rather than quietly falling back to
 * whatever the system has. That fallback would produce a thumbnail in a face
 * nobody chose while reporting success, which is the silent substitution §48
 * forbids — and it is exactly the behaviour a well-meaning refactor would add.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  FONT_ENV_VARS,
  FONT_HINT,
  fontMissingEnvVars,
  hasThumbnailFont,
  thumbnailFonts,
} from "@/lib/media/fonts";

const original = {
  headline: process.env["THUMBNAIL_FONT_FILE"],
  body: process.env["THUMBNAIL_FONT_FILE_BODY"],
};

/**
 * Real files, not mocks. `thumbnailFonts` decides with `statSync`, so a mocked
 * `node:fs` would be testing the mock's opinion of what a font file is rather than
 * the function's.
 */
const dir = mkdtempSync(join(tmpdir(), "vidxir-fonts-"));
const fakeHeadline = join(dir, "Headline.ttf");
const fakeBody = join(dir, "Body.ttf");
writeFileSync(fakeHeadline, "not really a font, but it is a file");
writeFileSync(fakeBody, "likewise");

function restore(name: "THUMBNAIL_FONT_FILE" | "THUMBNAIL_FONT_FILE_BODY", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("THUMBNAIL_FONT_FILE", original.headline);
  restore("THUMBNAIL_FONT_FILE_BODY", original.body);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("thumbnailFonts", () => {
  it("uses the configured headline file", () => {
    process.env["THUMBNAIL_FONT_FILE"] = fakeHeadline;
    delete process.env["THUMBNAIL_FONT_FILE_BODY"];

    expect(thumbnailFonts()?.headline).toBe(fakeHeadline);
  });

  it("uses the configured body file for the subline", () => {
    process.env["THUMBNAIL_FONT_FILE"] = fakeHeadline;
    process.env["THUMBNAIL_FONT_FILE_BODY"] = fakeBody;

    expect(thumbnailFonts()).toEqual({ headline: fakeHeadline, body: fakeBody });
  });

  it("trims a configured path, because a trailing newline is unopenable", () => {
    process.env["THUMBNAIL_FONT_FILE"] = `  ${fakeHeadline}\n`;

    expect(thumbnailFonts()?.headline).toBe(fakeHeadline);
  });

  /**
   * The important one. An operator who names a file meant that file; drawing in
   * Impact instead produces a thumbnail off-brand and a job that claims success.
   */
  it("reports unavailable when the configured file does not exist, rather than falling back", () => {
    process.env["THUMBNAIL_FONT_FILE"] = join(dir, "TypoInTheName.ttf");

    expect(thumbnailFonts()).toBeNull();
    expect(hasThumbnailFont()).toBe(false);
    expect(fontMissingEnvVars()).toContain("THUMBNAIL_FONT_FILE");
  });

  it("refuses a directory, whose ffmpeg error is an unhelpful 'could not load font'", () => {
    process.env["THUMBNAIL_FONT_FILE"] = dir;

    expect(thumbnailFonts()).toBeNull();
  });

  it("treats a blank variable as 'use the default', not as unavailable", () => {
    process.env["THUMBNAIL_FONT_FILE"] = "   ";
    delete process.env["THUMBNAIL_FONT_FILE_BODY"];

    // Whether a system font exists is a property of the host, so the assertion is
    // about the *path taken*: a blank override must not be read as a filename.
    expect(thumbnailFonts()?.headline).not.toBe("   ");
  });

  it("ignores a body override that does not exist and still returns a usable pair", () => {
    process.env["THUMBNAIL_FONT_FILE"] = fakeHeadline;
    process.env["THUMBNAIL_FONT_FILE_BODY"] = join(dir, "Missing.ttf");

    const fonts = thumbnailFonts();
    expect(fonts).not.toBeNull();
    // Some real face, never the path that does not exist. A missing *subline* face
    // is not worth refusing the whole composite over — unlike the headline, whose
    // face is the design.
    expect(fonts?.body).not.toContain("Missing.ttf");
  });

  it("is not cached, so a font mounted after boot is picked up without a restart", () => {
    const late = join(dir, "MountedLater.ttf");
    process.env["THUMBNAIL_FONT_FILE"] = late;
    expect(thumbnailFonts()).toBeNull();

    writeFileSync(late, "arrived after the first call");
    try {
      expect(thumbnailFonts()?.headline).toBe(late);
    } finally {
      rmSync(late, { force: true });
    }
  });

  it("reports no missing vars when a font is available", () => {
    process.env["THUMBNAIL_FONT_FILE"] = fakeHeadline;

    expect(fontMissingEnvVars()).toEqual([]);
  });
});

describe("operator-facing constants", () => {
  it("names both variables so the config notice can list them", () => {
    expect([...FONT_ENV_VARS]).toEqual([
      "THUMBNAIL_FONT_FILE",
      "THUMBNAIL_FONT_FILE_BODY",
    ]);
  });

  /**
   * The hint is the whole remedy for a `not_configured` state in a container, so
   * it has to carry an actual command and an actual path — "configure a font" is
   * not actionable at 3am.
   */
  it("gives a runnable fix for a slim Linux image", () => {
    expect(FONT_HINT).toContain("fonts-dejavu-core");
    expect(FONT_HINT).toContain("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf");
  });
});

/**
 * Caption grouping tests (§14, §39).
 *
 * `groupWords` turns word-level timings into the cues stored on `captions.cues` —
 * the single source for the SRT, the VTT and the burned-in overlay. Everything a
 * viewer notices about captions is decided here: where a line breaks, how long it
 * holds, and whether two lines are ever on screen at once. None of that is
 * visible by reading the function, so it is pinned by example.
 */
import { beforeAll, describe, expect, it } from "vitest";

const TEST_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://tally:tally@127.0.0.1:5432/tally_test",
  REDIS_URL: "redis://127.0.0.1:6379",
  S3_BUCKET: "tally-test",
  S3_ACCESS_KEY_ID: "test",
  S3_SECRET_ACCESS_KEY: "test",
  ENCRYPTION_KEY: "a".repeat(64),
  SESSION_SECRET: "b".repeat(64),
} as const;

let groupWords: typeof import("@/lib/providers/transcription")["groupWords"];

beforeAll(async () => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    process.env[key] = value;
  }
  ({ groupWords } = await import("@/lib/providers/transcription"));
});

/** Words laid end to end at a fixed length, with an optional gap between them. */
function stream(
  texts: readonly string[],
  options: { wordMs?: number; gapMs?: number; startMs?: number } = {},
): Array<{ text: string; startMs: number; endMs: number }> {
  const wordMs = options.wordMs ?? 300;
  const gapMs = options.gapMs ?? 0;
  let cursor = options.startMs ?? 0;

  return texts.map((text) => {
    const startMs = cursor;
    cursor = startMs + wordMs + gapMs;
    return { text, startMs, endMs: startMs + wordMs };
  });
}

describe("groupWords", () => {
  it("returns no cues for no words", () => {
    expect(groupWords([])).toEqual([]);
  });

  it("breaks at a sentence end even when the cue is short", () => {
    // Two sentences in one cue read as one sentence, which is worse than a short
    // cue.
    const cues = groupWords(stream(["Stop.", "Then", "go."]));

    expect(cues.map((c) => c.text)).toEqual(["Stop.", "Then go."]);
  });

  it("treats a closing quote after the period as still a sentence end", () => {
    const cues = groupWords(stream(['"Done."', "Next", "line."]));
    expect(cues[0]?.text).toBe('"Done."');
  });

  it("breaks on a pause longer than the gap threshold", () => {
    const cues = groupWords(stream(["a", "b"], { wordMs: 300, gapMs: 500 }));
    expect(cues).toHaveLength(2);
  });

  it("does not break on a pause at the threshold", () => {
    // 400ms is a breath, not a boundary; the break is on *longer than*.
    const cues = groupWords(stream(["a", "b"], { wordMs: 300, gapMs: 400 }));
    expect(cues).toHaveLength(1);
  });

  it("breaks before a cue would exceed the line length", () => {
    // Three ten-character words plus separators is 32; a fourth would be 43,
    // past the 42-character two-line budget.
    const cues = groupWords(stream(Array.from({ length: 5 }, () => "aaaaaaaaaa")));

    expect(cues).toHaveLength(2);
    expect(cues[0]?.text.split(" ")).toHaveLength(3);
    expect(cues[1]?.text.split(" ")).toHaveLength(2);
    for (const cue of cues) {
      expect(cue.text.length).toBeLessThanOrEqual(42);
    }
  });

  it("breaks before a cue would be held too long", () => {
    // Six one-second words: the sixth would make the cue 6s, past the 5s ceiling.
    const cues = groupWords(stream(Array.from({ length: 6 }, () => "word"), {
      wordMs: 1_000,
    }));

    expect(cues[0]?.text.split(" ")).toHaveLength(5);
    expect(cues[0]!.endMs - cues[0]!.startMs).toBeLessThanOrEqual(5_200);
  });

  it("starts each cue on its first word and holds past the last", () => {
    const cues = groupWords(stream(["Alpha", "beta."], { wordMs: 400 }));

    expect(cues[0]?.startMs).toBe(0);
    // A cue ending exactly on the final syllable vanishes as the word finishes.
    expect(cues[0]?.endMs).toBe(800 + 120);
  });

  it("holds a very short cue long enough to be read", () => {
    const cues = groupWords([{ text: "Go.", startMs: 0, endMs: 200 }]);
    expect(cues[0]?.endMs).toBe(700);
  });

  it("closes the space before punctuation returned as its own token", () => {
    const cues = groupWords([
      { text: "Hello", startMs: 0, endMs: 300 },
      { text: ",", startMs: 300, endMs: 320 },
      { text: "world.", startMs: 320, endMs: 700 },
    ]);

    expect(cues[0]?.text).toBe("Hello, world.");
  });

  it("ignores blank tokens rather than emitting an empty cue", () => {
    const cues = groupWords([
      { text: " ", startMs: 0, endMs: 100 },
      { text: "Real.", startMs: 100, endMs: 400 },
      { text: "", startMs: 400, endMs: 500 },
    ]);

    expect(cues.map((c) => c.text)).toEqual(["Real."]);
  });

  it("never puts two cues on screen at the same time", () => {
    // A provider emitting a word that starts before the previous one ended is an
    // alignment artefact around a hesitation, not a reason to drop spoken words.
    const cues = groupWords([
      { text: "One.", startMs: 0, endMs: 1_000 },
      { text: "Two.", startMs: 1_000, endMs: 1_100 },
      { text: "Three.", startMs: 1_050, endMs: 1_200 },
    ]);

    expect(cues).toHaveLength(3);
    for (let i = 1; i < cues.length; i += 1) {
      expect(cues[i]!.startMs).toBeGreaterThan(cues[i - 1]!.endMs);
      expect(cues[i]!.endMs).toBeGreaterThan(cues[i]!.startMs);
    }
  });

  it("keeps every spoken word", () => {
    const texts = [
      "The",
      "compounding",
      "effect",
      "is",
      "quiet.",
      "It",
      "is",
      "also",
      "relentless,",
      "which",
      "is",
      "the",
      "point.",
    ];

    const spoken = groupWords(stream(texts)).flatMap((c) => c.text.split(/\s+/));
    expect(spoken).toEqual(texts);
  });
});

/**
 * Tests for the placeholder-title guard, and a repository-level check behind it.
 *
 * The unit tests pin the classifier. The last test is different in kind: it reads the
 * source of every surface that renders a project title and asserts none of them reads
 * `project.title` raw. That is the check that stops this class of bug coming back through
 * a *new* screen, which no amount of testing the helper can do — the bug was never that
 * the helper was wrong, it was that four callers did not know they needed one.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { displayTitle, isPlaceholderTitle } from "./display-title";

describe("isPlaceholderTitle", () => {
  it("recognises the placeholder the from-youtube route writes", () => {
    // The exact string that put `pBt_n-tjV_Y` on four screens.
    expect(isPlaceholderTitle("New video from a YouTube link (pBt_n-tjV_Y)")).toBe(true);
    // And the same shape with any other id, which is the point of the fix.
    expect(isPlaceholderTitle("New video from a YouTube link (dQw4w9WgXcQ)")).toBe(true);
  });

  it("recognises a bare video id standing alone", () => {
    // What `source.title ?? source.videoId` produced downstream. Not written by any
    // current path, and refused anyway.
    expect(isPlaceholderTitle("pBt_n-tjV_Y")).toBe(true);
  });

  it("treats absent and blank titles as placeholders", () => {
    expect(isPlaceholderTitle(null)).toBe(true);
    expect(isPlaceholderTitle(undefined)).toBe(true);
    expect(isPlaceholderTitle("   ")).toBe(true);
  });

  it("keeps a real title, including one that mentions YouTube", () => {
    expect(isPlaceholderTitle("Why sourdough starters die")).toBe(false);
    // A title a user could plausibly type themselves. The parenthesised group has to
    // look like an id for this to be a placeholder, so their words survive.
    expect(isPlaceholderTitle("New video from a YouTube link (my best one yet)")).toBe(
      false,
    );
    // Eleven characters, but not the id alphabet — a real short title.
    expect(isPlaceholderTitle("Hello there")).toBe(false);
  });

  it("does not mistake a description-mode title for a placeholder", () => {
    // `from-description` writes the user's own sentence, which is legitimately theirs.
    expect(
      isPlaceholderTitle("I want to explain why sourdough starters die"),
    ).toBe(false);
  });
});

describe("displayTitle", () => {
  it("returns null for a placeholder so callers reach their own empty state", () => {
    expect(displayTitle("New video from a YouTube link (pBt_n-tjV_Y)")).toBeNull();
    expect(displayTitle(null)).toBeNull();
  });

  it("returns a real title, trimmed", () => {
    expect(displayTitle("  Why sourdough starters die  ")).toBe(
      "Why sourdough starters die",
    );
  });

  it("never returns a string containing a bare video id for the placeholder", () => {
    /**
     * The property the whole audit was about, stated directly: whatever this returns for
     * a placeholder, the video id must not be inside it. A future edit that made this
     * return `"Video pBt_n-tjV_Y"` instead of null would pass every test above.
     */
    const result = displayTitle("New video from a YouTube link (pBt_n-tjV_Y)");
    expect(result ?? "").not.toContain("pBt_n-tjV_Y");
  });
});

// ---------------------------------------------------------------------------
// Repository-level guard
// ---------------------------------------------------------------------------

/**
 * Surfaces that pass a project title into a user-facing component or a provider prompt,
 * with the expression each one must not use.
 *
 * A list rather than a directory walk, because the assertion is specific: these are the
 * files where a project title crosses into something a customer reads or a model is told.
 * A new screen added to this set has to be added here too — which is the review moment
 * this test exists to force, and the reason the failure message says so.
 */
const TITLE_SURFACES = [
  "src/app/dashboard/script/page.tsx",
  "src/app/dashboard/thumbnail/page.tsx",
  "src/app/dashboard/video/edit/page.tsx",
  "src/lib/scripts/service.ts",
] as const;

/**
 * Every way the source can read a project's title.
 *
 * `project.title`, `project?.title`, and the same through a `context.` holder. Comments
 * are stripped before this runs, so the prose in these files describing the bug does not
 * register as a violation.
 */
const TITLE_READ = /\b(?:\w+\.)*project\??\.title\b/g;

describe("no surface renders a raw project title", () => {
  it.each(TITLE_SURFACES)("%s routes the title through displayTitle", async (file) => {
    const raw = await readFile(file, "utf8");

    /**
     * Comments out, then every `displayTitle(...)` call out, then look for what is left.
     *
     * Checking for the *presence* of `displayTitle` was the first version of this test,
     * and it was worthless: replacing `displayTitle(project?.title)` with
     * `project?.title ?? null` left the import in place, so the test passed while the
     * bug was back. Deleting the guarded reads and asserting nothing remains is the
     * check that actually distinguishes those two states — a wrapped read disappears
     * with its wrapper, an unwrapped one survives to be found.
     */
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/displayTitle\([^)]*\)/g, "");

    const unguarded = source.match(TITLE_READ) ?? [];

    expect(
      unguarded,
      `${file} reads a project title without displayTitle(): ` +
        `${unguarded.join(", ")}. This file passes a project title to a ` +
        `customer-facing surface or a provider prompt, so an unwrapped read shows the ` +
        `from-a-link placeholder — and therefore the raw source video id — as the ` +
        `video's name for any project whose YouTube source was never analysed. ` +
        `Wrap it: displayTitle(...) from @/lib/projects/display-title.`,
    ).toEqual([]);

    // The wrapper has to be the real one, not a local shadow with the same name.
    expect(raw).toContain("@/lib/projects/display-title");
  });
});

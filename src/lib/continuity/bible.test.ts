/**
 * Story Bible tests (§1–§4, §24).
 *
 * What must hold, and why each one is here rather than being obvious:
 *
 *  - Parsing is *total*. A bible arrives from a model and from a `jsonb` column, and
 *    both can be malformed. `safeParseStoryBible` must return null rather than throw,
 *    because a thrown error on the read path fails a paid render (§22).
 *  - `isEmptyBible` is the gate the whole layer branches on, so it has to be exactly
 *    right about the boundary — a bible with only a style is *not* empty.
 *  - The bounds are enforced, not advisory. Every trait is rendered into every scene's
 *    prompt, so an unbounded list is an unbounded per-scene cost.
 *  - `toEntityId` is deterministic and total: the planner returns names, the scene
 *    states reference ids, and both sides must agree on the transformation.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_CHARACTERS,
  MAX_TRAITS,
  STORY_BIBLE_VERSION,
  emptyStoryBible,
  findCharacter,
  findEnvironment,
  findProp,
  hasStyle,
  isEmptyBible,
  knownEntityIds,
  parseStoryBible,
  safeParseStoryBible,
  toEntityId,
} from "@/lib/continuity/bible";

describe("parseStoryBible", () => {
  it("fills every field from an empty object", () => {
    const bible = parseStoryBible({});

    expect(bible.schemaVersion).toBe(STORY_BIBLE_VERSION);
    expect(bible.characters).toEqual([]);
    expect(bible.environments).toEqual([]);
    expect(bible.props).toEqual([]);
    expect(bible.premise).toBeNull();
    expect(bible.style).toEqual({
      medium: null,
      palette: [],
      lighting: null,
      camera: null,
      notes: [],
    });
  });

  it("keeps appearance traits in the order given", () => {
    // Order is load-bearing: the traits are rendered into a prompt in this order on
    // every scene, so a set would produce different text for the same bible.
    const bible = parseStoryBible({
      characters: [
        {
          id: "mara",
          name: "Mara",
          appearance: ["grey beard", "wire glasses", "tall"],
        },
      ],
    });

    expect(bible.characters[0]?.appearance).toEqual([
      "grey beard",
      "wire glasses",
      "tall",
    ]);
  });

  it("rejects an id that is not a lowercase slug", () => {
    expect(() =>
      parseStoryBible({
        characters: [{ id: "Mara's Workshop", name: "Mara" }],
      }),
    ).toThrow();
  });

  it("rejects more characters than the cap allows", () => {
    const characters = Array.from({ length: MAX_CHARACTERS + 1 }, (_, i) => ({
      id: `c${i}`,
      name: `Character ${i}`,
    }));

    expect(() => parseStoryBible({ characters })).toThrow();
  });

  it("rejects more traits than the cap allows", () => {
    expect(() =>
      parseStoryBible({
        characters: [
          {
            id: "mara",
            name: "Mara",
            appearance: Array.from({ length: MAX_TRAITS + 1 }, (_, i) => `trait ${i}`),
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a future schema version", () => {
    // The stored document outlives the code that wrote it. A reader that silently
    // accepted a version it does not understand would apply the wrong semantics.
    expect(() =>
      parseStoryBible({ schemaVersion: STORY_BIBLE_VERSION + 1 }),
    ).toThrow();
  });
});

describe("safeParseStoryBible", () => {
  it("returns null rather than throwing, for every unusable input", () => {
    // The pipeline's form. A malformed bible must degrade to "no continuity", never
    // to a failed render (§22).
    expect(safeParseStoryBible(null)).toBeNull();
    expect(safeParseStoryBible(undefined)).toBeNull();
    expect(safeParseStoryBible("not an object")).toBeNull();
    expect(safeParseStoryBible(42)).toBeNull();
    expect(safeParseStoryBible({ characters: "nope" })).toBeNull();
    expect(safeParseStoryBible({ schemaVersion: 99 })).toBeNull();
  });

  it("parses a valid document", () => {
    const bible = safeParseStoryBible({
      characters: [{ id: "mara", name: "Mara", appearance: ["brown coat"] }],
    });

    expect(bible?.characters).toHaveLength(1);
  });
});

describe("isEmptyBible", () => {
  it("treats null and a default bible as empty", () => {
    expect(isEmptyBible(null)).toBe(true);
    expect(isEmptyBible(emptyStoryBible())).toBe(true);
  });

  it("is not empty when only a style is set", () => {
    // The boundary that matters: a `style`-level video has no cast at all, and
    // treating it as empty would switch the whole layer off for it.
    const bible = parseStoryBible({ style: { medium: "hand-drawn 2D animation" } });

    expect(hasStyle(bible.style)).toBe(true);
    expect(isEmptyBible(bible)).toBe(false);
  });

  it("is not empty when only a palette is set", () => {
    const bible = parseStoryBible({ style: { palette: ["ochre", "teal"] } });

    expect(isEmptyBible(bible)).toBe(false);
  });

  it("is not empty with a cast", () => {
    expect(
      isEmptyBible(parseStoryBible({ characters: [{ id: "mara", name: "Mara" }] })),
    ).toBe(false);
  });
});

describe("lookup", () => {
  const bible = parseStoryBible({
    characters: [{ id: "mara", name: "Mara" }],
    environments: [{ id: "workshop", name: "The Workshop" }],
    props: [{ id: "lamp", name: "Brass Lamp" }],
  });

  it("finds each kind of entity by id", () => {
    expect(findCharacter(bible, "mara")?.name).toBe("Mara");
    expect(findEnvironment(bible, "workshop")?.name).toBe("The Workshop");
    expect(findProp(bible, "lamp")?.name).toBe("Brass Lamp");
  });

  it("returns undefined for an unknown id rather than guessing", () => {
    expect(findCharacter(bible, "nobody")).toBeUndefined();
    // Kinds do not leak into one another: a prop id is not a character.
    expect(findCharacter(bible, "lamp")).toBeUndefined();
  });

  it("collects ids per kind", () => {
    const ids = knownEntityIds(bible);

    expect([...ids.characters]).toEqual(["mara"]);
    expect([...ids.environments]).toEqual(["workshop"]);
    expect([...ids.props]).toEqual(["lamp"]);
  });
});

describe("toEntityId", () => {
  it("slugs a display name", () => {
    expect(toEntityId("Mara")).toBe("mara");
    expect(toEntityId("Mara's Workshop")).toBe("mara-s-workshop");
    expect(toEntityId("  The   Old Lamp  ")).toBe("the-old-lamp");
  });

  it("is case-insensitive, so one entity is not two", () => {
    expect(toEntityId("MARA")).toBe(toEntityId("mara"));
  });

  it("never returns something the id schema would reject", () => {
    // A name of only punctuation slugs to nothing, and an empty id fails validation —
    // which would fail the whole bible over a bad name.
    expect(toEntityId("!!!")).toBe("unnamed");
    expect(toEntityId("")).toBe("unnamed");
    expect(() =>
      parseStoryBible({ characters: [{ id: toEntityId("???"), name: "?" }] }),
    ).not.toThrow();
  });

  it("is idempotent", () => {
    const once = toEntityId("Mara's Workshop");
    expect(toEntityId(once)).toBe(once);
  });
});

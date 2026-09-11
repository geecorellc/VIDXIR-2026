/**
 * Voice continuity tests — the identity half of character consistency.
 *
 * The whole feature rests on one claim: **the same character gets the same voice
 * id, every time, without anything being cached.** So these cases are written to
 * fail if that stops being true for the reason it is true — that the assignment is a
 * pure function of the stored bible — rather than merely checking that two calls
 * happened to agree.
 *
 * What is asserted, and why each one is load-bearing:
 *
 *  - **Determinism over repetition.** A regenerated scene 3 matching scenes 1 and 2
 *    is asserted by rebuilding the input from scratch, in a different scene order,
 *    and getting the identical id. A test that called the function twice on the same
 *    object would pass for a memoised implementation that broke on reload.
 *  - **Two characters keep two voices.** The interesting failure is not "the voice is
 *    wrong" but "the voice is *somebody else's*", so the second character's id is
 *    asserted to be neither absent nor the first's.
 *  - **An absent voice is never filled in.** The scene falls back to the project's
 *    voice with a `project` source, and specifically not to the voiced character's
 *    id. Substituting one would make the whole feature actively harmful.
 *  - **No provider is reachable from here.** `providers/voice.ts` is not imported by
 *    the module under test, which `tests/integration/continuity.test.ts` asserts
 *    structurally; nothing in this file can open a socket because nothing in the
 *    import graph knows how.
 *
 * No provider call, no network, no database, no clock, no randomness. Every function
 * here is synchronous and pure.
 */
import { describe, expect, it } from "vitest";
import {
  hasCanonicalVoice,
  parseStoryBible,
  type StoryBible,
} from "@/lib/continuity/bible";
import { capabilitiesFor, type LevelCapabilities } from "@/lib/continuity/config";
import {
  parseSceneState,
  type IndexedSceneState,
} from "@/lib/continuity/scene-state";
import {
  assignSceneVoice,
  assignVoices,
  canonicalVoiceFor,
  hasVoiceSettings,
  leadCharacterFor,
  sameVoice,
  usesCharacterVoices,
  voicedCharacters,
  wasVoiced,
  type VoiceAssignmentInput,
} from "@/lib/continuity/voice";

/**
 * Two distinctive placeholder voice ids.
 *
 * Distinctive so an assertion that one appeared where the other belonged says
 * something, and obviously placeholders so nothing here resembles a real credential
 * or a real catalogue entry. Neither is ever sent anywhere.
 */
const MARA_VOICE = "voice-unit-placeholder-mara";
const BEN_VOICE = "voice-unit-placeholder-ben";

/**
 * A bible where Mara is voiced and Ben is not.
 *
 * The asymmetry is the point: a fixture where everyone has a voice cannot catch a
 * fallback that reaches for the nearest available id, which is the most tempting
 * wrong implementation of this feature.
 */
function bible(overrides: Record<string, unknown> = {}): StoryBible {
  // Through the real parser, so a fixture the store would reject fails here rather
  // than producing a confusing assertion later.
  return parseStoryBible({
    characters: [
      {
        id: "mara",
        name: "Mara",
        appearance: ["grey beard"],
        voice: {
          provider: "unit-voice-backend",
          providerVoiceId: MARA_VOICE,
          name: "Mara's voice",
          language: "en-GB",
          accent: "west country",
          characteristics: ["gravelly"],
          speakingStyle: "measured and dry",
          settings: { stability: 0.8, similarity: 0.9, styleIntensity: null, speed: null },
        },
      },
      { id: "ben", name: "Ben", appearance: ["ginger hair"] },
    ],
    environments: [{ id: "workshop", name: "The Workshop" }],
    ...overrides,
  });
}

/** Mara leads 0 and 2; Ben leads 1. */
function states(): IndexedSceneState[] {
  return [
    {
      sceneIndex: 0,
      state: parseSceneState({ characters: ["mara"], environment: "workshop" }),
    },
    {
      sceneIndex: 1,
      state: parseSceneState({ characters: ["ben"], environment: "workshop" }),
    },
    {
      sceneIndex: 2,
      // Mara first: billing order is what decides the speaker, and a scene with two
      // characters must not resolve to whichever of them happens to have a voice.
      state: parseSceneState({
        characters: ["mara", "ben"],
        environment: "workshop",
      }),
    },
  ];
}

function input(overrides: Partial<VoiceAssignmentInput> = {}): VoiceAssignmentInput {
  const capabilities: LevelCapabilities =
    overrides.capabilities ?? capabilitiesFor("character");

  return {
    bible: overrides.bible ?? bible(),
    states: overrides.states ?? states(),
    capabilities,
  };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("canonical voice identity", () => {
  it("stores a full voice identity on a character and reads it back", () => {
    // Every field the mandate names survives the parser: a schema that silently
    // dropped `accent` or `settings` would leave the identity half-specified and the
    // adapter unable to honour it.
    const voice = canonicalVoiceFor(bible(), "mara");

    expect(voice).not.toBeNull();
    expect(voice?.providerVoiceId).toBe(MARA_VOICE);
    expect(voice?.provider).toBe("unit-voice-backend");
    expect(voice?.name).toBe("Mara's voice");
    expect(voice?.language).toBe("en-GB");
    expect(voice?.accent).toBe("west country");
    expect(voice?.characteristics).toEqual(["gravelly"]);
    expect(voice?.speakingStyle).toBe("measured and dry");
    expect(voice?.settings.stability).toBe(0.8);
    expect(voice?.settings.similarity).toBe(0.9);
  });

  it("treats direction without a voice id as no canonical voice", () => {
    // An accent and a style are not an identity: there is nothing to hold constant,
    // and reporting this project as voice-consistent on the strength of an adjective
    // would be a claim nothing measured.
    const parsed = parseStoryBible({
      characters: [
        {
          id: "mara",
          name: "Mara",
          voice: { accent: "west country", speakingStyle: "dry" },
        },
      ],
    });

    expect(hasCanonicalVoice(parsed.characters[0]?.voice ?? null)).toBe(false);
    expect(usesCharacterVoices(parsed)).toBe(false);
    expect(canonicalVoiceFor(parsed, "mara")).toBeNull();
  });

  it("defaults to no voice, so every bible already stored parses unchanged", () => {
    // §25 in one case: this is the exact document shape written before voice
    // continuity existed, and it must remain valid at schema version 1.
    const legacy = parseStoryBible({
      schemaVersion: 1,
      characters: [{ id: "mara", name: "Mara", appearance: ["grey beard"] }],
    });

    expect(legacy.characters[0]?.voice).toBeNull();
    expect(usesCharacterVoices(legacy)).toBe(false);
    expect(voicedCharacters(legacy)).toEqual([]);
  });

  it("names only the voiced characters", () => {
    expect(voicedCharacters(bible()).map((c) => c.id)).toEqual(["mara"]);
    expect(usesCharacterVoices(bible())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

describe("assignSceneVoice", () => {
  it("gives a scene its lead character's canonical voice", () => {
    const assignment = assignSceneVoice(input(), 0);

    expect(assignment.source).toBe("character");
    expect(assignment.characterId).toBe("mara");
    expect(assignment.providerVoiceId).toBe(MARA_VOICE);
    expect(assignment.voiceName).toBe("Mara's voice");
    expect(assignment.language).toBe("en-GB");
    // The reason is shown and logged verbatim, so it has to read as prose.
    expect(assignment.reason).toContain("Mara");
  });

  it("uses the same voice for the same character in every scene they lead", () => {
    const resolved = input();
    const first = assignSceneVoice(resolved, 0);
    const later = assignSceneVoice(resolved, 2);

    expect(later.providerVoiceId).toBe(first.providerVoiceId);
    expect(later.characterId).toBe("mara");
  });

  it("resolves the billing lead, not whoever in the scene happens to have a voice", () => {
    // Ben leads scene 1 and has no voice while Mara does. Reaching past the lead to
    // Mara's voice would put the wrong character's voice on the scene and would do it
    // inconsistently, depending on who else the planner listed.
    const assignment = assignSceneVoice(input(), 1);

    expect(assignment.characterId).toBe("ben");
    expect(assignment.providerVoiceId).toBeNull();
    expect(assignment.providerVoiceId).not.toBe(MARA_VOICE);
  });

  it("gives different characters their own voices", () => {
    const both = bible({
      characters: [
        {
          id: "mara",
          name: "Mara",
          voice: { providerVoiceId: MARA_VOICE, name: "Mara's voice" },
        },
        {
          id: "ben",
          name: "Ben",
          voice: { providerVoiceId: BEN_VOICE, name: "Ben's voice" },
        },
      ],
    });
    const resolved = input({ bible: both });

    const mara = assignSceneVoice(resolved, 0);
    const ben = assignSceneVoice(resolved, 1);

    expect(mara.providerVoiceId).toBe(MARA_VOICE);
    expect(ben.providerVoiceId).toBe(BEN_VOICE);
    // The failure worth catching is not "wrong" but "somebody else's".
    expect(ben.providerVoiceId).not.toBe(mara.providerVoiceId);
  });

  it("falls back to the project voice for a character with none, and never to another character's", () => {
    const assignment = assignSceneVoice(input(), 1);

    // `project`, not `none`: this project does use character voices, so the honest
    // report is that *this* character's identity is missing.
    expect(assignment.source).toBe("project");
    expect(assignment.characterName).toBe("Ben");
    expect(assignment.providerVoiceId).toBeNull();
    expect(assignment.settings).toBeNull();
    expect(assignment.reason).toContain("no canonical voice");
  });

  it("asserts nothing for a project whose cast has no voices", () => {
    const plain = parseStoryBible({
      characters: [{ id: "mara", name: "Mara", appearance: ["grey beard"] }],
    });
    const assignment = assignSceneVoice(input({ bible: plain }), 0);

    expect(assignment.source).toBe("none");
    expect(assignment.providerVoiceId).toBeNull();
  });

  it("asserts nothing at a level that does not track characters", () => {
    // A `style`-level video has no cast, so it cannot have character voices. Not a
    // gap — there is no character to be consistent about.
    const assignment = assignSceneVoice(
      input({ capabilities: capabilitiesFor("style") }),
      0,
    );

    expect(assignment.source).toBe("none");
    expect(assignment.providerVoiceId).toBeNull();
    expect(assignment.reason).toContain("does not track characters");
  });

  it("asserts nothing for a scene with no continuity state or no cast", () => {
    const resolved = input();

    expect(assignSceneVoice(resolved, 99).source).toBe("none");
    expect(assignSceneVoice(resolved, 99).providerVoiceId).toBeNull();

    const silent = assignSceneVoice(
      input({
        states: [{ sceneIndex: 0, state: parseSceneState({ characters: [] }) }],
      }),
      0,
    );
    expect(silent.source).toBe("none");
    expect(silent.providerVoiceId).toBeNull();
  });

  it("does not invent a voice for a character the bible does not have", () => {
    // The planner naming a dropped character. Falling through to another character's
    // voice would be worse than the project's, because it would sound deliberate.
    const assignment = assignSceneVoice(
      input({
        states: [
          { sceneIndex: 0, state: parseSceneState({ characters: ["ghost"] }) },
        ],
      }),
      0,
    );

    expect(assignment.characterId).toBe("ghost");
    expect(assignment.characterName).toBeNull();
    expect(assignment.providerVoiceId).toBeNull();
    expect(assignment.source).toBe("project");
  });

  it("carries tuning only when the bible set some", () => {
    const tuned = assignSceneVoice(input(), 0);
    expect(tuned.settings?.stability).toBe(0.8);

    const untuned = assignSceneVoice(
      input({
        bible: bible({
          characters: [
            {
              id: "mara",
              name: "Mara",
              voice: { providerVoiceId: MARA_VOICE },
            },
          ],
        }),
      }),
      0,
    );

    // Null rather than a neutral 0.5, so a bible that tuned nothing does not assert
    // a default as a decision somebody made.
    expect(untuned.providerVoiceId).toBe(MARA_VOICE);
    expect(untuned.settings).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Determinism — the regeneration guarantee
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("resolves a regenerated scene to the voice its earlier scenes used", () => {
    /**
     * The mandate's scene-3 case, and the reason it holds.
     *
     * Both sides are built from scratch, and the second has its states in reverse
     * order to prove the answer does not depend on iteration order. Nothing is
     * cached and nothing is carried over — the guarantee is that the *function* is
     * the same function, so re-running it after a regeneration reproduces the
     * identical id.
     */
    const beforeRegeneration = assignVoices(input());
    const scene0 = beforeRegeneration.find((a) => a.sceneIndex === 0);
    const scene2 = beforeRegeneration.find((a) => a.sceneIndex === 2);

    const afterRegeneration = assignSceneVoice(
      input({ states: [...states()].reverse() }),
      2,
    );

    expect(scene0?.providerVoiceId).toBe(MARA_VOICE);
    expect(scene2?.providerVoiceId).toBe(MARA_VOICE);
    expect(afterRegeneration.providerVoiceId).toBe(MARA_VOICE);
    expect(afterRegeneration.characterId).toBe(scene2?.characterId);
  });

  it("only changes when the bible's canonical voice changes", () => {
    // The one legitimate way a voice moves: the owner edits the bible. Anything else
    // producing a different id would be the drift this feature exists to prevent.
    const changed = bible({
      characters: [
        {
          id: "mara",
          name: "Mara",
          voice: { providerVoiceId: BEN_VOICE, name: "A different voice" },
        },
        { id: "ben", name: "Ben" },
      ],
    });

    expect(assignSceneVoice(input(), 0).providerVoiceId).toBe(MARA_VOICE);
    expect(assignSceneVoice(input({ bible: changed }), 0).providerVoiceId).toBe(
      BEN_VOICE,
    );
  });

  it("produces a byte-identical assignment list on repeated runs", () => {
    const first = JSON.stringify(assignVoices(input()));
    const second = JSON.stringify(assignVoices(input()));
    expect(second).toBe(first);
  });

  it("returns assignments in ascending scene order whatever order the states arrive in", () => {
    const shuffled = assignVoices(input({ states: [...states()].reverse() }));
    expect(shuffled.map((a) => a.sceneIndex)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

describe("comparison helpers", () => {
  it("compares voice ids exactly, ignoring only surrounding whitespace", () => {
    expect(sameVoice(MARA_VOICE, ` ${MARA_VOICE} `)).toBe(true);
    expect(sameVoice(MARA_VOICE, BEN_VOICE)).toBe(false);
    // Case-sensitive: provider voice ids are opaque vendor tokens, and folding case
    // would merge two genuinely different voices on a case-sensitive provider.
    expect(sameVoice(MARA_VOICE, MARA_VOICE.toUpperCase())).toBe(false);
  });

  it("treats two absent voices as the same and one absent as different", () => {
    expect(sameVoice(null, null)).toBe(true);
    expect(sameVoice(MARA_VOICE, null)).toBe(false);
    expect(sameVoice(null, MARA_VOICE)).toBe(false);
  });

  it("reads a silent scene as unvoiced", () => {
    const record = {
      sceneIndex: 0,
      characterId: null,
      provider: "mock",
      source: "none" as const,
    };

    expect(wasVoiced({ ...record, providerVoiceId: null })).toBe(false);
    expect(wasVoiced({ ...record, providerVoiceId: "   " })).toBe(false);
    expect(wasVoiced({ ...record, providerVoiceId: MARA_VOICE })).toBe(true);
  });

  it("reports tuning as absent when no knob was set", () => {
    expect(
      hasVoiceSettings({
        stability: null,
        similarity: null,
        styleIntensity: null,
        speed: null,
      }),
    ).toBe(false);
    expect(
      hasVoiceSettings({
        stability: 0.1,
        similarity: null,
        styleIntensity: null,
        speed: null,
      }),
    ).toBe(true);
    expect(hasVoiceSettings(null)).toBe(false);
  });

  it("reads the lead as the first character in billing order", () => {
    expect(
      leadCharacterFor(parseSceneState({ characters: ["mara", "ben"] })),
    ).toBe("mara");
    expect(leadCharacterFor(parseSceneState({ characters: [] }))).toBeNull();
  });
});

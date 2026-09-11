/**
 * Voice continuity — which voice each scene's narration must be spoken in.
 *
 * The audio counterpart to `prompt.ts`. That module answers "what must this scene
 * *look* like"; this one answers "who is speaking, and in whose voice". Both are
 * pure, deterministic functions over the stored bible and scene states, and both
 * hand a *constraint* to the pipeline rather than acting on it themselves.
 *
 * Three properties are load-bearing, and each rules out a tempting shortcut:
 *
 *  1. **Nothing here knows what a voice provider is.** The result carries a provider
 *     voice id and provider-agnostic settings; translating those into a request is
 *     `providers/voice.ts`'s job, and this module does not import it — not even for
 *     a type. `tests/integration/continuity.test.ts` asserts that structurally,
 *     because a behavioural test would be satisfied by a mock just as happily as by
 *     the real abstraction.
 *  2. **It is a deterministic lookup, not a selection.** The same bible and the same
 *     scene states produce the same assignment on every run, on every machine, with
 *     no clock, no randomness and no model call. That is the whole guarantee: a
 *     regenerated scene 3 gets scene 1's voice because the function that produced
 *     scene 1's voice is the function being run again, not because anything was
 *     cached.
 *  3. **An absent voice is never filled in by guessing.** When a character has no
 *     canonical voice the answer is "this layer asserts nothing", and the caller
 *     falls back to the project's own voice. Substituting *another character's*
 *     established voice would be the exact failure this feature exists to prevent,
 *     dressed up as a fix.
 */

import {
  hasCanonicalVoice,
  type Character,
  type CharacterVoice,
  type StoryBible,
  type VoiceSettings,
} from "@/lib/continuity/bible";
import type { LevelCapabilities } from "@/lib/continuity/config";
import type { IndexedSceneState, SceneState } from "@/lib/continuity/scene-state";

/**
 * Where a scene's voice came from.
 *
 *  - `character` — a canonical voice from the bible. The constraint.
 *  - `project` — no character voice applies, so the project's own voice stands.
 *  - `none` — nothing to assert; the provider adapter's default applies.
 *
 * `project` and `none` are both "voice identity unavailable", which §8 requires be
 * distinguishable from "voice generation failed". Neither is an error, and neither
 * is reported as one.
 */
export type VoiceSource = "character" | "project" | "none";

/** The voice one scene's narration must be spoken in. */
export interface SceneVoiceAssignment {
  sceneIndex: number;
  /** The character this voice belongs to, or null when none applies. */
  characterId: string | null;
  characterName: string | null;
  /**
   * The provider voice id to use, or null to leave the choice to the caller.
   *
   * Null is not a failure: it means the continuity layer has no opinion, and the
   * caller's own fallback — the channel's voice, then the adapter's default — is
   * the right answer rather than a degraded one.
   */
  providerVoiceId: string | null;
  voiceName: string | null;
  /** The backend that minted `providerVoiceId`. Provenance, never a selector. */
  provider: string | null;
  language: string | null;
  /** Provider-agnostic tuning, or null when the voice carries none. */
  settings: VoiceSettings | null;
  source: VoiceSource;
  /** Why this voice. Shown and logged verbatim, never parsed. */
  reason: string;
}

/**
 * The voice a scene's narration was *actually* synthesised in.
 *
 * The audio equivalent of `SceneVisual.visualPrompt` being the prompt as sent: a
 * check that recomputed the assignment from the current bible would validate the
 * bible against itself and pass even if the voiceover stage had ignored it
 * entirely. So the pipeline records what it used, and the check reads that.
 */
export interface SceneVoiceRecord {
  sceneIndex: number;
  /** The voice id the provider was actually asked for, or null for silence. */
  providerVoiceId: string | null;
  /** The character the assignment named at synthesis time, or null. */
  characterId: string | null;
  /** The backend that produced the audio. */
  provider: string | null;
  source: VoiceSource;
}

export interface VoiceAssignmentInput {
  bible: StoryBible;
  states: readonly IndexedSceneState[];
  capabilities: LevelCapabilities;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Does this project use character voices at all?
 *
 * The gate for everything below, and the reason a project built before this existed
 * behaves identically: with no character carrying a canonical voice there is no
 * voice contract, so there is nothing to constrain, nothing to fall back from and
 * nothing to report. §25.
 */
export function usesCharacterVoices(bible: StoryBible): boolean {
  return bible.characters.some((character) => hasCanonicalVoice(character.voice));
}

/** Every character with a canonical voice, in bible order. */
export function voicedCharacters(bible: StoryBible): Character[] {
  return bible.characters.filter((character) => hasCanonicalVoice(character.voice));
}

/** A character's canonical voice, or null when they have none worth using. */
export function canonicalVoiceFor(
  bible: StoryBible,
  characterId: string,
): CharacterVoice | null {
  const character = bible.characters.find((c) => c.id === characterId);
  if (!character?.voice) return null;
  return hasCanonicalVoice(character.voice) ? character.voice : null;
}

/**
 * The character whose voice a scene's narration is spoken in.
 *
 * The first id in `state.characters`, which `scene-state.ts` documents as billing
 * order — the planner's own judgement about who the scene belongs to. Deliberately
 * *not* "the first character who happens to have a voice": reaching past the scene's
 * lead to a supporting character would let a walk-on part's voice narrate the scene,
 * and would do it inconsistently depending on who else the planner listed.
 *
 * A scene with no cast has no speaker, which is the ordinary case for a title card
 * or an establishing shot.
 */
export function leadCharacterFor(state: SceneState): string | null {
  return state.characters[0] ?? null;
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * The voice for one scene.
 *
 * Pure and synchronous, like `continuityContextFor`, and for the same reason: the
 * voiceover stage resolves the whole project's voices in one pass over data that
 * cannot change mid-stage, so a query per scene would be sixty round trips for one
 * answer.
 */
export function assignSceneVoice(
  input: VoiceAssignmentInput,
  sceneIndex: number,
): SceneVoiceAssignment {
  const none = (reason: string): SceneVoiceAssignment => ({
    sceneIndex,
    characterId: null,
    characterName: null,
    providerVoiceId: null,
    voiceName: null,
    provider: null,
    language: null,
    settings: null,
    source: "none",
    reason,
  });

  if (!input.capabilities.characters) {
    // A `style`- or `world`-level video does not track a cast, so it cannot have
    // character voices. Not a gap: there is no character to be consistent about.
    return none("This continuity level does not track characters.");
  }

  if (!usesCharacterVoices(input.bible)) {
    return none("No character in this story bible has a canonical voice.");
  }

  const entry = input.states.find((state) => state.sceneIndex === sceneIndex);
  if (!entry) {
    return none(`Scene ${sceneIndex} has no continuity state.`);
  }

  const leadId = leadCharacterFor(entry.state);
  if (!leadId) {
    return none(`Scene ${sceneIndex} has no character on screen.`);
  }

  const character = input.bible.characters.find((c) => c.id === leadId);
  if (!character) {
    /**
     * A state naming a character the bible does not have.
     *
     * `validate.ts` already reports this as `continuity.character.unknown`; here it
     * is simply a scene with no resolvable voice. Falling through to another
     * character's voice would be worse than falling back to the project's, because
     * it would sound deliberate.
     */
    return {
      ...none(
        `Scene ${sceneIndex} leads with "${leadId}", who is not in the story bible.`,
      ),
      characterId: leadId,
      source: "project",
    };
  }

  const voice = character.voice;
  if (!voice || !hasCanonicalVoice(voice)) {
    /**
     * The scene's lead has no canonical voice while other characters do.
     *
     * `project`, not `none`: this project *does* use character voices, so the honest
     * report is that this character's identity is missing rather than that voice
     * continuity does not apply. The caller uses the project voice, and
     * `validate.ts` records `continuity.voice.missing` — a note, not a break.
     */
    return {
      sceneIndex,
      characterId: character.id,
      characterName: character.name,
      providerVoiceId: null,
      voiceName: null,
      provider: null,
      language: null,
      settings: null,
      source: "project",
      reason: `${character.name} has no canonical voice; the project's voice is used.`,
    };
  }

  return {
    sceneIndex,
    characterId: character.id,
    characterName: character.name,
    providerVoiceId: voice.providerVoiceId,
    voiceName: voice.name,
    provider: voice.provider,
    language: voice.language,
    settings: hasVoiceSettings(voice.settings) ? voice.settings : null,
    source: "character",
    reason: `${character.name}'s canonical voice.`,
  };
}

/**
 * Every scene's voice, ascending by index.
 *
 * One pass, so the voiceover stage resolves the project's voices once and then
 * indexes into the result.
 */
export function assignVoices(
  input: VoiceAssignmentInput,
): SceneVoiceAssignment[] {
  return [...input.states]
    .sort((a, b) => a.sceneIndex - b.sceneIndex)
    .map((entry) => assignSceneVoice(input, entry.sceneIndex));
}

/** True when any tuning knob was actually set. */
export function hasVoiceSettings(settings: VoiceSettings | null): boolean {
  if (!settings) return false;
  return (
    settings.stability !== null ||
    settings.similarity !== null ||
    settings.styleIntensity !== null ||
    settings.speed !== null
  );
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Do two provider voice ids refer to the same voice?
 *
 * A trimmed, case-sensitive string comparison, and that is the whole
 * implementation. Provider voice ids are opaque tokens the vendor minted; folding
 * case would merge two genuinely different voices on a provider whose ids are
 * case-sensitive, which is the failure mode this check exists to catch. §10: no
 * model call for an equality test.
 */
export function sameVoice(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return left.trim() === right.trim();
}

/** True when a record shows a scene that was voiced at all. */
export function wasVoiced(record: SceneVoiceRecord): boolean {
  return record.providerVoiceId !== null && record.providerVoiceId.trim() !== "";
}

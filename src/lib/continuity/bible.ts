/**
 * The Story Bible — structured continuity facts for one project.
 *
 * This is the data half of the continuity layer. It holds what must stay the same
 * from scene one to scene eighty: who appears, what they look like, where the
 * action happens, and which objects carry meaning. Nothing here talks to a
 * provider, reads a database or knows what a prompt looks like — those live in
 * `prompt.ts`, `store.ts` and the service.
 *
 * Two decisions are worth stating, because both were the other way round in the
 * first sketch:
 *
 *  1. **These are records, not prose.** A "Story Bible" that is one long paragraph
 *     handed to a model is not a bible, it is a prompt with a grand name: nothing
 *     can validate it, diff it, or tell you which of its claims a scene violated.
 *     Every entity here is a struct with named fields, so `validate.ts` can say
 *     "scene 12 dressed Mara in blue and the bible says red" and mean it.
 *  2. **Traits are ordered and bounded.** `appearance` is a list, capped and
 *     stable, because it is rendered into a prompt in order on every scene. An
 *     unordered set would produce a different prompt for the same bible, and §12
 *     asks for determinism.
 *
 * A project with no bible is the ordinary case for everything built before this
 * layer existed, and every function here treats `null` as "no constraints" rather
 * than as an error.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Ceilings on every list.
 *
 * Not arbitrary: each entity's traits are rendered into every scene's prompt, so
 * the product of (entities × traits) is a per-scene token cost. Six characters at
 * eight traits is a cast and a wardrobe; sixty would be a novel, and would push
 * the actual shot description out of the model's attention.
 */
export const MAX_CHARACTERS = 8;
export const MAX_ENVIRONMENTS = 10;
export const MAX_PROPS = 12;
export const MAX_TRAITS = 8;
export const MAX_TRAIT_LENGTH = 120;
export const MAX_NAME_LENGTH = 60;

/**
 * Ceilings on a voice identity.
 *
 * `MAX_VOICE_ID_LENGTH` matches `voiceovers.voice_id` (`varchar(128)`) exactly: a
 * canonical voice that could not be written to the row recording what was used
 * would be a constraint nothing could audit afterwards.
 */
export const MAX_VOICE_ID_LENGTH = 128;
export const MAX_VOICE_PROVIDER_LENGTH = 48;
export const MAX_VOICE_TRAITS = 6;

/** A short, trimmed descriptive phrase. */
const trait = z.string().trim().min(1).max(MAX_TRAIT_LENGTH);

/**
 * An entity's stable identifier within one project.
 *
 * Slug rather than uuid: a scene refers to `"mara"`, and a slug survives the
 * planner regenerating the bible while a random id would orphan every reference.
 * Lowercased on the way in so `Mara` and `mara` are the same character.
 */
const entityId = z
  .string()
  .trim()
  .min(1)
  .max(MAX_NAME_LENGTH)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase slug");

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * Provider-independent voice settings.
 *
 * Named for what they *do*, not for what any one vendor calls them, because this
 * struct is stored in a bible that outlives whichever provider is configured today.
 * `stability` and `similarity` are the two knobs every commercial TTS exposes in
 * some form; the adapter translates them, and a provider that has no equivalent
 * ignores the ones it cannot honour rather than failing (§28).
 *
 * All optional and all null by default: a canonical voice is fully specified by its
 * provider voice id, and a bible that names one without tuning it must not
 * accidentally assert a neutral 0.5 as a decision somebody made.
 */
export const VoiceSettingsSchema = z.object({
  /** 0–1. How closely the provider holds the voice to its reference. */
  stability: z.number().min(0).max(1).nullable().default(null),
  /** 0–1. How strongly the provider matches the reference timbre. */
  similarity: z.number().min(0).max(1).nullable().default(null),
  /** 0–1. How much expressive style the provider applies. */
  styleIntensity: z.number().min(0).max(1).nullable().default(null),
  /**
   * Speaking rate multiplier.
   *
   * Bounded at the widest range any catalogued provider accepts rather than at one
   * provider's; the adapter clamps to its own documented window, which is where
   * that knowledge belongs.
   */
  speed: z.number().min(0.5).max(2).nullable().default(null),
});

export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

/**
 * A character's canonical voice — the identity half of voice continuity.
 *
 * The one field that carries the guarantee is `providerVoiceId`: it is what the
 * provider adapter turns into a request, and holding it constant is what makes the
 * same character sound the same in scene one and scene eighty. Everything else here
 * is either provenance (`provider`, `name`) or direction the adapter may apply
 * where it can (`language`, `accent`, `characteristics`, `speakingStyle`,
 * `settings`).
 *
 * `provider` is recorded but deliberately **not** used to select a provider. Which
 * voice backend is in use is a fact about the environment, resolved by
 * `providers/voice.ts` from `VOICE_PROVIDER`; a bible naming a provider it would
 * like cannot conjure credentials for it, and treating this field as a selector is
 * exactly the "client asks for an unconfigured provider" shape §20 forbids. It is
 * here so a mismatch can be *reported* — a voice id minted by one vendor sent to
 * another is a break worth a structured finding rather than a silent wrong voice.
 */
export const CharacterVoiceSchema = z.object({
  /**
   * The id of the voice backend this voice id was minted by.
   *
   * Provenance only, and deliberately an opaque string: this layer does not know
   * which backends exist, and naming one here would put a provider decision in the
   * continuity engine. Never a selector — see the docblock above.
   */
  provider: z
    .string()
    .trim()
    .min(1)
    .max(MAX_VOICE_PROVIDER_LENGTH)
    .nullable()
    .default(null),
  /**
   * The provider's own id for this voice. The load-bearing field.
   *
   * Not validated against a provider catalogue, and not checked for existence:
   * doing either would mean a live provider call to inspect a voice list, which §21
   * and §48 both rule out for something this layer only needs to pass through.
   */
  providerVoiceId: z
    .string()
    .trim()
    .min(1)
    .max(MAX_VOICE_ID_LENGTH)
    .nullable()
    .default(null),
  /** Human label, for the panel and for `voiceovers.voice_name`. */
  name: z.string().trim().max(MAX_NAME_LENGTH).nullable().default(null),
  /** BCP-47 tag when this character speaks a specific language. */
  language: z.string().trim().max(35).nullable().default(null),
  /** e.g. "west country", "received pronunciation". */
  accent: z.string().trim().max(MAX_TRAIT_LENGTH).nullable().default(null),
  /** e.g. "gravelly", "bright", "breathy". Direction, not a selector. */
  characteristics: z.array(trait).max(MAX_VOICE_TRAITS).default([]),
  /** e.g. "measured and dry". How the line is delivered. */
  speakingStyle: z.string().trim().max(MAX_TRAIT_LENGTH).nullable().default(null),
  settings: VoiceSettingsSchema.default({
    stability: null,
    similarity: null,
    styleIntensity: null,
    speed: null,
  }),
});

export type CharacterVoice = z.infer<typeof CharacterVoiceSchema>;

/**
 * True when a voice record names an actual voice to use.
 *
 * A `CharacterVoice` carrying only direction — an accent, a speaking style, no
 * provider id — is not a canonical voice: there is nothing to hold constant, and
 * treating it as an assignment would report a project as voice-consistent on the
 * strength of an adjective.
 */
export function hasCanonicalVoice(voice: CharacterVoice | null): boolean {
  return Boolean(voice?.providerVoiceId);
}

/**
 * A recurring on-screen figure.
 *
 * `appearance` is the part that drives continuity — the traits repeated verbatim
 * into every scene the character is in. `role` and `arc` are for the planner and
 * are never rendered into a visual prompt: a generator given "the mentor who
 * learns to let go" produces a worse shot than one given "grey beard, brown coat".
 */
export const CharacterSchema = z.object({
  id: entityId,
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  /** Story function — protagonist, mentor, antagonist. Planning only. */
  role: z.string().trim().max(MAX_TRAIT_LENGTH).nullable().default(null),
  /**
   * Fixed visual facts, in render order. The continuity contract for this
   * character: every scene featuring them repeats these.
   */
  appearance: z.array(trait).max(MAX_TRAITS).default([]),
  /** Wardrobe, kept separate because a costume change is legitimate and tracked. */
  wardrobe: z.array(trait).max(MAX_TRAITS).default([]),
  /** How they carry themselves. Steers generation without pinning pixels. */
  demeanour: z.string().trim().max(MAX_TRAIT_LENGTH).nullable().default(null),
  /** Narrative arc, for the planner. Never rendered into a visual prompt. */
  arc: z.string().trim().max(400).nullable().default(null),
  /**
   * This character's canonical voice, or null when they have none.
   *
   * Null is the ordinary case and the default, which is what makes this additive:
   * every bible already stored parses unchanged, and a project without character
   * voices narrates exactly as it did before — one channel voice for every scene.
   *
   * Not set by the planner. A text model asked to invent a provider voice id
   * produces a plausible-looking string that resolves to nothing, and a 404 for a
   * hallucinated voice is a worse outcome than no voice at all. Voices are assigned
   * by the owner through the continuity route, or by an explicit assignment pass
   * over voices the environment actually has.
   */
  voice: CharacterVoiceSchema.nullable().default(null),
});

export type Character = z.infer<typeof CharacterSchema>;

/** A place the action returns to. */
export const EnvironmentSchema = z.object({
  id: entityId,
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  /** Fixed visual facts about the place. */
  description: z.array(trait).max(MAX_TRAITS).default([]),
  /** Time of day, weather, season — the things that read as an error when they jump. */
  lighting: z.string().trim().max(MAX_TRAIT_LENGTH).nullable().default(null),
  palette: z.array(trait).max(MAX_TRAITS).default([]),
});

export type Environment = z.infer<typeof EnvironmentSchema>;

/** An object that must look the same each time it appears. */
export const PropSchema = z.object({
  id: entityId,
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  description: z.array(trait).max(MAX_TRAITS).default([]),
  /** Why it matters, so the planner does not drop it. Planning only. */
  significance: z.string().trim().max(MAX_TRAIT_LENGTH).nullable().default(null),
});

export type Prop = z.infer<typeof PropSchema>;

/**
 * The whole-video visual contract.
 *
 * Applied to every scene regardless of who is in it, which is what stops scene
 * three being a watercolour and scene four a photograph. Separate from the
 * channel's `videoStyle` setting: that is a preference across all videos, this is
 * a decision about one.
 */
export const VisualStyleSchema = z.object({
  /** e.g. "hand-drawn 2D animation", "photoreal documentary". */
  medium: z.string().trim().max(MAX_TRAIT_LENGTH).nullable().default(null),
  palette: z.array(trait).max(MAX_TRAITS).default([]),
  lighting: z.string().trim().max(MAX_TRAIT_LENGTH).nullable().default(null),
  /** Lens and framing language — "shallow depth of field, 35mm". */
  camera: z.string().trim().max(MAX_TRAIT_LENGTH).nullable().default(null),
  /** Free-form extras the planner considered load-bearing. */
  notes: z.array(trait).max(MAX_TRAITS).default([]),
});

export type VisualStyle = z.infer<typeof VisualStyleSchema>;

// ---------------------------------------------------------------------------
// The bible
// ---------------------------------------------------------------------------

/**
 * Schema version for the stored document.
 *
 * Mirrors `EDIT_DOCUMENT_VERSION`: a stored jsonb blob that outlives the code
 * that wrote it needs a version, and the reader needs a version to refuse.
 */
export const STORY_BIBLE_VERSION = 1;

export const StoryBibleSchema = z.object({
  schemaVersion: z.literal(STORY_BIBLE_VERSION).default(STORY_BIBLE_VERSION),
  /** One-line premise. Planning context, not a visual constraint. */
  premise: z.string().trim().max(600).nullable().default(null),
  /** Narrative shape, e.g. "three-act", "listicle", "call-and-response". */
  structure: z.string().trim().max(MAX_TRAIT_LENGTH).nullable().default(null),
  /** Emotional register carried across the video. */
  tone: z.string().trim().max(MAX_TRAIT_LENGTH).nullable().default(null),
  characters: z.array(CharacterSchema).max(MAX_CHARACTERS).default([]),
  environments: z.array(EnvironmentSchema).max(MAX_ENVIRONMENTS).default([]),
  props: z.array(PropSchema).max(MAX_PROPS).default([]),
  style: VisualStyleSchema.default({
    medium: null,
    palette: [],
    lighting: null,
    camera: null,
    notes: [],
  }),
});

export type StoryBible = z.infer<typeof StoryBibleSchema>;

/**
 * Parse a stored or generated bible, or throw.
 *
 * Throwing is right here and wrong in the pipeline, which is why the pipeline
 * calls `safeParseStoryBible` instead: a malformed bible must degrade to "no
 * continuity" rather than fail a render (§22).
 */
export function parseStoryBible(input: unknown): StoryBible {
  return StoryBibleSchema.parse(input);
}

/** Parse, or null. The pipeline's entry point: a bad bible is no bible. */
export function safeParseStoryBible(input: unknown): StoryBible | null {
  if (input === null || input === undefined) return null;
  const parsed = StoryBibleSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** An empty bible. Valid, and constrains nothing. */
export function emptyStoryBible(): StoryBible {
  return StoryBibleSchema.parse({});
}

/**
 * True when the bible carries no constraint worth rendering.
 *
 * The gate for the whole layer: an empty bible means every downstream step is a
 * no-op, and callers check this rather than counting fields themselves.
 */
export function isEmptyBible(bible: StoryBible | null): boolean {
  if (!bible) return true;
  return (
    bible.characters.length === 0 &&
    bible.environments.length === 0 &&
    bible.props.length === 0 &&
    !hasStyle(bible.style)
  );
}

export function hasStyle(style: VisualStyle): boolean {
  return (
    style.medium !== null ||
    style.lighting !== null ||
    style.camera !== null ||
    style.palette.length > 0 ||
    style.notes.length > 0
  );
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export function findCharacter(
  bible: StoryBible,
  id: string,
): Character | undefined {
  return bible.characters.find((c) => c.id === id);
}

export function findEnvironment(
  bible: StoryBible,
  id: string,
): Environment | undefined {
  return bible.environments.find((e) => e.id === id);
}

export function findProp(bible: StoryBible, id: string): Prop | undefined {
  return bible.props.find((p) => p.id === id);
}

/** Every entity id in the bible, for validating scene references. */
export function knownEntityIds(bible: StoryBible): {
  characters: Set<string>;
  environments: Set<string>;
  props: Set<string>;
} {
  return {
    characters: new Set(bible.characters.map((c) => c.id)),
    environments: new Set(bible.environments.map((e) => e.id)),
    props: new Set(bible.props.map((p) => p.id)),
  };
}

/**
 * Turn a display name into an entity id.
 *
 * Exported because the planner returns names and the scene states reference ids,
 * and both sides must agree on the transformation. Deliberately lossy and
 * deterministic: "Mara's Workshop" and "mara's workshop" both become
 * `mara-s-workshop`.
 */
export function toEntityId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_LENGTH);
  // A name of only punctuation would slug to nothing, which `entityId` rejects.
  return slug.length > 0 ? slug : "unnamed";
}

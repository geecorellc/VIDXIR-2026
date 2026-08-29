/**
 * Planning the bible and the scene states — the reasoning half of the layer.
 *
 * One AI call, through the existing `generateJson` abstraction, on the existing
 * `AI_PROVIDER` transport. No new provider, no new credential, no direct call to
 * anything: this module knows about `@/lib/providers/ai` and nothing else about the
 * outside world.
 *
 * It is one call rather than two because the bible and the scene states are the
 * same decision seen from two angles — deciding that Mara wears a brown coat and
 * deciding which scenes Mara is in cannot be done independently without the second
 * call inventing characters the first did not cast. Asking once and validating the
 * cross-references locally is both cheaper and more consistent.
 *
 * The narration is never touched. It arrives as fixed text, exactly as it does in
 * `scenes.ts`, and the model is told so — §9's approval guarantee only means
 * something if nothing downstream rewrites the words.
 */

import { z } from "zod";
import {
  CharacterSchema,
  EnvironmentSchema,
  PropSchema,
  StoryBibleSchema,
  VisualStyleSchema,
  MAX_CHARACTERS,
  MAX_ENVIRONMENTS,
  MAX_PROPS,
  MAX_TRAITS,
  toEntityId,
  type StoryBible,
} from "@/lib/continuity/bible";
import type { ContinuityPlan } from "@/lib/continuity/config";
import {
  NARRATIVE_BEATS,
  SceneStateSchema,
  type IndexedSceneState,
} from "@/lib/continuity/scene-state";
import { logger } from "@/lib/logger";
import { generateJson, jsonSchema, stringArray } from "@/lib/providers/ai";

const log = logger.child({ component: "continuity-planner" });

// ---------------------------------------------------------------------------
// The model's contract
// ---------------------------------------------------------------------------

/**
 * What the model returns.
 *
 * Looser than the stored schemas on purpose — ids are accepted as free text and
 * slugged locally, because a model asked for a slug will occasionally return
 * "Mara's Workshop" and failing the whole plan over punctuation would be a poor
 * trade. Everything is re-validated through the strict schemas after
 * normalisation.
 */
const PlanSchema = z.object({
  premise: z.string().nullable().default(null),
  structure: z.string().nullable().default(null),
  tone: z.string().nullable().default(null),
  style: z
    .object({
      medium: z.string().nullable().default(null),
      palette: z.array(z.string()).default([]),
      lighting: z.string().nullable().default(null),
      camera: z.string().nullable().default(null),
      notes: z.array(z.string()).default([]),
    })
    .default({}),
  characters: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        role: z.string().nullable().default(null),
        appearance: z.array(z.string()).default([]),
        wardrobe: z.array(z.string()).default([]),
        demeanour: z.string().nullable().default(null),
        arc: z.string().nullable().default(null),
      }),
    )
    .default([]),
  environments: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.array(z.string()).default([]),
        lighting: z.string().nullable().default(null),
        palette: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  props: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.array(z.string()).default([]),
        significance: z.string().nullable().default(null),
      }),
    )
    .default([]),
  scenes: z
    .array(
      z.object({
        index: z.number().int().min(0),
        characters: z.array(z.string()).default([]),
        environment: z.string().nullable().default(null),
        props: z.array(z.string()).default([]),
        beat: z.string().default("development"),
        changes: z.array(z.string()).default([]),
        echoesSceneIndex: z.number().int().min(0).nullable().default(null),
      }),
    )
    .default([]),
});

const PLAN_JSON_SCHEMA = jsonSchema({
  properties: {
    premise: {
      type: ["string", "null"],
      description: "One sentence describing what this video is about.",
    },
    structure: {
      type: ["string", "null"],
      description:
        "The narrative shape in two or three words, e.g. 'three-act', " +
        "'countdown', 'call and response'.",
    },
    tone: {
      type: ["string", "null"],
      description: "The emotional register held across the whole video.",
    },
    style: {
      type: "object",
      description:
        "The visual treatment applied to EVERY scene. This is what stops scene " +
        "three looking like a different video from scene four.",
      properties: {
        medium: {
          type: ["string", "null"],
          description:
            "The rendering medium, e.g. 'hand-drawn 2D animation', " +
            "'photoreal documentary footage', 'soft 3D render'.",
        },
        palette: stringArray(
          "Two to four specific colours that recur throughout.",
          { maxItems: MAX_TRAITS },
        ),
        lighting: {
          type: ["string", "null"],
          description: "The lighting held across scenes, e.g. 'warm afternoon side-light'.",
        },
        camera: {
          type: ["string", "null"],
          description: "Lens and framing language, e.g. 'shallow depth of field, 35mm'.",
        },
        notes: stringArray("Any other treatment detail that must not change.", {
          maxItems: MAX_TRAITS,
        }),
      },
      required: ["medium", "palette", "lighting", "camera", "notes"],
      additionalProperties: false,
    },
    characters: {
      type: "array",
      description:
        "Recurring on-screen figures. Only include a character who appears in " +
        "more than one scene, or who is the subject of one. An empty list is " +
        "correct for a video with no people in it.",
      maxItems: MAX_CHARACTERS,
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "A short lowercase identifier, e.g. 'mara'. Used to reference this character.",
          },
          name: { type: "string", description: "Display name." },
          role: {
            type: ["string", "null"],
            description: "Story function, e.g. 'protagonist'. Not drawn.",
          },
          appearance: stringArray(
            "Fixed, concrete, VISUAL facts a generator can draw: age range, " +
              "build, hair, skin tone, distinguishing features. No abstractions.",
            { maxItems: MAX_TRAITS },
          ),
          wardrobe: stringArray(
            "What they wear, specifically enough to redraw identically.",
            { maxItems: MAX_TRAITS },
          ),
          demeanour: {
            type: ["string", "null"],
            description: "How they carry themselves.",
          },
          arc: {
            type: ["string", "null"],
            description: "How they change across the video. Not drawn.",
          },
        },
        required: ["id", "name", "role", "appearance", "wardrobe", "demeanour", "arc"],
        additionalProperties: false,
      },
    },
    environments: {
      type: "array",
      description: "Places the video returns to.",
      maxItems: MAX_ENVIRONMENTS,
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Short lowercase identifier." },
          name: { type: "string" },
          description: stringArray("Fixed visual facts about the place.", {
            maxItems: MAX_TRAITS,
          }),
          lighting: {
            type: ["string", "null"],
            description: "Time of day and quality of light here.",
          },
          palette: stringArray("Colours specific to this place.", {
            maxItems: MAX_TRAITS,
          }),
        },
        required: ["id", "name", "description", "lighting", "palette"],
        additionalProperties: false,
      },
    },
    props: {
      type: "array",
      description:
        "Objects that carry meaning and must look the same each time. Do not list " +
        "scenery.",
      maxItems: MAX_PROPS,
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Short lowercase identifier." },
          name: { type: "string" },
          description: stringArray("What it looks like.", { maxItems: MAX_TRAITS }),
          significance: {
            type: ["string", "null"],
            description: "Why it matters. Not drawn.",
          },
        },
        required: ["id", "name", "description", "significance"],
        additionalProperties: false,
      },
    },
    scenes: {
      type: "array",
      description:
        "One entry per scene, using the SAME indices you were given. Say which " +
        "of the entities above appear in each scene, using their ids.",
      items: {
        type: "object",
        properties: {
          index: { type: "integer", description: "The scene index you were given." },
          characters: stringArray("Character ids on screen in this scene."),
          environment: {
            type: ["string", "null"],
            description: "Environment id, or null for an abstract shot.",
          },
          props: stringArray("Prop ids visible in this scene."),
          beat: {
            type: "string",
            enum: [...NARRATIVE_BEATS],
            description:
              "Where this scene sits. Use 'refrain' for a scene the video " +
              "deliberately repeats, such as a song chorus or a recurring card — " +
              "repetition there is the format, not a mistake.",
          },
          changes: stringArray(
            "What changes here that later scenes must respect, e.g. 'the lamp is " +
              "now broken'. Empty for most scenes.",
          ),
          echoesSceneIndex: {
            type: ["integer", "null"],
            description:
              "If this scene deliberately mirrors an earlier one, its index. " +
              "Otherwise null.",
          },
        },
        required: [
          "index",
          "characters",
          "environment",
          "props",
          "beat",
          "changes",
          "echoesSceneIndex",
        ],
        additionalProperties: false,
      },
    },
  },
  required: [
    "premise",
    "structure",
    "tone",
    "style",
    "characters",
    "environments",
    "props",
    "scenes",
  ],
});

/**
 * The system prompt.
 *
 * Two rules do most of the work. "Concrete and visual" is what separates a usable
 * appearance from an unusable one — a generator can draw "grey beard, brown canvas
 * coat" and cannot draw "world-weary". And the instruction to cast *nobody* when
 * there is nobody is what stops the model inventing a narrator to have a character,
 * which would then be dutifully rendered into eighty prompts.
 */
const SYSTEM_PROMPT = [
  "You are a continuity supervisor for an animated or filmed video.",
  "",
  "You are given a finished narration, already split into numbered scenes. The",
  "narration is fixed: you must not change, rewrite, summarise or reorder it. Your",
  "job is to decide what must stay visually consistent across the video, and which",
  "scenes each of those things appears in.",
  "",
  "Rules:",
  "- Be concrete and visual. Every appearance and description must be something an",
  "  image generator can draw. 'Grey beard, brown canvas coat, wire glasses' is",
  "  usable; 'world-weary and thoughtful' is not.",
  "- Cast nobody if there is nobody. Many videos have no characters at all — a",
  "  narrated explainer, a listicle, a montage. Returning an empty character list",
  "  for one of those is the correct answer, not a failure.",
  "- Only list what recurs. A character in one scene of forty is not a continuity",
  "  risk. An object mentioned once is scenery.",
  "- Reference entities by the ids you assigned. A scene may not name an id that is",
  "  not in your own lists.",
  "- Mark deliberately repeated scenes as 'refrain'. Children's songs, choruses and",
  "  recurring title cards are supposed to look the same each time, and a later",
  "  check will otherwise treat them as duplicates.",
  "- The visual style applies to every scene without exception. Choose one medium",
  "  and one palette and commit to them.",
].join("\n");

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface PlanBibleInput {
  /** Scenes as already segmented. Narration is read, never rewritten. */
  scenes: readonly {
    index: number;
    label: string;
    narration: string;
  }[];
  title: string;
  niche: string | null;
  contentStyle: string | null;
  videoStyle: string | null;
  targetAudience: string | null;
  plan: ContinuityPlan;
  usage: {
    userId: string;
    projectId: string;
    jobId: string;
    traceId?: string | null;
  };
}

export interface PlannedBible {
  bible: StoryBible;
  states: IndexedSceneState[];
}

/**
 * Plan the bible and the scene states for one project.
 *
 * The model's reply is normalised and then cross-checked locally: a scene
 * referencing an entity the model did not define has that reference dropped, and an
 * entity no scene uses is dropped from the bible. Both are silent by design — the
 * alternative is failing a build over a hallucinated id, when discarding it leaves
 * a smaller but entirely valid bible.
 */
export async function planStoryBible(
  input: PlanBibleInput,
): Promise<PlannedBible> {
  const numbered = input.scenes
    .map((scene) => `${scene.index}. [${scene.label}] ${scene.narration}`)
    .join("\n\n");

  const wanted = input.plan.capabilities;

  const prompt = [
    `Video title: ${input.title}`,
    input.niche ? `Channel niche: ${input.niche}` : null,
    input.contentStyle ? `Content style: ${input.contentStyle}` : null,
    input.videoStyle ? `Visual style preference: ${input.videoStyle}` : null,
    input.targetAudience ? `Audience: ${input.targetAudience}` : null,
    "",
    // The level is told to the model as a scope, so it does not spend its output
    // casting characters for a video whose continuity level ignores them.
    `Continuity scope: ${input.plan.level} — ${input.plan.reason}`,
    wanted.characters
      ? "Track characters, locations, objects and the visual style."
      : wanted.environments
        ? "Track locations and the visual style. Do not cast characters."
        : "Track the visual style only. Return empty character, location and object lists.",
    "",
    `There are ${input.scenes.length} scenes. Return one entry per scene, using the same indices.`,
    "",
    numbered,
  ]
    .filter((line) => line !== null)
    .join("\n");

  const raw = await generateJson({
    system: SYSTEM_PROMPT,
    prompt,
    schema: PlanSchema,
    jsonSchema: PLAN_JSON_SCHEMA,
    // The bible is a fixed cost plus a small per-scene mapping, which is why this
    // is much flatter in the scene count than `directScenes`.
    maxTokens: Math.min(32_000, 4_000 + input.scenes.length * 90),
    usage: {
      operation: "continuity.plan",
      userId: input.usage.userId,
      projectId: input.usage.projectId,
      jobId: input.usage.jobId,
      traceId: input.usage.traceId ?? null,
    },
  });

  return normalise(raw, input);
}

/**
 * Turn a model reply into a valid bible and scene states.
 *
 * Exported for the tests, which is the point: this is where every hallucination is
 * absorbed, and it is testable without a provider because it is a pure function of
 * the reply.
 */
export function normalise(
  raw: z.infer<typeof PlanSchema>,
  input: Pick<PlanBibleInput, "scenes" | "plan">,
): PlannedBible {
  const wanted = input.plan.capabilities;
  const validIndices = new Set(input.scenes.map((scene) => scene.index));

  // Slug every id, and keep a map from whatever the model said to the slug, so a
  // scene that referenced "Mara's Workshop" still resolves after normalisation.
  const alias = new Map<string, string>();
  const remember = (given: string, slug: string) => {
    alias.set(given.trim().toLowerCase(), slug);
    alias.set(slug, slug);
  };

  const characters = wanted.characters
    ? dedupeById(
        raw.characters.slice(0, MAX_CHARACTERS).map((character) => {
          const id = toEntityId(character.id || character.name);
          remember(character.id, id);
          remember(character.name, id);
          return {
            id,
            name: trim(character.name, 60) || id,
            role: nullable(character.role, 120),
            appearance: traits(character.appearance),
            wardrobe: traits(character.wardrobe),
            demeanour: nullable(character.demeanour, 120),
            arc: nullable(character.arc, 400),
          };
        }),
      )
    : [];

  const environments = wanted.environments
    ? dedupeById(
        raw.environments.slice(0, MAX_ENVIRONMENTS).map((environment) => {
          const id = toEntityId(environment.id || environment.name);
          remember(environment.id, id);
          remember(environment.name, id);
          return {
            id,
            name: trim(environment.name, 60) || id,
            description: traits(environment.description),
            lighting: nullable(environment.lighting, 120),
            palette: traits(environment.palette),
          };
        }),
      )
    : [];

  const props = wanted.props
    ? dedupeById(
        raw.props.slice(0, MAX_PROPS).map((prop) => {
          const id = toEntityId(prop.id || prop.name);
          remember(prop.id, id);
          remember(prop.name, id);
          return {
            id,
            name: trim(prop.name, 60) || id,
            description: traits(prop.description),
            significance: nullable(prop.significance, 120),
          };
        }),
      )
    : [];

  const characterIds = new Set(characters.map((c) => c.id));
  const environmentIds = new Set(environments.map((e) => e.id));
  const propIds = new Set(props.map((p) => p.id));

  const resolve = (given: string, known: Set<string>): string | null => {
    const slug = alias.get(given.trim().toLowerCase()) ?? toEntityId(given);
    return known.has(slug) ? slug : null;
  };

  let dropped = 0;
  const states: IndexedSceneState[] = [];

  for (const scene of raw.scenes) {
    if (!validIndices.has(scene.index)) {
      // A scene the planner invented. There is nothing to attach it to.
      dropped += 1;
      continue;
    }

    const parsed = SceneStateSchema.safeParse({
      characters: wanted.characters
        ? unique(
            scene.characters
              .map((id) => resolve(id, characterIds))
              .filter((id): id is string => id !== null),
          )
        : [],
      environment:
        wanted.environments && scene.environment
          ? resolve(scene.environment, environmentIds)
          : null,
      props: wanted.props
        ? unique(
            scene.props
              .map((id) => resolve(id, propIds))
              .filter((id): id is string => id !== null),
          )
        : [],
      beat: NARRATIVE_BEATS.includes(scene.beat as (typeof NARRATIVE_BEATS)[number])
        ? scene.beat
        : "development",
      changes: wanted.props ? traits(scene.changes, 200) : [],
      // An echo of a scene that does not exist is dropped here rather than
      // surviving as a dangling edge.
      echoesSceneIndex:
        scene.echoesSceneIndex !== null && validIndices.has(scene.echoesSceneIndex)
          ? scene.echoesSceneIndex
          : null,
    });

    if (!parsed.success) {
      dropped += 1;
      continue;
    }

    states.push({ sceneIndex: scene.index, state: parsed.data });
  }

  // Entities no scene uses would be rendered into no prompt and validated against
  // nothing, so they are dropped rather than stored as dead weight.
  const usedCharacters = new Set(states.flatMap((s) => s.state.characters));
  const usedEnvironments = new Set(
    states.map((s) => s.state.environment).filter((id): id is string => id !== null),
  );
  const usedProps = new Set(states.flatMap((s) => s.state.props));

  const bible = StoryBibleSchema.parse({
    premise: nullable(raw.premise, 600),
    structure: nullable(raw.structure, 120),
    tone: nullable(raw.tone, 120),
    characters: characters
      .filter((c) => usedCharacters.has(c.id))
      .map((c) => CharacterSchema.parse(c)),
    environments: environments
      .filter((e) => usedEnvironments.has(e.id))
      .map((e) => EnvironmentSchema.parse(e)),
    props: props.filter((p) => usedProps.has(p.id)).map((p) => PropSchema.parse(p)),
    style: wanted.style
      ? VisualStyleSchema.parse({
          medium: nullable(raw.style.medium, 120),
          palette: traits(raw.style.palette),
          lighting: nullable(raw.style.lighting, 120),
          camera: nullable(raw.style.camera, 120),
          notes: traits(raw.style.notes),
        })
      : undefined,
  });

  if (dropped > 0) {
    log.warn("continuity plan had unusable scene entries", { dropped });
  }

  return { bible, states };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trim(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function nullable(value: string | null, max: number): string | null {
  if (value === null) return null;
  const trimmed = trim(value, max);
  return trimmed.length > 0 ? trimmed : null;
}

function traits(values: readonly string[], max = 120): string[] {
  return unique(
    values.map((value) => trim(value, max)).filter((value) => value.length > 0),
  ).slice(0, MAX_TRAITS);
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function dedupeById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

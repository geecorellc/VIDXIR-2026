/**
 * Continuity layer integration tests (§20, §23, §24, §25, §26).
 *
 * The unit tests under `src/lib/continuity/` cover the pure logic — the score, the
 * repetition bands, the graph, the prompt. None of them can prove the four things
 * §24 actually asks for, because all four are properties of the real system rather
 * than of a function:
 *
 *  - **Tenant isolation** is a property of the SQL predicate that executes. A
 *    missing `userId` in a WHERE clause type-checks perfectly and passes every unit
 *    test. The only way to know a bible is invisible to another tenant is to store
 *    one, ask as somebody else, and look at what comes back.
 *  - **The feature flag** gates on `lib/env`, which is a process-wide singleton
 *    resolved at first touch. Flipping it and re-resolving is the only honest test
 *    that `TALLY_CONTINUITY_ENGINE_ENABLED=false` really turns the layer off.
 *  - **Provider independence** is a property of the module graph: continuity must
 *    reach generation only through the existing provider abstraction, never by
 *    naming a provider. That is checked by reading the source, because a mock would
 *    just as happily satisfy a hard-coded FAL call.
 *  - **§25's legacy projects** must work with no bible at all. Asserted against a
 *    real project row that has never had one.
 *
 * No provider is called and no AI request is made anywhere in this file. The
 * planner is never invoked: everything here writes bibles directly through the
 * store, which is what the pipeline does with the planner's normalised output.
 * `TALLY_USE_MOCK_PROVIDERS=true` from the harness makes that structural rather
 * than a matter of restraint.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
/**
 * The parsers and types are imported statically, unlike everything else here.
 *
 * The rest of the file uses dynamic imports because `lib/env` and `lib/db` are
 * singletons keyed off `process.env` at first touch, so the harness has to set the
 * environment before anything reaches them. `bible.ts` and `scene-state.ts` import
 * nothing but zod, and the `validate` import is types only, so neither can open a
 * connection at module scope.
 */
import { parseStoryBible, type StoryBible } from "@/lib/continuity/bible";
import { parseSceneState, type SceneState } from "@/lib/continuity/scene-state";
import type {
  ContinuityComponents,
  ContinuityReport,
} from "@/lib/continuity/validate";
import {
  createChannel,
  createUser,
  hasDatabase,
  jar,
  resetDatabase,
  setTier,
  signIn,
  useDatabase,
  type TestUser,
} from "./setup";

vi.mock("next/headers", () => ({
  cookies: async () => jar,
}));

const suite = hasDatabase ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A bible with something in every section.
 *
 * Named entities rather than placeholders, because several assertions check that a
 * *specific* character survives a round trip — "the first one" would still pass if
 * the store returned somebody else's document.
 */
function bible(name: string): StoryBible {
  // Through the real parser, so a fixture that would be rejected by the store's
  // own schema fails here rather than producing a confusing assertion later.
  return parseStoryBible({
    premise: `A ${name} restores a broken lamp.`,
    structure: "setup → attempt → resolution",
    tone: "warm",
    characters: [
      {
        id: "mara",
        name,
        role: "the restorer",
        appearance: ["grey beard", "wire glasses"],
        wardrobe: ["brown canvas coat"],
        demeanour: "unhurried",
        arc: "learns to ask for help",
      },
    ],
    environments: [
      {
        id: "workshop",
        name: "The Workshop",
        description: ["low wooden benches", "tools on hooks"],
        lighting: "single warm bulb",
        palette: ["ochre", "walnut"],
      },
    ],
    props: [
      {
        id: "lamp",
        name: "Brass Lamp",
        description: ["dented brass base"],
        significance: "the thing being fixed",
      },
    ],
    style: {
      medium: "hand-drawn animation",
      palette: ["ochre", "walnut"],
      lighting: "warm",
      camera: "static wide",
      notes: ["visible pencil texture"],
    },
  });
}

function sceneState(overrides: Record<string, unknown> = {}): SceneState {
  return parseSceneState({
    characters: ["mara"],
    environment: "workshop",
    props: ["lamp"],
    beat: "development",
    changes: [],
    echoesSceneIndex: null,
    ...overrides,
  });
}

/**
 * A report with a given verdict, for the paths that consume one.
 *
 * Hand-built rather than produced by `validateContinuity`: these tests are about
 * what `scenesToRegenerate` and `recordContinuityCheck` do with a verdict, and
 * arranging real prompts bad enough to score a specific number would make the test
 * depend on the scoring constants, which are meant to be tuned.
 */
function report(overrides: Partial<ContinuityReport> = {}): ContinuityReport {
  const components: ContinuityComponents = {
    characterConsistency: 60,
    environmentConsistency: 100,
    propContinuity: 100,
    storyContinuity: 100,
    styleConsistency: 100,
    duplicateRisk: 100,
  };

  return {
    score: 62,
    status: "warn",
    components,
    issues: [],
    affectedScenes: [],
    affectedEntities: [],
    repetitions: [],
    ...overrides,
  };
}

/**
 * A user with a channel, an AI_VIDEO project and channel settings that resolve to
 * `character` level.
 *
 * The settings matter: the level is derived from `content_style` and
 * `target_audience`, so a fixture without them resolves to `style` and every
 * character assertion below would be testing the wrong level.
 */
async function project(
  email: string,
  settings: {
    contentStyle?: string | null;
    videoStyle?: string | null;
    targetAudience?: string | null;
    generationMode?: string | null;
  } = {},
): Promise<{ user: TestUser; channelId: string; projectId: string }> {
  const { db } = await import("@/lib/db");
  const { channelSettings, projects } = await import("@/lib/db/schema");
  const { createProject } = await import("@/lib/projects/service");
  const { eq } = await import("drizzle-orm");

  const user = await createUser({ email });
  // AI video is a studio feature; on the free tier `resolveFor` refuses at the
  // entitlement gate and nothing downstream would be exercised.
  await setTier(user.id, "studio");
  const channelId = await createChannel(user.id, { title: `Channel ${email}` });

  await db.insert(channelSettings).values({
    channelId,
    userId: user.id,
    niche: "animated stories",
    contentStyle: settings.contentStyle ?? "storytelling",
    videoStyle: settings.videoStyle ?? null,
    targetAudience: settings.targetAudience ?? "adults who like short fiction",
  });

  const created = await createProject({
    userId: user.id,
    channelId,
    title: `Project for ${email}`,
    maxVideosPerMonth: null,
  });

  await db
    .update(projects)
    .set({ generationMode: settings.generationMode ?? "AI_VIDEO" })
    .where(eq(projects.id, created.id));

  return { user, channelId, projectId: created.id };
}

/**
 * Distinct shot subjects, one per scene.
 *
 * Deliberately not a numbered template: the repetition comparator drops tokens
 * shorter than three characters, so "shot 1" and "shot 2" are the same string to
 * it, and every scene would read as a duplicate of the first.
 */
const SHOTS = [
  "A tall figure sorting screws into a shallow tray",
  "Rain against a high window above the benches",
  "Hands wrapping a cloth around a dented base",
  "A kettle steaming beside a stack of manuals",
  "Wire spools hanging from a length of pegboard",
  "Chalk marks counting the days on a doorframe",
  "A bicycle upended with its chain removed",
  "Moths circling a bare bulb after dark",
];

/** Insert scene rows the continuity store can attach state to. */
async function insertScenes(
  userId: string,
  projectId: string,
  count: number,
): Promise<void> {
  const { db } = await import("@/lib/db");
  const { scenes } = await import("@/lib/db/schema");

  await db.insert(scenes).values(
    Array.from({ length: count }, (_, index) => ({
      projectId,
      userId,
      index,
      label: `Scene ${index}`,
      narration: `Narration for scene ${index}.`,
      // Distinct per scene: the comparator drops tokens under three characters, so
      // a numbered template would read as the same shot repeated.
      visualPrompt: SHOTS[index] ?? `An unrelated subject, take ${"x".repeat(index)}`,
      searchTerms: [] as string[],
    })),
  );
}

/**
 * Every scene's recorded continuity prompt, by index.
 *
 * Read straight from the column rather than through `getSceneStates`, which returns the
 * state and not the prompt. The prompt is what the *check* reads back to decide whether a
 * scene carried its constraints, so a test about what was recorded has to look at the row
 * the check will look at.
 */
async function sceneRows(
  userId: string,
  projectId: string,
): Promise<Map<number, string | null>> {
  const { db } = await import("@/lib/db");
  const { scenes } = await import("@/lib/db/schema");
  const { and, eq } = await import("drizzle-orm");

  const rows = await db
    .select({ index: scenes.index, prompt: scenes.continuityPrompt })
    .from(scenes)
    .where(and(eq(scenes.projectId, projectId), eq(scenes.userId, userId)));

  return new Map(rows.map((row) => [row.index, row.prompt]));
}

/** The `ContinuityProject` struct the service takes, for a studio-tier project. */
function continuityProject(projectId: string, channelId: string) {
  return {
    projectId,
    channelId,
    generationMode: "AI_VIDEO" as const,
    tier: "studio" as const,
  };
}

/**
 * Run something with the continuity flag forced to a value.
 *
 * `lib/env` caches on first touch, so both the assignment and the reset are
 * required, and the reset has to happen in a `finally` — a test that left the flag
 * on would silently change the behaviour of every test after it in the file.
 */
async function withFlag<T>(enabled: boolean, run: () => Promise<T>): Promise<T> {
  const { resetEnvCache } = await import("@/lib/env");
  const previous = process.env["TALLY_CONTINUITY_ENGINE_ENABLED"];

  process.env["TALLY_CONTINUITY_ENGINE_ENABLED"] = enabled ? "true" : "false";
  resetEnvCache();

  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env["TALLY_CONTINUITY_ENGINE_ENABLED"];
    else process.env["TALLY_CONTINUITY_ENGINE_ENABLED"] = previous;
    resetEnvCache();
  }
}

suite("continuity layer (integration)", () => {
  useDatabase();
  beforeEach(resetDatabase);

  // -------------------------------------------------------------------------
  // §20 — tenant isolation
  // -------------------------------------------------------------------------

  describe("tenant isolation", () => {
    it("does not return one tenant's story bible to another", async () => {
      const { getBible, saveBible } = await import("@/lib/continuity/store");

      const owner = await project("bible-owner@tally.test");
      const other = await createUser({ email: "bible-other@tally.test" });

      await saveBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: bible("Mara"),
        level: "character",
        generatedBy: "test",
      });

      // The owner sees their own cast.
      const mine = await getBible(owner.user.id, owner.projectId);
      expect(mine?.bible.characters[0]?.name).toBe("Mara");

      /**
       * A different tenant holding a valid project id gets null, not a document.
       *
       * Null rather than a thrown error is the deliberate shape: `store.ts` makes a
       * missing row and someone else's row indistinguishable, so a probe cannot use
       * the difference to confirm that a project id exists.
       */
      expect(await getBible(other.id, owner.projectId)).toBeNull();
    });

    it("does not let another tenant overwrite a bible through the unique index", async () => {
      const { getBible, saveBible, saveUserBible } = await import(
        "@/lib/continuity/store"
      );

      const owner = await project("overwrite-owner@tally.test");
      const attacker = await createUser({ email: "overwrite-attacker@tally.test" });

      await saveBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: bible("Mara"),
        level: "character",
        generatedBy: "test",
      });

      /**
       * The write both halves of the upsert have to refuse.
       *
       * `story_bibles` is unique on `project_id` alone, so an insert by a second
       * tenant naming the owner's project *conflicts* and falls through to the
       * update branch — where the `userId` in `values` is no longer consulted. The
       * `setWhere` predicate in the store is the only thing standing between that
       * and a recast of somebody else's video.
       */
      await saveBible({
        userId: attacker.id,
        projectId: owner.projectId,
        bible: bible("Impostor"),
        level: "character",
        generatedBy: "attack",
      });
      await saveUserBible({
        userId: attacker.id,
        projectId: owner.projectId,
        bible: bible("Impostor Two"),
        level: "character",
      });

      const after = await getBible(owner.user.id, owner.projectId);
      expect(after?.bible.characters[0]?.name).toBe("Mara");
      // And the attacker still cannot read what they failed to write.
      expect(await getBible(attacker.id, owner.projectId)).toBeNull();
    });

    it("does not return one tenant's scene states to another", async () => {
      const { getSceneStates, saveSceneContinuity } = await import(
        "@/lib/continuity/store"
      );

      const owner = await project("states-owner@tally.test");
      const other = await createUser({ email: "states-other@tally.test" });
      await insertScenes(owner.user.id, owner.projectId, 3);

      for (let index = 0; index < 3; index += 1) {
        await saveSceneContinuity({
          userId: owner.user.id,
          projectId: owner.projectId,
          sceneIndex: index,
          state: sceneState(),
          continuityPrompt: `block for scene ${index}`,
        });
      }

      expect(await getSceneStates(owner.user.id, owner.projectId)).toHaveLength(3);
      expect(await getSceneStates(other.id, owner.projectId)).toEqual([]);
    });

    it("does not let another tenant write a scene's continuity state", async () => {
      const { getSceneStates, saveSceneContinuity } = await import(
        "@/lib/continuity/store"
      );

      const owner = await project("scenewrite-owner@tally.test");
      const attacker = await createUser({ email: "scenewrite-attacker@tally.test" });
      await insertScenes(owner.user.id, owner.projectId, 2);

      await saveSceneContinuity({
        userId: owner.user.id,
        projectId: owner.projectId,
        sceneIndex: 0,
        state: sceneState({ characters: ["mara"] }),
        continuityPrompt: "owner block",
      });

      await saveSceneContinuity({
        userId: attacker.id,
        projectId: owner.projectId,
        sceneIndex: 0,
        state: sceneState({ characters: [] }),
        continuityPrompt: "attacker block",
      });

      const states = await getSceneStates(owner.user.id, owner.projectId);
      expect(states[0]?.state.characters).toEqual(["mara"]);
    });

    it("does not let another tenant spend a scene's regeneration budget", async () => {
      const { countRegeneration, regenerationCounts } = await import(
        "@/lib/continuity/store"
      );

      const owner = await project("regen-owner@tally.test");
      const attacker = await createUser({ email: "regen-attacker@tally.test" });
      await insertScenes(owner.user.id, owner.projectId, 2);

      /**
       * The counter is a spend ceiling, so a cross-tenant increment is a real
       * attack: exhausting it would stop the owner's own scenes being regenerated.
       * The update returns no rows for a foreign user, hence the 0.
       */
      expect(
        await countRegeneration({
          userId: attacker.id,
          projectId: owner.projectId,
          sceneIndex: 0,
        }),
      ).toBe(0);

      expect(
        await countRegeneration({
          userId: owner.user.id,
          projectId: owner.projectId,
          sceneIndex: 0,
        }),
      ).toBe(1);

      const counts = await regenerationCounts(owner.user.id, owner.projectId);
      expect(counts.get(0)).toBe(1);
      expect(
        (await regenerationCounts(attacker.id, owner.projectId)).size,
      ).toBe(0);
    });

    it("does not return one tenant's continuity check to another", async () => {
      const { latestContinuityCheck, recordContinuityCheck } = await import(
        "@/lib/continuity/store"
      );

      const owner = await project("check-owner@tally.test");
      const other = await createUser({ email: "check-other@tally.test" });

      await recordContinuityCheck({
        userId: owner.user.id,
        projectId: owner.projectId,
        report: report({
          issues: [
            {
              code: "continuity.character.missing",
              severity: "warn",
              message: "Mara's wardrobe is not described in scene 2.",
              sceneIndex: 2,
              entityId: "mara",
            },
          ],
          affectedScenes: [2],
          affectedEntities: ["mara"],
        }),
      });

      const mine = await latestContinuityCheck(owner.user.id, owner.projectId);
      expect(mine?.verdict).toBe("warn");
      expect(await latestContinuityCheck(other.id, owner.projectId)).toBeNull();
    });

    it("gives the read model nothing for a project the caller does not own", async () => {
      const { continuityView } = await import("@/lib/continuity/read");
      const { saveBible } = await import("@/lib/continuity/store");

      const owner = await project("view-owner@tally.test");
      const other = await createUser({ email: "view-other@tally.test" });
      await setTier(other.id, "studio");

      await saveBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: bible("Mara"),
        level: "character",
        generatedBy: "test",
      });

      await withFlag(true, async () => {
        const view = await continuityView(owner.user.id, owner.projectId, "studio");
        expect(view.bible?.characters[0]?.name).toBe("Mara");

        // The read model's first call is `getProject`, which is owner-scoped, so a
        // foreign id is refused before any continuity row is touched.
        await expect(
          continuityView(other.id, owner.projectId, "studio"),
        ).rejects.toMatchObject({ code: "forbidden" });
      });
    });

    it("refuses a foreign project id at the API guard", async () => {
      const { requireProjectAccess } = await import("@/lib/api/guard");

      const owner = await project("guard-owner@tally.test");
      const other = await createUser({ email: "guard-other@tally.test" });

      // The endpoint's first act. `store.ts` would return nothing anyway; this is
      // what turns "nothing" into a 403 rather than an empty panel.
      await expect(
        requireProjectAccess(other.id, owner.projectId),
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  // -------------------------------------------------------------------------
  // §23 — the feature flag
  // -------------------------------------------------------------------------

  describe("feature flag", () => {
    it("resolves to off, with a reason, when the flag is absent", async () => {
      const owner = await project("flag-off@tally.test");

      await withFlag(false, async () => {
        const { resolveFor } = await import("@/lib/continuity/service");
        const context = await resolveFor(
          continuityProject(owner.projectId, owner.channelId),
        );

        expect(context.active).toBe(false);
        expect(context.plan.level).toBe("off");
        // The reason is shown to the operator verbatim, so it has to name the flag
        // rather than blaming the project.
        expect(context.plan.reason).toMatch(/switched off/i);
        expect(context.bible.characters).toEqual([]);
        expect(context.states).toEqual([]);
      });
    });

    it("resolves to a real level when the flag is on", async () => {
      const owner = await project("flag-on@tally.test");

      await withFlag(true, async () => {
        const { resolveFor } = await import("@/lib/continuity/service");
        const context = await resolveFor(
          continuityProject(owner.projectId, owner.channelId),
        );

        expect(context.active).toBe(true);
        expect(context.plan.level).toBe("character");
      });
    });

    it("adds no continuity block to a scene prompt when the flag is off", async () => {
      const { saveBible, saveSceneContinuity } = await import(
        "@/lib/continuity/store"
      );
      const owner = await project("flag-prompt@tally.test");
      await insertScenes(owner.user.id, owner.projectId, 2);

      await saveBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: bible("Mara"),
        level: "character",
        generatedBy: "test",
      });
      await saveSceneContinuity({
        userId: owner.user.id,
        projectId: owner.projectId,
        sceneIndex: 0,
        state: sceneState(),
        continuityPrompt: null,
      });

      const shot = "A close shot of a lamp on a bench";

      const off = await withFlag(false, async () => {
        const { continuityContextFor, loadContext } = await import(
          "@/lib/continuity/service"
        );
        const context = await loadContext(
          owner.user.id,
          continuityProject(owner.projectId, owner.channelId),
        );
        return continuityContextFor({ context, sceneIndex: 0, visualPrompt: shot });
      });

      // Byte-identical, not merely similar: the flag-off path is the pre-continuity
      // pipeline, and a prompt that differs by even a trailing newline is a
      // different request to the provider.
      expect(off.block).toBe("");
      expect(off.prompt).toBe(shot);

      const on = await withFlag(true, async () => {
        const { continuityContextFor, loadContext } = await import(
          "@/lib/continuity/service"
        );
        const context = await loadContext(
          owner.user.id,
          continuityProject(owner.projectId, owner.channelId),
        );
        return continuityContextFor({ context, sceneIndex: 0, visualPrompt: shot });
      });

      // And with the flag on the same call does add constraints, so the test above
      // is not passing because the fixture has nothing to say.
      expect(on.block.length).toBeGreaterThan(0);
      expect(on.prompt).toContain(shot);
      expect(on.prompt).toContain("brown canvas coat");
    });

    it("records no continuity check when the flag is off", async () => {
      const { latestContinuityCheck, saveBible } = await import(
        "@/lib/continuity/store"
      );
      const owner = await project("flag-check@tally.test");
      await insertScenes(owner.user.id, owner.projectId, 2);

      await saveBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: bible("Mara"),
        level: "character",
        generatedBy: "test",
      });

      const result = await withFlag(false, async () => {
        const { checkContinuity } = await import("@/lib/continuity/service");
        return checkContinuity({
          userId: owner.user.id,
          project: continuityProject(owner.projectId, owner.channelId),
          visuals: [
            { sceneIndex: 0, visualPrompt: "A lamp", searchTerms: [] },
            { sceneIndex: 1, visualPrompt: "A lamp", searchTerms: [] },
          ],
        });
      });

      expect(result.report).toBeNull();
      // Nothing was written, so the studio screen shows no verdict rather than a
      // vacuous pass.
      expect(
        await latestContinuityCheck(owner.user.id, owner.projectId),
      ).toBeNull();
    });

    it("regenerates nothing when the flag is off, whatever the report says", async () => {
      const owner = await project("flag-regen@tally.test");
      await insertScenes(owner.user.id, owner.projectId, 4);

      await withFlag(false, async () => {
        const { resolveFor, scenesToRegenerate } = await import(
          "@/lib/continuity/service"
        );
        const context = await resolveFor(
          continuityProject(owner.projectId, owner.channelId),
        );

        // A failing report handed to an inert context. This is the path that spends
        // money, so it is gated on `context.active` rather than on the report alone.
        const scenes = await scenesToRegenerate({
          userId: owner.user.id,
          projectId: owner.projectId,
          context,
          report: report({ score: 20, status: "fail", affectedScenes: [1, 2] }),
        });

        expect(scenes).toEqual([]);
      });
    });
  });

  // -------------------------------------------------------------------------
  // §15, §26 — modes other than AI video keep working unchanged
  // -------------------------------------------------------------------------

  describe("generation mode", () => {
    it("is off for a stock-footage project even with the flag on", async () => {
      const owner = await project("stock@tally.test", {
        generationMode: "STOCK",
      });

      await withFlag(true, async () => {
        const { resolveFor } = await import("@/lib/continuity/service");
        const context = await resolveFor({
          ...continuityProject(owner.projectId, owner.channelId),
          generationMode: "STOCK",
        });

        expect(context.active).toBe(false);
        expect(context.plan.level).toBe("off");
        expect(context.plan.reason).toMatch(/stock footage/i);
      });
    });

    it("refuses at the entitlement gate for a plan without AI video", async () => {
      const { db } = await import("@/lib/db");
      const { channelSettings, projects } = await import("@/lib/db/schema");
      const { createProject } = await import("@/lib/projects/service");
      const { eq } = await import("drizzle-orm");

      // Deliberately left on the free tier signup gives, then asked at `starter`.
      const user = await createUser({ email: "tier@tally.test" });
      const channelId = await createChannel(user.id);
      await db.insert(channelSettings).values({
        channelId,
        userId: user.id,
        contentStyle: "storytelling",
      });
      const created = await createProject({
        userId: user.id,
        channelId,
        title: "Starter project",
        maxVideosPerMonth: null,
      });
      await db
        .update(projects)
        .set({ generationMode: "AI_VIDEO" })
        .where(eq(projects.id, created.id));

      await withFlag(true, async () => {
        const { resolveFor } = await import("@/lib/continuity/service");
        const context = await resolveFor({
          projectId: created.id,
          channelId,
          generationMode: "AI_VIDEO",
          tier: "starter",
        });

        expect(context.active).toBe(false);
        // The tier is read from the argument, which the caller reads from the
        // database — no path grants the feature because a request claimed a tier.
        expect(context.plan.reason).toMatch(/plan does not include/i);
      });
    });

    it("raises the level to character for a preschool audience", async () => {
      const owner = await project("preschool@tally.test", {
        // A style that would otherwise resolve to `style`.
        contentStyle: "listicle",
        targetAudience: "toddlers and preschool children",
      });

      await withFlag(true, async () => {
        const { resolveFor } = await import("@/lib/continuity/service");
        const context = await resolveFor(
          continuityProject(owner.projectId, owner.channelId),
        );

        expect(context.plan.level).toBe("character");
        expect(context.plan.preschool).toBe(true);
        // Repetition is the format for this audience, so the duplicate mark moves.
        expect(context.thresholds.duplicate).toBeGreaterThan(0.9);
      });
    });
  });

  // -------------------------------------------------------------------------
  // §25 — projects that predate the layer
  // -------------------------------------------------------------------------

  describe("legacy projects", () => {
    it("is inert for a project that has no bible", async () => {
      const owner = await project("legacy@tally.test");
      await insertScenes(owner.user.id, owner.projectId, 3);

      await withFlag(true, async () => {
        const { continuityContextFor, loadContext } = await import(
          "@/lib/continuity/service"
        );
        const context = await loadContext(
          owner.user.id,
          continuityProject(owner.projectId, owner.channelId),
        );

        // The level resolves — the flag is on and this is an AI video project — but
        // there is nothing stored to constrain against, so the layer stands down.
        expect(context.active).toBe(false);
        expect(context.plan.reason).toMatch(/no story bible/i);

        const shot = "A wide shot of a hallway";
        expect(
          continuityContextFor({ context, sceneIndex: 0, visualPrompt: shot }).prompt,
        ).toBe(shot);
      });
    });

    it("reports a usable view for a project with no continuity data at all", async () => {
      const { continuityView } = await import("@/lib/continuity/read");
      const owner = await project("legacy-view@tally.test");

      await withFlag(true, async () => {
        const view = await continuityView(owner.user.id, owner.projectId, "studio");

        // Null and empty rather than a throw: the panel renders "no bible yet".
        expect(view.bible).toBeNull();
        expect(view.scenes).toEqual([]);
        expect(view.check).toBeNull();
        expect(view.score).toBeNull();
        expect(view.editedByUser).toBe(false);
        expect(view.reason.length).toBeGreaterThan(0);
      });
    });

    it("skips scenes whose continuity state was never written", async () => {
      const { getSceneStates, saveSceneContinuity } = await import(
        "@/lib/continuity/store"
      );
      const owner = await project("partial@tally.test");
      await insertScenes(owner.user.id, owner.projectId, 5);

      // Only two of five. A partially-planned project validates the part that was
      // planned rather than defaulting the rest into false commitments.
      for (const index of [1, 3]) {
        await saveSceneContinuity({
          userId: owner.user.id,
          projectId: owner.projectId,
          sceneIndex: index,
          state: sceneState(),
          continuityPrompt: null,
        });
      }

      const states = await getSceneStates(owner.user.id, owner.projectId);
      expect(states.map((s) => s.sceneIndex)).toEqual([1, 3]);
    });

    it("treats an unparseable stored bible as no bible rather than failing", async () => {
      const { db } = await import("@/lib/db");
      const { storyBibles } = await import("@/lib/db/schema");
      const { getBible } = await import("@/lib/continuity/store");
      const owner = await project("future-schema@tally.test");

      /**
       * A document from a schema version this build does not know.
       *
       * Written straight to the column, because there is no application path that
       * produces one — the point is what happens after a rollback, when a row
       * written by a newer deploy is read by an older one. §22: a render must not
       * fail because a bible cannot be parsed.
       */
      await db.insert(storyBibles).values({
        projectId: owner.projectId,
        userId: owner.user.id,
        schemaVersion: 99,
        level: "character",
        document: { schemaVersion: 99, cast: [{ who: "Mara" }] },
        generatedBy: "future",
      });

      expect(await getBible(owner.user.id, owner.projectId)).toBeNull();

      await withFlag(true, async () => {
        const { loadContext } = await import("@/lib/continuity/service");
        const context = await loadContext(
          owner.user.id,
          continuityProject(owner.projectId, owner.channelId),
        );
        expect(context.active).toBe(false);
      });
    });
  });

  // -------------------------------------------------------------------------
  // The check, end to end against real rows
  // -------------------------------------------------------------------------

  describe("checking and regenerating", () => {
    it("writes a continuity verdict into the existing quality_checks table", async () => {
      const { db } = await import("@/lib/db");
      const { qualityChecks } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const { saveBible, saveSceneContinuity } = await import(
        "@/lib/continuity/store"
      );

      const owner = await project("verdict@tally.test");
      await insertScenes(owner.user.id, owner.projectId, 3);
      await saveBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: bible("Mara"),
        level: "character",
        generatedBy: "test",
      });
      for (let index = 0; index < 3; index += 1) {
        await saveSceneContinuity({
          userId: owner.user.id,
          projectId: owner.projectId,
          sceneIndex: index,
          state: sceneState(),
          continuityPrompt: null,
        });
      }

      const result = await withFlag(true, async () => {
        const { checkContinuity } = await import("@/lib/continuity/service");
        // Prompts with none of the constraints in them: the check should notice.
        return checkContinuity({
          userId: owner.user.id,
          project: continuityProject(owner.projectId, owner.channelId),
          visuals: [
            { sceneIndex: 0, visualPrompt: "A person in a room", searchTerms: [] },
            { sceneIndex: 1, visualPrompt: "A street at dusk", searchTerms: [] },
            { sceneIndex: 2, visualPrompt: "A cat on a windowsill", searchTerms: [] },
          ],
        });
      });

      expect(result.report).not.toBeNull();
      expect(result.report?.status).not.toBe("pass");

      // Recorded through the *existing* table and vocabulary, which is what the
      // studio screen already reads. No `continuity_checks` table exists.
      const rows = await db
        .select()
        .from(qualityChecks)
        .where(eq(qualityChecks.projectId, owner.projectId));

      expect(rows).toHaveLength(1);
      expect(["pass", "warn", "fail"]).toContain(rows[0]?.verdict);
      const findings = rows[0]?.findings ?? [];
      expect(findings.some((f) => f.code === "continuity.score")).toBe(true);
    });

    it("scores a plan whose prompts carry their constraints, and reads it back", async () => {
      const { continuityView } = await import("@/lib/continuity/read");
      const { saveBible, saveSceneContinuity } = await import(
        "@/lib/continuity/store"
      );

      const owner = await project("scored@tally.test");
      await insertScenes(owner.user.id, owner.projectId, 3);
      await saveBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: bible("Mara"),
        level: "character",
        generatedBy: "test",
      });
      for (let index = 0; index < 3; index += 1) {
        await saveSceneContinuity({
          userId: owner.user.id,
          projectId: owner.projectId,
          sceneIndex: index,
          state: sceneState(),
          continuityPrompt: null,
        });
      }

      const shots = SHOTS.slice(0, 3);

      const report = await withFlag(true, async () => {
        const { checkContinuity, continuityContextFor, loadContext } = await import(
          "@/lib/continuity/service"
        );
        const context = await loadContext(
          owner.user.id,
          continuityProject(owner.projectId, owner.channelId),
        );

        /**
         * The prompts the pipeline would actually have sent.
         *
         * Built through `continuityContextFor` rather than hand-written, so the
         * assertion is about the real prompt builder and the real validator
         * agreeing — which is the property that decides whether a well-behaved
         * video passes its own check.
         */
        const visuals = shots.map((shot, sceneIndex) => {
          const scene = continuityContextFor({ context, sceneIndex, visualPrompt: shot });
          return {
            sceneIndex,
            visualPrompt: scene.prompt,
            searchTerms: [] as string[],
            // The direction alone, for repetition detection: the block is the same
            // on all three scenes by design.
            shotPrompt: shot,
          };
        });

        const result = await checkContinuity({
          userId: owner.user.id,
          project: continuityProject(owner.projectId, owner.channelId),
          visuals,
        });
        return result.report;
      });

      expect(report?.status).toBe("pass");
      expect(report?.repetitions).toEqual([]);

      // And the read model surfaces that score from the finding it was stored in.
      await withFlag(true, async () => {
        const view = await continuityView(owner.user.id, owner.projectId, "studio");
        expect(view.score).toBe(report?.score);
        expect(view.check?.verdict).toBe("pass");
      });
    });

    it("caps regeneration at the threshold and honours scenes already retried", async () => {
      const { countRegeneration, saveBible, saveSceneContinuity } = await import(
        "@/lib/continuity/store"
      );

      const owner = await project("cap@tally.test");
      await insertScenes(owner.user.id, owner.projectId, 8);
      await saveBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: bible("Mara"),
        level: "character",
        generatedBy: "test",
      });
      // Every scene shares the cast, so a failure in one propagates downstream.
      for (let index = 0; index < 8; index += 1) {
        await saveSceneContinuity({
          userId: owner.user.id,
          projectId: owner.projectId,
          sceneIndex: index,
          state: sceneState(),
          continuityPrompt: null,
        });
      }

      // Scene 2 has already exhausted its budget: four paid attempts.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await countRegeneration({
          userId: owner.user.id,
          projectId: owner.projectId,
          sceneIndex: 2,
        });
      }

      const scenes = await withFlag(true, async () => {
        const { loadContext, scenesToRegenerate } = await import(
          "@/lib/continuity/service"
        );
        const context = await loadContext(
          owner.user.id,
          continuityProject(owner.projectId, owner.channelId),
        );
        expect(context.active).toBe(true);

        return scenesToRegenerate({
          userId: owner.user.id,
          projectId: owner.projectId,
          context,
          report: report({
            score: 30,
            status: "fail",
            affectedScenes: [1, 2],
            affectedEntities: ["mara"],
          }),
        });
      });

      // The ceiling is four, so a fail across a chained graph never turns into a
      // rebuild of the whole tail.
      expect(scenes.length).toBeLessThanOrEqual(4);
      // And the scene that already spent its budget is not retried a fifth time.
      expect(scenes).not.toContain(2);
      expect(scenes).toContain(1);
    });

    /**
     * The prompt a regeneration was actually built from, over the row the visuals
     * stage left behind.
     *
     * The check reads `scenes.continuity_prompt` to decide whether a scene carried its
     * constraints, so a regenerated scene whose row still holds the *original* block has
     * the next check validating a prompt nothing was generated from. It can pass a scene
     * that failed and fail one that was fixed.
     *
     * The stage itself cannot be run here — it charges credits, resolves a real model and
     * stores bytes, all of which `credit-charging.test.ts` already covers end to end. What
     * this asserts is the pair the stage writes: that `regenerationPromptFor` returns the
     * block embedded in the prompt it built, and that `recordScenePrompt` puts that same
     * block on the row where the check will find it.
     */
    it("re-records the block a regenerated scene was actually built from", async () => {
      const { getSceneStates, saveUserBible, saveSceneContinuity } = await import(
        "@/lib/continuity/store"
      );

      const owner = await project("regen-prompt@tally.test");
      await insertScenes(owner.user.id, owner.projectId, 2);
      await saveUserBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: bible("Mara"),
        level: "character",
      });
      for (let index = 0; index < 2; index += 1) {
        await saveSceneContinuity({
          userId: owner.user.id,
          projectId: owner.projectId,
          sceneIndex: index,
          state: sceneState(),
          // What the visuals stage would have stored: a block from the bible as it
          // was at build time.
          continuityPrompt: "Mara: an outdated description from the first build.",
        });
      }

      await withFlag(true, async () => {
        const { loadContext, recordScenePrompt, regenerationPromptFor } = await import(
          "@/lib/continuity/service"
        );
        const context = await loadContext(
          owner.user.id,
          continuityProject(owner.projectId, owner.channelId),
        );
        expect(context.active).toBe(true);

        const regeneration = regenerationPromptFor({
          context,
          report: report({
            score: 30,
            status: "fail",
            affectedScenes: [1],
            issues: [
              {
                code: "continuity.character.missing_constraint",
                severity: "fail",
                message: "Scene 1's prompt did not describe Mara.",
                sceneIndex: 1,
                entityId: "mara",
              },
            ],
          }),
          sceneIndex: 1,
          visualPrompt: SHOTS[1]!,
        });

        /**
         * The block is what the prompt contains, not a second computation of it.
         *
         * This is why `regenerationPromptFor` returns both: recomputing the block at the
         * call site to store it would put two derivations of the same thing one edit
         * apart, and the one thing that must never differ is what was stored from what
         * was sent.
         */
        expect(regeneration.block.length).toBeGreaterThan(0);
        expect(regeneration.prompt).toContain(regeneration.block);
        expect(regeneration.prompt).toContain(SHOTS[1]!);
        // §13: the failure that caused the redraw travels with it.
        expect(regeneration.prompt).toContain("Scene 1's prompt did not describe Mara.");

        await recordScenePrompt({
          userId: owner.user.id,
          projectId: owner.projectId,
          sceneIndex: 1,
          state: context.states.find((s) => s.sceneIndex === 1) ?? null,
          block: regeneration.block,
        });

        const states = await getSceneStates(owner.user.id, owner.projectId);
        const scenes = await sceneRows(owner.user.id, owner.projectId);

        // The regenerated scene's row is the prompt it was regenerated under.
        expect(scenes.get(1)).toBe(regeneration.block);
        expect(scenes.get(1)).not.toContain("outdated description");
        // And only that scene's: a redraw of scene 1 must not rewrite scene 0's record.
        expect(scenes.get(0)).toBe(
          "Mara: an outdated description from the first build.",
        );
        // The state survives the write, because the check builds the graph from it.
        expect(states.map((s) => s.sceneIndex)).toEqual([0, 1]);
      });
    });

    it("leaves the recorded prompt alone when there is nothing to record", async () => {
      /**
       * §25's half of the same write. An inert context produces an empty block, and
       * `recordScenePrompt` stores null for one rather than an empty string — so a
       * project with the layer off does not acquire a continuity row that reads as "this
       * scene was built with no constraints" when it was built before constraints
       * existed.
       */
      const { saveSceneContinuity } = await import("@/lib/continuity/store");
      const owner = await project("regen-prompt-inert@tally.test");
      await insertScenes(owner.user.id, owner.projectId, 1);
      await saveSceneContinuity({
        userId: owner.user.id,
        projectId: owner.projectId,
        sceneIndex: 0,
        state: sceneState(),
        continuityPrompt: null,
      });

      await withFlag(false, async () => {
        const { loadContext, recordScenePrompt, regenerationPromptFor } = await import(
          "@/lib/continuity/service"
        );
        const context = await loadContext(
          owner.user.id,
          continuityProject(owner.projectId, owner.channelId),
        );
        expect(context.active).toBe(false);

        const regeneration = regenerationPromptFor({
          context,
          report: report({ score: 20, status: "fail", affectedScenes: [0] }),
          sceneIndex: 0,
          visualPrompt: SHOTS[0]!,
        });

        // Byte-identical to the shot: an inert layer appends nothing.
        expect(regeneration.block).toBe("");
        expect(regeneration.prompt).toBe(SHOTS[0]!);

        await recordScenePrompt({
          userId: owner.user.id,
          projectId: owner.projectId,
          sceneIndex: 0,
          state: null,
          block: regeneration.block,
        });

        expect((await sceneRows(owner.user.id, owner.projectId)).get(0)).toBeNull();
      });
    });

    it("does not regenerate on a warn verdict", async () => {
      const { saveBible, saveSceneContinuity } = await import(
        "@/lib/continuity/store"
      );

      const owner = await project("warn@tally.test");
      await insertScenes(owner.user.id, owner.projectId, 4);
      await saveBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: bible("Mara"),
        level: "character",
        generatedBy: "test",
      });
      for (let index = 0; index < 4; index += 1) {
        await saveSceneContinuity({
          userId: owner.user.id,
          projectId: owner.projectId,
          sceneIndex: index,
          state: sceneState(),
          continuityPrompt: null,
        });
      }

      const scenes = await withFlag(true, async () => {
        const { loadContext, scenesToRegenerate } = await import(
          "@/lib/continuity/service"
        );
        const context = await loadContext(
          owner.user.id,
          continuityProject(owner.projectId, owner.channelId),
        );

        return scenesToRegenerate({
          userId: owner.user.id,
          projectId: owner.projectId,
          context,
          report: report({ score: 65, status: "warn", affectedScenes: [1, 2] }),
        });
      });

      // A warn is recorded and shown. Spending a provider call on it would make the
      // middle band cost the same as a failure.
      expect(scenes).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // §16, §26, §27, §28 — provider independence
  // -------------------------------------------------------------------------

  describe("provider independence", () => {
    /**
     * Read the continuity layer's own source.
     *
     * Structural, not behavioural, and deliberately so: a behavioural test would be
     * satisfied by a mock provider just as happily as by the real abstraction, so it
     * could not tell a correct implementation from one that hard-codes FAL and is
     * being fed a fake. What the mandate forbids is a *dependency*, and a dependency
     * is visible in the import list.
     */
    async function continuitySources(): Promise<Map<string, string>> {
      const { readdirSync, readFileSync } = await import("node:fs");
      const { join } = await import("node:path");

      const dir = join(process.cwd(), "src", "lib", "continuity");
      const files = readdirSync(dir).filter(
        (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
      );

      return new Map(
        files.map((name) => [name, readFileSync(join(dir, name), "utf8")]),
      );
    }

    /** Import statements only — a docblock explaining a rule must not trip it. */
    function importLines(source: string): string[] {
      return [...source.matchAll(/^\s*import\s[\s\S]*?from\s+"[^"]+";/gm)].map(
        (match) => match[0],
      );
    }

    it("names no video provider or model anywhere in the layer", async () => {
      const sources = await continuitySources();
      expect(sources.size).toBeGreaterThan(5);

      /**
       * The names §16 says belong in the capability layer.
       *
       * Checked against import statements and against code, but with the docblocks
       * stripped first: several modules explain in prose why they must not know
       * which provider is in use, and a naive substring search would fail on the
       * explanation rather than on a regression.
       */
      const forbidden = [
        "fal-ai/",
        "FAL_KEY",
        "GEMINI_API_KEY",
        "seedance",
        "kling",
        "veo-3",
        "wan-",
        "bedrock",
        "fal.run",
        "generativelanguage.googleapis.com",
      ];

      for (const [name, source] of sources) {
        const code = source
          .replace(/\/\*\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");

        for (const token of forbidden) {
          expect(
            code.toLowerCase().includes(token.toLowerCase()),
            `${name} must not name ${token} — provider rules belong in the capability layer`,
          ).toBe(false);
        }
      }
    });

    it("never imports a generation provider", async () => {
      const sources = await continuitySources();

      /**
       * The layer may import the *planning* abstraction and nothing else.
       *
       * `@/lib/providers/ai` is role (A) in the architecture — planning through the
       * existing AI abstraction — and only the planner uses it. Roles (B) and (C),
       * generation and visual analysis, must be reached by the pipeline, never from
       * here: §28's "never call a provider directly from continuity logic".
       */
      const generation = [
        "@/lib/providers/visuals",
        "@/lib/providers/render",
        "@/lib/providers/voice",
        "@/lib/providers/music",
        "@/lib/providers/transcription",
        "@/lib/providers/youtube",
        "@/lib/providers/http",
        "@/lib/providers/fetch",
      ];

      for (const [name, source] of sources) {
        const imports = importLines(source);
        // Not named `module`: Next's `no-assign-module-variable` rule flags any
        // binding of that name, even a for-of const that assigns nothing.
        for (const forbidden of generation) {
          expect(
            imports.filter((line) => line.includes(`"${forbidden}"`)),
            `${name} must not import ${forbidden}`,
          ).toEqual([]);
        }

        // `video-gen` is imported for the `GenerationMode` union and the type guard
        // that narrows a database string to it. `generateClip` is the line that must
        // never be crossed.
        expect(source).not.toMatch(/\bgenerateClip\b/);
        expect(source).not.toMatch(/\bresolveModel\b/);
      }
    });

    it("uses the existing AI abstraction for planning, and only in the planner", async () => {
      const sources = await continuitySources();

      const withAi = [...sources]
        .filter(([, source]) =>
          importLines(source).some((line) =>
            line.includes('"@/lib/providers/ai"'),
          ),
        )
        .map(([name]) => name);

      // One module, and it is the one whose job is to ask a model for a bible.
      expect(withAi).toEqual(["planner.ts"]);

      // Through `generateJson`, which is where usage accounting, JSON repair and
      // model selection already live — not through a bespoke HTTP call.
      const planner = sources.get("planner.ts") ?? "";
      expect(planner).toContain("generateJson");
      expect(planner).not.toMatch(/\bfetch\(/);
    });

    it("resolves the same level whatever the configured providers are", async () => {
      const owner = await project("provider-agnostic@tally.test");
      const levels: string[] = [];

      /**
       * Three provider configurations, one expected answer.
       *
       * The level is a function of the project and the channel's style settings. If
       * it moved with `VIDEO_GEN_PROVIDERS` then continuity would be silently
       * stronger on one deployment than another, and a project would behave
       * differently after a key rotation.
       */
      const { resetEnvCache } = await import("@/lib/env");
      const previous = process.env["VIDEO_GEN_PROVIDERS"];

      try {
        // Two live configurations and one retired id. `fal` resolves to nothing
        // since §14 removed it, so the third case also covers "a stale environment
        // line must not change how much continuity a project gets".
        for (const providers of ["mock", "qwen,minimax,seedance,veo", "fal"]) {
          process.env["VIDEO_GEN_PROVIDERS"] = providers;
          resetEnvCache();
          const context = await withFlag(true, async () => {
            const { resolveFor } = await import("@/lib/continuity/service");
            return resolveFor(continuityProject(owner.projectId, owner.channelId));
          });
          levels.push(`${context.plan.level}:${context.active}`);
        }
      } finally {
        if (previous === undefined) delete process.env["VIDEO_GEN_PROVIDERS"];
        else process.env["VIDEO_GEN_PROVIDERS"] = previous;
        resetEnvCache();
      }

      expect(levels).toEqual(["character:true", "character:true", "character:true"]);
    });

    it("builds the same continuity prompt whatever the configured providers are", async () => {
      const { saveBible, saveSceneContinuity } = await import(
        "@/lib/continuity/store"
      );
      const owner = await project("prompt-agnostic@tally.test");
      await insertScenes(owner.user.id, owner.projectId, 2);
      await saveBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: bible("Mara"),
        level: "character",
        generatedBy: "test",
      });
      await saveSceneContinuity({
        userId: owner.user.id,
        projectId: owner.projectId,
        sceneIndex: 0,
        state: sceneState(),
        continuityPrompt: null,
      });

      const { resetEnvCache } = await import("@/lib/env");
      const previous = process.env["VIDEO_GEN_PROVIDERS"];
      const prompts: string[] = [];

      try {
        for (const providers of ["mock", "qwen,minimax", "veo", "fal"]) {
          process.env["VIDEO_GEN_PROVIDERS"] = providers;
          resetEnvCache();

          prompts.push(
            await withFlag(true, async () => {
              const { continuityContextFor, loadContext } = await import(
                "@/lib/continuity/service"
              );
              const context = await loadContext(
                owner.user.id,
                continuityProject(owner.projectId, owner.channelId),
              );
              return continuityContextFor({
                context,
                sceneIndex: 0,
                visualPrompt: "A bench under a warm bulb",
              }).prompt;
            }),
          );
        }
      } finally {
        if (previous === undefined) delete process.env["VIDEO_GEN_PROVIDERS"];
        else process.env["VIDEO_GEN_PROVIDERS"] = previous;
        resetEnvCache();
      }

      // Byte-identical across every configuration. The provider chooses how to
      // render the request; it does not change what the request says.
      expect(prompts).toHaveLength(4);
      expect(new Set(prompts).size).toBe(1);
      expect(prompts[0]).toContain("brown canvas coat");
    });
  });

  // -------------------------------------------------------------------------
  // The human edit path (§17, §19)
  // -------------------------------------------------------------------------

  describe("operator-edited bibles", () => {
    it("stops the planner path from overwriting an edited bible", async () => {
      const { getBible, saveBible, saveUserBible } = await import(
        "@/lib/continuity/store"
      );
      const owner = await project("edited@tally.test");

      await saveUserBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: bible("Mara"),
        level: "character",
      });

      const stored = await getBible(owner.user.id, owner.projectId);
      expect(stored?.editedByUser).toBe(true);

      // The planner's write returns false rather than recasting a corrected video.
      const written = await saveBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: bible("Replacement"),
        level: "character",
        generatedBy: "continuity.plan",
      });

      expect(written).toBe(false);
      const after = await getBible(owner.user.id, owner.projectId);
      expect(after?.bible.characters[0]?.name).toBe("Mara");
    });

    it("lets the owner edit their own bible twice", async () => {
      const { getBible, saveUserBible } = await import("@/lib/continuity/store");
      const owner = await project("edited-twice@tally.test");

      await saveUserBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: bible("Mara"),
        level: "character",
      });
      await saveUserBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: bible("Mara Reconsidered"),
        level: "character",
      });

      // The flag exists to stop the planner, never the human.
      const after = await getBible(owner.user.id, owner.projectId);
      expect(after?.bible.characters[0]?.name).toBe("Mara Reconsidered");
      expect(after?.editedByUser).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Reference stills (§5, §6)
  // -------------------------------------------------------------------------

  /**
   * Reference images are the one part of the layer whose correctness is entirely
   * about the *database*, so almost none of it is testable in a unit test:
   *
   *  - Whether a reference is found again depends on a `meta->>'…' = 'true'` predicate
   *    against a jsonb column. That is a SQL fact, and it type-checks either way.
   *  - Whether it is invisible to another tenant depends on a `userId` in a WHERE
   *    clause, the same class of defect §20 exists to catch.
   *  - Whether a second run costs money depends on `referencedEntityKeys` actually
   *    excluding what is stored. Getting that wrong is a paid regeneration of the
   *    whole cast on every build, which no unit test would notice.
   *
   * No provider is called anywhere below. Reference rows are inserted directly, which
   * is exactly what the pipeline stage does with a generated still — the stage's own
   * provider call is covered by the video-provider tests against the mock.
   */
  describe("reference stills", () => {
    /**
     * Store a reference row the way the pipeline stage does.
     *
     * Through `referenceAssetMeta` rather than a hand-written `meta` literal, so a
     * change to the flag or the key names breaks the writer and the reader together
     * instead of leaving this test passing against a vocabulary nothing else uses.
     */
    async function storeReference(args: {
      userId: string;
      projectId: string;
      kind: "character" | "environment" | "prop";
      entityId: string;
      entityName?: string;
    }): Promise<string> {
      const { db } = await import("@/lib/db");
      const { assets } = await import("@/lib/db/schema");
      const { referenceAssetMeta } = await import("@/lib/continuity/store");

      const rows = await db
        .insert(assets)
        .values({
          userId: args.userId,
          projectId: args.projectId,
          kind: "generated_image",
          storageKey: `reference/${args.projectId}/${args.kind}-${args.entityId}.png`,
          mimeType: "image/png",
          width: 1280,
          height: 720,
          provider: "mock",
          license: "Generated",
          meta: referenceAssetMeta({
            kind: args.kind,
            entityId: args.entityId,
            entityName: args.entityName ?? args.entityId,
            prompt: `A reference for ${args.entityId}`,
            // Branded id, never a vendor name — the same value the stage stores.
            modelId: "mock/standard",
          }),
        })
        .returning({ id: assets.id });

      return rows[0]!.id;
    }

    it("finds a stored reference again through the meta flag", async () => {
      const { getReferenceImages } = await import("@/lib/continuity/store");
      const owner = await project("reference-read@tally.test");

      await storeReference({
        userId: owner.user.id,
        projectId: owner.projectId,
        kind: "character",
        entityId: "mara",
        entityName: "Mara",
      });

      const stored = await getReferenceImages(owner.user.id, owner.projectId);

      expect(stored).toHaveLength(1);
      expect(stored[0]?.kind).toBe("character");
      expect(stored[0]?.entityId).toBe("mara");
      expect(stored[0]?.entityName).toBe("Mara");
      expect(stored[0]?.storageKey).toContain("reference/");
      expect(stored[0]?.modelId).toBe("mock/standard");
    });

    it("does not mistake an ordinary generated image for a reference", async () => {
      const { db } = await import("@/lib/db");
      const { assets } = await import("@/lib/db/schema");
      const { getReferenceImages } = await import("@/lib/continuity/store");
      const owner = await project("reference-not-flagged@tally.test");

      // A scene visual that happens to be a still — same kind, no flag. If the
      // predicate were on `kind` alone, this would be served as a character sheet.
      await db.insert(assets).values({
        userId: owner.user.id,
        projectId: owner.projectId,
        kind: "generated_image",
        storageKey: `visual/${owner.projectId}/scene-0.png`,
        mimeType: "image/png",
        provider: "mock",
        meta: { sceneIndex: 0 },
      });

      expect(await getReferenceImages(owner.user.id, owner.projectId)).toEqual([]);
    });

    it("does not return one tenant's references to another", async () => {
      const { getReferenceImages } = await import("@/lib/continuity/store");
      const owner = await project("reference-owner@tally.test");
      const intruder = await project("reference-intruder@tally.test");

      await storeReference({
        userId: owner.user.id,
        projectId: owner.projectId,
        kind: "character",
        entityId: "mara",
      });

      // The owner's project id with the intruder's user id — the exact shape of a
      // guard that checks the project but forgets the tenant.
      expect(
        await getReferenceImages(intruder.user.id, owner.projectId),
      ).toEqual([]);
    });

    it("returns only the newest reference per entity", async () => {
      const { getReferenceImages } = await import("@/lib/continuity/store");
      const owner = await project("reference-superseded@tally.test");

      const first = await storeReference({
        userId: owner.user.id,
        projectId: owner.projectId,
        kind: "character",
        entityId: "mara",
        entityName: "Mara",
      });
      const second = await storeReference({
        userId: owner.user.id,
        projectId: owner.projectId,
        kind: "character",
        entityId: "mara",
        entityName: "Mara Redrawn",
      });

      const stored = await getReferenceImages(owner.user.id, owner.projectId);

      // The older row stays as provenance, exactly as a replaced scene visual does,
      // but a caller receiving both would have to decide which is current.
      expect(stored).toHaveLength(1);
      expect(stored[0]?.assetId).toBe(second);
      expect(stored[0]?.assetId).not.toBe(first);
      expect(stored[0]?.entityName).toBe("Mara Redrawn");
    });

    /**
     * The stills as the panel receives them.
     *
     * `ContinuityPanel` itself cannot be render-tested in this repository — `vitest.config.ts`
     * runs `environment: "node"`, includes only `*.test.ts`, and there is no jsdom or
     * `@testing-library` dependency — so the assertions are on the data the component is a
     * pure function of. What that leaves untested is the JSX; what it covers is everything
     * that could be wrong about the stills a panel is given: which rows, whose rows, and
     * whether each has a URL a browser can fetch.
     */
    describe("in the read model", () => {
      it("signs each stored still for the panel, newest per entity", async () => {
        const { continuityView } = await import("@/lib/continuity/read");
        const { saveUserBible } = await import("@/lib/continuity/store");
        const owner = await project("reference-view@tally.test");

        await saveUserBible({
          userId: owner.user.id,
          projectId: owner.projectId,
          bible: bible("Mara"),
          level: "character",
        });

        await storeReference({
          userId: owner.user.id,
          projectId: owner.projectId,
          kind: "character",
          entityId: "mara",
          entityName: "Mara",
        });
        await storeReference({
          userId: owner.user.id,
          projectId: owner.projectId,
          kind: "environment",
          entityId: "workshop",
          entityName: "The Workshop",
        });
        // Superseded by the next one: the panel must show the current still, not both.
        await storeReference({
          userId: owner.user.id,
          projectId: owner.projectId,
          kind: "character",
          entityId: "mara",
          entityName: "Mara Redrawn",
        });

        const view = await withFlag(true, () =>
          continuityView(owner.user.id, owner.projectId, "studio"),
        );

        expect(view.references).toHaveLength(2);

        const byEntity = new Map(view.references.map((r) => [r.entityId, r]));
        expect(byEntity.get("mara")?.name).toBe("Mara Redrawn");
        expect(byEntity.get("mara")?.kind).toBe("character");
        expect(byEntity.get("workshop")?.kind).toBe("environment");

        for (const reference of view.references) {
          /**
           * A real signed URL, which is the point of signing them here.
           *
           * The bucket is private, so a storage key rendered into an `<img src>` would be
           * a broken image on every panel. The query has to carry a signature and an
           * expiry — a bare object URL would 403.
           */
          expect(reference.url, reference.entityId).toBeTruthy();
          expect(reference.assetId, reference.entityId).toBeTruthy();
          expect(reference.url).toMatch(/X-Amz-Signature=/);
          expect(reference.url).toMatch(/X-Amz-Expires=/);
          // Signed for reading. A panel must never be handed an upload URL.
          expect(reference.url).not.toContain("uploadId");
        }
      });

      it("gives the panel an empty list rather than a failure when nothing is drawn", async () => {
        // The ordinary case, and the reason the panel hides the section instead of
        // showing an empty strip: stills are drawn on request, so most projects have none.
        const { continuityView } = await import("@/lib/continuity/read");
        const { saveUserBible } = await import("@/lib/continuity/store");
        const owner = await project("reference-view-empty@tally.test");

        await saveUserBible({
          userId: owner.user.id,
          projectId: owner.projectId,
          bible: bible("Mara"),
          level: "character",
        });

        const view = await withFlag(true, () =>
          continuityView(owner.user.id, owner.projectId, "studio"),
        );

        expect(view.references).toEqual([]);
        // And the rest of the view is intact, so an absent still is not read as an
        // absent bible.
        expect(view.bible?.characters[0]?.name).toBe("Mara");
      });

      it("does not put one tenant's stills on another's panel", async () => {
        const { continuityView } = await import("@/lib/continuity/read");
        const { saveUserBible } = await import("@/lib/continuity/store");

        const owner = await project("reference-view-owner@tally.test");
        const intruder = await project("reference-view-intruder@tally.test");

        await saveUserBible({
          userId: owner.user.id,
          projectId: owner.projectId,
          bible: bible("Mara"),
          level: "character",
        });
        await storeReference({
          userId: owner.user.id,
          projectId: owner.projectId,
          kind: "character",
          entityId: "mara",
          entityName: "Mara",
        });

        await withFlag(true, async () => {
          expect(
            (await continuityView(owner.user.id, owner.projectId, "studio")).references,
          ).toHaveLength(1);

          // The owner's project id with the intruder's user id — refused at
          // `getProject`, before any still is read or signed.
          await expect(
            continuityView(intruder.user.id, owner.projectId, "studio"),
          ).rejects.toMatchObject({ code: "forbidden" });

          // And the intruder's own panel shows their own emptiness.
          expect(
            (await continuityView(intruder.user.id, intruder.projectId, "studio"))
              .references,
          ).toEqual([]);
        });
      });

      it("keeps a still whose URL cannot be signed, without its picture", async () => {
        /**
         * A signing failure costs one still its thumbnail, not the panel its cast — and
         * never the video screen its render. The still exists, so dropping it would tell
         * an operator the character is undrawn and invite them to pay to draw it again.
         */
        const { continuityView } = await import("@/lib/continuity/read");
        const { saveUserBible } = await import("@/lib/continuity/store");
        const storage = await import("@/lib/storage");
        const owner = await project("reference-view-unsignable@tally.test");

        await saveUserBible({
          userId: owner.user.id,
          projectId: owner.projectId,
          bible: bible("Mara"),
          level: "character",
        });
        await storeReference({
          userId: owner.user.id,
          projectId: owner.projectId,
          kind: "character",
          entityId: "mara",
          entityName: "Mara",
        });

        const spy = vi
          .spyOn(storage, "signedReadUrl")
          .mockRejectedValue(new Error("signing is unavailable"));

        try {
          const view = await withFlag(true, () =>
            continuityView(owner.user.id, owner.projectId, "studio"),
          );

          expect(view.references).toHaveLength(1);
          expect(view.references[0]?.name).toBe("Mara");
          expect(view.references[0]?.url).toBeNull();
        } finally {
          spy.mockRestore();
        }
      });
    });

    it("plans every entity with visual facts, and nothing when the flag is off", async () => {
      const { saveUserBible } = await import("@/lib/continuity/store");
      const owner = await project("reference-plan@tally.test");

      await saveUserBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: bible("Mara"),
        level: "character",
      });

      const planned = await withFlag(true, async () => {
        const { referenceImagePlan } = await import("@/lib/continuity/service");
        return referenceImagePlan({
          userId: owner.user.id,
          project: continuityProject(owner.projectId, owner.channelId),
        });
      });

      expect(planned.wanted.map((entry) => `${entry.kind}:${entry.entityId}`)).toEqual([
        "character:mara",
        "environment:workshop",
        "prop:lamp",
      ]);
      expect(planned.existing).toEqual([]);
      expect(planned.reason).toBe("");

      // The same project with the flag off wants nothing, and says why.
      const off = await withFlag(false, async () => {
        const { referenceImagePlan } = await import("@/lib/continuity/service");
        return referenceImagePlan({
          userId: owner.user.id,
          project: continuityProject(owner.projectId, owner.channelId),
        });
      });

      expect(off.wanted).toEqual([]);
      expect(off.reason).toContain("switched off");
    });

    it("excludes entities that already have a reference, so a second run costs nothing", async () => {
      const { saveUserBible } = await import("@/lib/continuity/store");
      const owner = await project("reference-plan-partial@tally.test");

      await saveUserBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: bible("Mara"),
        level: "character",
      });

      await storeReference({
        userId: owner.user.id,
        projectId: owner.projectId,
        kind: "character",
        entityId: "mara",
        entityName: "Mara",
      });

      const planned = await withFlag(true, async () => {
        const { referenceImagePlan } = await import("@/lib/continuity/service");
        return referenceImagePlan({
          userId: owner.user.id,
          project: continuityProject(owner.projectId, owner.channelId),
        });
      });

      expect(planned.wanted.map((entry) => entry.entityId)).toEqual([
        "workshop",
        "lamp",
      ]);
      expect(planned.existing.map((entry) => entry.entityId)).toEqual(["mara"]);
    });

    it("wants nothing, with a distinct reason, once every entity is drawn", async () => {
      const { saveUserBible } = await import("@/lib/continuity/store");
      const owner = await project("reference-plan-complete@tally.test");

      await saveUserBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: bible("Mara"),
        level: "character",
      });

      for (const entity of [
        { kind: "character" as const, entityId: "mara" },
        { kind: "environment" as const, entityId: "workshop" },
        { kind: "prop" as const, entityId: "lamp" },
      ]) {
        await storeReference({
          userId: owner.user.id,
          projectId: owner.projectId,
          ...entity,
        });
      }

      const planned = await withFlag(true, async () => {
        const { referenceImagePlan } = await import("@/lib/continuity/service");
        return referenceImagePlan({
          userId: owner.user.id,
          project: continuityProject(owner.projectId, owner.channelId),
        });
      });

      expect(planned.wanted).toEqual([]);
      expect(planned.existing).toHaveLength(3);
      // "Already drawn" is a different answer from "nothing to draw", and a user
      // reading the second when the first is true would go looking for a bug.
      expect(planned.reason).toContain("already has a reference");
    });

    /**
     * What the panel quotes before the user presses Generate (§20).
     *
     * The reference panel is the one place a *total* can be quoted honestly: the entity
     * count comes out of the stored bible, so unlike a scene count it is known before
     * any generation happens. These cases are about that total being the figure the
     * stage will actually charge, and about it being absent rather than zero when the
     * project cannot be priced at all.
     */
    describe("the cost quote (§20)", () => {
      /** Set the project's model and resolution, as the picker's Save would. */
      async function selectModel(
        projectId: string,
        model: string | null,
        quality: string | null,
      ): Promise<void> {
        const { db } = await import("@/lib/db");
        const { projects } = await import("@/lib/db/schema");
        const { eq } = await import("drizzle-orm");
        await db
          .update(projects)
          .set({ generationModel: model, videoQuality: quality })
          .where(eq(projects.id, projectId));
      }

      /** The panel, as the studio fetches it. */
      async function fetchPanel(projectId: string) {
        const { NextRequest } = await import("next/server");
        const { GET } = await import(
          "@/app/api/video/continuity/references/route"
        );
        const response = await GET(
          new NextRequest(
            `http://localhost:3000/api/video/continuity/references?projectId=${projectId}`,
            { method: "GET" },
          ) as never,
        );
        return {
          status: response.status,
          body: (await response.json()) as {
            data?: {
              pending?: { entityId: string }[];
              cost?: {
                perImage: number;
                total: number;
                quality: string;
                entities: number;
              } | null;
            };
            error?: { code?: string };
          },
        };
      }

      /** Onboarded and signed in, which `requireOnboarded()` demands. */
      async function asCaller(user: TestUser): Promise<void> {
        const { saveStep, complete } = await import("@/lib/onboarding/service");
        await saveStep(user.id, {
          niche: "animated stories",
          contentStyle: "storytelling",
          voicePreference: "warm-male",
        });
        await complete(user.id);
        await signIn(user);
      }

      it("totals the outstanding entities at the image rate", async () => {
        const { saveUserBible } = await import("@/lib/continuity/store");
        const owner = await project("reference-cost@tally.test");
        await selectModel(owner.projectId, "mock/placeholder", "1080p");
        await asCaller(owner.user);

        await saveUserBible({
          userId: owner.user.id,
          projectId: owner.projectId,
          bible: bible("Mara"),
          level: "character",
        });

        const result = await withFlag(true, () => fetchPanel(owner.projectId));

        expect(result.status).toBe(200);
        // Three entities in the fixture bible: one character, one environment, one prop.
        expect(result.body.data?.pending).toHaveLength(3);

        const cost = result.body.data?.cost;
        const { imagePriceFor } = await import("@/lib/credits/pricing");
        const expected = imagePriceFor("mock/placeholder", "1080p");

        expect(cost?.perImage).toBe(expected);
        expect(cost?.entities).toBe(3);
        /*
         * The total is the product, which is the whole claim: a panel that quoted the
         * per-image rate as the total would understate a three-character bible by two
         * thirds, and the button next to it spends the difference.
         */
        expect(cost?.total).toBe(expected * 3);
        expect(cost?.quality).toBe("1080p");
      });

      it("charges nothing more for an entity already drawn, and says so in the total", async () => {
        const { saveUserBible } = await import("@/lib/continuity/store");
        const owner = await project("reference-cost-partial@tally.test");
        await selectModel(owner.projectId, "mock/placeholder", "1080p");
        await asCaller(owner.user);

        await saveUserBible({
          userId: owner.user.id,
          projectId: owner.projectId,
          bible: bible("Mara"),
          level: "character",
        });
        await storeReference({
          userId: owner.user.id,
          projectId: owner.projectId,
          kind: "character",
          entityId: "mara",
          entityName: "Mara",
        });

        const result = await withFlag(true, () => fetchPanel(owner.projectId));

        // The quote follows `pending`, not the bible: the stage skips what is already
        // stored, so a total over all three would charge for a still nobody will draw.
        expect(result.body.data?.pending).toHaveLength(2);
        expect(result.body.data?.cost?.entities).toBe(2);
        const { imagePriceFor } = await import("@/lib/credits/pricing");
        expect(result.body.data?.cost?.total).toBe(
          imagePriceFor("mock/placeholder", "1080p") * 2,
        );
      });

      it("quotes the resolution the model actually draws stills at", async () => {
        /**
         * The project asks for 2K; the quote has to name whatever
         * `assertImageQuality` resolves, because that is what the stage will charge.
         * Asserted as "one of the model's own image tiers" rather than as a literal,
         * so this stays true if the mock's tiers change — the property is that the
         * quoted resolution is a real one, not a repetition of the request.
         */
        const { saveUserBible } = await import("@/lib/continuity/store");
        const owner = await project("reference-cost-quality@tally.test");
        await selectModel(owner.projectId, "mock/placeholder", "2k");
        await asCaller(owner.user);

        await saveUserBible({
          userId: owner.user.id,
          projectId: owner.projectId,
          bible: bible("Mara"),
          level: "character",
        });

        const result = await withFlag(true, () => fetchPanel(owner.projectId));

        const { resolveModel } = await import("@/lib/providers/video-gen");
        const { isVideoQuality } = await import("@/lib/video/quality");
        const tiers = resolveModel("mock/placeholder").model.capabilities
          .imageQualities as readonly string[];

        const quoted = result.body.data?.cost?.quality;
        // Narrowed rather than cast: a `as VideoQuality` here would let a junk string
        // through to `imagePriceFor`, which prices anything it does not recognise at the
        // unknown rate — and the test would pass on a quote nobody could be charged.
        expect(isVideoQuality(quoted)).toBe(true);
        expect(tiers).toContain(quoted);

        const { imagePriceFor } = await import("@/lib/credits/pricing");
        if (isVideoQuality(quoted)) {
          expect(result.body.data?.cost?.perImage).toBe(
            imagePriceFor("mock/placeholder", quoted),
          );
        }
      });

      it("quotes nothing rather than zero for a stock-footage project", async () => {
        /**
         * Null, not `total: 0`. A zero reads as "free", and the panel has to be able to
         * tell "this costs nothing" from "there is no price to quote here" — the second
         * is the truth for a project that will never draw a still.
         */
        const owner = await project("reference-cost-stock@tally.test", {
          generationMode: "STOCK",
        });
        await asCaller(owner.user);

        const result = await withFlag(true, () => fetchPanel(owner.projectId));

        expect(result.status).toBe(200);
        expect(result.body.data?.cost).toBeNull();
      });

      it("still renders the panel when the project's model cannot be priced", async () => {
        /**
         * A project holding a model id no provider declares — a §17 pre-existing row, or
         * one whose provider an operator has since removed. `generationPlanFor` throws
         * for it, and the GET must still answer: the panel's job is to report the state,
         * and the POST is where that project is refused with a message naming the
         * problem.
         */
        const owner = await project("reference-cost-unknown@tally.test");
        await selectModel(owner.projectId, "retired/model", "1080p");
        await asCaller(owner.user);

        const result = await withFlag(true, () => fetchPanel(owner.projectId));

        expect(result.status).toBe(200);
        expect(result.body.data?.cost).toBeNull();
      });

      it("refuses an unauthenticated read of the panel", async () => {
        const owner = await project("reference-cost-anon@tally.test");
        await selectModel(owner.projectId, "mock/placeholder", "1080p");
        jar.clear();

        expect((await fetchPanel(owner.projectId)).status).toBe(401);
      });
    });

    it("wants nothing for a project with no bible", async () => {
      const owner = await project("reference-plan-no-bible@tally.test");

      const planned = await withFlag(true, async () => {
        const { referenceImagePlan } = await import("@/lib/continuity/service");
        return referenceImagePlan({
          userId: owner.user.id,
          project: continuityProject(owner.projectId, owner.channelId),
        });
      });

      expect(planned.wanted).toEqual([]);
      expect(planned.reason).toContain("No story bible");
    });

    /**
     * The reuse half of §6, at the level it is decided.
     *
     * `referencesForScene` is pure, but a meaningful test of it needs a real context —
     * a stored bible, real scene states and the level the settings resolve to — and
     * assembling those by hand would be asserting against a fixture rather than
     * against the resolution the pipeline actually performs.
     */
    describe("per-scene selection", () => {
      async function contextFor(owner: {
        user: TestUser;
        channelId: string;
        projectId: string;
      }) {
        const { loadContext } = await import("@/lib/continuity/service");
        return loadContext(
          owner.user.id,
          continuityProject(owner.projectId, owner.channelId),
        );
      }

      it("sends only the entities the scene commits to, cast first", async () => {
        const { saveSceneContinuity, saveUserBible, getReferenceImages } =
          await import("@/lib/continuity/store");
        const { referencesForScene } = await import("@/lib/continuity/service");
        const owner = await project("reference-scene-select@tally.test");

        await saveUserBible({
          userId: owner.user.id,
          projectId: owner.projectId,
          bible: bible("Mara"),
          level: "character",
        });
        await insertScenes(owner.user.id, owner.projectId, 2);

        // Scene 0 has the whole cast; scene 1 is the location alone.
        await saveSceneContinuity({
          userId: owner.user.id,
          projectId: owner.projectId,
          sceneIndex: 0,
          state: sceneState(),
          continuityPrompt: null,
        });
        await saveSceneContinuity({
          userId: owner.user.id,
          projectId: owner.projectId,
          sceneIndex: 1,
          state: sceneState({ characters: [], props: [] }),
          continuityPrompt: null,
        });

        for (const entity of [
          { kind: "character" as const, entityId: "mara" },
          { kind: "environment" as const, entityId: "workshop" },
          { kind: "prop" as const, entityId: "lamp" },
        ]) {
          await storeReference({
            userId: owner.user.id,
            projectId: owner.projectId,
            ...entity,
          });
        }

        await withFlag(true, async () => {
          const context = await contextFor(owner);
          const stored = await getReferenceImages(owner.user.id, owner.projectId);

          // Characters, then the location, then the objects — the order
          // `buildContinuityPrompt` weights its clauses by, so a backend that caps
          // how many it accepts drops the least important.
          expect(
            referencesForScene({ context, sceneIndex: 0, stored }).map(
              (entry) => `${entry.kind}:${entry.entityId}`,
            ),
          ).toEqual(["character:mara", "environment:workshop", "prop:lamp"]);

          // Scene 1 must not be handed the character. Sending the whole cast to
          // every scene is how a two-hander becomes a crowd.
          expect(
            referencesForScene({ context, sceneIndex: 1, stored }).map(
              (entry) => entry.entityId,
            ),
          ).toEqual(["workshop"]);
        });
      });

      it("returns nothing for a scene with no recorded state", async () => {
        const { saveUserBible, getReferenceImages } = await import(
          "@/lib/continuity/store"
        );
        const { referencesForScene } = await import("@/lib/continuity/service");
        const owner = await project("reference-scene-nostate@tally.test");

        await saveUserBible({
          userId: owner.user.id,
          projectId: owner.projectId,
          bible: bible("Mara"),
          level: "character",
        });
        await insertScenes(owner.user.id, owner.projectId, 1);
        await storeReference({
          userId: owner.user.id,
          projectId: owner.projectId,
          kind: "character",
          entityId: "mara",
        });

        await withFlag(true, async () => {
          const context = await contextFor(owner);
          const stored = await getReferenceImages(owner.user.id, owner.projectId);

          // §25's shape: a scene the planner never wrote a state for commits to
          // nothing, so it constrains nothing.
          expect(referencesForScene({ context, sceneIndex: 0, stored })).toEqual([]);
        });
      });

      it("skips an entity the scene commits to but nobody has drawn", async () => {
        const { saveSceneContinuity, saveUserBible, getReferenceImages } =
          await import("@/lib/continuity/store");
        const { referencesForScene } = await import("@/lib/continuity/service");
        const owner = await project("reference-scene-partial@tally.test");

        await saveUserBible({
          userId: owner.user.id,
          projectId: owner.projectId,
          bible: bible("Mara"),
          level: "character",
        });
        await insertScenes(owner.user.id, owner.projectId, 1);
        await saveSceneContinuity({
          userId: owner.user.id,
          projectId: owner.projectId,
          sceneIndex: 0,
          state: sceneState(),
          continuityPrompt: null,
        });

        // Only the character exists. The location and the prop fall back to text.
        await storeReference({
          userId: owner.user.id,
          projectId: owner.projectId,
          kind: "character",
          entityId: "mara",
        });

        await withFlag(true, async () => {
          const context = await contextFor(owner);
          const stored = await getReferenceImages(owner.user.id, owner.projectId);

          expect(
            referencesForScene({ context, sceneIndex: 0, stored }).map(
              (entry) => entry.entityId,
            ),
          ).toEqual(["mara"]);
        });
      });

      it("returns nothing when the layer is inert", async () => {
        const { saveSceneContinuity, saveUserBible, getReferenceImages } =
          await import("@/lib/continuity/store");
        const owner = await project("reference-scene-inert@tally.test");

        await saveUserBible({
          userId: owner.user.id,
          projectId: owner.projectId,
          bible: bible("Mara"),
          level: "character",
        });
        await insertScenes(owner.user.id, owner.projectId, 1);
        await saveSceneContinuity({
          userId: owner.user.id,
          projectId: owner.projectId,
          sceneIndex: 0,
          state: sceneState(),
          continuityPrompt: null,
        });
        await storeReference({
          userId: owner.user.id,
          projectId: owner.projectId,
          kind: "character",
          entityId: "mara",
        });

        // Stills that exist, a state that names them, and the flag off. §25: a
        // project must behave exactly as it did before this layer existed.
        const stored = await withFlag(true, () =>
          getReferenceImages(owner.user.id, owner.projectId),
        );
        expect(stored).toHaveLength(1);

        await withFlag(false, async () => {
          const { referencesForScene } = await import("@/lib/continuity/service");
          const context = await contextFor(owner);
          expect(context.active).toBe(false);
          expect(referencesForScene({ context, sceneIndex: 0, stored })).toEqual([]);
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // Character voices — the cases that need real rows
  // -------------------------------------------------------------------------

  /**
   * Voice continuity end to end, against Postgres.
   *
   * `src/lib/continuity/voice.test.ts` covers the resolver, which is pure. What it
   * cannot cover is everything that only exists once there are rows: that a canonical
   * voice survives a round trip through `story_bibles.document` intact, that the read
   * is owner-scoped, that two of one owner's projects do not share a cast, and that a
   * project with no bible at all still reaches the single-voice path it has always
   * used.
   *
   * No provider is reached anywhere in this block, and that is a property rather than
   * a promise: an identity is resolved from stored data, so there is no catalogue
   * lookup and no validation probe to make. The last case here asserts it.
   */
  describe("character voices", () => {
    /**
     * Two distinct placeholder voice ids.
     *
     * Distinct so an assertion that one appeared where the other belonged says
     * something, and obviously placeholders so neither resembles a real catalogue
     * entry. Neither is ever sent anywhere.
     */
    const MARA_VOICE = "voice-integration-placeholder-mara";
    const BEN_VOICE = "voice-integration-placeholder-ben";

    /**
     * `bible()`'s cast, voiced, plus a second character.
     *
     * Mara always has a canonical voice; Ben only when asked for one. The asymmetry
     * is the point: a fixture where everybody is voiced cannot catch a fallback that
     * reaches for the nearest available id, which is the most tempting wrong
     * implementation of this feature.
     */
    function voicedBible(args: { ben?: string | null } = {}): StoryBible {
      const base = bible("Mara");

      return parseStoryBible({
        ...base,
        characters: [
          {
            ...base.characters[0],
            voice: {
              provider: "integration-voice-backend",
              providerVoiceId: MARA_VOICE,
              name: "Mara's voice",
              language: "en-GB",
              accent: "west country",
              characteristics: ["gravelly"],
              speakingStyle: "measured and dry",
              settings: { stability: 0.8, similarity: 0.9 },
            },
          },
          {
            id: "ben",
            name: "Ben",
            role: "the apprentice",
            appearance: ["ginger hair"],
            wardrobe: ["blue overalls"],
            ...(args.ben
              ? { voice: { providerVoiceId: args.ben, name: "Ben's voice" } }
              : {}),
          },
        ],
      });
    }

    /**
     * A project with a voiced bible, scene rows, and one lead per scene.
     *
     * Written through `saveUserBible` rather than `saveBible`, because a canonical
     * voice is an operator decision: it arrives through the continuity route, and
     * that route writes this way. Same path as production, so these cases exercise
     * how a voice actually gets stored rather than a shortcut around it.
     */
    async function voicedProject(
      email: string,
      args: { ben?: string | null; leads?: readonly string[] } = {},
    ) {
      const { saveSceneContinuity, saveUserBible } = await import(
        "@/lib/continuity/store"
      );
      const owner = await project(email);
      const leads = args.leads ?? ["mara", "ben", "mara"];

      await saveUserBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: voicedBible({ ben: args.ben ?? null }),
        level: "character",
      });
      await insertScenes(owner.user.id, owner.projectId, leads.length);

      for (const [sceneIndex, lead] of leads.entries()) {
        await saveSceneContinuity({
          userId: owner.user.id,
          projectId: owner.projectId,
          sceneIndex,
          // No props: a scene led by the apprentice does not need the lamp, and the
          // prop check is not what any of these cases are about.
          state: sceneState({ characters: [lead], props: [] }),
          continuityPrompt: null,
        });
      }

      return owner;
    }

    async function voiceContext(owner: {
      user: TestUser;
      channelId: string;
      projectId: string;
    }) {
      const { loadContext } = await import("@/lib/continuity/service");
      return loadContext(
        owner.user.id,
        continuityProject(owner.projectId, owner.channelId),
      );
    }

    /**
     * The prompts the pipeline would actually have sent, from the real builder.
     *
     * Hand-written prompts would make the visual half of the score depend on guesses
     * about which constraints the validator looks for. Built this way, the visual
     * components are satisfied and any score movement below belongs to the voice
     * check — which is what the score cases are measuring.
     */
    async function visualsFor(
      context: Awaited<ReturnType<typeof voiceContext>>,
      count: number,
    ) {
      const { continuityContextFor } = await import("@/lib/continuity/service");

      return Array.from({ length: count }, (_, sceneIndex) => {
        const shot = SHOTS[sceneIndex] ?? `An unrelated subject, take ${sceneIndex}`;
        return {
          sceneIndex,
          visualPrompt: continuityContextFor({ context, sceneIndex, visualPrompt: shot })
            .prompt,
          searchTerms: [] as string[],
          // The direction alone, for repetition detection: the continuity block is
          // the same on every scene sharing a cast, by design.
          shotPrompt: shot,
        };
      });
    }

    /** What the voiceover stage records for a scene it narrated. */
    function record(sceneIndex: number, providerVoiceId: string) {
      return {
        sceneIndex,
        providerVoiceId,
        characterId: "mara",
        provider: "mock",
        source: "character" as const,
      };
    }

    it("stores a whole canonical voice in the bible document and reads it back", async () => {
      // Every field an identity carries survives a real round trip through jsonb. A
      // schema that dropped `accent` or `settings` on the way to the column would
      // leave the identity half-specified in production while every in-memory test
      // still passed.
      const { getBible } = await import("@/lib/continuity/store");
      const owner = await voicedProject("voice-persist@tally.test");

      const stored = await getBible(owner.user.id, owner.projectId);
      const voice = stored?.bible.characters.find((c) => c.id === "mara")?.voice;

      expect(voice?.providerVoiceId).toBe(MARA_VOICE);
      expect(voice?.provider).toBe("integration-voice-backend");
      expect(voice?.name).toBe("Mara's voice");
      expect(voice?.language).toBe("en-GB");
      expect(voice?.accent).toBe("west country");
      expect(voice?.characteristics).toEqual(["gravelly"]);
      expect(voice?.speakingStyle).toBe("measured and dry");
      expect(voice?.settings.stability).toBe(0.8);
      expect(voice?.settings.similarity).toBe(0.9);
      // No migration was needed and none was written: this is a document column, and
      // the schema version is unchanged, so every bible already stored still parses.
      expect(stored?.bible.schemaVersion).toBe(1);
    });

    it("uses the same voice for the same character in every scene they lead", async () => {
      const { sceneVoicesFor } = await import("@/lib/continuity/service");
      const owner = await voicedProject("voice-same@tally.test");

      await withFlag(true, async () => {
        const voices = sceneVoicesFor({
          context: await voiceContext(owner),
          sceneIndices: [0, 1, 2],
        });

        expect(voices.get(0)?.providerVoiceId).toBe(MARA_VOICE);
        expect(voices.get(2)?.providerVoiceId).toBe(MARA_VOICE);
        expect(voices.get(0)?.characterId).toBe("mara");
        // Ben has no canonical voice here, so no constraint is produced for his scene
        // and the project's voice narrates it — the behaviour this project had before.
        expect(voices.has(1)).toBe(false);
      });
    });

    it("gives different characters their own voices", async () => {
      const { sceneVoicesFor } = await import("@/lib/continuity/service");
      const owner = await voicedProject("voice-different@tally.test", {
        ben: BEN_VOICE,
      });

      await withFlag(true, async () => {
        const voices = sceneVoicesFor({
          context: await voiceContext(owner),
          sceneIndices: [0, 1, 2],
        });

        expect(voices.get(0)?.providerVoiceId).toBe(MARA_VOICE);
        expect(voices.get(1)?.providerVoiceId).toBe(BEN_VOICE);
        // The failure worth catching is not "wrong" but "somebody else's".
        expect(voices.get(1)?.providerVoiceId).not.toBe(
          voices.get(0)?.providerVoiceId,
        );
      });
    });

    it("resolves a regenerated scene to the voice its earlier scenes used", async () => {
      /**
       * The mandate's scene-3 case, against real rows.
       *
       * `countRegeneration` writes the row a regeneration actually writes, and the
       * assignment is then resolved again from a freshly loaded context. It matches
       * because the assignment is a pure function of the stored bible: nothing is
       * cached, so there is nothing to go stale, and no code had to remember to
       * preserve anything.
       */
      const { countRegeneration } = await import("@/lib/continuity/store");
      const { sceneVoicesFor } = await import("@/lib/continuity/service");
      const owner = await voicedProject("voice-regenerate@tally.test");

      await withFlag(true, async () => {
        const before = sceneVoicesFor({
          context: await voiceContext(owner),
          sceneIndices: [0, 2],
        });

        expect(
          await countRegeneration({
            userId: owner.user.id,
            projectId: owner.projectId,
            sceneIndex: 2,
          }),
        ).toBe(1);

        const after = sceneVoicesFor({
          context: await voiceContext(owner),
          sceneIndices: [2],
        });

        expect(after.get(2)?.providerVoiceId).toBe(MARA_VOICE);
        expect(after.get(2)?.providerVoiceId).toBe(before.get(0)?.providerVoiceId);
      });
    });

    it("keeps the established voice for a character who returns after another scene", async () => {
      // Scene-state inheritance: Mara is established in scene 0 and returns in 2 and
      // 3, with Ben's scene in between. The graph decides which scene a *visual*
      // reference comes from; the voice comes from the bible, so it is the same in all
      // three without anything being threaded from one scene to the next.
      const { sceneVoicesFor } = await import("@/lib/continuity/service");
      const owner = await voicedProject("voice-inherit@tally.test", {
        leads: ["mara", "ben", "mara", "mara"],
      });

      await withFlag(true, async () => {
        const context = await voiceContext(owner);
        const voices = sceneVoicesFor({ context, sceneIndices: [0, 1, 2, 3] });

        expect(context.graph.establishedBy.get("character:mara")).toBe(0);
        expect(voices.get(2)?.providerVoiceId).toBe(MARA_VOICE);
        expect(voices.get(3)?.providerVoiceId).toBe(MARA_VOICE);
      });
    });

    it("produces no voice constraint for a project whose cast has no voices", async () => {
      // §25: the ordinary project, and the one that must be left alone. `bible()` has
      // a cast and no voices, which is every bible written before this existed.
      const { saveUserBible } = await import("@/lib/continuity/store");
      const { sceneVoicesFor } = await import("@/lib/continuity/service");
      const owner = await project("voice-legacy@tally.test");

      await saveUserBible({
        userId: owner.user.id,
        projectId: owner.projectId,
        bible: bible("Mara"),
        level: "character",
      });
      await insertScenes(owner.user.id, owner.projectId, 2);

      await withFlag(true, async () => {
        const context = await voiceContext(owner);
        // Active, and still silent about voices: the layer is doing its other work.
        expect(context.active).toBe(true);
        expect(sceneVoicesFor({ context, sceneIndices: [0, 1] }).size).toBe(0);
      });
    });

    it("produces no voice constraint for a project with no bible at all", async () => {
      // §25's harder case: a project that never had a continuity document. The
      // voiceover stage must reach its single-voice path rather than throwing.
      const { sceneVoicesFor } = await import("@/lib/continuity/service");
      const owner = await project("voice-no-bible@tally.test");
      await insertScenes(owner.user.id, owner.projectId, 2);

      await withFlag(true, async () => {
        const context = await voiceContext(owner);
        expect(context.active).toBe(false);
        expect(sceneVoicesFor({ context, sceneIndices: [0, 1] }).size).toBe(0);
      });
    });

    it("produces no voice constraint while the layer is switched off", async () => {
      const { sceneVoicesFor } = await import("@/lib/continuity/service");
      const owner = await voicedProject("voice-inert@tally.test");

      await withFlag(false, async () => {
        const context = await voiceContext(owner);
        expect(context.active).toBe(false);
        // The bible still holds the voice; the layer simply asserts nothing while off,
        // so the pipeline narrates exactly as it did before this existed.
        expect(sceneVoicesFor({ context, sceneIndices: [0, 1, 2] }).size).toBe(0);
      });
    });

    it("does not resolve one tenant's character voices for another", async () => {
      /**
       * §20 for the voice half.
       *
       * Tenant isolation is a property of a SQL predicate, and a missing `userId`
       * type-checks perfectly. A canonical voice rides inside the bible document, so
       * it comes back through the same owner-scoped read — which is exactly why that
       * read has to be confirmed for a new field rather than assumed.
       */
      const { getBible } = await import("@/lib/continuity/store");
      const { loadContext, sceneVoicesFor } = await import(
        "@/lib/continuity/service"
      );
      const owner = await voicedProject("voice-owner@tally.test");
      const other = await createUser({ email: "voice-other@tally.test" });

      expect(await getBible(other.id, owner.projectId)).toBeNull();

      await withFlag(true, async () => {
        // The intruder holds a valid project id and asks with their own user id.
        const stolen = await loadContext(
          other.id,
          continuityProject(owner.projectId, owner.channelId),
        );

        const voices = sceneVoicesFor({ context: stolen, sceneIndices: [0, 1, 2] });
        expect(voices.size).toBe(0);
        expect(JSON.stringify([...voices.values()])).not.toContain(MARA_VOICE);
      });
    });

    it("keeps two of one owner's projects on their own voices", async () => {
      // Project isolation, not only tenant isolation: one owner with two projects must
      // not have the first project's casting decisions voicing the second's scenes.
      const { saveSceneContinuity, saveUserBible } = await import(
        "@/lib/continuity/store"
      );
      const { sceneVoicesFor } = await import("@/lib/continuity/service");
      const { createProject } = await import("@/lib/projects/service");
      const { db } = await import("@/lib/db");
      const { projects } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      const owner = await voicedProject("voice-two-projects@tally.test");

      const second = await createProject({
        userId: owner.user.id,
        channelId: owner.channelId,
        title: "A second project",
        maxVideosPerMonth: null,
      });
      await db
        .update(projects)
        .set({ generationMode: "AI_VIDEO" })
        .where(eq(projects.id, second.id));

      // The same cast ids, and a voice on the character who leads this project's
      // first scene. Sharing a document would show up as Mara's voice below.
      await saveUserBible({
        userId: owner.user.id,
        projectId: second.id,
        bible: voicedBible({ ben: BEN_VOICE }),
        level: "character",
      });
      await insertScenes(owner.user.id, second.id, 1);
      await saveSceneContinuity({
        userId: owner.user.id,
        projectId: second.id,
        sceneIndex: 0,
        state: sceneState({ characters: ["ben"], props: [] }),
        continuityPrompt: null,
      });

      await withFlag(true, async () => {
        const first = sceneVoicesFor({
          context: await voiceContext(owner),
          sceneIndices: [0],
        });
        const other = sceneVoicesFor({
          context: await voiceContext({ ...owner, projectId: second.id }),
          sceneIndices: [0],
        });

        expect(first.get(0)?.providerVoiceId).toBe(MARA_VOICE);
        expect(other.get(0)?.providerVoiceId).toBe(BEN_VOICE);
      });
    });

    it("records a wrong voice as a structured finding without billing a regeneration", async () => {
      /**
       * The check end to end, and the cost guarantee inside it.
       *
       * A recorded voice that disagrees with the bible produces `fail` findings in the
       * *existing* `quality_checks` row — no second table and no second scoring
       * system. And the scene stays out of the regeneration set:
       * `executeSceneRegeneration` regenerates a scene's **visual**, and redrawing a
       * shot cannot change which voice narrated it, so an automatic regeneration here
       * would bill for work that cannot possibly help.
       */
      const { checkContinuity, scenesToRegenerate } = await import(
        "@/lib/continuity/service"
      );
      const { latestContinuityCheck } = await import("@/lib/continuity/store");
      const owner = await voicedProject("voice-finding@tally.test", {
        leads: ["mara", "mara", "mara"],
      });

      await withFlag(true, async () => {
        const context = await voiceContext(owner);

        const { report } = await checkContinuity({
          userId: owner.user.id,
          project: continuityProject(owner.projectId, owner.channelId),
          visuals: await visualsFor(context, 3),
          voices: [
            record(0, MARA_VOICE),
            record(1, MARA_VOICE),
            // The wrong voice, recorded as the one actually used. This is the whole
            // reason the check reads back what was sent instead of recomputing it:
            // recomputing would compare the bible with itself and always pass.
            record(2, BEN_VOICE),
          ],
        });

        const codes = (report?.issues ?? []).map((issue) => issue.code);
        expect(codes).toContain("continuity.voice.assignment_mismatch");
        expect(codes).toContain("continuity.voice.drift");
        // Nothing an operator reads contains a voice id: the findings name the scene
        // and the character, not an opaque vendor token.
        expect(JSON.stringify(report?.issues ?? [])).not.toContain(BEN_VOICE);

        // Recorded through the existing table in the existing shape, so the studio
        // screen and the read model surface it with no change.
        const stored = await latestContinuityCheck(owner.user.id, owner.projectId);
        expect(
          stored?.findings.some(
            (finding) => finding.code === "continuity.voice.assignment_mismatch",
          ),
        ).toBe(true);

        expect(report?.affectedScenes ?? []).not.toContain(2);
        expect(
          await scenesToRegenerate({
            userId: owner.user.id,
            projectId: owner.projectId,
            context,
            report,
          }),
        ).toEqual([]);
      });
    });

    it("scores a correctly voiced project exactly what the same project scores unvoiced", async () => {
      // §25 as an equality against real rows: assigning canonical voices and narrating
      // every scene in them must not cost a project a single point. The same visuals
      // are checked twice, so the only difference between the two runs is the voices.
      const { checkContinuity } = await import("@/lib/continuity/service");
      const { saveUserBible } = await import("@/lib/continuity/store");
      const owner = await voicedProject("voice-score@tally.test", {
        leads: ["mara", "mara"],
      });

      await withFlag(true, async () => {
        const visuals = await visualsFor(await voiceContext(owner), 2);

        const voiced = await checkContinuity({
          userId: owner.user.id,
          project: continuityProject(owner.projectId, owner.channelId),
          visuals,
          voices: [record(0, MARA_VOICE), record(1, MARA_VOICE)],
        });

        // The same project with the voices taken back out of the bible.
        await saveUserBible({
          userId: owner.user.id,
          projectId: owner.projectId,
          bible: bible("Mara"),
          level: "character",
        });
        const unvoiced = await checkContinuity({
          userId: owner.user.id,
          project: continuityProject(owner.projectId, owner.channelId),
          visuals,
        });

        expect(voiced.report?.score).toBe(unvoiced.report?.score);
        expect(voiced.report?.components.characterConsistency).toBe(
          unvoiced.report?.components.characterConsistency,
        );
      });
    });

    it("resolves every scene's voice without touching a provider", async () => {
      /**
       * §10's cost rule, asserted rather than asserted-about.
       *
       * `synthesize` is the only function in the voice adapter that reaches a
       * provider, and it is spied on for the duration. Resolving an identity is a
       * lookup over stored data — no catalogue call, no existence probe — so the spy
       * must never be reached, and a later change that helpfully "checks the voice is
       * still valid" fails here rather than on somebody's provider bill.
       */
      const voiceProvider = await import("@/lib/providers/voice");
      const spy = vi.spyOn(voiceProvider, "synthesize");
      const { sceneVoicesFor } = await import("@/lib/continuity/service");
      const owner = await voicedProject("voice-no-calls@tally.test", {
        ben: BEN_VOICE,
      });

      try {
        await withFlag(true, async () => {
          const voices = sceneVoicesFor({
            context: await voiceContext(owner),
            sceneIndices: [0, 1, 2],
          });
          expect(voices.size).toBe(3);
        });
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });
});

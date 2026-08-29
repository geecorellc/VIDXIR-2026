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
        for (const providers of ["mock", "fal", "veo,runway"]) {
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
        for (const providers of ["mock", "fal", "veo"]) {
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

      // Byte-identical across all three. The provider chooses how to render the
      // request; it does not change what the request says.
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
});

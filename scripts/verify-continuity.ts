/**
 * Prove the continuity layer's two pipeline stages really run, in a real Node
 * process, against real infrastructure (§24, §32).
 *
 * The vitest suites cover the arithmetic (183 unit tests over the score, the
 * repetition bands, the graph, the prompt) and the persistence (31 integration
 * tests over tenant isolation, the feature flag and provider independence). What
 * neither can cover is the failure that has bitten this project twice:
 * `vitest.config.ts` aliases `server-only` away, so a module graph that could never
 * boot passes green — Phase 5 shipped 541 tests over a worker that could not start.
 * `video-continuity-check` and `video-scene-regenerate` are new entries in the real
 * registry, reached through the real worker harness, and nothing under vitest proves
 * that registry can be loaded by the process that consumes the queue.
 *
 * So every check below runs with no aliases, against the real Postgres, Redis and
 * MinIO, through the shipped `HANDLERS` map and a real BullMQ `Worker`.
 *
 * What it verifies:
 *
 *   1. the environment loads, and the layer's flag plus mock providers are on
 *   2. a fixture tenant, an AI_VIDEO project walked to VIDEO_READY, four scenes
 *   3. a seeded bible resolves to `character` level through the real gate chain
 *   4. the real prompt builder produces a block carrying the wardrobe verbatim, and
 *      `recordScenePrompt` stores it for the one scene that "received" it
 *   5. both stages are registered on the pipeline queue, and the check is enqueued
 *      through the public `enqueue()`
 *   6. a real Worker runs the check to `succeeded`, scoring the video a `fail`
 *   7. the verdict lands in the existing `quality_checks` table, and the read model
 *      parses the score back out of it
 *   8. the stage enqueued a regeneration for exactly the failed scenes — 1, 2 and 3,
 *      not scene 0 — and each ran to `succeeded` at attempt 1
 *   9. each regeneration produced a new asset from the resolved provider, repointed
 *      its scene, and incremented that scene's counter; scene 0 was left alone
 *  10. the project never left VIDEO_READY: continuity cannot fail a paid render
 *  11. a re-check reads the constraints the redraw actually carried, so the three
 *      repaired scenes now pass and the score rises — and nothing is re-billed
 *  12. a further re-run, with no regeneration between, scores identically (§12's
 *      determinism, end to end, on inputs that genuinely did not move)
 *  13. the regeneration ceiling refuses a further attempt and spends nothing
 *  14. another tenant can neither read the bible, the states and the check, nor
 *      overwrite them through the upsert
 *  15. the reference-still stage draws one image per bible entity with visual facts
 *  16. those stills are real landscape PNGs under the `reference/` prefix, found again
 *      by the reader, not re-drawn by a second run, and selected per scene by the
 *      entities that scene commits to
 *  17. with `TALLY_CONTINUITY_ENGINE_ENABLED=false` the stage is a no-op that records
 *      nothing
 *  18. every provider call this run made was the mock — asserted from `api_usage`
 *
 * ## Cost and safety
 *
 * `TALLY_USE_MOCK_PROVIDERS=true` is set at module scope, before anything reads the
 * environment, so `videoGenProviderIds()` resolves to `["mock"]` and every
 * regeneration is a solid PNG synthesised in-process. Step 1 asserts that rather
 * than assuming it, and step 15 audits `api_usage` afterwards to prove no other
 * provider was reached. No request is made to any of the four AI video backends, to
 * Runway or to Bedrock;
 * nothing is published; no Stripe call happens; there is no encode, because the
 * RENDER stage is never enqueued.
 *
 * **The planner is deliberately not exercised.** `planContinuity` reaches a model
 * through `generateJson`, and `lib/providers/ai` has no mock branch — the AI
 * provider is always the real one. Calling it here would be a real, billable
 * request, which §24 forbids, so the bible and scene states are seeded directly
 * through the store, exactly as the pipeline stores the planner's normalised output.
 * `normalise` — the part of the planner that absorbs a model's mistakes — is a pure
 * function with 21 dedicated unit tests. What this script is for is the wiring.
 *
 * Two paths are also deliberately left alone. A regeneration for a scene index that
 * does not exist throws `NotFoundError`, and `runStage` transitions the project to
 * FAILED on any non-retryable throw — so provoking it here would wreck the fixture
 * the later steps read. That guard is covered in `guards.test.ts`, which asserts the
 * typed error and that it is not retried. And nothing here renders: a regeneration
 * replaces a scene's asset, and the user re-exports from the editor when they want
 * it in an MP4.
 *
 * Everything it writes belongs to a fixture tenant, reused across runs and cleaned
 * at the start of each. No real project is read or touched.
 *
 *   npx tsx scripts/verify-continuity.ts
 *
 * Its own queue prefix, so a run cannot consume a developer's jobs or leave messages
 * for one. Exits non-zero on the first failure.
 */
import "@/lib/load-env";
// Type-only, so it does not defeat the dynamic imports below: every runtime import in
// this file is deferred until after the environment overrides, because `lib/env`
// snapshots the environment on first read.
import type { NarrativeBeat } from "@/lib/continuity/scene-state";

const PREFIX = "tally-verify-continuity";
process.env["QUEUE_PREFIX"] = PREFIX;

/**
 * Both flags, set before anything can read them.
 *
 * `.env.local` has `TALLY_USE_MOCK_PROVIDERS=false` and the continuity flag unset,
 * which is the right default for a developer's web app and the wrong one for this
 * script. `process.loadEnvFile` runs from the hoisted `load-env` import above and
 * does not overwrite variables already present — but it ran *first*, so these
 * assignments are what win, and no `env()` call has happened yet.
 */
process.env["TALLY_USE_MOCK_PROVIDERS"] = "true";
process.env["TALLY_CONTINUITY_ENGINE_ENABLED"] = "true";

/** Generous: four mock generations plus a check take seconds, not minutes. */
const JOB_TIMEOUT_MS = 5 * 60_000;

const FIXTURE_EMAIL = "continuity-verify@tally.local";
const OTHER_EMAIL = "continuity-verify-other@tally.local";

/** The model the fixture project is built with. Free, local, and honest about it. */
const MOCK_MODEL = "mock/placeholder";

let step = 0;

function ok(message: string): void {
  step += 1;
  console.log(`  ${step}. OK  ${message}`);
}

function detail(message: string): void {
  console.log(`        ${message}`);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * The story bible the whole run is scored against.
 *
 * Named entities with real distinguishing facts, because the character check looks
 * for the name *plus* one appearance fact in each prompt — a bible of placeholders
 * would pass or fail for reasons that have nothing to do with the layer.
 */
const BIBLE_DOCUMENT = {
  premise: "A lamp restorer learns to ask for help.",
  structure: "setup → attempt → resolution",
  tone: "warm",
  characters: [
    {
      id: "mara",
      name: "Mara",
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
};

/**
 * Four scenes with genuinely distinct subjects.
 *
 * Deliberately not a numbered template: the repetition comparator drops tokens
 * shorter than three characters, so "shot 1" and "shot 2" are the same string to it
 * and every scene would read as a duplicate of the first — which would spend the
 * regeneration budget on a fixture artefact.
 *
 * None of prompts 1–3 contains any bible fact, which is the defect the run is built
 * around: scene 0 was generated with its continuity block and the other three were
 * not, so the validator should find exactly those three at fault.
 */
const SCENES: ReadonlyArray<{
  label: string;
  narration: string;
  visualPrompt: string;
  beat: NarrativeBeat;
  changes: string[];
}> = [
  {
    label: "Setup",
    narration: "The workshop opens before the street does.",
    visualPrompt: "A tall figure sorting screws into a shallow tray",
    beat: "setup",
    changes: [],
  },
  {
    label: "Attempt",
    narration: "Rain arrives, and with it the first real problem.",
    visualPrompt: "Rain against a high window above the benches",
    beat: "development",
    changes: ["the lamp is dented"],
  },
  {
    label: "Attempt",
    narration: "Tea goes cold beside the manuals nobody reads.",
    visualPrompt: "A kettle steaming beside a stack of manuals",
    beat: "development",
    changes: [],
  },
  {
    label: "Resolution",
    narration: "Counted in chalk, the days add up to a finished thing.",
    visualPrompt: "Chalk marks counting the days on a doorframe",
    beat: "resolution",
    changes: [],
  },
];

async function main(): Promise<void> {
  console.log(`\ncontinuity layer verification (queue prefix ${PREFIX})\n`);

  // ---- 1. environment, flags and the resolved provider --------------------

  const { env, continuityEnabled, usingMockProviders, resetEnvCache } = await import(
    "@/lib/env"
  );
  const { videoGenProviderIds, resolveModel } = await import(
    "@/lib/providers/video-gen"
  );

  const e = env();
  assert(
    e.NODE_ENV !== "production",
    "refusing to run against NODE_ENV=production: this script writes fixture rows.",
  );
  assert(continuityEnabled(), "TALLY_CONTINUITY_ENGINE_ENABLED did not take effect.");
  assert(
    usingMockProviders(),
    "mock providers are off — a regeneration would reach a paid generation API.",
  );

  const providers = videoGenProviderIds();
  assert(
    providers.length === 1 && providers[0] === "mock",
    `expected the mock provider alone, got [${providers.join(", ")}]. A real ` +
      "provider here would bill for every regeneration below.",
  );
  // Resolves rather than assumed: an unavailable model would fail the stage at
  // `generationPlanFor` and the failure would read as a continuity bug.
  const resolved = resolveModel(MOCK_MODEL);
  assert(
    resolved.provider === "mock",
    `${MOCK_MODEL} resolved to provider ${resolved.provider}, not mock.`,
  );
  ok(
    `environment loaded — continuity on, providers [${providers.join(", ")}], ` +
      `model ${resolved.model.id}`,
  );

  const { db, closeDb } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { and, asc, eq, inArray, ne } = await import("drizzle-orm");

  // ---- 2. a fixture tenant and a project at VIDEO_READY -------------------

  const { transition, getProject, createProject } = await import(
    "@/lib/projects/service"
  );

  const userId = await fixtureUser({ db, schema, eq }, FIXTURE_EMAIL, "studio");
  const otherUserId = await fixtureUser({ db, schema, eq }, OTHER_EMAIL, "studio");

  const channelRows = await db
    .insert(schema.channels)
    .values({
      userId,
      youtubeChannelId: "UCcontinuityverify00000",
      title: "Continuity Verification",
    })
    .returning({ id: schema.channels.id });
  const channelId = channelRows[0]?.id;
  assert(channelId !== undefined, "could not create the fixture channel");

  /**
   * The settings the level is derived from.
   *
   * `storytelling` is what resolves to `character`; without it the plan would be
   * `style`, every character assertion below would be checking a level the pipeline
   * never selected, and the run would pass while proving nothing.
   */
  await db.insert(schema.channelSettings).values({
    channelId: channelId!,
    userId,
    niche: "animated stories",
    contentStyle: "storytelling",
    targetAudience: "adults who like short fiction",
  });

  const created = await createProject({
    userId,
    channelId: channelId!,
    title: "[verify] continuity",
    maxVideosPerMonth: null,
  });
  const projectId = created.id;

  await db
    .update(schema.projects)
    .set({ generationMode: "AI_VIDEO", generationModel: MOCK_MODEL })
    .where(eq(schema.projects.id, projectId));

  // Walked through the real state machine rather than declared ready by fiat: the
  // continuity stages run after a render, and a project that reached VIDEO_READY by
  // an UPDATE would not prove the transition they run behind is legal.
  for (const status of [
    "SCRIPT_GENERATING",
    "SCRIPT_READY",
    "ASSETS_GENERATING",
    "ASSETS_READY",
    "RENDERING",
    "VIDEO_READY",
  ] as const) {
    await transition(userId, projectId, status);
  }

  await db.insert(schema.scenes).values(
    SCENES.map((scene, index) => ({
      projectId,
      userId,
      index,
      label: scene.label,
      narration: scene.narration,
      visualPrompt: scene.visualPrompt,
      searchTerms: [] as string[],
    })),
  );

  /**
   * A placeholder visual per scene, so "the regeneration repointed the scene" is a
   * change from one asset to another rather than from null to something.
   *
   * `provider: "fixture"` keeps these distinguishable from the assets the mock
   * provider writes later, which step 9 counts.
   */
  const seededAssets = new Map<number, string>();
  for (const [index] of SCENES.entries()) {
    const rows = await db
      .insert(schema.assets)
      .values({
        userId,
        projectId,
        kind: "generated_image",
        mimeType: "image/png",
        provider: "fixture",
        meta: { sceneIndex: index },
      })
      .returning({ id: schema.assets.id });
    const assetId = rows[0]?.id;
    assert(assetId !== undefined, `could not seed a visual for scene ${index}`);
    seededAssets.set(index, assetId!);
    await db
      .update(schema.scenes)
      .set({ visualAssetId: assetId! })
      .where(and(eq(schema.scenes.projectId, projectId), eq(schema.scenes.index, index)));
  }

  const project = await getProject(userId, projectId);
  assert(project.status === "VIDEO_READY", `project is ${project.status}`);
  ok(
    `fixture tenant ready — project ${projectId.slice(0, 8)} at VIDEO_READY, ` +
      `${SCENES.length} scenes, mode ${project.generationMode}/${project.generationModel}`,
  );

  // ---- 3. the bible resolves to `character` through the real gate chain ----

  const { parseStoryBible } = await import("@/lib/continuity/bible");
  const { parseSceneState } = await import("@/lib/continuity/scene-state");
  const store = await import("@/lib/continuity/store");
  const continuity = await import("@/lib/continuity/service");

  const bible = parseStoryBible(BIBLE_DOCUMENT);

  const wrote = await store.saveBible({
    userId,
    projectId,
    bible,
    level: "character",
    // Honest provenance: seeded by this script, not drafted by a model.
    generatedBy: "verify-continuity-seed",
  });
  assert(wrote, "saveBible reported it preserved a user-edited bible; none exists");

  for (const [index, scene] of SCENES.entries()) {
    await store.saveSceneContinuity({
      userId,
      projectId,
      sceneIndex: index,
      state: parseSceneState({
        characters: ["mara"],
        environment: "workshop",
        props: ["lamp"],
        beat: scene.beat,
        changes: scene.changes,
        echoesSceneIndex: null,
      }),
      continuityPrompt: null,
    });
  }

  const continuityProject = {
    projectId,
    channelId: channelId!,
    generationMode: "AI_VIDEO" as const,
    tier: "studio" as const,
  };

  const context = await continuity.loadContext(userId, continuityProject);
  assert(context.active, `continuity is inert: ${context.plan.reason}`);
  assert(
    context.plan.level === "character",
    `expected level character, got ${context.plan.level} (${context.plan.reason})`,
  );
  assert(
    context.states.length === SCENES.length,
    `${context.states.length} scene states stored, expected ${SCENES.length}`,
  );
  assert(
    context.graph.scenes.length === SCENES.length,
    "the scene state graph does not cover every scene",
  );
  ok(
    `level ${context.plan.level} resolved from the channel's settings — ` +
      `${context.states.length} states, ${context.graph.edges.length} graph edges, ` +
      `thresholds pass ${context.thresholds.pass} / fail ${context.thresholds.fail} / ` +
      `max regenerations ${context.thresholds.maxRegenerations}`,
  );

  // ---- 4. the block, built by the real prompt builder --------------------

  /**
   * Scene 0 records its block; scenes 1–3 record none.
   *
   * That is what makes the check below find something. It is also the exact defect
   * the layer exists to catch: a bible full of commitments and a request that did
   * not carry them. Recorded through `recordScenePrompt`, the same call
   * `executeVisuals` makes, so the stored shape is the shipped one.
   */
  const blocks = new Map<number, string>();
  for (const [index, scene] of SCENES.entries()) {
    const built = continuity.continuityContextFor({
      context,
      sceneIndex: index,
      visualPrompt: scene.visualPrompt,
    });
    blocks.set(index, built.block);

    await continuity.recordScenePrompt({
      userId,
      projectId,
      sceneIndex: index,
      state: context.states.find((s) => s.sceneIndex === index) ?? null,
      block: index === 0 ? built.block : "",
    });
  }

  const firstBlock = blocks.get(0) ?? "";
  for (const fact of [
    "Mara",
    "brown canvas coat",
    "The Workshop",
    "hand-drawn animation",
    "Brass Lamp",
  ]) {
    assert(
      firstBlock.includes(fact),
      `the continuity block does not carry "${fact}" — it reads: ${firstBlock}`,
    );
  }
  assert(
    !/keep .*consistent/i.test(firstBlock),
    "the block contains a generic consistency instruction rather than facts (§7)",
  );

  const storedPrompts = await db
    .select({ index: schema.scenes.index, prompt: schema.scenes.continuityPrompt })
    .from(schema.scenes)
    .where(eq(schema.scenes.projectId, projectId))
    .orderBy(asc(schema.scenes.index));
  assert(
    storedPrompts.filter((row) => row.prompt !== null).length === 1,
    "expected exactly one scene to have a stored continuity block",
  );
  assert(
    storedPrompts[0]?.prompt !== null,
    "scene 0's continuity block was not stored",
  );
  ok(
    `the prompt builder produced a ${firstBlock.length}-character block of facts, ` +
      "stored for scene 0 only — scenes 1-3 stand in for a request that dropped it",
  );

  // ---- 5. both stages registered, and the check enqueued ------------------

  const { CONTINUITY_JOB, REFERENCE_IMAGES_JOB, SCENE_REGEN_JOB } = await import(
    "@/lib/video/service"
  );
  const { Worker } = await import("bullmq");
  const { workerConnection, closeRedis } = await import("@/lib/queue/redis");
  const { workerQueueOptions, getQueue, closeQueues } = await import(
    "@/lib/queue/queues"
  );
  const { runJob } = await import("@/worker/runner");
  const { HANDLERS } = await import("@/worker/registry");
  const { enqueue, getJob } = await import("@/lib/queue/jobs");

  // The shipped registry, not a stub: a name that never reached `videoHandlers`
  // would be registered under the key `undefined` and vanish silently.
  const pipelineHandlers = HANDLERS["pipeline"] ?? {};
  for (const name of [CONTINUITY_JOB, REFERENCE_IMAGES_JOB, SCENE_REGEN_JOB]) {
    assert(
      name in pipelineHandlers,
      `${name} has no handler registered on the pipeline queue`,
    );
  }

  const queueContinuityCheck = async (): Promise<string> => {
    const job = await enqueue({
      queue: "pipeline",
      name: CONTINUITY_JOB,
      userId,
      channelId: channelId!,
      projectId,
      stage: "QUALITY_CHECK",
      payload: { projectId, tier: "studio" },
      traceId: "verify-continuity",
      statusMessage: "Queued",
    });
    return job.id;
  };

  const checkJobId = await queueContinuityCheck();
  ok(
    `both stages registered; ${CONTINUITY_JOB} enqueued as ` +
      `${checkJobId.slice(0, 8)} through the public enqueue()`,
  );

  // ---- 6. a real Worker runs the check ------------------------------------

  const worker = new Worker(
    "pipeline",
    async (job) => (await runJob("pipeline", pipelineHandlers, job)).result,
    { connection: workerConnection(), concurrency: 1, ...workerQueueOptions() },
  );
  await worker.waitUntilReady();

  /** Jobs for this project that Redis has not finished with. */
  const pending = async (): Promise<number> => {
    const rows = await db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.projectId, projectId),
          inArray(schema.jobs.status, ["queued", "running"]),
        ),
      );
    return rows.length;
  };

  /**
   * Wait for the project's queue to go quiet.
   *
   * Polls the `jobs` rows rather than a BullMQ event, because the row is what the
   * product reads — and because the continuity check enqueues follow-up work, so
   * "this job finished" is not the same question as "the stage is done".
   */
  const drain = async (): Promise<void> => {
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    for (;;) {
      if ((await pending()) === 0) return;
      if (Date.now() > deadline) throw new Error("jobs did not finish in time");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };

  const jobResult = async (jobId: string): Promise<Record<string, unknown>> => {
    const rows = await db
      .select({ result: schema.jobs.result })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .limit(1);
    return rows[0]?.result ?? {};
  };

  const requireSucceeded = async (jobId: string, what: string): Promise<void> => {
    const view = await getJob(userId, jobId);
    assert(view !== null, `the ${what} job row disappeared`);
    assert(
      view!.status === "succeeded",
      `the ${what} ended ${view!.status}: ${view!.error ?? "(no message)"} ` +
        `[${view!.errorCode ?? "no code"}]`,
    );
  };

  await drain();
  await requireSucceeded(checkJobId, "continuity check");

  const checkResult = await jobResult(checkJobId);
  assert(checkResult["checked"] === true, "the stage reported it did not check");
  const firstScore = checkResult["score"];
  assert(
    typeof firstScore === "number",
    `the stage recorded no score: ${JSON.stringify(checkResult)}`,
  );
  assert(
    checkResult["status"] === "fail",
    `expected a fail verdict for three scenes with no constraints, got ` +
      `${String(checkResult["status"])} at ${String(firstScore)}`,
  );
  assert(
    (firstScore as number) < context.thresholds.fail,
    `verdict is fail but the score ${String(firstScore)} is not below the ` +
      `fail threshold ${context.thresholds.fail}`,
  );
  assert(
    checkResult["regenerating"] === 3,
    `expected 3 scenes queued for regeneration, got ${String(
      checkResult["regenerating"],
    )}`,
  );
  ok(
    `the worker ran ${CONTINUITY_JOB} to succeeded — score ${String(firstScore)}/100, ` +
      `verdict fail, ${String(checkResult["regenerating"])} scenes to regenerate`,
  );

  // ---- 7. the verdict is in `quality_checks`, and the read model sees it ---

  const { continuityView } = await import("@/lib/continuity/read");

  const stored = await store.latestContinuityCheck(userId, projectId);
  assert(stored !== null, "no quality_checks row was written");
  assert(stored!.verdict === "fail", `the stored verdict is ${stored!.verdict}`);

  const summary = stored!.findings.find((f) => f.code === "continuity.score");
  assert(summary !== undefined, "the findings carry no continuity.score summary row");
  assert(
    summary!.message === `Continuity score ${String(firstScore)}/100 (fail).`,
    `the summary finding reads "${summary!.message}", which the read model parses ` +
      "with a fixed pattern",
  );

  const failing = stored!.findings.filter((f) => f.severity === "fail");
  const missingCharacter = failing.filter(
    (f) => f.code === "continuity.character.missing_constraint",
  );
  assert(
    missingCharacter.length === 3,
    `expected 3 character findings, got ${missingCharacter.length}`,
  );

  const view = await continuityView(userId, projectId, "studio");
  assert(
    view.score === firstScore,
    `the read model reports ${String(view.score)} but the stage recorded ` +
      `${String(firstScore)}`,
  );
  assert(view.level === "character", `the read model reports level ${view.level}`);
  assert(view.active, "the read model reports continuity inactive");
  assert(view.bible !== null, "the read model returns no bible");
  assert(
    view.scenes.length === SCENES.length,
    `the read model returns ${view.scenes.length} scene states`,
  );
  ok(
    `quality_checks holds the verdict (${failing.length} fail findings), and the ` +
      `read model parses the score back as ${String(view.score)}`,
  );
  detail(`components: ${summary!.detail ?? "(none)"}`);
  for (const finding of failing) {
    detail(`${finding.code} — ${finding.detail ?? "(no detail)"}`);
  }

  // ---- 8. regeneration was queued for exactly the failed scenes ----------

  const regenJobs = await db
    .select({
      id: schema.jobs.id,
      status: schema.jobs.status,
      payload: schema.jobs.payload,
      stage: schema.jobs.stage,
    })
    .from(schema.jobs)
    .where(
      and(eq(schema.jobs.projectId, projectId), eq(schema.jobs.name, SCENE_REGEN_JOB)),
    );

  const regenIndices = regenJobs
    .map((row) => row.payload?.["sceneIndex"])
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b);
  assert(
    JSON.stringify(regenIndices) === JSON.stringify([1, 2, 3]),
    `regeneration was queued for [${regenIndices.join(", ")}]; expected [1, 2, 3] — ` +
      "the scene that carried its block must not be regenerated",
  );
  assert(
    regenJobs.every((row) => row.stage === "QUALITY_CHECK"),
    "a regeneration job was recorded against a stage other than QUALITY_CHECK",
  );

  let generations = 0;
  for (const row of regenJobs) {
    await requireSucceeded(row.id, `scene ${String(row.payload?.["sceneIndex"])} regeneration`);
    const result = await jobResult(row.id);
    assert(
      result["regenerated"] === true,
      `scene ${String(row.payload?.["sceneIndex"])} reported ` +
        `regenerated=${String(result["regenerated"])}`,
    );
    assert(
      result["attempt"] === 1,
      `scene ${String(row.payload?.["sceneIndex"])} recorded attempt ` +
        `${String(result["attempt"])}, expected 1`,
    );
    generations += 1;
  }
  ok(
    `${regenJobs.length} regenerations ran to succeeded at attempt 1, for scenes ` +
      `[${regenIndices.join(", ")}] — queued by the stage itself, on the existing queue`,
  );

  // ---- 9. each regeneration produced a real asset and repointed its scene --

  const sceneRows = await db
    .select({
      index: schema.scenes.index,
      visualAssetId: schema.scenes.visualAssetId,
      regenerations: schema.scenes.continuityRegenerations,
    })
    .from(schema.scenes)
    .where(eq(schema.scenes.projectId, projectId))
    .orderBy(asc(schema.scenes.index));

  for (const row of sceneRows) {
    const seeded = seededAssets.get(row.index);
    if (row.index === 0) {
      assert(
        row.visualAssetId === seeded,
        "scene 0's visual was replaced, but scene 0 was never queued",
      );
      assert(
        row.regenerations === 0,
        `scene 0 records ${row.regenerations} regenerations`,
      );
      continue;
    }
    assert(
      row.visualAssetId !== null && row.visualAssetId !== seeded,
      `scene ${row.index} still points at its seeded asset`,
    );
    assert(
      row.regenerations === 1,
      `scene ${row.index} records ${row.regenerations} regenerations, expected 1`,
    );
  }

  const newAssets = await db
    .select({
      id: schema.assets.id,
      kind: schema.assets.kind,
      provider: schema.assets.provider,
      bytes: schema.assets.bytes,
      storageKey: schema.assets.storageKey,
      license: schema.assets.license,
      meta: schema.assets.meta,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.projectId, projectId),
        ne(schema.assets.provider, "fixture"),
      ),
    );

  assert(
    newAssets.length === 3,
    `expected 3 regenerated assets, found ${newAssets.length}`,
  );
  for (const asset of newAssets) {
    assert(
      asset.provider === "mock",
      `a regenerated asset came from provider ${String(asset.provider)}, not the mock`,
    );
    assert(
      asset.storageKey !== null && (asset.bytes ?? 0) > 0,
      "a regenerated asset has no stored object — MinIO did not receive the bytes",
    );
    // The mock synthesises a still, and the asset says so: §42 forbids recording a
    // generated video because AI mode was requested.
    assert(
      asset.kind === "generated_image",
      `a mock still was recorded as ${asset.kind}`,
    );
    assert(
      (asset.license ?? "").includes("not for publication"),
      `a placeholder asset claims licence "${String(asset.license)}"`,
    );
    assert(
      asset.meta?.["continuityRegeneration"] === 1,
      "a regenerated asset does not record which attempt produced it",
    );
  }

  // Round-trip one of them through a signed URL, as the editor and renderer would.
  const { signedReadUrl } = await import("@/lib/storage");
  const sample = newAssets[0];
  assert(sample !== undefined, "no regenerated asset to fetch");
  const url = await signedReadUrl(sample!.storageKey!, { expiresInSeconds: 300 });
  const response = await fetch(url);
  assert(response.ok, `the regenerated asset's URL returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(
    bytes.byteLength === sample!.bytes,
    `the stored object is ${bytes.byteLength} bytes but the row says ${String(
      sample!.bytes,
    )}`,
  );
  // A real PNG signature, not an empty file the row merely claims exists.
  assert(
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "the regenerated object is not a PNG",
  );
  ok(
    `3 new assets from the resolved provider (${bytes.byteLength} bytes downloaded ` +
      "through a signed URL), scenes 1-3 repointed and counted, scene 0 untouched",
  );

  // ---- 10. the project never left VIDEO_READY ----------------------------

  const afterCheck = await getProject(userId, projectId);
  assert(
    afterCheck.status === "VIDEO_READY",
    `continuity moved the project to ${afterCheck.status} — a failed check must not ` +
      "undo a paid render (§22)",
  );
  assert(
    afterCheck.failedStage === null && afterCheck.errorCode === null,
    `the project carries a failure: ${String(afterCheck.errorCode)} at ` +
      `${String(afterCheck.failedStage)}`,
  );
  ok(
    `the project is still VIDEO_READY at ${afterCheck.progress}% after a fail ` +
      "verdict and three regenerations — no failure recorded",
  );

  // ---- 11. a re-check sees the repair, and re-bills nothing ---------------

  /**
   * The loop actually closing, which is what §13 is for.
   *
   * This step used to assert the opposite — that a second check scored *identically* —
   * and it passed for the wrong reason. `executeSceneRegeneration` replaced a scene's
   * asset but left `scenes.continuity_prompt` holding the block from the original
   * visuals stage, so the validator kept re-reading the constraints the *first* attempt
   * carried and kept failing scenes that had already been fixed. Every check queued
   * three more paid redraws, forever, until the ceiling stopped it. The identical score
   * was the symptom.
   *
   * A regeneration now records the block it actually sent, so the three repaired scenes
   * carry their constraints and pass. The score has to *rise*, and the second pass has
   * to queue nothing — that is the difference between a quality feature that converges
   * and one that bills in a loop (§22).
   *
   * §12's determinism is not weakened by this and is not what this step covers: the
   * validator is still a pure function of its inputs, and `validate.test.ts` pins that
   * over fixed structs. What changed is an *input*, deliberately. The re-run below is
   * the end-to-end determinism check, on inputs that genuinely did not move.
   */
  const secondCheckId = await queueContinuityCheck();
  await drain();
  await requireSucceeded(secondCheckId, "second continuity check");

  const secondResult = await jobResult(secondCheckId);
  const secondScore = secondResult["score"];
  assert(
    typeof secondScore === "number" && secondScore > (firstScore as number),
    `the re-check scored ${String(secondScore)}, not above the first pass's ` +
      `${String(firstScore)} — a redraw that recorded its constraints must clear the ` +
      `findings that caused it`,
  );
  assert(
    secondResult["regenerating"] === 0,
    `the second pass queued ${String(secondResult["regenerating"])} regeneration(s); ` +
      `the repaired scenes must not be re-billed`,
  );

  const secondRegen = await db
    .select({ id: schema.jobs.id, payload: schema.jobs.payload })
    .from(schema.jobs)
    .where(
      and(eq(schema.jobs.projectId, projectId), eq(schema.jobs.name, SCENE_REGEN_JOB)),
    );
  const fresh = secondRegen.filter((row) => !regenJobs.some((old) => old.id === row.id));
  assert(
    fresh.length === 0,
    `${fresh.length} new regeneration job(s) were queued for scenes that were ` +
      `already repaired, at full provider price`,
  );
  ok(
    `re-checked: score rose ${String(firstScore)} → ${String(secondScore)} and no ` +
      `scene was queued again — the redraws' own constraints were read back`,
  );

  /**
   * And now the determinism, on inputs that really are unchanged.
   *
   * A third check with nothing between it and the second: no regeneration ran, so no
   * prompt moved, and the score must be byte-identical. This is the assertion the old
   * step 11 was reaching for, in the one place where its premise actually holds.
   */
  const thirdCheckId = await queueContinuityCheck();
  await drain();
  await requireSucceeded(thirdCheckId, "third continuity check");

  const thirdResult = await jobResult(thirdCheckId);
  assert(
    thirdResult["score"] === secondScore &&
      thirdResult["status"] === secondResult["status"],
    `an unchanged video scored ${String(thirdResult["score"])} then ` +
      `${String(secondScore)} — §12 requires the validator to be deterministic`,
  );
  ok(
    `and an unchanged re-run scored ${String(thirdResult["score"])} again — ` +
      `§12's determinism, end to end`,
  );

  // ---- 13. the ceiling refuses a further attempt -------------------------

  const ceiling = context.thresholds.maxRegenerations;
  await db
    .update(schema.scenes)
    .set({ continuityRegenerations: ceiling })
    .where(and(eq(schema.scenes.projectId, projectId), eq(schema.scenes.index, 1)));

  const beforeCeiling = await db
    .select({ id: schema.assets.id })
    .from(schema.assets)
    .where(
      and(eq(schema.assets.projectId, projectId), eq(schema.assets.provider, "mock")),
    );

  const ceilingJob = await enqueue({
    queue: "pipeline",
    name: SCENE_REGEN_JOB,
    userId,
    channelId: channelId!,
    projectId,
    stage: "QUALITY_CHECK",
    payload: { projectId, tier: "studio", sceneIndex: 1 },
    traceId: "verify-continuity",
    statusMessage: "Queued — ceiling",
  });
  await drain();
  await requireSucceeded(ceilingJob.id, "ceiling regeneration");

  const ceilingResult = await jobResult(ceilingJob.id);
  assert(
    ceilingResult["regenerated"] === false,
    "the ceiling did not stop a further regeneration",
  );
  assert(
    ceilingResult["attempt"] === ceiling + 1,
    `the ceiling job recorded attempt ${String(ceilingResult["attempt"])}, expected ` +
      `${ceiling + 1}`,
  );

  const afterCeiling = await db
    .select({ id: schema.assets.id })
    .from(schema.assets)
    .where(
      and(eq(schema.assets.projectId, projectId), eq(schema.assets.provider, "mock")),
    );
  assert(
    afterCeiling.length === beforeCeiling.length,
    `the refused regeneration still produced ${
      afterCeiling.length - beforeCeiling.length
    } asset(s) — the ceiling has to be checked before the provider call, not after`,
  );
  ok(
    `attempt ${ceiling + 1} was refused at the ceiling of ${ceiling} and spent ` +
      "nothing: no new asset, and the count still incremented",
  );

  // ---- 14. another tenant sees nothing, and cannot overwrite -------------

  const { ForbiddenError } = await import("@/lib/errors");

  assert(
    (await store.getBible(otherUserId, projectId)) === null,
    "another tenant can read this project's story bible (§20)",
  );
  assert(
    (await store.getSceneStates(otherUserId, projectId)).length === 0,
    "another tenant can read this project's scene states (§20)",
  );
  assert(
    (await store.latestContinuityCheck(otherUserId, projectId)) === null,
    "another tenant can read this project's continuity check (§20)",
  );
  assert(
    (await store.regenerationCounts(otherUserId, projectId)).size === 0,
    "another tenant can read this project's regeneration counts (§20)",
  );

  const viewError = await continuityView(otherUserId, projectId, "studio").catch(
    (error: unknown) => error,
  );
  assert(
    viewError instanceof ForbiddenError,
    `the read model gave another tenant ${
      viewError instanceof Error ? viewError.constructor.name : "a view"
    } rather than a 403`,
  );

  /**
   * The write half, which the type system cannot catch.
   *
   * `story_bibles` is unique on `project_id` *alone*, so a caller who knows another
   * tenant's project id reaches the UPDATE branch of the upsert. Only the
   * `setWhere` predicate stops it, and that predicate is a runtime property of the
   * emitted SQL — exactly the thing a unit test cannot see.
   */
  const hijack = parseStoryBible({
    ...BIBLE_DOCUMENT,
    characters: [
      {
        id: "mara",
        name: "Somebody Else",
        role: null,
        appearance: ["a completely different face"],
        wardrobe: [],
        demeanour: null,
        arc: null,
      },
    ],
  });
  await store.saveBible({
    userId: otherUserId,
    projectId,
    bible: hijack,
    level: "character",
    generatedBy: "verify-continuity-intruder",
  });
  await store.saveSceneContinuity({
    userId: otherUserId,
    projectId,
    sceneIndex: 0,
    state: null,
    continuityPrompt: null,
  });

  const afterIntrusion = await store.getBible(userId, projectId);
  assert(
    afterIntrusion?.bible.characters[0]?.name === "Mara",
    "another tenant overwrote this project's story bible through the upsert (§20)",
  );
  const statesAfter = await store.getSceneStates(userId, projectId);
  assert(
    statesAfter.length === SCENES.length,
    `another tenant erased scene state: ${statesAfter.length} of ${SCENES.length} remain`,
  );
  const promptsAfter = await db
    .select({ prompt: schema.scenes.continuityPrompt })
    .from(schema.scenes)
    .where(and(eq(schema.scenes.projectId, projectId), eq(schema.scenes.index, 0)))
    .limit(1);
  assert(
    promptsAfter[0]?.prompt !== null,
    "another tenant cleared scene 0's recorded continuity block (§20)",
  );
  ok(
    "another tenant reads no bible, no states, no check and no counts, gets a 403 " +
      "from the view, and its writes through both upserts changed nothing",
  );

  // ---- 15. the reference-still stage draws the cast, once -----------------

  /**
   * §5 and §6's intersection, on real infrastructure.
   *
   * The integration suite proves the SQL — the `meta` flag, the tenant predicate, the
   * newest-per-entity collapse — and the unit tests prove the prompts. What neither
   * can prove is that the stage is reachable through the shipped registry and that its
   * generations land in object storage as assets the reader finds again, which is the
   * same class of gap this whole script exists for.
   *
   * Every generation below is the mock: a solid PNG synthesised in-process. Step 16
   * audits `api_usage` to prove that rather than asserting it in prose.
   */
  const planBefore = await continuity.referenceImagePlan({
    userId,
    project: continuityProject,
  });
  assert(
    planBefore.existing.length === 0,
    `the fixture already has ${planBefore.existing.length} reference still(s)`,
  );
  // Three entities with visual facts, which is what BIBLE_DOCUMENT carries: one
  // character, one location, one prop.
  assert(
    planBefore.wanted.length === 3,
    `expected 3 entities wanting a reference, got ${planBefore.wanted.length}: ` +
      planBefore.wanted.map((entry) => entry.entityId).join(", "),
  );

  const referenceJob = await enqueue({
    queue: "pipeline",
    name: REFERENCE_IMAGES_JOB,
    userId,
    channelId: channelId!,
    projectId,
    stage: "SCENE_PLAN",
    payload: { projectId, tier: "studio" },
    traceId: "verify-continuity",
    statusMessage: "Queued — references",
  });
  await drain();
  await requireSucceeded(referenceJob.id, "reference stills");

  const referenceResult = await jobResult(referenceJob.id);
  assert(
    referenceResult["generated"] === 3,
    `the stage generated ${String(referenceResult["generated"])} stills, expected 3`,
  );
  assert(
    referenceResult["failed"] === 0,
    `${String(referenceResult["failed"])} reference generation(s) failed`,
  );
  generations += 3;
  ok(
    `${REFERENCE_IMAGES_JOB} ran to succeeded — 3 stills for ` +
      planBefore.wanted.map((entry) => entry.entityId).join(", "),
  );

  // ---- 16. the stills are real objects, found again, and not re-drawn -----

  const referenceRows = await store.getReferenceImages(userId, projectId);
  assert(
    referenceRows.length === 3,
    `the reader found ${referenceRows.length} stills, expected 3`,
  );
  assert(
    referenceRows.every((row) => row.modelId === MOCK_MODEL),
    `a still records a model other than ${MOCK_MODEL}: ` +
      referenceRows.map((row) => row.modelId).join(", "),
  );

  /**
   * The bytes exist in object storage, at the key the row records.
   *
   * `storeAsset` writes to MinIO and inserts the row, and a row pointing at a key
   * that was never written is the failure mode that only a real fetch catches. Read
   * back rather than `objectExists`, because a zero-byte object exists.
   */
  const { getObjectBuffer } = await import("@/lib/storage");
  for (const row of referenceRows) {
    /**
     * Under the tenant's own `reference/` folder, not `visual/`.
     *
     * Keys are `u/{userId}/{folder}/{projectId}/{id}.{ext}`, so the folder sits mid-key
     * and the tenant prefix is asserted alongside it. The folder matters beyond
     * tidiness: a reference still outlives the visuals made from it, so a retention
     * rule written for one prefix must not silently apply to the other.
     */
    assert(
      row.storageKey.startsWith(`u/${userId}/reference/`),
      `a still is stored at ${row.storageKey}, not under u/${userId}/reference/ — a ` +
        "retention rule written for scene visuals would then apply to the cast",
    );
    const bytes = await getObjectBuffer(row.storageKey);
    assert(
      bytes.byteLength > 0,
      `the object at ${row.storageKey} is empty`,
    );
    // A real PNG, not a placeholder string: the first eight bytes are the signature.
    assert(
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      `the object at ${row.storageKey} is not a PNG`,
    );
  }

  // Landscape whatever the video's frame is: a reference is a chart, not a shot, and
  // cropping a character sheet to 9:16 cuts off the coat the video must match.
  assert(
    referenceRows.every(
      (row) => row.width !== null && row.height !== null && row.width > row.height,
    ),
    "a reference still is not landscape: " +
      referenceRows.map((row) => `${row.width}x${row.height}`).join(", "),
  );

  const planAfter = await continuity.referenceImagePlan({
    userId,
    project: continuityProject,
  });
  assert(
    planAfter.wanted.length === 0,
    `${planAfter.wanted.length} entity/entities still want a reference after the run`,
  );
  assert(
    planAfter.reason.includes("already has a reference"),
    `the plan's reason after a complete run reads "${planAfter.reason}"`,
  );

  /**
   * The cost control, verified by running the stage again.
   *
   * A second run that redrew the cast would be three paid generations to arrive back
   * where the project already was — and on a full bible, thirty.
   */
  const assetsBeforeRerun = await db
    .select({ id: schema.assets.id })
    .from(schema.assets)
    .where(eq(schema.assets.projectId, projectId));

  const rerunJob = await enqueue({
    queue: "pipeline",
    name: REFERENCE_IMAGES_JOB,
    userId,
    channelId: channelId!,
    projectId,
    stage: "SCENE_PLAN",
    payload: { projectId, tier: "studio" },
    traceId: "verify-continuity",
    statusMessage: "Queued — references again",
  });
  await drain();
  await requireSucceeded(rerunJob.id, "reference stills, second run");

  const rerunResult = await jobResult(rerunJob.id);
  assert(
    rerunResult["generated"] === 0,
    `the second run generated ${String(rerunResult["generated"])} still(s) — an ` +
      "already-drawn cast must cost nothing",
  );
  assert(
    rerunResult["skipped"] === 3,
    `the second run skipped ${String(rerunResult["skipped"])}, expected 3`,
  );

  const assetsAfterRerun = await db
    .select({ id: schema.assets.id })
    .from(schema.assets)
    .where(eq(schema.assets.projectId, projectId));
  assert(
    assetsAfterRerun.length === assetsBeforeRerun.length,
    `the second run created ${
      assetsAfterRerun.length - assetsBeforeRerun.length
    } asset(s)`,
  );

  /**
   * The reuse decision, on the real stored set.
   *
   * `referencesForScene` is what the visuals stage calls per scene. The provider layer
   * refuses references for a model that declares none — `mock/placeholder` does — so
   * this asserts the *selection*, which is the part the continuity layer owns. Scene 1
   * commits to the character, the location and the lamp; a stage that sent all three
   * to a scene committed to one would put a crowd in a two-hander.
   */
  const liveContext = await continuity.loadContext(userId, continuityProject);
  const forScene1 = continuity.referencesForScene({
    context: liveContext,
    sceneIndex: 1,
    stored: referenceRows,
  });
  assert(
    forScene1.map((entry) => `${entry.kind}:${entry.entityId}`).join(",") ===
      "character:mara,environment:workshop,prop:lamp",
    `scene 1 selected [${forScene1
      .map((entry) => `${entry.kind}:${entry.entityId}`)
      .join(", ")}], expected the cast first, then the location, then the prop`,
  );
  ok(
    `3 stills are real landscape PNGs under reference/, found again by the reader, ` +
      "not re-drawn on a second run, and selected per scene by committed entity",
  );

  // ---- 17. the flag off makes the stage a no-op ---------------------------

  const checksBefore = await db
    .select({ id: schema.qualityChecks.id })
    .from(schema.qualityChecks)
    .where(eq(schema.qualityChecks.projectId, projectId));

  process.env["TALLY_CONTINUITY_ENGINE_ENABLED"] = "false";
  resetEnvCache();
  assert(!continuityEnabled(), "the flag did not turn off");
  assert(
    usingMockProviders(),
    "resetting the environment cache turned mock providers off; the next stage " +
      "would reach a paid provider",
  );

  let offResult: Record<string, unknown>;
  try {
    const offJobId = await queueContinuityCheck();
    await drain();
    await requireSucceeded(offJobId, "continuity check with the flag off");
    offResult = await jobResult(offJobId);
  } finally {
    process.env["TALLY_CONTINUITY_ENGINE_ENABLED"] = "true";
    resetEnvCache();
  }

  assert(
    offResult["checked"] === false,
    `the stage checked continuity with the flag off: ${JSON.stringify(offResult)}`,
  );
  assert(
    offResult["score"] === null && offResult["status"] === null,
    "the stage reported a score with the flag off",
  );
  assert(
    offResult["regenerating"] === 0,
    "the stage queued a regeneration with the flag off — that would be a paid call",
  );

  const checksAfter = await db
    .select({ id: schema.qualityChecks.id })
    .from(schema.qualityChecks)
    .where(eq(schema.qualityChecks.projectId, projectId));
  assert(
    checksAfter.length === checksBefore.length,
    `the flag-off run wrote ${
      checksAfter.length - checksBefore.length
    } quality_checks row(s)`,
  );
  assert(
    (await getProject(userId, projectId)).status === "VIDEO_READY",
    "the flag-off run moved the project",
  );
  ok(
    "TALLY_CONTINUITY_ENGINE_ENABLED=false: the stage succeeds as a no-op, records " +
      "nothing and queues nothing — the pre-continuity behaviour exactly",
  );

  // ---- 18. every provider call was the mock ------------------------------

  /**
   * The cost claim in the header, audited rather than asserted in prose.
   *
   * `withUsage` writes one row per provider call, whatever the outcome, so a stray
   * real request would be here even if it failed.
   */
  const usage = await db
    .select({
      provider: schema.apiUsage.provider,
      operation: schema.apiUsage.operation,
      model: schema.apiUsage.model,
      ok: schema.apiUsage.ok,
    })
    .from(schema.apiUsage)
    .where(eq(schema.apiUsage.projectId, projectId));

  const offenders = usage.filter((row) => row.provider !== "mock");
  assert(
    offenders.length === 0,
    `${offenders.length} provider call(s) went somewhere other than the mock: ` +
      offenders.map((row) => `${row.provider}/${String(row.model)}`).join(", "),
  );
  assert(
    usage.length === generations,
    `${usage.length} provider calls recorded for ${generations} regenerations`,
  );
  /**
   * Two operations, and only two.
   *
   * A scene generation per regeneration, and one still per reference. Named
   * explicitly rather than checked loosely: an unexpected third operation is how a
   * stage that quietly calls a provider it should not would show up here.
   */
  const expectedOperations = new Set([
    "video.scene.generate",
    "continuity.reference.image",
  ]);
  const unexpected = usage.filter(
    (row) => !expectedOperations.has(row.operation) || !row.ok,
  );
  assert(
    unexpected.length === 0,
    `${unexpected.length} recorded provider call(s) were not a successful scene ` +
      `generation or reference still: ` +
      unexpected.map((row) => `${row.operation}(ok=${String(row.ok)})`).join(", "),
  );

  const referenceCalls = usage.filter(
    (row) => row.operation === "continuity.reference.image",
  );
  assert(
    referenceCalls.length === 3,
    `${referenceCalls.length} reference generations recorded, expected 3`,
  );
  ok(
    `api_usage audit: ${usage.length} calls (${
      usage.length - referenceCalls.length
    } scene, ${referenceCalls.length} reference), all provider mock, model ` +
      `${String(usage[0]?.model)} — no billable request, no publish, no encode`,
  );

  // ---- teardown ---------------------------------------------------------

  await worker.close();
  await getQueue("pipeline").obliterate({ force: true });
  await closeQueues();
  await closeRedis();
  await closeDb();

  console.log(
    `\n${step}/${step} checks passed — the continuity stages run on real ` +
      "infrastructure.\n",
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A verification tenant, cleaned of the previous run's rows.
 *
 * Reused across runs and left behind deliberately, like `verify-worker`'s and
 * `verify-editor`'s: a recognisable local fixture rather than a real account. The
 * password hash is not a valid scrypt digest, so the row cannot be signed into.
 *
 * The tier matters here in a way it does not in the other scripts: `resolveFor`
 * refuses continuity outright on a plan without `aiVideoGeneration`, so a starter
 * fixture would make every check below vacuous.
 */
async function fixtureUser(
  ctx: {
    db: typeof import("@/lib/db").db;
    schema: typeof import("@/lib/db/schema");
    eq: typeof import("drizzle-orm").eq;
  },
  email: string,
  tier: "starter" | "studio" | "scale",
): Promise<string> {
  const { db, schema, eq } = ctx;

  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  const found = existing[0];
  if (found) {
    // Cascades take the scenes, assets, jobs, story bible and quality checks with
    // them, so a re-run starts clean rather than scoring last run's fixtures.
    await db.delete(schema.projects).where(eq(schema.projects.userId, found.id));
    await db.delete(schema.channels).where(eq(schema.channels.userId, found.id));
    await db
      .update(schema.subscriptions)
      .set({ tier })
      .where(eq(schema.subscriptions.userId, found.id));
    return found.id;
  }

  const inserted = await db
    .insert(schema.users)
    .values({
      email,
      emailNormalized: email.toLowerCase(),
      name: "Continuity Verification",
      passwordHash: "not-a-loginable-hash",
    })
    .returning({ id: schema.users.id });

  const userId = inserted[0]?.id;
  if (!userId) throw new Error(`could not create the verification user ${email}`);
  await db
    .insert(schema.subscriptions)
    .values({ userId, tier, status: "active" });
  return userId;
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(
      `\n  FAIL at step ${step + 1}: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    );
    process.exit(1);
  },
);

/**
 * Prove that a project whose YouTube source was never analysed exposes its raw source
 * video id on no customer-facing surface (§22, §42).
 *
 * ## Why this exists as a script rather than only as tests
 *
 * The vitest suites pin the behaviour against fixtures: 12 unit tests over the
 * placeholder classifier, 2 over the script prompt, and 7 integration tests that build an
 * abandoned project and read every loader a screen renders from. What none of them can do
 * is answer the question that started this — "is `pBt_n-tjV_Y` still on my screen?" —
 * because that is a claim about one real row in the developer's own database, not about a
 * fixture. This script loads that row through the same server functions the pages call
 * and scans what comes back.
 *
 * The distinction it is checking is the whole point of the fix:
 *
 *   a user submitted a URL   ≠   Tally successfully analysed the source
 *
 * `projects.source_video_id` is written the moment a link is pasted, before any worker
 * runs. `research_runs.source_analysis`, `source_title` and `source_channel_title` are
 * written later, by the worker, only if it actually read the video. So the presence of an
 * id proves the first statement and never the second — and every surface that treated it
 * as proof of the second is what put an eleven-character id on screen as though it were
 * the name of a video.
 *
 * ## What it verifies
 *
 *   1. the target project exists, is channel-less, and still carries both its stored
 *      source video id and the from-a-link placeholder title — the row is not rewritten,
 *      because the fix is in the reads (§9's "preserve the failure history")
 *   2. no research run for it ever read the source: no analysis, no source title, no
 *      channel title
 *   3. the Link Studio payload — the YouTube screen, and the same data
 *      `/api/projects/link-status` serves — presents no source card, and carries the id
 *      nowhere except the two fields that legitimately hold provenance
 *   4. the stage context the Script, Thumbnail, Video and Editor screens share hands out
 *      no title containing the id, and the exact prop expression each page evaluates
 *      resolves to null
 *   5. the script brief and the fully rendered provider prompt contain no id and no
 *      working-title line — the one path where this bug reached a model rather than a
 *      screen
 *   6. the dashboard overview lists nothing for this project at all, since it requires a
 *      channel
 *   7. the research screen's loader is unreachable for it, for the same reason
 *   8. the id appears in no other project of the same owner, and in no scripts, scenes,
 *      thumbnails, video metadata or published-video titles anywhere in the database —
 *      the check that catches a surface nobody thought to audit
 *
 * ## Cost and safety
 *
 * Read-only, and free. Every function it calls is a loader or a pure builder: `getProject`,
 * `getLinkStudioData`, `getStageContext`, `buildBrief`, `buildScriptPrompt`, `getOverview`.
 * It opens no queue, starts no worker, enqueues nothing, and writes no row — asserted at
 * the end by re-reading the project's `updated_at` and comparing it to what was read
 * first. `buildScriptPrompt` renders the prompt as a string in-process and is not sent
 * anywhere: no AI provider, no YouTube API, no Stripe call, no credit spent.
 *
 * `TALLY_USE_MOCK_PROVIDERS=true` is set at module scope as belt-and-braces, so that if a
 * future edit to one of these loaders did reach a provider registry, it would resolve to
 * the mock rather than to a paid backend.
 *
 * One consequence of that is visible in the output and is not a failure: `buildBrief` asks
 * `generationPlanFor` to resolve the project's chosen model, and with mocks forced on, a
 * real model such as `fal/wan-v2-2-a14b` is "not available on this deployment". The
 * builder already treats that as a warning and drops the filming section from the prompt
 * rather than failing the script — the visuals stage is where an unavailable model is
 * reported, because that is the stage about to spend money on it (§42). The audit is
 * unaffected: what it reads is the title, and the dropped section could not have contained
 * one.
 *
 *   npx tsx scripts/verify-abandoned-source.ts [projectId]
 *
 * With no argument it audits every channel-less project whose research never read the
 * source, which is the general form of the bug. Exits non-zero on the first failure.
 */
import "@/lib/load-env";

/**
 * Set before anything can read it.
 *
 * `.env.local` has `TALLY_USE_MOCK_PROVIDERS=false`, which is right for a developer's web
 * app and wrong here. `process.loadEnvFile` runs from the hoisted `load-env` import above
 * and does not overwrite variables already present — but it ran *first*, so this
 * assignment wins, and no `env()` call has happened yet.
 */
process.env["TALLY_USE_MOCK_PROVIDERS"] = "true";

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
 * The assertion this whole script is for.
 *
 * Serialised and searched rather than field-by-field, because the failure mode was a
 * *field nobody thought about* — the id reached the screen through `project.title`, which
 * no reviewer of the YouTube panel would have looked at. Scanning the whole payload
 * catches the next one of those without anyone remembering to extend this script.
 */
function assertNoId(value: unknown, videoId: string, what: string): void {
  const json = JSON.stringify(value) ?? "";
  if (json.includes(videoId)) {
    const at = json.indexOf(videoId);
    throw new Error(
      `${what} exposes the raw source video id ${videoId}: ` +
        `…${json.slice(Math.max(0, at - 120), at + 60)}…`,
    );
  }
}

async function main(): Promise<void> {
  console.log("\nTally abandoned-source exposure verification\n");

  const { env, usingMockProviders } = await import("@/lib/env");
  const e = env();
  assert(usingMockProviders(), "mock providers must be on: this script must be free");
  assert(Boolean(e.DATABASE_URL), "DATABASE_URL must be set");

  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { and, eq, isNotNull, isNull, or } = await import("drizzle-orm");
  const { displayTitle, isPlaceholderTitle } = await import(
    "@/lib/projects/display-title"
  );

  const wanted = process.argv[2] ?? null;

  /**
   * The projects to audit.
   *
   * Either the one named on the command line, or every channel-less project seeded from a
   * link — the general population this class of bug lives in. Not filtered to failed runs
   * here: a project whose research *succeeded* must also pass, and if it does not, that is
   * a worse bug (a real analysis being suppressed), so it belongs in the same sweep.
   */
  const targets = await db
    .select({
      id: schema.projects.id,
      userId: schema.projects.userId,
      title: schema.projects.title,
      status: schema.projects.status,
      channelId: schema.projects.channelId,
      origin: schema.projects.origin,
      sourceVideoId: schema.projects.sourceVideoId,
      updatedAt: schema.projects.updatedAt,
    })
    .from(schema.projects)
    .where(
      wanted
        ? eq(schema.projects.id, wanted)
        : and(
            isNull(schema.projects.channelId),
            isNotNull(schema.projects.sourceVideoId),
          ),
    );

  assert(
    targets.length > 0,
    wanted
      ? `no project ${wanted} in this database`
      : "no channel-less project with a source video id: nothing to audit",
  );

  ok(`${targets.length} project(s) to audit`);
  for (const t of targets) {
    detail(
      `${t.id.slice(0, 8)}  ${t.status.padEnd(12)} ${t.sourceVideoId}  ` +
        `${isPlaceholderTitle(t.title) ? "placeholder title" : "named"}`,
    );
  }

  const { getProject } = await import("@/lib/projects/service");
  const { getLinkStudioData } = await import("@/lib/dashboard/link-studio");
  const { getStageContext } = await import("@/lib/dashboard/stage");
  const { getOverview } = await import("@/lib/dashboard/overview");
  const { buildBrief } = await import("@/lib/scripts/service");
  const { buildScriptPrompt } = await import("@/lib/scripts/prompt");

  for (const target of targets) {
    const videoId = target.sourceVideoId;
    assert(videoId !== null, `project ${target.id} has no source video id`);
    const id = videoId as string;
    const label = `${target.id.slice(0, 8)} (${id})`;

    console.log(`\n  --- ${label} ---`);

    // ---- The stored row: unchanged, and still holding its history ----------
    const project = await getProject(target.userId, target.id);
    assert(project.sourceVideoId === id, `${label}: provenance column was rewritten`);
    ok(`${label}: source video id still stored as provenance (§22)`);

    /**
     * Whether the worker ever read the source, for every run keyed to this project.
     *
     * Any one of the three columns is enough: the worker writes them together, and a run
     * that filled in even the title read the video. This is the same eligibility question
     * `getLinkStudioData` now asks, checked here against the raw rows so the loader's
     * answer can be compared to the truth rather than trusted.
     */
    const runs = await db
      .select({
        id: schema.researchRuns.id,
        status: schema.researchRuns.status,
        errorCode: schema.researchRuns.errorCode,
        sourceTitle: schema.researchRuns.sourceTitle,
        sourceChannelTitle: schema.researchRuns.sourceChannelTitle,
        sourceAnalysis: schema.researchRuns.sourceAnalysis,
      })
      .from(schema.researchRuns)
      .where(
        and(
          eq(schema.researchRuns.userId, target.userId),
          isNull(schema.researchRuns.channelId),
          or(
            eq(schema.researchRuns.projectId, target.id),
            eq(schema.researchRuns.sourceVideoId, id),
          ),
        ),
      );

    const analysed = runs.some(
      (r) =>
        r.sourceAnalysis !== null ||
        r.sourceTitle !== null ||
        r.sourceChannelTitle !== null,
    );

    ok(
      `${label}: ${runs.length} run(s), source ` +
        (analysed ? "WAS analysed" : "was never analysed"),
    );
    for (const r of runs) {
      detail(
        `run ${r.id.slice(0, 8)} ${r.status}` +
          (r.errorCode ? ` (${r.errorCode})` : "") +
          `  analysis=${r.sourceAnalysis === null ? "null" : "present"}` +
          `  title=${r.sourceTitle ?? "null"}`,
      );
    }

    // ---- 3. The YouTube screen, and the polled status behind it ------------
    const studio = await getLinkStudioData(target.userId, target.id);

    if (analysed) {
      /**
       * The other direction, asserted rather than skipped.
       *
       * A fix that suppressed the source card unconditionally would pass every
       * "id is absent" check in this script while destroying the feature. So when the
       * worker really did read the video, the card has to be there.
       */
      assert(
        studio.source !== null,
        `${label}: source WAS analysed but the studio shows no card — ` +
          `the eligibility check is now too strict`,
      );
      ok(`${label}: analysed source still shows its card`);
    } else {
      assert(
        studio.source === null,
        `${label}: studio built a source card from an unanalysed source`,
      );
      ok(`${label}: no source card for an unanalysed source`);
    }

    /**
     * The whole payload, minus the two fields that legitimately carry the id.
     *
     * `project.sourceVideoId` is provenance §22 requires Tally to keep, and
     * `project.title` is the stored row, which is deliberately not rewritten — the fix is
     * that no screen renders it raw, proved on the next line. `source.videoId` is excluded
     * only in the analysed case, where the card is real and the id is the thing the user
     * pasted, shown as part of a source Tally genuinely read.
     */
    const scrubbedStudio = {
      ...studio,
      project: { ...studio.project, sourceVideoId: null, title: null },
      source: studio.source ? { ...studio.source, videoId: null } : null,
    };
    assertNoId(scrubbedStudio, id, `${label}: Link Studio payload`);
    ok(`${label}: id appears nowhere else in the Link Studio payload`);

    // ---- 4. Every stage screen's shared context ---------------------------
    const context = await getStageContext(target.userId, target.id);

    /**
     * The exact expressions the three pages evaluate, not an approximation of them.
     *
     * This is what the audit found: the loaders were fine, and the exposure was in what
     * the pages did with `project.title`. Copying the prop expressions verbatim is the
     * only way this script checks the thing that was actually broken.
     */
    const scriptProp = displayTitle(context.project?.title); // dashboard/script/page.tsx
    const thumbProp = context.script?.title ?? displayTitle(context.project?.title); // thumbnail
    const editorProp = context.script?.title ?? displayTitle(context.project?.title); // video/edit

    for (const [name, value] of [
      ["script screen projectTitle", scriptProp],
      ["thumbnail screen baseTitle", thumbProp],
      ["editor projectTitle", editorProp],
    ] as const) {
      assert(
        value === null || !value.includes(id),
        `${label}: ${name} would render "${String(value)}"`,
      );
    }
    ok(`${label}: no stage screen receives a title containing the id`);
    detail(
      `script=${String(scriptProp)}  thumbnail=${String(thumbProp)}  ` +
        `editor=${String(editorProp)}`,
    );

    /**
     * And the rest of the context, which feeds the Video screen, the scene list, the
     * metadata panel, the job list and the quality panel. `project` is excluded for the
     * same two reasons as above.
     */
    const scrubbedContext = {
      ...context,
      project: context.project
        ? { ...context.project, sourceVideoId: null, title: null }
        : null,
    };
    assertNoId(scrubbedContext, id, `${label}: stage context`);
    ok(`${label}: id appears nowhere else in the stage context`);

    // ---- 5. The one path that reached a provider --------------------------
    const brief = await buildBrief(target.userId, target.id);
    assertNoId(brief, id, `${label}: script brief`);

    const prompt = buildScriptPrompt(brief);
    assert(
      !prompt.includes(id),
      `${label}: the rendered script prompt contains the id — a generated script ` +
        `would name it, which is permanent rather than merely on screen`,
    );
    if (isPlaceholderTitle(target.title) && !brief.idea) {
      assert(
        !prompt.includes("Working title"),
        `${label}: the prompt states a working title for a project that has none`,
      );
    }
    ok(`${label}: neither the brief nor the rendered prompt carries the id`);
    detail(`prompt is ${prompt.length} characters, sent nowhere by this script`);

    // ---- 6/7. Dashboard overview and the research screen ------------------
    const overview = await getOverview(target.userId);
    assertNoId(overview, id, `${label}: dashboard overview`);
    assert(
      !overview.inProgress.some((p) => p.id === target.id),
      `${label}: a channel-less project reached the overview's in-progress list, ` +
        `which joins on channels — the join was weakened`,
    );
    ok(`${label}: absent from the dashboard overview (no channel to list it under)`);

    // The research screen requires a channelId, so a channel-less project cannot reach
    // it. Asserted from the row rather than by calling the loader with a fabricated
    // channel id, which would prove nothing about this project.
    assert(
      target.channelId === null,
      `${label}: expected a channel-less project; the research screen audit above ` +
        `assumes it, and a project with a channel needs the channel path audited too`,
    );
    ok(`${label}: channel-less, so the Research screen's loader is unreachable for it`);

    // ---- Nothing was written ---------------------------------------------
    const after = await db
      .select({ updatedAt: schema.projects.updatedAt })
      .from(schema.projects)
      .where(eq(schema.projects.id, target.id))
      .limit(1);
    assert(
      after[0]?.updatedAt?.getTime() === target.updatedAt.getTime(),
      `${label}: the project row was modified by this audit`,
    );
    ok(`${label}: read-only — the project row is byte-identical`);
  }

  // ---- 8. The whole database, for anywhere else an id could have landed ----
  console.log("\n  --- generated content, database-wide ---");

  const ids = targets.map((t) => t.sourceVideoId).filter((v): v is string => v !== null);

  /**
   * Every table that stores a customer-facing string derived from a project.
   *
   * Not a scan of the loaders this time but of what has been *persisted*: if a generation
   * ran while the bug was live, the id would be baked into a script title, a scene label,
   * a thumbnail's headline or a published video's title, and fixing the reads would not
   * remove it. Reported rather than deleted — §9 forbids destroying generated content, and
   * a real hit here is a data-repair decision for the operator, not for this script.
   */
  const persisted: Array<{ where: string; id: string; text: string }> = [];

  /**
   * The generated title lives on `script_versions`, not on `scripts`.
   *
   * `scripts` is the per-project container — it holds the active version pointer and the
   * approval timestamp, and no text at all. Every draft's title is a version row, so
   * checking the parent would have scanned a table with nothing in it to find and reported
   * a clean result for a script whose title named the video id. Same shape for thumbnails:
   * the headline is on `thumbnail_variants`.
   */
  const scriptRows = await db
    .select({ id: schema.scriptVersions.id, title: schema.scriptVersions.title })
    .from(schema.scriptVersions);
  const sceneRows = await db
    .select({
      id: schema.scenes.id,
      label: schema.scenes.label,
      narration: schema.scenes.narration,
    })
    .from(schema.scenes);
  const thumbRows = await db
    .select({
      id: schema.thumbnailVariants.id,
      headline: schema.thumbnailVariants.headline,
      subline: schema.thumbnailVariants.subline,
    })
    .from(schema.thumbnailVariants);
  const metaRows = await db
    .select({
      id: schema.videoMetadata.projectId,
      title: schema.videoMetadata.title,
      description: schema.videoMetadata.description,
    })
    .from(schema.videoMetadata);
  const publishedRows = await db
    .select({
      id: schema.publishedVideos.id,
      titleUsed: schema.publishedVideos.titleUsed,
    })
    .from(schema.publishedVideos);

  for (const videoId of ids) {
    for (const r of scriptRows) {
      if (r.title.includes(videoId)) {
        persisted.push({
          where: `script_versions.title ${r.id}`,
          id: videoId,
          text: r.title,
        });
      }
    }
    for (const r of sceneRows) {
      for (const [col, text] of [
        ["label", r.label],
        ["narration", r.narration],
      ] as const) {
        if (text?.includes(videoId)) {
          persisted.push({ where: `scenes.${col} ${r.id}`, id: videoId, text });
        }
      }
    }
    for (const r of thumbRows) {
      for (const [col, text] of [
        ["headline", r.headline],
        ["subline", r.subline],
      ] as const) {
        if (text?.includes(videoId)) {
          persisted.push({
            where: `thumbnail_variants.${col} ${r.id}`,
            id: videoId,
            text,
          });
        }
      }
    }
    for (const r of metaRows) {
      for (const [col, text] of [
        ["title", r.title],
        ["description", r.description],
      ] as const) {
        if (text.includes(videoId)) {
          persisted.push({
            where: `video_metadata.${col} ${r.id}`,
            id: videoId,
            text,
          });
        }
      }
    }
    for (const r of publishedRows) {
      if (r.titleUsed?.includes(videoId)) {
        persisted.push({
          where: `published_videos.title_used ${r.id}`,
          id: videoId,
          text: r.titleUsed,
        });
      }
    }
  }

  if (persisted.length > 0) {
    for (const hit of persisted) detail(`${hit.where}: ${hit.text}`);
    throw new Error(
      `${persisted.length} stored string(s) contain a raw source video id. These are ` +
        `generated content, so they are reported rather than deleted — decide per row ` +
        `whether to regenerate or to correct it.`,
    );
  }

  ok(
    `no stored script title, scene label, narration, thumbnail headline, metadata ` +
      `title or published title contains any audited id`,
  );

  /**
   * And the placeholder string itself, anywhere it could have been copied.
   *
   * Wider than the ids: this catches a title propagated by `configureProject` or by a
   * generation that ran before the fix, for a video id no longer present on any project.
   */
  const placeholderHits = [
    ...scriptRows.map((r) => r.title),
    ...metaRows.map((r) => r.title),
    ...publishedRows.map((r) => r.titleUsed),
  ].filter(
    (t): t is string => t !== null && t.trim().length > 0 && isPlaceholderTitle(t),
  );

  if (placeholderHits.length > 0) {
    for (const hit of placeholderHits) detail(hit);
    throw new Error(
      `${placeholderHits.length} generated title(s) are from-a-link placeholders`,
    );
  }
  ok("no generated title is a from-a-link placeholder");

  console.log(`\n  ${step} checks passed. No id reaches any customer-facing surface.\n`);
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

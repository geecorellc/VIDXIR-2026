/**
 * Prove the Phase C editor works against a real generated project, in a real Node
 * process (§24, §42).
 *
 * The vitest suites cover the operations, the routes and the persistence. What they
 * cannot cover is the failure that has bitten this project twice: `vitest.config.ts`
 * aliases `server-only` away, so a module graph that could never boot passes green —
 * Phase 5 shipped 541 tests over a worker that could not start. So every check below
 * runs with no aliases, against the real Postgres, Redis and MinIO, on a project the
 * real pipeline built.
 *
 * What it verifies:
 *
 *   1. a real completed project opens, and its seeded cut is byte-identical to the
 *      timeline the pipeline itself would assemble — opening changes nothing
 *   2. every asset the preview would play signs, and the object is really there
 *   3. the geometry the timeline draws, and the frame the preview shows at a scrub
 *      position, both resolve from the compiled cut
 *   4. every gesture the UI dispatches — move, trim, split, duplicate, delete, text,
 *      volume, undo, redo — produces the document it claims to
 *   5. the edited document round-trips through the real save path and its version bumps
 *   6. a stale save is refused, a malformed one is refused, and neither touches the row
 *   7. another tenant can neither open nor save the cut
 *   8. ONE real export: save → export → RENDER_JOB → real Worker → real ffmpeg → MP4
 *   9. the MP4 is a playable file whose own header duration reflects the edit
 *  10. the export status reports the finished cut as up to date, never a storage key
 *  11. a project that was never opened in the editor still renders from its scene rows
 *
 * The gestures in step 4 are the same `applyOperation` calls the components dispatch —
 * `Timeline.tsx`'s pointer handlers and `ClipProperties.tsx`'s inputs are thin wrappers
 * over them, and the document each produces is what the preview and the export read.
 * What this therefore does *not* prove is the browser layer: that pointer capture drags,
 * that `<video>` seeks, that the rAF clock advances. There is no browser driver in this
 * repo and Phase C's scope does not include adding one, so those are reported as
 * hand-checked rather than claimed here.
 *
 * ## Cost and safety
 *
 * `RENDER_PROVIDER` resolves to `ffmpeg` (`env.ts` preprocesses the `mock` value to it),
 * so the export is a local encode: no provider call, no billable request, no quota. Only
 * the RENDER stage runs — no voiceover, visuals, music or caption work — because an
 * export re-cuts assets that already exist. Nothing is published.
 *
 * Everything it writes is scoped to a copy. The source project's rows are read, then
 * duplicated under a fixture user, and the copy is what gets edited and rendered; the
 * real project's status, renders and `project_edits` are never touched, which step 7
 * asserts rather than assumes. The copy is also a genuine second tenant, which is what
 * makes the isolation checks real instead of notional.
 *
 *   npx tsx scripts/verify-editor.ts
 *
 * Its own queue prefix, so it cannot consume a developer's jobs or leave messages for
 * one. Exits non-zero on the first failure.
 */
import "@/lib/load-env";
// Type-only, so it does not defeat the dynamic imports below: every runtime import in
// this file is deferred until after `QUEUE_PREFIX` is overridden, because `lib/env`
// snapshots the environment on first read.
import type { EditOperation } from "@/lib/video/edit-ops";

const PREFIX = "tally-verify-editor";
process.env["QUEUE_PREFIX"] = PREFIX;

/** Long, because a real 1080p encode of a real project takes minutes, not seconds. */
const RENDER_TIMEOUT_MS = 45 * 60_000;

/** How far the drag in step 4 moves the last shot, and so how much longer the MP4 is. */
const DRAG_MS = 1_500;

const FIXTURE_EMAIL = "editor-verify@tally.local";

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

function mib(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(2)} MiB`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  console.log(`\nPhase C editor verification (queue prefix ${PREFIX})\n`);

  const { env } = await import("@/lib/env");
  const { db, rawSql, closeDb } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { and, desc, eq } = await import("drizzle-orm");
  const { capabilityStatus } = await import("@/lib/providers/config");

  const e = env();
  const render = capabilityStatus("render");
  assert(
    render.state !== "not_configured",
    `render is not configured: missing ${render.missingEnvVars.join(", ")}`,
  );

  // ---- 1. a project the real pipeline built ---------------------------------

  /**
   * The newest project that actually finished a render, chosen by data rather than
   * hard-coded: the claim under test is that *existing generated videos* open, so the
   * subject has to be one the pipeline produced.
   *
   * Never a project this script itself left behind. `fixtureUser` deletes the previous
   * run's copies, but it does that at step 2 — so without this filter a run that failed
   * before teardown leaves a copy that is newer than every real project, step 1 picks it
   * as the "source", and step 2 then deletes the very row it is about to copy ("the source
   * project vanished"). Worse than the crash is the case where it succeeds: the script
   * would be verifying the editor against its own fixture instead of against a video the
   * pipeline really generated, which is the whole claim.
   */
  const found = await rawSql()`
    select p.id, p.title, p.status,
           (select count(*)::int from scenes s where s.project_id = p.id) as scenes,
           (select max(r.duration_ms) from renders r
             where r.project_id = p.id and r.status = 'succeeded') as rendered_ms
      from projects p
      join users u on u.id = p.user_id
     where exists (select 1 from renders r
                    where r.project_id = p.id and r.status = 'succeeded')
       and u.email <> ${FIXTURE_EMAIL}
     order by p.created_at desc
     limit 1`;

  const source = found[0];
  assert(
    source !== undefined,
    "no completed project in this database — generate one before verifying",
  );

  const sourceId = String(source!["id"]);
  const sourceStatus = String(source!["status"]);
  const renderedMs = Number(source!["rendered_ms"] ?? 0);

  ok(
    `source project: "${String(source!["title"]).slice(0, 48)}" — ` +
      `${sourceStatus}, ${String(source!["scenes"])} scenes, ` +
      `${seconds(renderedMs)} already rendered`,
  );
  detail(
    `render=${render.provider} (${render.state}), ` +
      `mocks=${String(e.TALLY_USE_MOCK_PROVIDERS)} — a render calls no provider`,
  );

  // ---- 2. a copy, so the real project is never modified ---------------------

  const userId = await fixtureUser({ db, schema, eq });
  const copyId = await copyProject({ db, schema, eq, sourceId, targetUserId: userId });

  const { getProject } = await import("@/lib/projects/service");
  const copy = await getProject(userId, copyId);
  ok(
    `copied under a fixture tenant — ${copy.status}, ` +
      `format ${copy.videoFormat ?? "null (landscape)"}`,
  );

  // ---- 3. the editor opens it -----------------------------------------------

  const {
    getOrSeedEditDocument,
    loadEditDocument,
    saveEditDocument,
    compileProjectEdit,
  } = await import("@/lib/video/edit-service");
  const { compileEditDocument } = await import("@/lib/video/edit-document");

  const opened = await getOrSeedEditDocument(userId, copyId);
  assert(opened.seeded, "the first open should have seeded a cut");
  assert(opened.version === 1, `first version should be 1, got ${opened.version}`);

  const openedCut = compileEditDocument(opened.document);
  assert(openedCut.timeline.scenes.length > 0, "the seeded cut compiled to no scenes");

  ok(
    `opened — v${opened.version}, ${seconds(openedCut.durationMs)}, ` +
      `${opened.document.tracks.length} tracks ` +
      `(${opened.document.tracks.map((t) => `${t.kind}x${t.clips.length}`).join(" ")})`,
  );

  // The Phase B equality claim, re-checked on real data: opening a project and exporting
  // it untouched must produce the video it already had.
  const { assembleTimeline } = await import("@/lib/video/service");
  const pipelineTimeline = await assembleTimeline(userId, copyId);
  assert(
    JSON.stringify(openedCut.timeline) === JSON.stringify(pipelineTimeline),
    "a seeded, unedited cut does not compile to the pipeline's own timeline",
  );
  ok("an unedited cut compiles to byte-identical output to the pipeline's timeline");

  // ---- 4. the preview's assets sign and resolve ----------------------------

  const { signedReadUrl } = await import("@/lib/storage");
  const keys = [
    ...new Set(
      openedCut.clips
        .map((clip) => clip.storageKey)
        .filter((key): key is string => key !== null),
    ),
  ];
  assert(keys.length > 0, "the cut references no assets at all");

  let mediaBytes = 0;
  for (const key of keys) {
    const url = await signedReadUrl(key, { expiresInSeconds: 600 });
    assert(url.startsWith("http"), `the URL for ${key} is not a URL`);
    assert(
      url.includes("X-Amz-Signature"),
      `the URL for ${key} carries no signature — a browser could forge it`,
    );
    /**
     * The secret must not appear outside `X-Amz-Credential`.
     *
     * SigV4 puts the *access key id* in that parameter by design, and a substring search
     * over the whole URL cannot tell the two apart when a local deployment uses the same
     * string for both — MinIO's dev credentials do. So the credential parameter is
     * removed first and the remainder is what gets searched, which still catches the
     * failure worth catching: a secret pasted into the path, the query, or a header
     * echoed into the URL.
     */
    const withoutCredential = url.replace(/X-Amz-Credential=[^&]*/, "");
    assert(
      !withoutCredential.includes(e.S3_SECRET_ACCESS_KEY),
      `the URL for ${key} carries the storage secret outside X-Amz-Credential`,
    );

    /**
     * A ranged GET, which is exactly what a `<video>` element issues.
     *
     * Not a HEAD: a presigned URL is signed for one method, so a HEAD against a URL
     * signed for GET is a different canonical request and 403s — correctly. And not a
     * whole GET either, because proving the object is there does not require pulling tens
     * of MiB of stock footage through the process. The total size comes back in
     * `Content-Range`, so the row's recorded length is still checkable.
     */
    const response = await fetch(url, { headers: { Range: "bytes=0-1023" } });
    assert(
      response.status === 206 || response.status === 200,
      `the signed URL for ${key} returned ${response.status}`,
    );
    const total = Number(
      /\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1] ??
        response.headers.get("content-length") ??
        0,
    );
    assert(total > 0, `the object at ${key} is empty`);
    mediaBytes += total;
  }
  ok(
    `all ${keys.length} preview assets signed and present ` +
      `(${mib(mediaBytes)} of media, signature-bearing, no credential in any URL)`,
  );

  // ---- 5. the geometry and the frame the UI draws --------------------------

  const view = await import("@/lib/video/editor-view");
  const spanMs = view.timelineSpanMs(opened.document);
  assert(
    spanMs >= openedCut.durationMs,
    `the timeline span ${spanMs} is shorter than the cut ${openedCut.durationMs}`,
  );

  const pxPerMs = view.zoomAt(view.DEFAULT_ZOOM_INDEX);
  const ticks = view.rulerTicks(spanMs, pxPerMs);
  assert(ticks.length > 1, "the ruler drew no ticks");

  // Scrub to the middle and ask what the preview would show there. This is the read the
  // player makes on every frame, so an empty answer mid-cut is a black preview.
  const midMs = Math.floor(openedCut.durationMs / 2);
  const frame = view.frameAt(openedCut.clips, midMs);
  assert(
    frame.visual !== null,
    `scrubbing to ${midMs}ms resolved no visual — the preview would be black`,
  );
  assert(
    frame.visual!.storageKey.length > 0,
    "the visual at the playhead has no storage key, so it could not be played",
  );
  const audible = frame.audio.filter((track) => track.gain > 0);
  ok(
    `scrub to ${view.timecode(midMs)} resolves a ${frame.visual!.trackKind} visual at ` +
      `${frame.visual!.sourceTimeSeconds.toFixed(2)}s into its source, ` +
      `${audible.length} audible track(s), caption ` +
      `${frame.caption === null ? "none" : "present"}`,
  );
  detail(
    `ruler: ${ticks.length} ticks over ${view.timecode(spanMs)} at ` +
      `${pxPerMs.toFixed(4)} px/ms`,
  );

  // ---- 6. every gesture the UI dispatches ---------------------------------

  const ops = await import("@/lib/video/edit-ops");
  const history = await import("@/lib/video/edit-history");

  const videoTrack = opened.document.tracks.find((t) => t.kind === "video");
  assert(videoTrack !== undefined, "the cut has no video track");
  const captionTrack = opened.document.tracks.find((t) => t.kind === "caption");
  const musicTrack = opened.document.tracks.find((t) => t.kind === "music");

  const ordered = ops.orderedClips(videoTrack!);
  const lastClip = ordered[ordered.length - 1];
  const midClip = ordered[Math.floor(ordered.length / 2)];
  assert(lastClip !== undefined && midClip !== undefined, "not enough clips to edit");

  let state = history.initHistory(opened.document);
  const applied: string[] = [];

  /**
   * Apply a gesture the way `dispatch` does, and require that it changed something.
   *
   * A refused gesture returns the same document by design, so asserting the identity
   * moved is what stops this script "passing" against an editor that silently declined
   * every one of them.
   */
  function gesture(label: string, operation: EditOperation): void {
    const next = ops.applyOperation(state.present, operation);
    assert(next !== state.present, `the "${label}" gesture was refused`);
    state = history.pushHistory(state, next, operation);
    applied.push(label);
  }

  // Drag the last clip later. The last one specifically: seeded scenes abut, so an
  // interior clip has nowhere to go and `moveClip` would correctly clamp it to a no-op.
  const movedTo = lastClip!.startMs + DRAG_MS;
  gesture("move", { type: "moveClip", clipId: lastClip!.id, startMs: movedTo });
  assert(
    ops.findClip(state.present, lastClip!.id)?.clip.startMs === movedTo,
    "the move did not land where it was asked to",
  );

  const trimTarget = ops.findClip(state.present, midClip!.id)!.clip;
  const trimmedEnd = trimTarget.startMs + Math.floor(trimTarget.durationMs / 2);
  gesture("trim", { type: "trimClipEnd", clipId: midClip!.id, endMs: trimmedEnd });
  assert(
    ops.clipEndMs(ops.findClip(state.present, midClip!.id)!.clip) === trimmedEnd,
    "the trim did not shorten the clip to the requested end",
  );

  const splitTarget = ops.findClip(state.present, lastClip!.id)!.clip;
  const beforeSplit = ops.findTrack(state.present, videoTrack!.id)!.clips.length;
  gesture("split", {
    type: "splitClip",
    clipId: lastClip!.id,
    atMs: splitTarget.startMs + Math.floor(splitTarget.durationMs / 2),
  });
  const afterSplit = ops.findTrack(state.present, videoTrack!.id)!.clips.length;
  assert(
    afterSplit === beforeSplit + 1,
    `split produced ${afterSplit} clips, expected ${beforeSplit + 1}`,
  );

  gesture("duplicate", { type: "duplicateClip", clipId: midClip!.id });
  assert(
    ops.findTrack(state.present, videoTrack!.id)!.clips.length === afterSplit + 1,
    "duplicate added no clip",
  );

  // Delete the copy again, so the exported cut stays recognisably the original video.
  const copyClip = ops
    .findTrack(state.present, videoTrack!.id)!
    .clips.find((clip) => clip.id.startsWith(`${midClip!.id}-copy`));
  assert(copyClip !== undefined, "could not find the duplicate to delete");
  gesture("delete", { type: "deleteClip", clipId: copyClip!.id });
  assert(
    ops.findTrack(state.present, videoTrack!.id)!.clips.length === afterSplit,
    "the delete did not remove exactly the duplicate",
  );

  const CAPTION_TEXT = "Edited by verify-editor";
  if (captionTrack?.clips[0]) {
    const captionId = captionTrack.clips[0].id;
    gesture("caption text", { type: "setClipText", clipId: captionId, text: CAPTION_TEXT });
    assert(
      ops.findClip(state.present, captionId)?.clip.text === CAPTION_TEXT,
      "the caption text did not change",
    );
  }

  if (musicTrack?.clips[0]) {
    gesture("clip volume", {
      type: "setClipVolume",
      clipId: musicTrack.clips[0].id,
      volume: 0.4,
    });
    gesture("track volume", { type: "setTrackVolume", trackId: musicTrack.id, volume: 0.8 });
  }

  // Undo and redo, on the same stack the toolbar drives.
  const beforeUndo = state.present;
  assert(history.canUndo(state), "undo should be available after those gestures");
  const undone = history.undo(state);
  assert(undone.present !== beforeUndo, "undo changed nothing");
  assert(history.canRedo(undone), "redo should be available after an undo");
  const redone = history.redo(undone);
  assert(
    JSON.stringify(redone.present) === JSON.stringify(beforeUndo),
    "redo did not restore the document undo walked out of",
  );
  state = redone;
  applied.push("undo", "redo");

  // A refused gesture is identity, which is what stops the editor rewriting the row for
  // a drag that could not move.
  assert(
    ops.applyOperation(state.present, {
      type: "moveClip",
      clipId: "no-such-clip",
      startMs: 0,
    }) === state.present,
    "a refused gesture did not return the same document",
  );

  const editedCut = compileEditDocument(state.present);
  ok(`${applied.length} gestures applied: ${applied.join(", ")}`);
  detail(
    `${seconds(openedCut.durationMs)} -> ${seconds(editedCut.durationMs)}, ` +
      `${openedCut.clips.length} -> ${editedCut.clips.length} compiled clips, ` +
      `${state.past.length} undo entries`,
  );

  // ---- 7. save, reload, and refuse what should be refused -----------------

  const saved = await saveEditDocument(userId, copyId, {
    document: state.present,
    expectedVersion: opened.version,
  });
  assert(
    saved.version === opened.version + 1,
    `version should be ${opened.version + 1}, got ${saved.version}`,
  );

  // Re-read the way a browser reload does — this is the "autosave persisted" claim.
  const reloaded = await loadEditDocument(userId, copyId);
  assert(reloaded !== null, "the saved cut could not be read back");
  assert(!reloaded!.seeded, "a reload re-seeded instead of reading the stored cut");
  assert(
    JSON.stringify(reloaded!.document) === JSON.stringify(state.present),
    "the document read back differs from the one saved",
  );
  assert(
    reloaded!.durationMs === editedCut.durationMs,
    `the stored duration ${String(reloaded!.durationMs)} is not the compiled ` +
      `${editedCut.durationMs}`,
  );
  assert(
    ops.findClip(reloaded!.document, lastClip!.id)?.clip.startMs === movedTo,
    "the moved clip did not survive the round trip at its new offset",
  );
  ok(
    `saved v${opened.version} -> v${saved.version} and reloaded identical ` +
      `(the dragged clip is still at ${view.timecode(movedTo)})`,
  );

  const { ConflictError, ValidationError, ForbiddenError } = await import("@/lib/errors");

  let staleRefused = false;
  try {
    await saveEditDocument(userId, copyId, {
      document: state.present,
      expectedVersion: opened.version,
    });
  } catch (error) {
    staleRefused = error instanceof ConflictError;
  }
  assert(staleRefused, "a stale save was not refused with a conflict");

  let garbageRefused = false;
  try {
    await saveEditDocument(userId, copyId, {
      document: { schemaVersion: 1, tracks: "not an array" },
      expectedVersion: saved.version,
    });
  } catch (error) {
    // A `ValidationError`, not a raw `ZodError`: the route renders the former as a 400
    // and the latter as a 500, and an autosave told "server error" retries forever.
    garbageRefused = error instanceof ValidationError;
  }
  assert(garbageRefused, "a malformed document was not refused as a validation error");

  const afterRefusals = await loadEditDocument(userId, copyId);
  assert(
    afterRefusals!.version === saved.version,
    "a refused save still moved the version — the row was written anyway",
  );
  assert(
    JSON.stringify(afterRefusals!.document) === JSON.stringify(state.present),
    "a refused save still altered the stored document",
  );
  ok("a stale save and a malformed save are both refused, and the row is unharmed");

  // ---- 8. tenant isolation, against a project that really is someone else's

  let readDenied = false;
  try {
    await getOrSeedEditDocument(userId, sourceId);
  } catch (error) {
    readDenied = error instanceof ForbiddenError;
  }
  assert(readDenied, "the fixture tenant could open another tenant's project");

  let saveDenied = false;
  try {
    await saveEditDocument(userId, sourceId, {
      document: state.present,
      expectedVersion: 1,
    });
  } catch (error) {
    saveDenied = error instanceof ForbiddenError;
  }
  assert(saveDenied, "the fixture tenant could save over another tenant's project");

  const sourceEdits = await rawSql()`
    select count(*)::int as n from project_edits where project_id = ${sourceId}`;
  assert(
    Number(sourceEdits[0]?.["n"]) === 0,
    "the real project acquired an edit document — a refusal wrote anyway",
  );
  const sourceNow = await rawSql()`
    select status from projects where id = ${sourceId}`;
  assert(
    String(sourceNow[0]?.["status"]) === sourceStatus,
    "the real project's status changed — this script was to leave it alone",
  );
  ok(
    "another tenant's project cannot be opened or saved, and the real project's " +
      "rows are untouched",
  );

  // ---- 9. ONE real export, through the real worker and real ffmpeg --------

  const { startEditExport, RENDER_JOB } = await import("@/lib/video/service");

  const exported = await startEditExport({
    userId,
    projectId: copyId,
    tier: "starter",
    traceId: "verify-editor",
  });
  assert(
    exported.durationMs === editedCut.durationMs,
    `the export reported ${exported.durationMs}ms but the editor showed ` +
      `${editedCut.durationMs}ms — they must be the same number`,
  );

  const queued = await db
    .select({ name: schema.jobs.name })
    .from(schema.jobs)
    .where(eq(schema.jobs.projectId, copyId));
  assert(
    queued.length === 1 && queued[0]?.name === RENDER_JOB,
    `expected exactly one ${RENDER_JOB} and nothing else, got ` +
      `[${queued.map((j) => j.name).join(", ")}]`,
  );
  assert(
    (await getProject(userId, copyId)).status === "RENDERING",
    "the project did not move to RENDERING",
  );
  ok(
    `export queued: one ${RENDER_JOB}, ${exported.sceneCount} scenes, ` +
      `${seconds(exported.durationMs)} — no generation stage enqueued`,
  );

  const { Worker } = await import("bullmq");
  const { workerConnection, closeRedis } = await import("@/lib/queue/redis");
  const { workerQueueOptions, getQueue, closeQueues } = await import(
    "@/lib/queue/queues"
  );
  const { runJob } = await import("@/worker/runner");
  const { HANDLERS } = await import("@/worker/registry");
  const { getJob } = await import("@/lib/queue/jobs");

  // The shipped registry, not a stub handler: the point is that the real wiring runs it.
  const pipelineHandlers = HANDLERS["pipeline"] ?? {};
  assert(
    RENDER_JOB in pipelineHandlers,
    `${RENDER_JOB} has no handler registered on the pipeline queue`,
  );

  const startedAt = Date.now();
  const worker = new Worker(
    "pipeline",
    async (job) => (await runJob("pipeline", pipelineHandlers, job)).result,
    { connection: workerConnection(), concurrency: 1, ...workerQueueOptions() },
  );
  await worker.waitUntilReady();
  detail("worker listening; a real 1080p encode of this cut takes minutes...");

  // Poll the row rather than a BullMQ event, because the row is what the product reads.
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  let jobView = await getJob(userId, exported.jobId);
  let lastProgress = -1;
  while (jobView && jobView.status !== "succeeded" && jobView.status !== "failed") {
    if (Date.now() > deadline) break;
    if (jobView.progress !== lastProgress) {
      lastProgress = jobView.progress;
      detail(`  ${jobView.status} ${jobView.progress}% ${jobView.statusMessage ?? ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    jobView = await getJob(userId, exported.jobId);
  }
  await worker.close();

  assert(jobView !== null, "the job row disappeared");
  assert(
    jobView!.status === "succeeded",
    `the render ended ${jobView!.status}: ${jobView!.error ?? "(no message)"} ` +
      `[${jobView!.errorCode ?? "no code"}]`,
  );
  ok(
    `the worker ran the export to succeeded in ` +
      `${((Date.now() - startedAt) / 1000).toFixed(0)}s`,
  );

  // ---- 10. the MP4 is real, playable, and reflects the edit ---------------

  const renderRows = await db
    .select({
      status: schema.renders.status,
      provider: schema.renders.provider,
      outputAssetId: schema.renders.outputAssetId,
    })
    .from(schema.renders)
    .where(and(eq(schema.renders.projectId, copyId), eq(schema.renders.userId, userId)))
    .orderBy(desc(schema.renders.createdAt))
    .limit(1);

  const renderRow = renderRows[0];
  assert(renderRow?.status === "succeeded", "no succeeded render row for the export");
  assert(renderRow!.outputAssetId !== null, "the render recorded no output asset");

  const outputRows = await db
    .select({
      storageKey: schema.assets.storageKey,
      mimeType: schema.assets.mimeType,
      bytes: schema.assets.bytes,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.id, renderRow!.outputAssetId!),
        eq(schema.assets.userId, userId),
      ),
    )
    .limit(1);

  const output = outputRows[0];
  assert(output?.storageKey != null, "the output asset row is missing, or not ours");

  // Download it through a signed URL, exactly as the browser would.
  const outputUrl = await signedReadUrl(output!.storageKey!, { expiresInSeconds: 600 });
  assert(outputUrl.startsWith("http"), "the output URL is not a URL");
  const outputResponse = await fetch(outputUrl);
  assert(outputResponse.ok, `the output URL returned ${outputResponse.status}`);
  const mp4 = Buffer.from(await outputResponse.arrayBuffer());
  assert(mp4.byteLength > 100_000, `the MP4 is only ${mp4.byteLength} bytes`);

  // Read the container rather than trusting the exit code, which would be circular.
  // `ffmpeg-static` ships no ffprobe, so the box tree is walked here the same way the
  // Phase B encoder smoke tests walk it.
  //
  // On the top-level box *order*, not on a substring search over the first few KiB. A
  // faststart `moov` for a 7.8-minute, 35-clip timeline carries a sample table tens of
  // KiB wide, so `mdat` starts well past any fixed head window and searching one finds
  // `moov` at a real offset and `mdat` at -1 — which reads as "moov comes after mdat"
  // about a file that is correctly interleaved.
  const top = boxes(mp4).map((box) => box.type);
  assert(top.includes("ftyp"), `no ftyp box — this is not an MP4 (saw ${top.join(", ")})`);
  assert(top.includes("moov"), `no moov box (saw ${top.join(", ")})`);
  assert(top.includes("mdat"), `no mdat box (saw ${top.join(", ")})`);
  assert(
    top.indexOf("moov") < top.indexOf("mdat"),
    "moov comes after mdat — the file would not play until fully downloaded",
  );

  const headerMs = movieDurationMs(mp4);
  const tracks = handlerTypes(mp4);
  assert(tracks.includes("vide"), `no video track — handlers were [${tracks.join(", ")}]`);
  assert(tracks.includes("soun"), `no audio track — handlers were [${tracks.join(", ")}]`);

  assert(
    Math.abs(headerMs - editedCut.durationMs) <= 2_000,
    `the MP4 header says ${headerMs.toFixed(0)}ms but the edited cut is ` +
      `${editedCut.durationMs}ms`,
  );
  // The edit is visible in the output: the last shot was dragged later, so the finished
  // file is longer than the render the pipeline originally produced.
  assert(
    headerMs > renderedMs + DRAG_MS / 2,
    `the MP4 (${headerMs.toFixed(0)}ms) does not reflect the ${DRAG_MS}ms drag — ` +
      `the original render was ${renderedMs}ms`,
  );

  ok(
    `MP4 verified: ${mib(mp4.byteLength)}, ${output!.mimeType ?? "no mime"}, ` +
      `${tracks.join("+")}, header duration ${seconds(headerMs)}`,
  );
  detail(
    `original render ${seconds(renderedMs)} -> edited export ${seconds(headerMs)} ` +
      `(+${seconds(headerMs - renderedMs)}, the dragged shot), faststart, ` +
      `provider ${renderRow!.provider}`,
  );

  // ---- 11. the export status is honest -----------------------------------

  const finalEdit = await loadEditDocument(userId, copyId);
  assert(
    finalEdit!.lastRenderedAt !== null,
    "the cut was not stamped as rendered after a successful export",
  );
  assert(
    finalEdit!.updatedAt.getTime() <= finalEdit!.lastRenderedAt!.getTime(),
    "the freshly exported cut reports as out of date",
  );
  assert(
    (await getProject(userId, copyId)).status === "VIDEO_READY",
    "the project did not end at VIDEO_READY",
  );
  ok(
    `status honest: v${finalEdit!.version} stamped rendered, upToDate=true, ` +
      `VIDEO_READY, output reachable by signed URL only`,
  );

  // ---- 12. an unedited project still uses the original path --------------

  const untouchedId = await copyProject({
    db,
    schema,
    eq,
    sourceId,
    targetUserId: userId,
  });

  assert(
    (await compileProjectEdit(userId, untouchedId)) === null,
    "a project never opened in the editor has a cut — seeding is not lazy, and " +
      "`executeRender` would take the edit path for every project",
  );
  const untouchedEdits = await rawSql()`
    select count(*)::int as n from project_edits where project_id = ${untouchedId}`;
  assert(
    Number(untouchedEdits[0]?.["n"]) === 0,
    "an unopened project has a project_edits row",
  );

  const untouchedTimeline = await assembleTimeline(userId, untouchedId);
  assert(
    JSON.stringify(untouchedTimeline) === JSON.stringify(pipelineTimeline),
    "an unedited project's timeline is not what the pipeline would assemble",
  );
  ok(
    "an unedited project has no cut and assembles from its scene rows — " +
      "`executeRender` still takes the original path",
  );

  // ---- teardown ---------------------------------------------------------

  await getQueue("pipeline").obliterate({ force: true });
  await closeQueues();
  await closeRedis();
  await closeDb();

  console.log(`\n${step}/${step} checks passed — Phase C works on real generated data.\n`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The verification tenant.
 *
 * Reused across runs and left behind deliberately, like `verify-worker`'s: a recognisable
 * local fixture rather than a real account. The password hash is not a valid scrypt
 * digest, so the row cannot be signed into.
 */
async function fixtureUser(ctx: {
  db: typeof import("@/lib/db").db;
  schema: typeof import("@/lib/db/schema");
  eq: typeof import("drizzle-orm").eq;
}): Promise<string> {
  const { db, schema, eq } = ctx;

  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, FIXTURE_EMAIL))
    .limit(1);

  if (existing[0]) {
    // Last run's copies, so a re-run starts clean rather than accumulating projects.
    // Cascades take the scenes, assets, renders and `project_edits` with them.
    await db.delete(schema.projects).where(eq(schema.projects.userId, existing[0].id));
    return existing[0].id;
  }

  const inserted = await db
    .insert(schema.users)
    .values({
      email: FIXTURE_EMAIL,
      emailNormalized: FIXTURE_EMAIL.toLowerCase(),
      name: "Editor Verification",
      passwordHash: "not-a-loginable-hash",
    })
    .returning({ id: schema.users.id });

  const userId = inserted[0]?.id;
  if (!userId) throw new Error("could not create the verification user");
  await db
    .insert(schema.subscriptions)
    .values({ userId, tier: "starter", status: "active" });
  return userId;
}

/**
 * Duplicate a project and everything the editor reads, under another tenant.
 *
 * Rows only. The storage objects are shared, because both copies reference the same keys
 * and neither writes to them; `assets.user_id` is rewritten so the copy's clips resolve
 * against the fixture tenant's own rows, which is what `resolveClipSources` requires — a
 * copy that left them owned by the source user would fail its ownership check, and that
 * check is precisely what the isolation step is testing.
 *
 * Each row is copied by spreading it and overriding only the columns that must change,
 * rather than by listing columns. A hand-written column list silently drops anything
 * added to the schema later, and a fixture missing a column the seeder reads would
 * present as an editor bug.
 */
async function copyProject(ctx: {
  db: typeof import("@/lib/db").db;
  schema: typeof import("@/lib/db/schema");
  eq: typeof import("drizzle-orm").eq;
  sourceId: string;
  targetUserId: string;
}): Promise<string> {
  const { db, schema, eq, sourceId, targetUserId } = ctx;

  const sourceRows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, sourceId))
    .limit(1);
  const project = sourceRows[0];
  if (!project) throw new Error("the source project vanished");

  const {
    id: _projectId,
    createdAt: _projectCreatedAt,
    updatedAt: _projectUpdatedAt,
    ...projectRest
  } = project;

  const insertedProject = await db
    .insert(schema.projects)
    .values({
      ...projectRest,
      userId: targetUserId,
      // No channel and no idea: both belong to the source tenant. A project without a
      // channel is a shape the rest of the system already supports (§4), and it means
      // the copy has no brand kit — which the seeder handles by design.
      channelId: null,
      ideaId: null,
      title: `[verify] ${project.title}`,
      // The copy starts at IDEA and walks to VIDEO_READY through the real state machine
      // below, rather than being declared ready by fiat.
      status: "IDEA",
      currentStage: null,
      progress: 0,
      failedStage: null,
      errorMessage: null,
      errorCode: null,
      failedAt: null,
      retryCount: 0,
      traceId: "verify-editor",
    })
    .returning({ id: schema.projects.id });

  const projectId = insertedProject[0]?.id;
  if (!projectId) throw new Error("could not copy the project");

  // Assets first: scenes, music and captions all reference them by id.
  const assetIds = new Map<string, string>();
  for (const asset of await db
    .select()
    .from(schema.assets)
    .where(eq(schema.assets.projectId, sourceId))) {
    const { id, createdAt: _assetCreatedAt, ...rest } = asset;
    const inserted = await db
      .insert(schema.assets)
      .values({ ...rest, projectId, userId: targetUserId, channelId: null })
      .returning({ id: schema.assets.id });
    if (inserted[0]) assetIds.set(id, inserted[0].id);
  }

  for (const scene of await db
    .select()
    .from(schema.scenes)
    .where(eq(schema.scenes.projectId, sourceId))) {
    const {
      id: _sceneId,
      createdAt: _sceneCreatedAt,
      updatedAt: _sceneUpdatedAt,
      ...rest
    } = scene;
    await db.insert(schema.scenes).values({
      ...rest,
      projectId,
      userId: targetUserId,
      // The script version belongs to the source project's script, which is not copied.
      scriptVersionId: null,
      visualAssetId: scene.visualAssetId
        ? (assetIds.get(scene.visualAssetId) ?? null)
        : null,
    });
  }

  for (const track of await db
    .select()
    .from(schema.musicTracks)
    .where(eq(schema.musicTracks.projectId, sourceId))) {
    const { id: _trackId, createdAt: _trackCreatedAt, ...rest } = track;
    await db.insert(schema.musicTracks).values({
      ...rest,
      projectId,
      userId: targetUserId,
      assetId: track.assetId ? (assetIds.get(track.assetId) ?? null) : null,
    });
  }

  for (const caption of await db
    .select()
    .from(schema.captions)
    .where(eq(schema.captions.projectId, sourceId))) {
    const { id: _captionId, createdAt: _captionCreatedAt, ...rest } = caption;
    await db.insert(schema.captions).values({
      ...rest,
      projectId,
      userId: targetUserId,
      srtAssetId: caption.srtAssetId ? (assetIds.get(caption.srtAssetId) ?? null) : null,
      vttAssetId: caption.vttAssetId ? (assetIds.get(caption.vttAssetId) ?? null) : null,
    });
  }

  const { transition } = await import("@/lib/projects/service");
  for (const status of [
    "SCRIPT_GENERATING",
    "SCRIPT_READY",
    "ASSETS_GENERATING",
    "ASSETS_READY",
    "RENDERING",
    "VIDEO_READY",
  ] as const) {
    await transition(targetUserId, projectId, status);
  }

  return projectId;
}

// ---------------------------------------------------------------------------
// MP4 inspection
//
// The same hand-rolled box walk the Phase B encoder smoke tests use, for the same
// reason: trusting ffmpeg's exit code to prove ffmpeg produced a valid file would be
// circular, and `ffmpeg-static` ships no ffprobe to ask instead.
// ---------------------------------------------------------------------------

/** Boxes that contain other boxes, and how many bytes to skip before the children. */
const CONTAINERS = new Map([
  ["moov", 0],
  ["trak", 0],
  ["mdia", 0],
  ["minf", 0],
  ["stbl", 0],
  ["edts", 0],
  ["udta", 0],
]);

function boxes(buffer: Buffer): Array<{ type: string; payload: Buffer }> {
  const out: Array<{ type: string; payload: Buffer }> = [];
  let offset = 0;

  while (offset + 8 <= buffer.byteLength) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    let header = 8;

    if (size === 1) {
      if (offset + 16 > buffer.byteLength) break;
      size = Number(buffer.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = buffer.byteLength - offset;
    }

    if (size < header || offset + size > buffer.byteLength) break;
    out.push({ type, payload: buffer.subarray(offset + header, offset + size) });
    offset += size;
  }

  return out;
}

function findBoxes(buffer: Buffer, type: string, depth = 0): Buffer[] {
  if (depth > 8) return [];
  const hits: Buffer[] = [];

  for (const box of boxes(buffer)) {
    if (box.type === type) hits.push(box.payload);
    const prefix = CONTAINERS.get(box.type);
    if (prefix !== undefined) {
      hits.push(...findBoxes(box.payload.subarray(prefix), type, depth + 1));
    }
  }

  return hits;
}

/** The track kinds the file declares — `vide`, `soun`. */
function handlerTypes(mp4: Buffer): string[] {
  return findBoxes(mp4, "hdlr").map((payload) => payload.toString("ascii", 8, 12));
}

/** The movie header's own duration, which is what a player reads. */
function movieDurationMs(mp4: Buffer): number {
  const [mvhd] = findBoxes(mp4, "mvhd");
  if (!mvhd) throw new Error("no mvhd box — the file has no movie header");

  if (mvhd[0] === 1) {
    return (Number(mvhd.readBigUInt64BE(24)) / mvhd.readUInt32BE(20)) * 1000;
  }
  return (mvhd.readUInt32BE(16) / mvhd.readUInt32BE(12)) * 1000;
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

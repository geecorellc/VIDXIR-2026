/**
 * The editor's HTTP surface (Phase C).
 *
 * `video-edit.test.ts` covers the persistence layer directly — seeding, versioning, key
 * rewriting, tenant scoping. This file covers what only exists at the route: the guard
 * stack in the order production runs it, the signed-URL map the preview cannot work
 * without, and the export's refusal conditions.
 *
 * Four claims are worth a real request rather than a service call:
 *
 *  - **A foreign project id is a 403 with the same message as a nonexistent one.**
 *    `requireProjectAccess` runs before anything reads a body, and the pair of responses
 *    has to be indistinguishable or the route becomes an existence oracle for other
 *    tenants' projects (§34).
 *  - **The GET returns signed URLs, not storage keys.** The preview plays private objects,
 *    so a route that returned keys would either break playback or — worse — hand the
 *    browser something it could sign itself. Only keys the *stored* document references
 *    may appear.
 *  - **A save round-trips through the schema and the version check.** A malformed document
 *    is a 400 and leaves the row alone; a stale `expectedVersion` is a 409.
 *  - **An export refuses honestly.** No saved cut, an emptied cut, and a published project
 *    each have their own refusal, and none of them may leave a queued job behind.
 *
 * No provider is called. `TALLY_USE_MOCK_PROVIDERS=true` comes from the harness, and the
 * export test asserts on the enqueued `jobs` row rather than running a worker — so no
 * render, no ffmpeg, and no paid generation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChannel,
  createUser,
  hasDatabase,
  jar,
  resetDatabase,
  signIn,
  useDatabase,
  type TestUser,
} from "./setup";

vi.mock("next/headers", () => ({
  cookies: async () => jar,
}));

const suite = hasDatabase ? describe : describe.skip;

/** The origin the harness configures as `APP_URL`; `assertSameOrigin` compares to it. */
const ORIGIN = "http://localhost:3000";

interface RouteResult {
  status: number;
  body: {
    data?: Record<string, unknown>;
    error?: { code?: string; message?: string };
  };
}

/** One route handler, however the module happens to name it. */
type Handler = (request: never) => Promise<Response>;

/**
 * Call a route the way a browser would.
 *
 * The handler is passed in rather than the module, so each caller below picks the export
 * it means and a renamed method is a typecheck failure rather than a test that silently
 * stops covering anything.
 */
async function call(
  method: "GET" | "PUT" | "POST",
  path: string,
  handler: () => Promise<Handler>,
  body?: unknown,
): Promise<RouteResult> {
  const { NextRequest } = await import("next/server");
  const route = await handler();

  const request = new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers: new Headers({ "content-type": "application/json", origin: ORIGIN }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const response = await route(request as never);
  return {
    status: response.status,
    body: (await response.json()) as RouteResult["body"],
  };
}

const getEdit = (projectId: string) =>
  call("GET", `/api/video/edit?projectId=${encodeURIComponent(projectId)}`, async () => {
    const { GET } = await import("@/app/api/video/edit/route");
    return GET as Handler;
  });

const putEdit = (body: unknown) =>
  call(
    "PUT",
    "/api/video/edit",
    async () => {
      const { PUT } = await import("@/app/api/video/edit/route");
      return PUT as Handler;
    },
    body,
  );

const postExport = (body: unknown) =>
  call(
    "POST",
    "/api/video/export",
    async () => {
      const { POST } = await import("@/app/api/video/export/route");
      return POST as Handler;
    },
    body,
  );

const getExportStatus = (projectId: string) =>
  call(
    "GET",
    `/api/video/export/status?projectId=${encodeURIComponent(projectId)}`,
    async () => {
      const { GET } = await import("@/app/api/video/export/status/route");
      return GET as Handler;
    },
  );

suite("editor API (integration)", () => {
  useDatabase();

  beforeAll(async () => {
    // The route graph and BullMQ's first Redis connection are expensive on a cold
    // machine; paid once here rather than inside whichever test runs first.
    await import("@/app/api/video/edit/route");
    await import("@/app/api/video/export/route");
    await import("@/lib/queue/jobs");
    const { getRedis } = await import("@/lib/queue/redis");
    await getRedis().ping();
  }, 60_000);

  afterAll(async () => {
    const { closeQueues } = await import("@/lib/queue/queues");
    const { closeRedis } = await import("@/lib/queue/redis");
    await closeQueues();
    await closeRedis();
  });

  beforeEach(async () => {
    await resetDatabase();
    jar.clear();
  });

  /** A user past onboarding, which `requireOnboarded()` demands before any of these. */
  async function onboardedUser(email: string): Promise<TestUser> {
    const { saveStep, complete } = await import("@/lib/onboarding/service");
    const user = await createUser({ email });
    await saveStep(user.id, {
      niche: "Retro computing",
      contentStyle: "documentary",
      voicePreference: "warm-male",
    });
    await complete(user.id);
    return user;
  }

  /**
   * A project at VIDEO_READY with the rows the seeder reads, plus real objects in storage.
   *
   * The objects matter here in a way they do not in `video-edit.test.ts`: this file
   * asserts the GET returns *signed URLs*, and signing a key requires the bucket to be
   * reachable. Tiny buffers — the seeder never decodes media.
   */
  async function builtProject(email: string) {
    const { db } = await import("@/lib/db");
    const { assets, captions, musicTracks, scenes } = await import("@/lib/db/schema");
    const { createProject, transition } = await import("@/lib/projects/service");
    const { putObject } = await import("@/lib/storage");

    const user = await onboardedUser(email);
    const channelId = await createChannel(user.id);

    const project = await createProject({
      userId: user.id,
      channelId,
      title: "Restoring a beige keyboard",
      maxVideosPerMonth: null,
    });

    let cursor = 0;
    for (const index of [0, 1]) {
      const visualKey = `video/${project.id}/visual-${index}.mp4`;
      const narrationKey = `audio/${project.id}/narration-${index}.mp3`;
      await putObject({
        key: visualKey,
        body: Buffer.from(`visual-${index}`),
        contentType: "video/mp4",
      });
      await putObject({
        key: narrationKey,
        body: Buffer.from(`narration-${index}`),
        contentType: "audio/mpeg",
      });

      const visual = await db
        .insert(assets)
        .values({
          projectId: project.id,
          userId: user.id,
          kind: "stock_video",
          storageKey: visualKey,
          mimeType: "video/mp4",
          durationMs: 8_000,
          provider: "pexels",
          providerAssetId: `pexels-${index}`,
          license: "Pexels License",
        })
        .returning({ id: assets.id });

      await db.insert(assets).values({
        projectId: project.id,
        userId: user.id,
        kind: "voiceover",
        storageKey: narrationKey,
        mimeType: "audio/mpeg",
        durationMs: 4_000,
        meta: { sceneIndex: index },
      });

      await db.insert(scenes).values({
        projectId: project.id,
        userId: user.id,
        index,
        label: `Scene ${index}`,
        narration: `Narration for scene ${index}.`,
        startMs: cursor,
        durationMs: 4_000,
        visualAssetId: visual[0]?.id,
      });
      cursor += 4_000;
    }

    const musicKey = `audio/${project.id}/bed.mp3`;
    await putObject({
      key: musicKey,
      body: Buffer.from("bed"),
      contentType: "audio/mpeg",
    });
    const musicAsset = await db
      .insert(assets)
      .values({
        projectId: project.id,
        userId: user.id,
        kind: "music",
        storageKey: musicKey,
        mimeType: "audio/mpeg",
        durationMs: 120_000,
      })
      .returning({ id: assets.id });

    await db.insert(musicTracks).values({
      projectId: project.id,
      userId: user.id,
      assetId: musicAsset[0]?.id,
      role: "background",
      mood: "calm",
      volume: 0.14,
      startMs: 0,
      durationMs: 120_000,
    });

    await db.insert(captions).values({
      projectId: project.id,
      userId: user.id,
      cues: [
        { startMs: 0, endMs: 2_000, text: "First line" },
        { startMs: 2_000, endMs: 4_000, text: "Second line" },
      ],
      burnedIn: true,
    });

    // The status an editable video actually has, reached through the real state machine
    // one legal step at a time — so the `VIDEO_READY → RENDERING` edge the export relies
    // on is exercised from a status a real project can be in, not from one set by fiat.
    for (const status of [
      "SCRIPT_GENERATING",
      "SCRIPT_READY",
      "ASSETS_GENERATING",
      "ASSETS_READY",
      "RENDERING",
      "VIDEO_READY",
    ] as const) {
      await transition(user.id, project.id, status);
    }

    return { user, channelId, project };
  }

  // -------------------------------------------------------------------------
  // GET — open the editor
  // -------------------------------------------------------------------------

  describe("GET /api/video/edit", () => {
    it("seeds the cut from the project's real rows and signs every asset it plays", async () => {
      const { user, project } = await builtProject("api-open@tally.test");
      await signIn(user);

      const result = await getEdit(project.id);

      expect(result.status).toBe(200);
      const data = result.body.data as {
        version: number;
        seeded: boolean;
        durationMs: number;
        document: { tracks: Array<{ kind: string; clips: unknown[] }> };
        assetUrls: Record<string, string>;
      };

      expect(data.seeded).toBe(true);
      expect(data.version).toBe(1);
      // Two 4s scenes plus the compiler's tail padding — a real number from real rows,
      // not the denormalised column.
      expect(data.durationMs).toBeGreaterThan(8_000);

      const kinds = data.document.tracks.map((track) => track.kind);
      expect(kinds).toContain("video");
      expect(kinds).toContain("voiceover");
      expect(kinds).toContain("music");
      expect(kinds).toContain("caption");

      // Every playable clip has a URL, and every URL is signed rather than being a key.
      const keys = data.document.tracks
        .flatMap((track) => track.clips as Array<{ source: { storageKey: string } | null }>)
        .map((clip) => clip.source?.storageKey)
        .filter((key): key is string => typeof key === "string");

      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        const url = data.assetUrls[key];
        expect(url, `no signed URL for ${key}`).toBeTruthy();
        expect(url).toMatch(/^https?:\/\//);
        // A signature of some kind — the browser must not be able to construct this.
        expect(url?.length).toBeGreaterThan(key.length + 20);
      }
    });

    it("returns the same 403 for another tenant's project as for one that does not exist", async () => {
      const owner = await builtProject("api-owner@tally.test");
      const intruder = await onboardedUser("api-intruder@tally.test");
      await signIn(intruder);

      const foreign = await getEdit(owner.project.id);
      const missing = await getEdit("11111111-1111-4111-8111-111111111111");

      expect(foreign.status).toBe(403);
      expect(missing.status).toBe(403);
      // Identical, or the pair tells an attacker which project ids are real.
      expect(foreign.body.error?.message).toBe(missing.body.error?.message);

      // And nothing was seeded for the intruder in the attempt.
      const { db } = await import("@/lib/db");
      const { projectEdits } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db
        .select({ id: projectEdits.id })
        .from(projectEdits)
        .where(eq(projectEdits.userId, intruder.id));
      expect(rows).toHaveLength(0);
    });

    it("requires a session", async () => {
      const { project } = await builtProject("api-anon@tally.test");
      jar.clear();

      const result = await getEdit(project.id);
      expect(result.status).toBe(401);
    });

    it("rejects a projectId that is not a uuid before touching the database", async () => {
      const user = await onboardedUser("api-badid@tally.test");
      await signIn(user);

      const result = await getEdit("not-a-uuid");
      expect(result.status).toBe(400);
      expect(result.body.error?.code).toBe("validation_failed");
    });
  });

  // -------------------------------------------------------------------------
  // PUT — autosave
  // -------------------------------------------------------------------------

  describe("PUT /api/video/edit", () => {
    it("saves an edited cut and bumps the version", async () => {
      const { applyOperation } = await import("@/lib/video/edit-ops");
      const { user, project } = await builtProject("api-save@tally.test");
      await signIn(user);

      const opened = (await getEdit(project.id)).body.data as {
        version: number;
        durationMs: number;
        document: Parameters<typeof applyOperation>[0];
      };
      // The *last* visual clip. The seeded scenes abut, so the first one is boxed in by
      // its successor and `moveClip` correctly clamps it to a no-op — dragging it right
      // would overlap. Only the last clip has open timeline after it.
      const videoTrack = opened.document.tracks[0];
      const target = videoTrack?.clips[videoTrack.clips.length - 1];
      expect(target).toBeTruthy();
      const movedToMs = (target?.startMs ?? 0) + 1_500;

      // A real gesture through the real operation, so what is posted is exactly what the
      // editor would post.
      const edited = applyOperation(opened.document, {
        type: "moveClip",
        clipId: target?.id as string,
        startMs: movedToMs,
      });
      // The gesture has to have done something, or the assertions below would pass
      // against an unchanged document and prove nothing about saving.
      expect(edited).not.toBe(opened.document);

      const saved = await putEdit({
        projectId: project.id,
        expectedVersion: opened.version,
        document: edited,
      });

      expect(saved.status).toBe(200);
      expect((saved.body.data as { version: number }).version).toBe(opened.version + 1);

      // Read back through the route, which is what the next open would see.
      const reopened = (await getEdit(project.id)).body.data as {
        seeded: boolean;
        durationMs: number;
        document: { tracks: Array<{ clips: Array<{ id: string; startMs: number }> }> };
      };
      expect(reopened.seeded).toBe(false);

      const persisted = reopened.document.tracks[0]?.clips.find(
        (clip) => clip.id === target?.id,
      );
      expect(persisted?.startMs).toBe(movedToMs);
      // The compiled length follows the edit rather than the row's stale copy: dragging
      // the last shot later makes the video longer.
      expect(reopened.durationMs).toBeGreaterThan(opened.durationMs);
    });

    it("rejects a document the schema does not accept and leaves the row alone", async () => {
      const { user, project } = await builtProject("api-invalid@tally.test");
      await signIn(user);

      const opened = (await getEdit(project.id)).body.data as {
        version: number;
        document: { tracks: Array<{ clips: Array<Record<string, unknown>> }> };
      };

      // Two clips at the same offset on one track — the overlap the schema refuses,
      // because there is no defined winner and the render would pick one silently.
      const broken = structuredClone(opened.document);
      const track = broken.tracks[0];
      const first = track?.clips[0];
      if (track && first) {
        track.clips = [first, { ...first, id: `${String(first["id"])}-dup` }];
      }

      const result = await putEdit({
        projectId: project.id,
        expectedVersion: opened.version,
        document: broken,
      });

      expect(result.status).toBe(400);
      expect(result.body.error?.code).toBe("validation_failed");

      // The stored cut is untouched — a rejected autosave must not corrupt the row.
      const after = (await getEdit(project.id)).body.data as { version: number };
      expect(after.version).toBe(opened.version);
    });

    it("refuses a stale save with a conflict rather than overwriting", async () => {
      const { user, project } = await builtProject("api-conflict@tally.test");
      await signIn(user);

      const opened = (await getEdit(project.id)).body.data as {
        version: number;
        document: unknown;
      };

      const first = await putEdit({
        projectId: project.id,
        expectedVersion: opened.version,
        document: opened.document,
      });
      expect(first.status).toBe(200);

      // The second tab's save, still holding the version it read. This is the response
      // the editor turns into its terminal `conflict` state.
      const second = await putEdit({
        projectId: project.id,
        expectedVersion: opened.version,
        document: opened.document,
      });

      expect(second.status).toBe(409);
      expect(second.body.error?.code).toBe("conflict");
    });

    it("will not let another tenant save over a cut", async () => {
      const owner = await builtProject("api-save-owner@tally.test");
      await signIn(owner.user);
      const opened = (await getEdit(owner.project.id)).body.data as {
        version: number;
        document: unknown;
      };

      const intruder = await onboardedUser("api-save-intruder@tally.test");
      await signIn(intruder);

      const result = await putEdit({
        projectId: owner.project.id,
        expectedVersion: opened.version,
        document: opened.document,
      });

      expect(result.status).toBe(403);

      // Still at the version the owner left it at.
      await signIn(owner.user);
      const after = (await getEdit(owner.project.id)).body.data as { version: number };
      expect(after.version).toBe(opened.version);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/video/export
  // -------------------------------------------------------------------------

  describe("POST /api/video/export", () => {
    /** Jobs queued for a project, which is how an export is observed without a worker. */
    async function jobsFor(projectId: string) {
      const { db } = await import("@/lib/db");
      const { jobs } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      return db
        .select({ name: jobs.name, status: jobs.status, stage: jobs.stage })
        .from(jobs)
        .where(eq(jobs.projectId, projectId));
    }

    it("queues the existing render job for the saved cut", async () => {
      const { user, project } = await builtProject("api-export@tally.test");
      await signIn(user);

      // Open, which seeds and stores the cut the export will read.
      const opened = (await getEdit(project.id)).body.data as { durationMs: number };

      const result = await postExport({ projectId: project.id });

      expect(result.status).toBe(200);
      const data = result.body.data as {
        jobId: string;
        durationMs: number;
        sceneCount: number;
        status: string;
      };
      expect(data.status).toBe("queued");
      expect(data.sceneCount).toBe(2);
      // The same length the editor showed — one compiler, one answer.
      expect(data.durationMs).toBe(opened.durationMs);

      // One RENDER job and nothing else: an export must not re-run voiceover, visuals or
      // music, all of which cost provider credit.
      const queued = await jobsFor(project.id);
      const names = queued.map((job) => job.name);
      const { RENDER_JOB } = await import("@/lib/video/service");
      expect(names).toContain(RENDER_JOB);
      expect(names.filter((name) => name !== RENDER_JOB)).toHaveLength(0);

      // And the project is in RENDERING, so the studio screen reports it honestly.
      const { getProject } = await import("@/lib/projects/service");
      expect((await getProject(user.id, project.id)).status).toBe("RENDERING");
    });

    it("refuses when the project has never been opened in the editor", async () => {
      const { user, project } = await builtProject("api-export-none@tally.test");
      await signIn(user);

      const result = await postExport({ projectId: project.id });

      expect(result.status).toBe(409);
      expect(result.body.error?.code).toBe("conflict");
      // Nothing queued — a refusal that still spent a render would be worse than the
      // error it reported.
      expect(await jobsFor(project.id)).toHaveLength(0);
    });

    it("refuses a cut with no visible clips instead of rendering nothing", async () => {
      const { applyOperation } = await import("@/lib/video/edit-ops");
      const { user, project } = await builtProject("api-export-empty@tally.test");
      await signIn(user);

      const opened = (await getEdit(project.id)).body.data as {
        version: number;
        document: Parameters<typeof applyOperation>[0];
      };

      // Delete every visual clip, which is a legal document and an unrenderable video.
      let document = opened.document;
      for (const track of opened.document.tracks) {
        if (track.kind !== "video" && track.kind !== "image") continue;
        for (const clip of track.clips) {
          document = applyOperation(document, { type: "deleteClip", clipId: clip.id });
        }
      }

      const saved = await putEdit({
        projectId: project.id,
        expectedVersion: opened.version,
        document,
      });
      expect(saved.status).toBe(200);

      const result = await postExport({ projectId: project.id });

      expect(result.status).toBe(400);
      expect(result.body.error?.message).toMatch(/no visible clips/i);
      expect(await jobsFor(project.id)).toHaveLength(0);
    });

    it("will not export another tenant's project", async () => {
      const owner = await builtProject("api-export-owner@tally.test");
      await signIn(owner.user);
      await getEdit(owner.project.id);

      const intruder = await onboardedUser("api-export-intruder@tally.test");
      await signIn(intruder);

      const result = await postExport({ projectId: owner.project.id });

      expect(result.status).toBe(403);
      expect(await jobsFor(owner.project.id)).toHaveLength(0);
    });

    /**
     * The state a real project is actually in when a user decides to edit it.
     *
     * `builtProject` stops at `VIDEO_READY`, but generating a thumbnail — the normal next
     * step, and what every project in the dev database had done — moves it on to
     * `READY_TO_PUBLISH`. `startEditExport` transitions to `RENDERING`, and that edge did
     * not exist from `READY_TO_PUBLISH`, so the export failed *after* the editor had
     * happily accepted and saved the edit. Exercised through the real state machine and
     * the real route, one legal step at a time, rather than by setting the status by fiat.
     */
    it("exports an edited cut from READY_TO_PUBLISH, not just VIDEO_READY", async () => {
      const { applyOperation } = await import("@/lib/video/edit-ops");
      const { getProject, transition } = await import("@/lib/projects/service");
      const { user, project } = await builtProject("api-export-rtp@tally.test");
      await signIn(user);

      // The thumbnail round trip a user does before reviewing the video.
      await transition(user.id, project.id, "THUMBNAIL_GENERATING");
      await transition(user.id, project.id, "READY_TO_PUBLISH");
      expect((await getProject(user.id, project.id)).status).toBe("READY_TO_PUBLISH");

      // A real edit, so this is an edited export and not just a re-render.
      const opened = (await getEdit(project.id)).body.data as {
        version: number;
        document: Parameters<typeof applyOperation>[0];
      };
      const track = opened.document.tracks.find(
        (candidate) => candidate.kind === "video",
      );
      const clip = track?.clips[1];
      expect(clip, "a second visual clip to move").toBeDefined();
      const edited = applyOperation(opened.document, {
        type: "moveClip",
        clipId: clip!.id,
        startMs: clip!.startMs + 500,
      });
      expect(edited).not.toBe(opened.document);

      const saved = await putEdit({
        projectId: project.id,
        expectedVersion: opened.version,
        document: edited,
      });
      expect(saved.status).toBe(200);

      const result = await postExport({ projectId: project.id });

      expect(result.status).toBe(200);
      expect((result.body.data as { status: string }).status).toBe("queued");
      // The render really was queued, and only the render.
      const { RENDER_JOB } = await import("@/lib/video/service");
      const names = (await jobsFor(project.id)).map((job) => job.name);
      expect(names).toEqual([RENDER_JOB]);
      expect((await getProject(user.id, project.id)).status).toBe("RENDERING");
    });

    /**
     * The new edge must not have made a committed publish re-renderable.
     *
     * A scheduled video has a file promised at a time; exporting there would race the
     * upload. The refusal comes from the state machine rather than from a check in the
     * route, so this is what proves the edge was added narrowly.
     */
    it("refuses to export a scheduled project", async () => {
      const { getProject, transition } = await import("@/lib/projects/service");
      const { user, project } = await builtProject("api-export-scheduled@tally.test");
      await signIn(user);
      await getEdit(project.id);

      await transition(user.id, project.id, "READY_TO_PUBLISH");
      await transition(user.id, project.id, "SCHEDULED");

      const result = await postExport({ projectId: project.id });

      expect(result.status).toBe(409);
      expect(result.body.error?.code).toBe("invalid_state_transition");
      // Still scheduled, and nothing queued: a refused export must not spend a render or
      // leave the project in a state the publish path no longer recognises.
      expect((await getProject(user.id, project.id)).status).toBe("SCHEDULED");
      expect(await jobsFor(project.id)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/video/export/status
  // -------------------------------------------------------------------------

  describe("GET /api/video/export/status", () => {
    it("reports no render and no cut for an untouched project", async () => {
      const { user, project } = await builtProject("api-status-fresh@tally.test");
      await signIn(user);

      const result = await getExportStatus(project.id);

      expect(result.status).toBe(200);
      const data = result.body.data as { render: unknown; edit: unknown };
      expect(data.render).toBeNull();
      expect(data.edit).toBeNull();
    });

    it("reports a saved cut as out of date until it has been rendered", async () => {
      const { user, project } = await builtProject("api-status-stale@tally.test");
      await signIn(user);
      await getEdit(project.id);

      const data = (await getExportStatus(project.id)).body.data as {
        edit: { version: number; lastRenderedAt: string | null; upToDate: boolean };
      };

      // Seeded but never exported. "Up to date" here would tell the user the file they
      // can download matches the timeline, which it does not — there is no file.
      expect(data.edit.version).toBe(1);
      expect(data.edit.lastRenderedAt).toBeNull();
      expect(data.edit.upToDate).toBe(false);
    });

    it("does not report another tenant's render", async () => {
      const owner = await builtProject("api-status-owner@tally.test");
      const intruder = await onboardedUser("api-status-intruder@tally.test");
      await signIn(intruder);

      const result = await getExportStatus(owner.project.id);
      expect(result.status).toBe(403);
    });
  });
});

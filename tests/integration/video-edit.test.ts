/**
 * Edit-document persistence integration tests.
 *
 * `edit-document.test.ts` proves the compiler is correct as a pure function. It cannot
 * prove any of the claims that are actually about Postgres, and those are the ones that
 * matter for a tenant-scoped editable document:
 *
 *  - **Seeding reads the project's real rows.** The unit tests hand the seeder a
 *    hand-built `SeedInput`; only a database can show that the six queries behind it
 *    find the actual scene offsets, the chosen visual per scene, the voiceover assets
 *    keyed off `assets.meta.sceneIndex`, the newest caption row and the brand kit — and
 *    that the compiled result still equals `assembleTimeline`'s own output for the same
 *    project. That equality, measured through the database rather than through
 *    fixtures, is the real "existing generated videos open correctly" claim.
 *  - **Seeding is idempotent and race-safe.** `project_edits_project_key` is unique on
 *    `project_id`, and two concurrent opens must produce one cut, not a duplicate-key
 *    error surfaced to the user.
 *  - **A save cannot silently overwrite another tab's.** The optimistic-concurrency
 *    check is a `WHERE version = ?`, so only a real update can demonstrate that a stale
 *    save is refused rather than applied.
 *  - **Another tenant cannot read, seed or overwrite a cut.** Every query filters on
 *    `user_id`; that is only testable with two users and a valid id belonging to one of
 *    them (§34).
 *  - **An unedited project is untouched.** Nothing in the pipeline writes a document, so
 *    a project that is never opened in the editor has no row and renders exactly as it
 *    did before this table existed.
 *
 * No provider is called anywhere in this file. The assets are rows and small objects in
 * storage, which is all the seeder reads — it never decodes media.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
// Type-only, so it is erased and does not load the module before the mock below.
import type { EditDocument } from "@/lib/video/edit-document";
import {
  createChannel,
  createUser,
  hasDatabase,
  jar,
  resetDatabase,
  useDatabase,
} from "./setup";

vi.mock("next/headers", () => ({
  cookies: async () => jar,
}));

const suite = hasDatabase ? describe : describe.skip;

suite("edit document persistence", () => {
  useDatabase();

  beforeEach(async () => {
    await resetDatabase();
  });

  /**
   * A project at VIDEO_READY with every asset the seeder reads.
   *
   * Built through the real `createProject` and real inserts rather than through the
   * seven pipeline stages: the stages are covered by `video.test.ts`, and what this
   * file needs is the *rows they leave behind*. Offsets are written the way the
   * TIMELINE stage writes them — measured, accumulated, never estimated.
   */
  async function builtProject(email: string) {
    const { db } = await import("@/lib/db");
    const { assets, brandKits, captions, musicTracks, scenes } = await import(
      "@/lib/db/schema"
    );
    const { createProject } = await import("@/lib/projects/service");

    const user = await createUser({ email });
    const channelId = await createChannel(user.id);

    await db.insert(brandKits).values({
      channelId,
      userId: user.id,
      brandName: "Wired Cottage",
      primaryColor: "#22D3EE",
      fontPreference: "Inter",
      // One valid override and one out-of-range value, so the test can show the
      // document stores what the render used rather than what the kit claimed.
      captionStyle: { fontSizePx: 64, verticalPosition: 42 },
    });

    const project = await createProject({
      userId: user.id,
      channelId,
      title: "Budget smart home sensors",
      maxVideosPerMonth: null,
    });

    const narrationMs = [6_000, 11_400, 1_200];
    let cursor = 0;

    for (const [index, ms] of narrationMs.entries()) {
      const visual = await db
        .insert(assets)
        .values({
          projectId: project.id,
          userId: user.id,
          kind: index === 2 ? "stock_image" : "stock_video",
          storageKey: `video/${project.id}/visual-${index}.mp4`,
          mimeType: index === 2 ? "image/jpeg" : "video/mp4",
          durationMs: index === 2 ? null : 8_000,
          provider: "pexels",
          providerAssetId: `pexels-${index}`,
          license: "Pexels License",
        })
        .returning({ id: assets.id });

      await db.insert(assets).values({
        projectId: project.id,
        userId: user.id,
        kind: "voiceover",
        storageKey: `audio/${project.id}/narration-${index}.mp3`,
        mimeType: "audio/mpeg",
        durationMs: ms,
        // The key the seeder joins on, exactly as the voiceover stage writes it.
        meta: { sceneIndex: index },
      });

      // MIN_SCENE_MS is 1500, so scene 2's 1200ms line gets a 1500ms slot — the same
      // floor `buildTimeline` applies, written back by the TIMELINE stage.
      const durationMs = Math.max(1_500, ms);

      await db.insert(scenes).values({
        projectId: project.id,
        userId: user.id,
        index,
        label: `Scene ${index}`,
        narration: `Narration for scene ${index}.`,
        onScreenText: index === 1 ? "Look at this" : null,
        startMs: cursor,
        durationMs,
        visualAssetId: visual[0]?.id,
      });

      cursor += durationMs;
    }

    const musicAsset = await db
      .insert(assets)
      .values({
        projectId: project.id,
        userId: user.id,
        kind: "music",
        storageKey: `audio/${project.id}/bed.mp3`,
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
        { startMs: 0, endMs: 1_800, text: "First line" },
        { startMs: 1_800, endMs: 4_100, text: "Second line" },
        // Word-level, the length Whisper actually emits.
        { startMs: 4_100, endMs: 4_160, text: "a" },
      ],
      burnedIn: true,
    });

    return { user, channelId, project };
  }

  describe("seeding from an existing project", () => {
    it("compiles to the same timeline assembleTimeline builds from the same rows", async () => {
      const { getOrSeedEditDocument, compileProjectEdit } = await import(
        "@/lib/video/edit-service"
      );
      const { assembleTimeline } = await import("@/lib/video/service");

      const { user, project } = await builtProject("seed-equal@tally.test");

      // The pipeline's own answer, from the real rows.
      const expected = await assembleTimeline(user.id, project.id);

      await getOrSeedEditDocument(user.id, project.id);
      const compiled = await compileProjectEdit(user.id, project.id);

      // The whole document. This is the claim the phase rests on, measured through
      // Postgres rather than through a fixture: opening the editor and exporting
      // without touching anything cannot change the video.
      expect(compiled?.timeline).toEqual(expected);
    });

    it("reads the measured scene offsets rather than recomputing them", async () => {
      const { getOrSeedEditDocument } = await import("@/lib/video/edit-service");
      const { user, project } = await builtProject("seed-offsets@tally.test");

      const stored = await getOrSeedEditDocument(user.id, project.id);
      const video = stored.document.tracks.find((t) => t.id === "video-0");

      // 0, 6000, 17400 — accumulated from the real narration durations.
      expect(video?.clips.map((c) => c.startMs)).toEqual([0, 6_000, 17_400]);
      expect(stored.seeded).toBe(true);
      expect(stored.version).toBe(1);
    });

    it("resolves each clip to the asset row it actually plays", async () => {
      const { db } = await import("@/lib/db");
      const { assets } = await import("@/lib/db/schema");
      const { and, eq } = await import("drizzle-orm");
      const { getOrSeedEditDocument } = await import("@/lib/video/edit-service");

      const { user, project } = await builtProject("seed-assets@tally.test");
      const stored = await getOrSeedEditDocument(user.id, project.id);

      const sources = stored.document.tracks
        .flatMap((track) => track.clips)
        .map((clip) => clip.source)
        .filter((source): source is NonNullable<typeof source> => source !== null);

      expect(sources.length).toBeGreaterThan(0);

      // Every asset id on the document is a real row belonging to this user. A clip
      // pointing at a key with no row is how a "successful" export produces an ffmpeg
      // failure minutes later.
      for (const source of sources) {
        const rows = await db
          .select({ id: assets.id, storageKey: assets.storageKey })
          .from(assets)
          .where(and(eq(assets.id, source.assetId), eq(assets.userId, user.id)))
          .limit(1);

        expect(rows[0]?.storageKey).toBe(source.storageKey);
      }
    });

    it("stores the caption style the render used, not what the brand kit claimed", async () => {
      const { getOrSeedEditDocument } = await import("@/lib/video/edit-service");
      const { user, project } = await builtProject("seed-style@tally.test");

      const stored = await getOrSeedEditDocument(user.id, project.id);

      // fontSizePx 64 is in range and kept; verticalPosition 42 is not and falls back
      // to the default — the same filtering `pickStyle` applies on the render path.
      expect(stored.document.captions.style.fontSizePx).toBe(64);
      expect(stored.document.captions.style.verticalPosition).toBe(0.82);
    });

    it("returns the stored cut on a second open rather than reseeding", async () => {
      const { getOrSeedEditDocument, saveEditDocument } = await import(
        "@/lib/video/edit-service"
      );
      const { user, project } = await builtProject("seed-once@tally.test");

      const first = await getOrSeedEditDocument(user.id, project.id);

      const trimmed = JSON.parse(JSON.stringify(first.document)) as typeof first.document;
      const clip = trimmed.tracks[0]?.clips[0];
      if (!clip) throw new Error("fixture");
      clip.durationMs = 2_000;
      trimmed.tracks[0]!.clips = [clip];

      await saveEditDocument(user.id, project.id, {
        document: trimmed,
        expectedVersion: first.version,
      });

      const second = await getOrSeedEditDocument(user.id, project.id);

      // Reseeding would silently discard the user's cut and hand back the pipeline's,
      // which is the worst possible failure for an editor: the work is gone and
      // nothing reports an error.
      expect(second.seeded).toBe(false);
      expect(second.document.tracks[0]?.clips).toHaveLength(1);
      expect(second.version).toBe(2);
    });

    it("produces one cut when two opens race", async () => {
      const { db } = await import("@/lib/db");
      const { projectEdits } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const { getOrSeedEditDocument } = await import("@/lib/video/edit-service");

      const { user, project } = await builtProject("seed-race@tally.test");

      // Two tabs opening the editor at the same moment. Both seed; the unique index
      // decides, and neither call may surface a duplicate-key error.
      const [a, b] = await Promise.all([
        getOrSeedEditDocument(user.id, project.id),
        getOrSeedEditDocument(user.id, project.id),
      ]);

      const rows = await db
        .select({ id: projectEdits.id })
        .from(projectEdits)
        .where(eq(projectEdits.projectId, project.id));

      expect(rows).toHaveLength(1);
      // Both saw the same cut — the seed is a pure function of rows neither changed.
      expect(a.document).toEqual(b.document);
    });

    it("refuses to seed a project whose visuals stage has not run", async () => {
      const { db } = await import("@/lib/db");
      const { scenes } = await import("@/lib/db/schema");
      const { and, eq } = await import("drizzle-orm");
      const { getOrSeedEditDocument } = await import("@/lib/video/edit-service");
      const { AssetMissingError } = await import("@/lib/errors");

      const { user, project } = await builtProject("seed-incomplete@tally.test");

      await db
        .update(scenes)
        .set({ visualAssetId: null })
        .where(and(eq(scenes.projectId, project.id), eq(scenes.index, 1)));

      // The same refusal `assembleTimeline` makes. An editor opened onto a half-built
      // project would show a gap it could not explain.
      await expect(getOrSeedEditDocument(user.id, project.id)).rejects.toBeInstanceOf(
        AssetMissingError,
      );
    });

    it("leaves an unedited project with no row at all", async () => {
      const { db } = await import("@/lib/db");
      const { projectEdits } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const { loadEditDocument, compileProjectEdit } = await import(
        "@/lib/video/edit-service"
      );

      const { user, project } = await builtProject("never-edited@tally.test");

      // Nothing in the pipeline writes a document, so a project that is never opened
      // renders from its scene rows exactly as it did before this table existed.
      expect(await loadEditDocument(user.id, project.id)).toBeNull();
      expect(await compileProjectEdit(user.id, project.id)).toBeNull();

      const rows = await db
        .select({ id: projectEdits.id })
        .from(projectEdits)
        .where(eq(projectEdits.projectId, project.id));
      expect(rows).toHaveLength(0);
    });
  });

  describe("saving", () => {
    it("persists a cut and advances the version", async () => {
      const { getOrSeedEditDocument, saveEditDocument, loadEditDocument } = await import(
        "@/lib/video/edit-service"
      );
      const { user, project } = await builtProject("save-ok@tally.test");

      const opened = await getOrSeedEditDocument(user.id, project.id);
      const document = JSON.parse(JSON.stringify(opened.document)) as typeof opened.document;
      // Delete the middle shot — a real edit, and one that shortens the video.
      document.tracks[0]!.clips.splice(1, 1);

      const saved = await saveEditDocument(user.id, project.id, {
        document,
        expectedVersion: opened.version,
      });

      expect(saved.version).toBe(opened.version + 1);

      const reloaded = await loadEditDocument(user.id, project.id);
      expect(reloaded?.document.tracks[0]?.clips).toHaveLength(2);
      // The denormalised duration is the compiler's, so a project list can show a
      // length without compiling every cut.
      expect(reloaded?.durationMs).toBe(saved.durationMs);
    });

    it("refuses a stale save instead of overwriting the newer one", async () => {
      const { getOrSeedEditDocument, saveEditDocument, loadEditDocument } = await import(
        "@/lib/video/edit-service"
      );
      const { ConflictError } = await import("@/lib/errors");

      const { user, project } = await builtProject("save-conflict@tally.test");
      const opened = await getOrSeedEditDocument(user.id, project.id);

      const firstTab = JSON.parse(JSON.stringify(opened.document)) as typeof opened.document;
      firstTab.tracks[0]!.clips.splice(2, 1);
      await saveEditDocument(user.id, project.id, {
        document: firstTab,
        expectedVersion: opened.version,
      });

      // The second tab still holds the version it read before the first tab saved.
      const secondTab = JSON.parse(JSON.stringify(opened.document)) as typeof opened.document;
      secondTab.tracks[0]!.clips.splice(0, 1);

      await expect(
        saveEditDocument(user.id, project.id, {
          document: secondTab,
          expectedVersion: opened.version,
        }),
      ).rejects.toBeInstanceOf(ConflictError);

      // The first tab's work is intact. An editor is exactly the place a user has two
      // tabs open, and a last-write-wins save would erase whichever finished first.
      const reloaded = await loadEditDocument(user.id, project.id);
      expect(reloaded?.document.tracks[0]?.clips.map((c) => c.id)).toEqual([
        "scene-0-visual",
        "scene-1-visual",
      ]);
    });

    it("rejects a document the schema does not accept", async () => {
      const { getOrSeedEditDocument, saveEditDocument, loadEditDocument } = await import(
        "@/lib/video/edit-service"
      );

      const { user, project } = await builtProject("save-invalid@tally.test");
      const opened = await getOrSeedEditDocument(user.id, project.id);

      const malicious = JSON.parse(JSON.stringify(opened.document)) as Record<
        string,
        unknown
      >;
      // A negative offset would reach ffmpeg as an argument, and ffmpeg is not a
      // validator.
      (
        (malicious["tracks"] as Array<Record<string, unknown>>)[0]!["clips"] as Array<
          Record<string, unknown>
        >
      )[0]!["startMs"] = -5_000;

      await expect(
        saveEditDocument(user.id, project.id, {
          document: malicious,
          expectedVersion: opened.version,
        }),
      ).rejects.toThrow();

      // Nothing was written, so the stored cut is still the one that was opened.
      const reloaded = await loadEditDocument(user.id, project.id);
      expect(reloaded?.version).toBe(opened.version);
    });
  });

  describe("tenant isolation (§34)", () => {
    it("does not let another user read a cut", async () => {
      const { getOrSeedEditDocument, loadEditDocument, compileProjectEdit } =
        await import("@/lib/video/edit-service");

      const owner = await builtProject("iso-owner@tally.test");
      const intruder = await createUser({ email: "iso-intruder@tally.test" });

      await getOrSeedEditDocument(owner.user.id, owner.project.id);

      // A valid project id belonging to somebody else. Absent, not forbidden — leaking
      // existence is itself an isolation leak.
      expect(await loadEditDocument(intruder.id, owner.project.id)).toBeNull();
      expect(await compileProjectEdit(intruder.id, owner.project.id)).toBeNull();
    });

    it("does not let another user seed or overwrite a cut", async () => {
      const { db } = await import("@/lib/db");
      const { projectEdits } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const {
        getOrSeedEditDocument,
        saveEditDocument,
        loadEditDocument,
      } = await import("@/lib/video/edit-service");

      const owner = await builtProject("iso2-owner@tally.test");
      const intruder = await createUser({ email: "iso2-intruder@tally.test" });

      const opened = await getOrSeedEditDocument(owner.user.id, owner.project.id);

      const overwrite = JSON.parse(JSON.stringify(opened.document)) as typeof opened.document;
      overwrite.tracks[0]!.clips = [overwrite.tracks[0]!.clips[0]!];

      await expect(
        saveEditDocument(intruder.id, owner.project.id, {
          document: overwrite,
          expectedVersion: opened.version,
        }),
      ).rejects.toThrow();

      // Opening as the intruder must not create a second row for the same project
      // either — the unique index is on `project_id` alone.
      await expect(
        getOrSeedEditDocument(intruder.id, owner.project.id),
      ).rejects.toThrow();

      const rows = await db
        .select({ userId: projectEdits.userId })
        .from(projectEdits)
        .where(eq(projectEdits.projectId, owner.project.id));

      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(owner.user.id);

      const reloaded = await loadEditDocument(owner.user.id, owner.project.id);
      expect(reloaded?.document.tracks[0]?.clips).toHaveLength(3);
      expect(reloaded?.version).toBe(opened.version);
    });
  });

  /**
   * Asset ownership on save.
   *
   * `assetId` and `storageKey` are the only fields in the document that name something
   * outside it, and the export path signs a read URL for every `storageKey`. Shape
   * validation cannot cover this: a uuid belonging to another tenant is a perfectly
   * well-formed uuid. Each case below drives the real `saveEditDocument`.
   */
  describe("clip asset ownership (§34)", () => {
    /** A first clip with its source replaced, ready to hand to `saveEditDocument`. */
    function withFirstClipSource(
      document: EditDocument,
      source: Partial<NonNullable<EditDocument["tracks"][number]["clips"][number]["source"]>>,
    ): EditDocument {
      const next = JSON.parse(JSON.stringify(document)) as EditDocument;
      const clip = next.tracks[0]?.clips[0];
      if (!clip?.source) throw new Error("fixture has no first media clip");
      clip.source = { ...clip.source, ...source };
      return next;
    }

    it("accepts a cut that references only the tenant's own assets", async () => {
      const { getOrSeedEditDocument, saveEditDocument, loadEditDocument } =
        await import("@/lib/video/edit-service");

      const owner = await builtProject("asset-own@tally.test");
      const opened = await getOrSeedEditDocument(owner.user.id, owner.project.id);

      // A real edit, so this is not just "the seeded document round-trips": the first
      // clip is trimmed and shortened, and its asset is still the user's own.
      const edited = JSON.parse(JSON.stringify(opened.document)) as EditDocument;
      const clip = edited.tracks[0]!.clips[0]!;
      clip.durationMs = 4_000;
      clip.sourceInMs = 500;
      clip.sourceOutMs = 4_500;

      const saved = await saveEditDocument(owner.user.id, owner.project.id, {
        document: edited,
        expectedVersion: opened.version,
      });

      expect(saved.version).toBe(opened.version + 1);

      const reloaded = await loadEditDocument(owner.user.id, owner.project.id);
      expect(reloaded?.document.tracks[0]?.clips[0]?.sourceInMs).toBe(500);
      expect(reloaded?.document.tracks[0]?.clips[0]?.durationMs).toBe(4_000);
    });

    it("rejects a cut referencing another tenant's asset, and writes nothing", async () => {
      const { db } = await import("@/lib/db");
      const { assets } = await import("@/lib/db/schema");
      const { getOrSeedEditDocument, saveEditDocument, loadEditDocument } =
        await import("@/lib/video/edit-service");

      const owner = await builtProject("asset-victim@tally.test");
      const attacker = await builtProject("asset-attacker@tally.test");

      // A real asset row, owned by the victim. The attacker knows both its id and its
      // key — which is the point: neither may be enough.
      const victimAsset = await db
        .insert(assets)
        .values({
          projectId: owner.project.id,
          userId: owner.user.id,
          kind: "stock_video",
          storageKey: `video/${owner.project.id}/private-footage.mp4`,
          mimeType: "video/mp4",
          durationMs: 8_000,
        })
        .returning({ id: assets.id, storageKey: assets.storageKey });

      const opened = await getOrSeedEditDocument(
        attacker.user.id,
        attacker.project.id,
      );

      await expect(
        saveEditDocument(attacker.user.id, attacker.project.id, {
          document: withFirstClipSource(opened.document, {
            assetId: victimAsset[0]!.id,
            storageKey: victimAsset[0]!.storageKey!,
          }),
          expectedVersion: opened.version,
        }),
      ).rejects.toThrow(/not available/i);

      // All-or-nothing: the version is untouched, so no part of the cut was persisted.
      const reloaded = await loadEditDocument(
        attacker.user.id,
        attacker.project.id,
      );
      expect(reloaded?.version).toBe(opened.version);
    });

    it("rejects an unknown assetId with the same error as a forbidden one", async () => {
      const { getOrSeedEditDocument, saveEditDocument } = await import(
        "@/lib/video/edit-service"
      );

      const owner = await builtProject("asset-unknown@tally.test");
      const opened = await getOrSeedEditDocument(owner.user.id, owner.project.id);

      // A well-formed uuid that is not an asset at all. The message must match the
      // other-tenant case exactly, or the pair becomes an existence oracle.
      await expect(
        saveEditDocument(owner.user.id, owner.project.id, {
          document: withFirstClipSource(opened.document, {
            assetId: "00000000-0000-4000-8000-000000000abc",
          }),
          expectedVersion: opened.version,
        }),
      ).rejects.toThrow(/not available/i);
    });

    it("ignores storageKey entirely, so it cannot bypass or widen ownership", async () => {
      const { db } = await import("@/lib/db");
      const { assets } = await import("@/lib/db/schema");
      const { getOrSeedEditDocument, saveEditDocument, loadEditDocument } =
        await import("@/lib/video/edit-service");

      const owner = await builtProject("asset-key@tally.test");
      const victim = await builtProject("asset-key-victim@tally.test");

      const victimAsset = await db
        .insert(assets)
        .values({
          projectId: victim.project.id,
          userId: victim.user.id,
          kind: "stock_video",
          storageKey: `video/${victim.project.id}/leak-me.mp4`,
          mimeType: "video/mp4",
          durationMs: 8_000,
        })
        .returning({ storageKey: assets.storageKey });

      const opened = await getOrSeedEditDocument(owner.user.id, owner.project.id);
      const ownKey = opened.document.tracks[0]?.clips[0]?.source?.storageKey;
      expect(ownKey).toBeTruthy();

      // The attack the check has to defeat: keep an `assetId` that passes ownership and
      // swap only the key, which is the value the renderer signs.
      const saved = await saveEditDocument(owner.user.id, owner.project.id, {
        document: withFirstClipSource(opened.document, {
          storageKey: victimAsset[0]!.storageKey!,
        }),
        expectedVersion: opened.version,
      });

      expect(saved.version).toBe(opened.version + 1);

      // Accepted, because the id was legitimate — but the key was discarded and rewritten
      // from the asset row, so the victim's object is nowhere in the stored cut.
      const stored = await loadEditDocument(owner.user.id, owner.project.id);
      expect(stored?.document.tracks[0]?.clips[0]?.source?.storageKey).toBe(ownKey);

      const serialised = JSON.stringify(stored?.document);
      expect(serialised).not.toContain("leak-me.mp4");

      // And the compiled cut the renderer actually consumes carries the owner's key, so
      // nothing downstream signs the injected one either.
      const { compileProjectEdit } = await import("@/lib/video/edit-service");
      const compiled = await compileProjectEdit(owner.user.id, owner.project.id);
      for (const clip of compiled?.clips ?? []) {
        expect(clip.storageKey).not.toBe(victimAsset[0]!.storageKey);
      }
    });
  });
});

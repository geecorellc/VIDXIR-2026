/**
 * Persistence for the edit document.
 *
 * Three operations, and the interesting decisions are all about what happens when
 * there is no row yet:
 *
 *  - `getOrSeedEditDocument` — open the editor. Returns the stored cut, or seeds one
 *    from the project's real scenes, assets, music and captions on first open.
 *  - `saveEditDocument` — autosave, with optimistic concurrency.
 *  - `compileProjectEdit` — the export path: read the cut and compile it to the
 *    `TimelineDocument` the existing renderer takes.
 *
 * Every function takes `userId` and filters on it in the query rather than checking
 * ownership afterwards, which is the convention the rest of the video service follows
 * (§34): a row belonging to another tenant is not found, not forbidden.
 *
 * Seeding is deliberately **lazy and non-destructive**. Nothing writes a document at
 * pipeline time, so a project that is never edited has no row and renders from its
 * scene rows exactly as it did before this existed. The first open is the only thing
 * that creates one, and the insert is `onConflictDoNothing` so two tabs opening at
 * once produce one cut rather than a race.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  assets,
  brandKits,
  captions,
  musicTracks,
  projectEdits,
  scenes as scenesTable,
} from "@/lib/db/schema";
import {
  AssetMissingError,
  ConflictError,
  ForbiddenError,
  ValidationError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getProject } from "@/lib/projects/service";
import { formatSpec } from "@/lib/video/format";
import {
  compileEditDocument,
  parseEditDocument,
  seedEditDocument,
  EditDocumentSchema,
  EDIT_DOCUMENT_VERSION,
  type ClipVisualKind,
  type CompiledEdit,
  type EditDocument,
  type SeedScene,
} from "@/lib/video/edit-document";
import type { TimelineCaptionStyle } from "@/lib/video/timeline";

const log = logger.child({ component: "video-edit" });

/** A stored cut, with the version a save has to quote back. */
export interface StoredEdit {
  projectId: string;
  version: number;
  document: EditDocument;
  durationMs: number | null;
  lastRenderedAt: Date | null;
  updatedAt: Date;
  /** True when this open created the row, so the UI can say "seeded from your video". */
  seeded: boolean;
}

/**
 * Load the project's cut, seeding one from its existing scenes on first open.
 *
 * The seed is what makes an already-generated video open correctly: it reads the same
 * rows `assembleTimeline` reads — scene offsets, the chosen visual per scene, the
 * voiceover assets, the music bed, the newest caption row, the brand kit — so the
 * document describes the video that was actually rendered rather than an approximation
 * of it.
 *
 * Throws `AssetMissingError` when a scene has no visual, for the same reason
 * `assembleTimeline` does: there is no cut to edit until the visuals stage has run,
 * and an editor opened onto a half-built project would show gaps it could not explain.
 */
export async function getOrSeedEditDocument(
  userId: string,
  projectId: string,
): Promise<StoredEdit> {
  // Ownership first, like `saveEditDocument`. No data could leak without it — every
  // query below filters on `userId`, so another tenant's project simply finds no scenes
  // — but the *refusal* would be an `AssetMissingError` from the seeder rather than a
  // `ForbiddenError`, telling a caller "this video has no scene plan" about a video that
  // is not theirs. This function is also not required to be reached through
  // `requireProjectAccess`, and a service that only refuses correctly when its caller
  // remembers to check is one refactor away from not refusing at all.
  await getProject(userId, projectId);

  const existing = await loadEdit(userId, projectId);
  if (existing) return existing;

  const document = await buildSeedDocument(userId, projectId);
  const { durationMs } = compileEditDocument(document);

  // `onConflictDoNothing` rather than a transaction: two tabs opening the same project
  // at once both seed, and the loser reads the winner's row below. Both would have
  // produced the same document — the seed is a pure function of rows neither changed —
  // so there is nothing to reconcile.
  await db
    .insert(projectEdits)
    .values({
      projectId,
      userId,
      version: 1,
      schemaVersion: EDIT_DOCUMENT_VERSION,
      document,
      durationMs,
    })
    .onConflictDoNothing();

  const stored = await loadEdit(userId, projectId);
  if (!stored) {
    // The insert was skipped and the row is still not visible, which means it belongs
    // to another tenant: `project_edits_project_key` is unique on `project_id` alone,
    // so a conflict from a different user is possible in principle. Refusing is the
    // isolation-safe answer.
    throw new ForbiddenError("Project not found or not accessible.");
  }

  log.info("seeded edit document from existing project", {
    projectId,
    tracks: document.tracks.length,
    durationMs,
  });

  return { ...stored, seeded: true };
}

/** Read the stored cut without creating one. Null when the project was never edited. */
export async function loadEditDocument(
  userId: string,
  projectId: string,
): Promise<StoredEdit | null> {
  return loadEdit(userId, projectId);
}

/**
 * Save a cut.
 *
 * `expectedVersion` is the version the client read. A mismatch is a `ConflictError`
 * rather than a silent overwrite: two tabs autosaving one project would otherwise let
 * whichever request arrived later erase the other's work, and an editor is exactly the
 * place a user has two tabs open.
 *
 * The document is re-validated here rather than trusted from the route, because this is
 * also the function a future worker-side migration would call.
 */
export async function saveEditDocument(
  userId: string,
  projectId: string,
  input: { document: unknown; expectedVersion: number },
): Promise<StoredEdit> {
  // Ownership before anything else. `getProject` throws `ForbiddenError` for a project
  // that is not this user's, so the update below cannot be used to probe for one.
  await getProject(userId, projectId);

  const parsed = parseIncomingDocument(input.document);
  // Shape is not ownership: the schema proves `assetId` is a uuid and `storageKey` is a
  // bounded string, and neither says the bytes are this tenant's. Resolved before the
  // write so a rejected document is never persisted.
  const document = await resolveClipSources(userId, parsed);
  const { durationMs } = compileEditDocument(document);

  const updated = await db
    .update(projectEdits)
    .set({
      document,
      durationMs,
      schemaVersion: document.schemaVersion,
      version: input.expectedVersion + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectEdits.projectId, projectId),
        eq(projectEdits.userId, userId),
        // The concurrency check, in the WHERE rather than in a prior read: a
        // read-then-write would leave a window between them.
        eq(projectEdits.version, input.expectedVersion),
      ),
    )
    .returning({
      version: projectEdits.version,
      durationMs: projectEdits.durationMs,
      lastRenderedAt: projectEdits.lastRenderedAt,
      updatedAt: projectEdits.updatedAt,
    });

  const row = updated[0];
  if (!row) {
    const current = await loadEdit(userId, projectId);
    if (!current) {
      throw new ConflictError(
        "This video has no saved edit yet. Open the editor before saving.",
      );
    }
    throw new ConflictError(
      "This video was edited somewhere else. Reload to get the latest version.",
      { expectedVersion: input.expectedVersion, currentVersion: current.version },
    );
  }

  return {
    projectId,
    version: row.version,
    document,
    durationMs: row.durationMs,
    lastRenderedAt: row.lastRenderedAt,
    updatedAt: row.updatedAt,
    seeded: false,
  };
}

/**
 * Compile the project's cut for rendering.
 *
 * Returns null when the project has no saved cut, which is the signal to the render
 * path that it should assemble from scene rows as it always has. That null is the whole
 * of the backwards-compatibility story: an unedited project's render is byte-identical
 * to what it was before the editor existed, because it goes down the same code path.
 */
export async function compileProjectEdit(
  userId: string,
  projectId: string,
): Promise<CompiledEdit | null> {
  const stored = await loadEdit(userId, projectId);
  if (!stored) return null;
  return compileEditDocument(stored.document);
}

/** Record that the current cut has been exported. */
export async function markEditRendered(
  userId: string,
  projectId: string,
): Promise<void> {
  await db
    .update(projectEdits)
    .set({ lastRenderedAt: new Date() })
    .where(
      and(eq(projectEdits.projectId, projectId), eq(projectEdits.userId, userId)),
    );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Resolve every clip's asset against the tenant's own rows, and rewrite the keys.
 *
 * The document is `jsonb` a browser writes, and `assetId` plus `storageKey` are the only
 * two fields in it that name something outside the document. `EditDocumentSchema` proves
 * they are *well-formed*; it cannot prove they are **this tenant's**, and a signed read
 * URL is minted for every `clip.storageKey` on export (`signTimelineAssets`). Left
 * unchecked, a crafted save would hand a caller a signed URL for an arbitrary object.
 *
 * So the key the client sent is not validated — it is **discarded**. Each `assetId` is
 * looked up under `assets.userId = userId`, and `storageKey` is overwritten from the row.
 * That is what makes the check impossible to bypass by editing the key: even a correct
 * guess at another tenant's key never survives, because the value that gets stored comes
 * from the database rather than from the request. `kind` and `sourceDurationMs` are
 * refreshed from the row for the same reason — the compiler makes renderer decisions from
 * them (whether an input loops, whether it is a still) and they describe the file, not
 * the cut.
 *
 * A missing id and another tenant's id produce the identical error, deliberately: the
 * distinction is exactly the information that would turn this into an existence oracle.
 */
async function resolveClipSources(
  userId: string,
  document: EditDocument,
): Promise<EditDocument> {
  const ids = new Set<string>();
  for (const track of document.tracks) {
    for (const clip of track.clips) {
      if (clip.source) ids.add(clip.source.assetId);
    }
  }

  // A cut of nothing but text and captions references no assets at all, and is legal.
  if (ids.size === 0) return document;

  const rows = await db
    .select({
      id: assets.id,
      storageKey: assets.storageKey,
      kind: assets.kind,
      durationMs: assets.durationMs,
    })
    .from(assets)
    // Scoped by owner, not by project: a user's own footage is reusable across their
    // projects, and `assets.projectId` is nullable for exactly that (channel-level and
    // uploaded assets have no project). Tenant is the boundary that matters here.
    .where(and(eq(assets.userId, userId), inArray(assets.id, [...ids])));

  const byId = new Map(rows.map((row) => [row.id, row]));

  for (const id of ids) {
    const row = byId.get(id);
    // Same message whether the row is another tenant's, absent, or present but never
    // uploaded: all three are "you cannot reference this", and saying which would leak.
    if (!row?.storageKey) {
      throw new ValidationError(
        "This edit references media that is not available. Reload the editor and try again.",
        { assetId: id },
      );
    }
  }

  // Rejecting is all-or-nothing: a partially-resolved cut would be a different video
  // than the user saved, so the throw above happens before anything is rewritten.
  return {
    ...document,
    tracks: document.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => {
        if (!clip.source) return clip;
        const row = byId.get(clip.source.assetId);
        if (!row?.storageKey) return clip;
        return {
          ...clip,
          source: {
            ...clip.source,
            storageKey: row.storageKey,
            kind: isVisualKind(row.kind) ? row.kind : null,
            sourceDurationMs: row.durationMs,
          },
        };
      }),
    })),
  };
}

/**
 * Parse a document that came from a browser.
 *
 * `parseEditDocument` throws a `ZodError`, which is not an `AppError` — so `handle()`
 * would render an autosave of a malformed cut as a 500 "Something went wrong. The error
 * has been logged." That reads as a Vidxir AI fault for something the client got wrong, and
 * it tells the editor to keep retrying a body that will never be accepted. Translated
 * here, at the one boundary where the value is untrusted client input, so the route stays
 * free of a second schema.
 *
 * The issue paths are echoed in the same `fields` shape `parseJson` uses. They name
 * positions in a document the client already has, so nothing is disclosed by them.
 *
 * Deliberately not applied to `loadEdit`: a stored document failing the schema is our
 * bug or a bad migration, not a bad request, and a 500 is the honest answer there.
 */
function parseIncomingDocument(value: unknown): EditDocument {
  const result = EditDocumentSchema.safeParse(value);
  if (result.success) return result.data;

  throw new ValidationError("This cut could not be saved — it is not a valid edit.", {
    fields: result.error.issues.slice(0, 12).map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

async function loadEdit(
  userId: string,
  projectId: string,
): Promise<StoredEdit | null> {
  const rows = await db
    .select({
      version: projectEdits.version,
      document: projectEdits.document,
      durationMs: projectEdits.durationMs,
      lastRenderedAt: projectEdits.lastRenderedAt,
      updatedAt: projectEdits.updatedAt,
    })
    .from(projectEdits)
    .where(
      and(eq(projectEdits.projectId, projectId), eq(projectEdits.userId, userId)),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    projectId,
    version: row.version,
    // Parsed on the way out as well as in. The column is `jsonb`, so a document written
    // by an older deploy or touched by a migration is untrusted input here too, and a
    // shape error is better raised at open than inside the compiler.
    document: parseEditDocument(row.document),
    durationMs: row.durationMs,
    lastRenderedAt: row.lastRenderedAt,
    updatedAt: row.updatedAt,
    seeded: false,
  };
}

/**
 * Assemble a seed document from the project's real rows.
 *
 * Reads the same six things `assembleTimeline` reads, and in one round of parallel
 * queries for the same reason. The queries are duplicated here rather than imported
 * because `service.ts` keeps its loaders private and returns them shaped for
 * `buildTimeline`; what the seeder needs is asset *ids* as well as keys, so it can
 * record what each clip plays.
 */
async function buildSeedDocument(
  userId: string,
  projectId: string,
): Promise<EditDocument> {
  const sceneRows = await db
    .select({
      index: scenesTable.index,
      label: scenesTable.label,
      onScreenText: scenesTable.onScreenText,
      transition: scenesTable.transition,
      startMs: scenesTable.startMs,
      durationMs: scenesTable.durationMs,
      visualAssetId: scenesTable.visualAssetId,
    })
    .from(scenesTable)
    .where(and(eq(scenesTable.projectId, projectId), eq(scenesTable.userId, userId)))
    .orderBy(asc(scenesTable.index));

  if (sceneRows.length === 0) {
    throw new AssetMissingError("a scene plan for this video");
  }

  const [project, visuals, narrations, music, captionRow, brand] = await Promise.all([
    getProject(userId, projectId),
    loadVisuals(userId, projectId),
    loadNarrations(userId, projectId),
    loadMusicBed(userId, projectId),
    loadNewestCaptions(userId, projectId),
    loadBrand(userId, projectId),
  ]);

  const scenes: SeedScene[] = sceneRows.map((scene) => {
    const visual = visuals.get(scene.index);
    if (!visual) {
      // The same refusal `assembleTimeline` makes, and for the same reason: without a
      // visual there is no cut to edit. Not retryable as a provider fault — the visuals
      // stage has to run again.
      throw new AssetMissingError(`a visual for scene ${scene.index + 1}`);
    }

    return {
      index: scene.index,
      label: scene.label,
      onScreenText: scene.onScreenText,
      transition: scene.transition,
      startMs: scene.startMs,
      durationMs: scene.durationMs,
      visual,
      narration: narrations.get(scene.index) ?? null,
    };
  });

  return seedEditDocument({
    format: formatSpec(project.videoFormat).format,
    scenes,
    music,
    captions: captionRow,
    captionStyle: (brand?.captionStyle as Partial<TimelineCaptionStyle>) ?? null,
    brand: {
      primaryColor: brand?.primaryColor ?? null,
      secondaryColor: brand?.secondaryColor ?? null,
      fontPreference: brand?.fontPreference ?? null,
    },
  });
}

const VISUAL_KINDS: readonly ClipVisualKind[] = [
  "stock_video",
  "stock_image",
  "generated_video",
  "generated_image",
];

function isVisualKind(value: string): value is ClipVisualKind {
  return (VISUAL_KINDS as readonly string[]).includes(value);
}

/**
 * The chosen visual per scene, joined through `scenes.visual_asset_id`.
 *
 * An inner join rather than the two-query approach `service.ts` uses, because the
 * seeder needs both rows anyway and there is no second caller to share the asset map
 * with. Scenes whose asset row is gone or whose kind is not a visual are absent from
 * the map, and `buildSeedDocument` turns that absence into `AssetMissingError`.
 */
async function loadVisuals(
  userId: string,
  projectId: string,
): Promise<Map<number, SeedScene["visual"]>> {
  const rows = await db
    .select({
      index: scenesTable.index,
      assetId: assets.id,
      storageKey: assets.storageKey,
      kind: assets.kind,
      durationMs: assets.durationMs,
    })
    .from(scenesTable)
    .innerJoin(assets, eq(assets.id, scenesTable.visualAssetId))
    .where(
      and(
        eq(scenesTable.projectId, projectId),
        eq(scenesTable.userId, userId),
        eq(assets.userId, userId),
      ),
    );

  const out = new Map<number, SeedScene["visual"]>();
  for (const row of rows) {
    if (!row.storageKey || !isVisualKind(row.kind)) continue;
    out.set(row.index, {
      assetId: row.assetId,
      storageKey: row.storageKey,
      kind: row.kind,
      durationMs: row.durationMs,
    });
  }
  return out;
}

/**
 * Narration audio by scene index, keyed off `assets.meta.sceneIndex`.
 *
 * The same key and the same "later rows win" rule `service.ts` uses, so a regenerated
 * take replaces the previous one here exactly as it does on the pipeline's timeline.
 */
async function loadNarrations(
  userId: string,
  projectId: string,
): Promise<Map<number, NonNullable<SeedScene["narration"]>>> {
  const rows = await db
    .select({
      id: assets.id,
      storageKey: assets.storageKey,
      durationMs: assets.durationMs,
      meta: assets.meta,
    })
    .from(assets)
    .where(
      and(
        eq(assets.projectId, projectId),
        eq(assets.userId, userId),
        eq(assets.kind, "voiceover"),
      ),
    )
    .orderBy(asc(assets.createdAt));

  const out = new Map<number, NonNullable<SeedScene["narration"]>>();
  for (const row of rows) {
    const index = row.meta?.["sceneIndex"];
    if (typeof index !== "number" || !row.storageKey) continue;
    out.set(index, {
      assetId: row.id,
      storageKey: row.storageKey,
      durationMs: row.durationMs ?? 0,
    });
  }
  return out;
}

/** The background bed: newest `role='background'` row, as the pipeline picks it. */
async function loadMusicBed(
  userId: string,
  projectId: string,
): Promise<{
  assetId: string;
  storageKey: string;
  volume: number;
  startMs: number;
  durationMs: number | null;
  duckUnderNarration: boolean;
} | null> {
  const rows = await db
    .select({
      assetId: assets.id,
      storageKey: assets.storageKey,
      volume: musicTracks.volume,
      startMs: musicTracks.startMs,
      durationMs: musicTracks.durationMs,
      duckUnderNarration: musicTracks.duckUnderNarration,
    })
    .from(musicTracks)
    .innerJoin(assets, eq(assets.id, musicTracks.assetId))
    .where(
      and(
        eq(musicTracks.projectId, projectId),
        eq(musicTracks.userId, userId),
        eq(musicTracks.role, "background"),
      ),
    )
    .orderBy(desc(musicTracks.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row?.storageKey) return null;

  return {
    assetId: row.assetId,
    storageKey: row.storageKey,
    volume: row.volume,
    startMs: row.startMs,
    durationMs: row.durationMs,
    duckUnderNarration: row.duckUnderNarration,
  };
}

async function loadNewestCaptions(
  userId: string,
  projectId: string,
): Promise<{
  burnedIn: boolean;
  cues: Array<{ startMs: number; endMs: number; text: string }>;
} | null> {
  const rows = await db
    .select({ cues: captions.cues, burnedIn: captions.burnedIn })
    .from(captions)
    .where(and(eq(captions.projectId, projectId), eq(captions.userId, userId)))
    .orderBy(desc(captions.createdAt))
    .limit(1);

  return rows[0] ?? null;
}

/** The channel's brand kit. Null for a channel-less project, as elsewhere (§4). */
async function loadBrand(
  userId: string,
  projectId: string,
): Promise<{
  captionStyle: Record<string, unknown> | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  fontPreference: string | null;
} | null> {
  const project = await getProject(userId, projectId);
  if (!project.channelId) return null;

  const rows = await db
    .select({
      captionStyle: brandKits.captionStyle,
      primaryColor: brandKits.primaryColor,
      secondaryColor: brandKits.secondaryColor,
      fontPreference: brandKits.fontPreference,
    })
    .from(brandKits)
    .where(
      and(eq(brandKits.channelId, project.channelId), eq(brandKits.userId, userId)),
    )
    .limit(1);

  return rows[0] ?? null;
}

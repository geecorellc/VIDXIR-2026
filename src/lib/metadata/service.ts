/**
 * Metadata generation and editing (§17).
 *
 * Two rules shape this file:
 *
 *  - **A user edit is final until they say otherwise.** `edited_by_user` is set on
 *    any manual save, and regeneration refuses to overwrite an edited row unless
 *    explicitly forced. The Publish panel already tells the user this ("Edited by
 *    you — regenerating metadata will not overwrite this"), so the promise has to
 *    be kept server-side rather than by the button being hidden.
 *  - **Chapter timestamps are computed, never generated.** A timestamp is a claim
 *    about where something happens in the video file. The model contributes labels;
 *    the offsets come from the script's own per-section word counts at the same
 *    words-per-minute rate the duration estimate uses. Once real scene timings
 *    exist (Phase 5) they supersede this estimate, and `chaptersFrom` takes them
 *    when they are available.
 *
 * Unlike scripts, this runs inline in the request. It is a single short
 * generation on text already in the database — a few seconds, no media — so the
 * queue would add a poll cycle and a job row for nothing. If it grows a second
 * provider call it moves to the pipeline queue.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  brandKits,
  channelSettings,
  channels,
  scenes,
  scriptVersions,
  scripts,
  videoMetadata,
} from "@/lib/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { generateJson } from "@/lib/providers/ai";
import { getProject } from "@/lib/projects/service";
import { WORDS_PER_MINUTE } from "@/lib/scripts/prompt";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_TITLE_CHARS,
  MIN_CHAPTERS,
  normaliseHashtags,
  normaliseTags,
} from "@/lib/metadata/format";
import {
  METADATA_JSON_SCHEMA,
  METADATA_SYSTEM_PROMPT,
  MetadataDraftSchema,
  buildMetadataPrompt,
} from "@/lib/metadata/prompt";

const log = logger.child({ component: "metadata" });

export interface MetadataRecord {
  projectId: string;
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  chapters: Array<{ startMs: number; label: string }>;
  categoryId: string;
  defaultLanguage: string | null;
  editedByUser: boolean;
  generatedBy: string | null;
}

/** Read a project's metadata, or null when none has been generated. */
export async function getMetadata(
  userId: string,
  projectId: string,
): Promise<MetadataRecord | null> {
  const rows = await db
    .select()
    .from(videoMetadata)
    .where(
      and(
        eq(videoMetadata.projectId, projectId),
        eq(videoMetadata.userId, userId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    tags: row.tags,
    hashtags: row.hashtags,
    chapters: row.chapters,
    categoryId: row.categoryId,
    defaultLanguage: row.defaultLanguage,
    editedByUser: row.editedByUser,
    generatedBy: row.generatedBy,
  };
}

export interface GenerateMetadataInput {
  userId: string;
  projectId: string;
  /**
   * Overwrite a row the user has edited. Only ever set from an explicit
   * "regenerate anyway" action, never from an automated pass.
   */
  force?: boolean;
  traceId?: string | null;
}

/**
 * Generate metadata from the project's active script version.
 *
 * Requires a script: metadata written before the script would describe a video
 * that does not exist yet, which is the sort of plausible-looking fiction §42
 * exists to prevent.
 */
export async function generateMetadata(
  input: GenerateMetadataInput,
): Promise<MetadataRecord> {
  const project = await getProject(input.userId, input.projectId);

  const existing = await getMetadata(input.userId, input.projectId);
  if (existing?.editedByUser && !input.force) {
    throw new ConflictError(
      "This metadata was edited by hand. Regenerating would discard those " +
        "edits — confirm the regeneration to replace them.",
    );
  }

  const version = await activeVersion(input.userId, input.projectId);
  if (!version) {
    throw new NotFoundError(
      "There is no script yet. Metadata is written from the finished script.",
    );
  }

  /**
   * Channel context is optional (Phase 11 §4).
   *
   * The channel title, settings and brand kit only *enrich* the prompt — they name
   * the audience, the niche and the CTA. A project created from a pasted YouTube
   * link has no channel yet, and metadata for it is still worth writing: the model
   * falls back to the same defaults it already uses for a channel whose settings
   * screen was never filled in. So the three lookups are skipped rather than being
   * made to fail, and nothing downstream distinguishes "no channel" from "channel
   * with nothing configured", because for a prompt they are the same thing.
   */
  const channelId = project.channelId;
  const [channelRows, settingsRows, brandRows] = channelId
    ? await Promise.all([
        db
          .select({ title: channels.title })
          .from(channels)
          .where(
            and(eq(channels.id, channelId), eq(channels.userId, input.userId)),
          )
          .limit(1),
        db
          .select({
            niche: channelSettings.niche,
            targetAudience: channelSettings.targetAudience,
            contentLanguage: channelSettings.contentLanguage,
            keywords: channelSettings.keywords,
          })
          .from(channelSettings)
          .where(
            and(
              eq(channelSettings.channelId, channelId),
              eq(channelSettings.userId, input.userId),
            ),
          )
          .limit(1),
        db
          .select({
            brandName: brandKits.brandName,
            defaultCta: brandKits.defaultCta,
          })
          .from(brandKits)
          .where(
            and(
              eq(brandKits.channelId, channelId),
              eq(brandKits.userId, input.userId),
            ),
          )
          .limit(1),
      ])
    : ([[], [], []] as const);

  const settings = settingsRows[0];
  const language = settings?.contentLanguage ?? "en-US";

  const draft = await generateJson({
    system: METADATA_SYSTEM_PROMPT,
    prompt: buildMetadataPrompt({
      channelTitle: channelRows[0]?.title ?? null,
      niche: settings?.niche ?? null,
      targetAudience: settings?.targetAudience ?? null,
      contentLanguage: language,
      scriptTitle: version.title,
      titleIdeas: version.titleIdeas,
      hook: version.hook,
      introduction: version.introduction,
      sections: version.sections.map((s) => ({
        heading: s.heading,
        body: s.body,
      })),
      conclusion: version.conclusion,
      cta: version.cta,
      references: version.references,
      keywords: settings?.keywords ?? [],
      brandName: brandRows[0]?.brandName ?? null,
      defaultCta: brandRows[0]?.defaultCta ?? null,
    }),
    schema: MetadataDraftSchema,
    jsonSchema: METADATA_JSON_SCHEMA,
    maxTokens: 4_000,
    usage: {
      operation: "metadata.generate",
      userId: input.userId,
      projectId: input.projectId,
      traceId: input.traceId ?? null,
    },
  });

  const chapters = await chaptersFrom(
    input.userId,
    input.projectId,
    version,
    draft.chapterLabels,
  );

  const record: Omit<MetadataRecord, "projectId"> = {
    title: draft.title.slice(0, MAX_TITLE_CHARS),
    description: draft.description.slice(0, MAX_DESCRIPTION_CHARS),
    tags: normaliseTags(draft.tags),
    hashtags: normaliseHashtags(draft.hashtags),
    chapters,
    categoryId: draft.categoryId,
    defaultLanguage: language,
    // A regeneration replaces a generated row, so the flag resets: whatever is
    // stored now came from the model, not from the user.
    editedByUser: false,
    generatedBy: "ai",
  };

  await db
    .insert(videoMetadata)
    .values({
      projectId: input.projectId,
      userId: input.userId,
      ...record,
    })
    .onConflictDoUpdate({
      target: videoMetadata.projectId,
      set: { ...record, updatedAt: new Date() },
    });

  log.info("metadata generated", {
    userId: input.userId,
    projectId: input.projectId,
    stage: "METADATA",
    traceId: input.traceId ?? undefined,
    tagCount: record.tags.length,
    chapterCount: record.chapters.length,
  });

  return { projectId: input.projectId, ...record };
}

export interface UpdateMetadataInput {
  userId: string;
  projectId: string;
  title?: string;
  description?: string;
  tags?: string[];
  hashtags?: string[];
  chapters?: Array<{ startMs: number; label: string }>;
  categoryId?: string;
  madeForKids?: boolean;
}

/**
 * Apply a manual edit.
 *
 * Sets `editedByUser`, which is the whole reason this is a separate function
 * rather than a generic update: the flag is what protects the edit from the next
 * regeneration, and it must be impossible to save an edit without setting it.
 */
export async function updateMetadata(
  input: UpdateMetadataInput,
): Promise<MetadataRecord> {
  // Confirms ownership and existence before writing.
  await getProject(input.userId, input.projectId);

  const existing = await getMetadata(input.userId, input.projectId);
  if (!existing) {
    throw new NotFoundError(
      "There is no metadata to edit yet. Generate it from the script first.",
    );
  }

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) throw new ValidationError("A title is required.");
    if (title.length > MAX_TITLE_CHARS) {
      throw new ValidationError(
        `YouTube titles are limited to ${MAX_TITLE_CHARS} characters.`,
      );
    }
  }

  if (
    input.description !== undefined &&
    input.description.length > MAX_DESCRIPTION_CHARS
  ) {
    throw new ValidationError(
      `YouTube descriptions are limited to ${MAX_DESCRIPTION_CHARS} characters.`,
    );
  }

  const tags = input.tags === undefined ? undefined : normaliseTags(input.tags);

  const [row] = await db
    .update(videoMetadata)
    .set({
      ...(input.title === undefined ? {} : { title: input.title.trim() }),
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      ...(tags === undefined ? {} : { tags }),
      ...(input.hashtags === undefined
        ? {}
        : { hashtags: normaliseHashtags(input.hashtags) }),
      ...(input.chapters === undefined ? {} : { chapters: input.chapters }),
      ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
      ...(input.madeForKids === undefined
        ? {}
        : { madeForKids: input.madeForKids }),
      editedByUser: true,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(videoMetadata.projectId, input.projectId),
        eq(videoMetadata.userId, input.userId),
      ),
    )
    .returning();

  if (!row) throw new NotFoundError("Metadata not found.");

  return {
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    tags: row.tags,
    hashtags: row.hashtags,
    chapters: row.chapters,
    categoryId: row.categoryId,
    defaultLanguage: row.defaultLanguage,
    editedByUser: row.editedByUser,
    generatedBy: row.generatedBy,
  };
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

interface ActiveVersion {
  id: string;
  title: string;
  titleIdeas: string[];
  hook: string;
  introduction: string | null;
  sections: Array<{
    heading: string;
    body: string;
    talkingPoints?: string[];
    transition?: string;
  }>;
  conclusion: string | null;
  cta: string | null;
  references: Array<{ label: string; url?: string }>;
  estimatedDurationSeconds: number | null;
}

/** The active script version for a project, with the tenant predicate applied. */
export async function activeVersion(
  userId: string,
  projectId: string,
): Promise<ActiveVersion | null> {
  const rows = await db
    .select({
      id: scriptVersions.id,
      title: scriptVersions.title,
      titleIdeas: scriptVersions.titleIdeas,
      hook: scriptVersions.hook,
      introduction: scriptVersions.introduction,
      sections: scriptVersions.sections,
      conclusion: scriptVersions.conclusion,
      cta: scriptVersions.cta,
      references: scriptVersions.references,
      estimatedDurationSeconds: scriptVersions.estimatedDurationSeconds,
    })
    .from(scripts)
    .innerJoin(scriptVersions, eq(scriptVersions.id, scripts.activeVersionId))
    .where(and(eq(scripts.projectId, projectId), eq(scripts.userId, userId)))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Chapter offsets for the given labels.
 *
 * Prefers real scene timings when the pipeline has produced them — those are
 * measured from the assembled timeline. Falls back to the script's own word
 * distribution, which is an estimate derived from a stated rate rather than a
 * guess. Returns no chapters at all rather than made-up ones when neither source
 * is usable.
 *
 * YouTube requires a chapter at 00:00 and at least three chapters for the feature
 * to activate, so a shorter list is returned empty: two timestamps in a
 * description are noise that does nothing.
 */
export async function chaptersFrom(
  userId: string,
  projectId: string,
  version: Pick<ActiveVersion, "id" | "hook" | "sections">,
  labels: string[],
): Promise<Array<{ startMs: number; label: string }>> {
  if (labels.length < MIN_CHAPTERS) return [];

  // Real timings first. `start_ms` is written by the timeline stage from actual
  // audio durations, so when it exists it is not an estimate.
  const sceneRows = await db
    .select({ startMs: scenes.startMs, label: scenes.label })
    .from(scenes)
    .where(
      and(
        eq(scenes.projectId, projectId),
        eq(scenes.userId, userId),
        eq(scenes.scriptVersionId, version.id),
      ),
    )
    .orderBy(asc(scenes.index));

  const timed = sceneRows.filter(
    (s): s is { startMs: number; label: string | null } => s.startMs !== null,
  );

  if (timed.length >= labels.length) {
    return labels.map((label, i) => ({
      // Guaranteed by the length check; the index access is narrowed for
      // noUncheckedIndexedAccess.
      startMs: timed[i]?.startMs ?? 0,
      label,
    }));
  }

  // Estimate from word counts. The first label covers the hook and intro; each
  // subsequent label covers one section, in order.
  const blocks = [version.hook, ...version.sections.map((s) => s.body)];
  if (blocks.length < labels.length) return [];

  const msPerWord = (60 / WORDS_PER_MINUTE) * 1000;
  let cursor = 0;
  const chapters: Array<{ startMs: number; label: string }> = [];

  labels.forEach((label, i) => {
    chapters.push({ startMs: Math.round(cursor), label });
    const block = blocks[i];
    cursor += wordsIn(block ?? "") * msPerWord;
  });

  // A chapter list whose entries are not strictly increasing is rejected by
  // YouTube. An empty section body could produce a duplicate offset, so drop
  // rather than nudge — a nudged timestamp is invented data.
  for (let i = 1; i < chapters.length; i += 1) {
    const previous = chapters[i - 1];
    const current = chapters[i];
    if (!previous || !current || current.startMs <= previous.startMs) return [];
  }

  return chapters;
}

function wordsIn(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

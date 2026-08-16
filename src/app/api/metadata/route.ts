/**
 * /api/metadata — the title, description, tags and chapters a video publishes
 * with (§17).
 *
 * `GET` reads, `POST` generates from the active script, `PATCH` saves a manual
 * edit. `PATCH` is what the Publish panel's "Save changes" calls, and it sets
 * `edited_by_user`, which is what makes the panel's promise — "regenerating will
 * not overwrite this" — true rather than decorative.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  handle,
  parseJson,
  parseQuery,
  requireOnboarded,
  requireProjectAccess,
} from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { NotConfiguredError } from "@/lib/errors";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_TAG_CHARS,
  MAX_TITLE_CHARS,
} from "@/lib/metadata/format";
import {
  generateMetadata,
  getMetadata,
  updateMetadata,
} from "@/lib/metadata/service";
import { isCapabilityAvailable } from "@/lib/providers/config";

const QuerySchema = z.object({ projectId: z.string().uuid() });

const PostSchema = z.object({
  projectId: z.string().uuid(),
  /** Explicit confirmation that a hand-edited row may be replaced. */
  force: z.boolean().optional(),
});

const PatchSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(MAX_TITLE_CHARS).optional(),
  description: z.string().max(MAX_DESCRIPTION_CHARS).optional(),
  // The 50 here is an abuse bound, not the tag limit. `normaliseTags` keeps the
  // first 15 that fit YouTube's 500-character budget, so a user pasting twenty
  // tags gets a save that keeps fifteen rather than an error.
  tags: z.array(z.string().max(MAX_TAG_CHARS)).max(50).optional(),
  hashtags: z.array(z.string().max(30)).max(10).optional(),
  chapters: z
    .array(
      z.object({
        startMs: z.number().int().min(0),
        label: z.string().min(1).max(100),
      }),
    )
    .max(40)
    .optional(),
  categoryId: z.string().regex(/^\d{1,3}$/).optional(),
  madeForKids: z.boolean().optional(),
});

export async function GET(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    const { projectId } = parseQuery(request, QuerySchema);

    await requireProjectAccess(user.id, projectId);
    await enforce(rules().read, `metadata:${user.id}`);

    // Null rather than an empty shell: the panel says "Not generated yet", and a
    // blank row would look like a generation that produced nothing.
    return { metadata: await getMetadata(user.id, projectId) };
  });
}

export async function POST(request: NextRequest) {
  return handle(request, async ({ traceId }) => {
    const { user } = await requireOnboarded();
    const body = await parseJson(request, PostSchema);

    await requireProjectAccess(user.id, body.projectId);

    if (!isCapabilityAvailable("ai")) {
      throw new NotConfiguredError(
        "Claude",
        ["ANTHROPIC_API_KEY"],
        "Metadata is written from the script by Claude.",
      );
    }

    await enforce(rules().generation, `metadata:${user.id}`);

    const metadata = await generateMetadata({
      userId: user.id,
      projectId: body.projectId,
      force: body.force ?? false,
      traceId,
    });

    return { metadata };
  });
}

export async function PATCH(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    const body = await parseJson(request, PatchSchema);

    await requireProjectAccess(user.id, body.projectId);

    const metadata = await updateMetadata({
      userId: user.id,
      projectId: body.projectId,
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.description === undefined
        ? {}
        : { description: body.description }),
      ...(body.tags === undefined ? {} : { tags: body.tags }),
      ...(body.hashtags === undefined ? {} : { hashtags: body.hashtags }),
      ...(body.chapters === undefined ? {} : { chapters: body.chapters }),
      ...(body.categoryId === undefined ? {} : { categoryId: body.categoryId }),
      ...(body.madeForKids === undefined
        ? {}
        : { madeForKids: body.madeForKids }),
    });

    return { metadata };
  });
}

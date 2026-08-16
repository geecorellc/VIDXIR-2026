/**
 * /api/projects (§36).
 *
 * POST creates a project from a selected research idea — the hand-off from
 * "which video should I make" to "make it". GET lists them for the dashboard.
 *
 * The plan gate lives here, on the server, reading the `subscriptions` table
 * (§23, §24): a request cannot claim a tier, and starting a video is the action
 * the monthly allowance actually counts.
 */
import type { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  currentTier,
  handle,
  parseJson,
  parseQuery,
  requireChannelAccess,
  requireOnboarded,
} from "@/lib/api/guard";
import { db } from "@/lib/db";
import { channelSettings, ideas, projects } from "@/lib/db/schema";
import { ValidationError } from "@/lib/errors";
import { assertCanStartVideo } from "@/lib/plans/enforce";
import { createProject } from "@/lib/projects/service";

const CreateSchema = z.object({
  channelId: z.string().uuid(),
  /** The research idea to build. Omit only when a title is supplied. */
  ideaId: z.string().uuid().optional(),
  /** Free-text title, for a project started without research. */
  title: z.string().trim().min(3).max(200).optional(),
});

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    const body = await parseJson(request, CreateSchema);

    await requireChannelAccess(user.id, body.channelId);

    if (!body.ideaId && !body.title) {
      throw new ValidationError("Provide either an idea or a title.");
    }

    // Enforced before the row exists: the counter incremented inside
    // `createProject` is the record of a started video, not the gate on it.
    const tier = await currentTier(user.id);
    await assertCanStartVideo(user.id, tier);

    let title = body.title ?? "";
    let ideaId: string | null = null;

    if (body.ideaId) {
      // Ownership *and* channel are both checked. An idea belonging to this user
      // but a different channel would otherwise cross a channel boundary (§27).
      const rows = await db
        .select({ id: ideas.id, title: ideas.title, state: ideas.state })
        .from(ideas)
        .where(
          and(
            eq(ideas.id, body.ideaId),
            eq(ideas.userId, user.id),
            eq(ideas.channelId, body.channelId),
          ),
        )
        .limit(1);

      const idea = rows[0];
      if (!idea) throw new ValidationError("Idea not found for this channel.");
      if (idea.state === "used") {
        throw new ValidationError(
          "That idea has already been made into a video.",
        );
      }

      ideaId = idea.id;
      title = body.title ?? idea.title;
    }

    // The channel's preferred length seeds the project so the script generator
    // has a target without asking again (§28).
    const settings = await db
      .select({ length: channelSettings.preferredLengthSeconds })
      .from(channelSettings)
      .where(
        and(
          eq(channelSettings.channelId, body.channelId),
          eq(channelSettings.userId, user.id),
        ),
      )
      .limit(1);

    const project = await createProject({
      userId: user.id,
      channelId: body.channelId,
      title,
      ideaId,
      origin: "manual",
      targetDurationSeconds: settings[0]?.length ?? null,
    });

    return { project };
  });
}

const ListSchema = z.object({
  channelId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export async function GET(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    const query = parseQuery(request, ListSchema);

    const where = query.channelId
      ? and(
          eq(projects.userId, user.id),
          eq(projects.channelId, query.channelId),
        )
      : eq(projects.userId, user.id);

    const rows = await db
      .select({
        id: projects.id,
        channelId: projects.channelId,
        ideaId: projects.ideaId,
        title: projects.title,
        status: projects.status,
        currentStage: projects.currentStage,
        progress: projects.progress,
        errorMessage: projects.errorMessage,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .where(where)
      .orderBy(desc(projects.createdAt))
      .limit(query.limit);

    return { projects: rows };
  });
}

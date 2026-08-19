/**
 * /api/research/ideas (§7, §8, §29, §36).
 *
 * GET returns generated ideas with their six component scores and — for each one
 * — the source videos it was derived from. The provenance is part of the payload
 * rather than an extra request because §29 makes "where did this come from"
 * something the user should never have to dig for.
 *
 * PATCH records a save or a reject. That is training data for §26's feedback
 * loop, not just a UI preference, so it is persisted rather than held in React
 * state (§45).
 */
import type { NextRequest } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  assertUuid,
  handle,
  parseJson,
  parseQuery,
  requireChannelAccess,
  requireOnboarded,
} from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { db } from "@/lib/db";
import { ideas, researchResults } from "@/lib/db/schema";
import { NotFoundError } from "@/lib/errors";
import { setIdeaState } from "@/lib/research/ideas";

const QuerySchema = z.object({
  channelId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  /** Omit to see everything still in play; `new` is the default board view. */
  state: z.enum(["new", "saved", "rejected", "used", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** One source video, as shown under an idea. Metadata only — never media (§29). */
interface SourceView {
  id: string;
  title: string;
  url: string | null;
  channelTitle: string | null;
  publishedAt: Date | null;
  viewCount: number | null;
  viewsPerHour: number | null;
}

export async function GET(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    // Two queries, the second an IN over up to a few hundred source ids.
    await enforce(rules().read, `ideas:${user.id}`);
    const query = parseQuery(request, QuerySchema);

    await requireChannelAccess(user.id, query.channelId);

    const predicates = [
      eq(ideas.userId, user.id),
      eq(ideas.channelId, query.channelId),
    ];
    if (query.runId) predicates.push(eq(ideas.runId, query.runId));
    if (query.state !== "all") predicates.push(eq(ideas.state, query.state));

    const rows = await db
      .select({
        id: ideas.id,
        runId: ideas.runId,
        title: ideas.title,
        angle: ideas.angle,
        rationale: ideas.rationale,
        topic: ideas.topic,
        targetKeywords: ideas.targetKeywords,
        sourceResultIds: ideas.sourceResultIds,
        trendScore: ideas.trendScore,
        opportunityScore: ideas.opportunityScore,
        competitionScore: ideas.competitionScore,
        audienceFitScore: ideas.audienceFitScore,
        velocityScore: ideas.velocityScore,
        freshnessScore: ideas.freshnessScore,
        tallyScore: ideas.tallyScore,
        scoreBreakdown: ideas.scoreBreakdown,
        state: ideas.state,
        generatedBy: ideas.generatedBy,
        createdAt: ideas.createdAt,
      })
      .from(ideas)
      .where(and(...predicates))
      .orderBy(desc(ideas.tallyScore), desc(ideas.createdAt))
      .limit(query.limit);

    // Sources for the whole page in one query rather than one per idea. The
    // `userId` predicate is not redundant with the id list: it is what makes a
    // forged id in a `source_result_ids` array unable to read another tenant's
    // row (§34).
    const sourceIds = [...new Set(rows.flatMap((row) => row.sourceResultIds))];
    const sources = new Map<string, SourceView>();

    if (sourceIds.length > 0) {
      const sourceRows = await db
        .select({
          id: researchResults.id,
          title: researchResults.title,
          url: researchResults.url,
          channelTitle: researchResults.channelTitle,
          publishedAt: researchResults.publishedAt,
          viewCount: researchResults.viewCount,
          viewsPerHour: researchResults.viewsPerHour,
        })
        .from(researchResults)
        .where(
          and(
            eq(researchResults.userId, user.id),
            inArray(researchResults.id, sourceIds),
          ),
        );

      for (const row of sourceRows) {
        sources.set(row.id, {
          id: row.id,
          title: row.title,
          url: row.url,
          channelTitle: row.channelTitle,
          publishedAt: row.publishedAt,
          // `numeric` arrives as a string because view counts exceed 2^31.
          // Parsed here so the client gets a number or an honest null.
          viewCount: row.viewCount === null ? null : Number(row.viewCount),
          viewsPerHour: row.viewsPerHour,
        });
      }
    }

    return {
      ideas: rows.map((row) => ({
        ...row,
        sources: row.sourceResultIds
          .map((id) => sources.get(id))
          .filter((source): source is SourceView => source !== undefined),
      })),
    };
  });
}

const PatchSchema = z.object({
  ideaId: z.string().uuid(),
  /**
   * `used` is not accepted here. That transition belongs to project creation,
   * which is the only thing that knows a video was actually started.
   */
  state: z.enum(["new", "saved", "rejected"]),
});

export async function PATCH(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    await enforce(rules().mutation, `ideas:${user.id}`);
    const body = await parseJson(request, PatchSchema);

    assertUuid(body.ideaId, "ideaId");

    // `setIdeaState` scopes the UPDATE by `userId`, so a foreign id matches no
    // row and returns false rather than mutating someone else's idea.
    const updated = await setIdeaState(user.id, body.ideaId, body.state);
    if (!updated) throw new NotFoundError("Idea not found.");

    return { ideaId: body.ideaId, state: body.state };
  });
}

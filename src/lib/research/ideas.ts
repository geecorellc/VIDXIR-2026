/**
 * Original angle generation (§7, §8, §29).
 *
 * The spec is emphatic: *"Do not simply copy the most popular video."* The job
 * here is to read the evidence, work out **why** those videos got attention, and
 * propose something new that serves the same underlying demand.
 *
 * Three mechanisms enforce that rather than merely requesting it:
 *
 *  1. The prompt supplies the evidence as *signals to reason about*, and the
 *     schema demands a separate `angle` and `rationale` per idea — a copied title
 *     has no angle to state, so the shape itself resists it.
 *  2. `sourceResultIds` is recorded on every idea. Provenance is not decoration:
 *     it is what lets a user (or a copyright review) see exactly which public
 *     videos informed an idea.
 *  3. A post-generation similarity check rejects any title that is substantially
 *     a source title. The model is asked not to copy; this makes it verifiable.
 *
 * Scores are computed **here in code**, not by the model. The Tally Opportunity
 * Score has to be reproducible and explainable — a number a language model felt
 * was about right is neither, and §8 requires a configurable formula.
 */
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { ideas } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  generateJson,
  jsonSchema,
  stringArray,
  aiProviderName,
} from "@/lib/providers/ai";
import {
  parseWeightOverrides,
  scoreOpportunity,
  tokenize,
  type ScoredOpportunity,
  type SignalInput,
} from "@/lib/research/scoring";
import type {
  CollectedSignal,
  ResearchContext,
} from "@/lib/research/signals";

const log = logger.child({ component: "research-ideas" });

/** How many ideas one run proposes. */
const IDEA_COUNT = 6;

/** Evidence rows shown to the model. Enough context, bounded prompt size. */
const MAX_EVIDENCE = 40;

/**
 * Rejection threshold for title similarity.
 *
 * Jaccard overlap of content words. 0.6 is intentionally permissive: two videos
 * on the same subject legitimately share most of their nouns, and rejecting that
 * would reject every on-topic idea. What it catches is the actual failure — a
 * title returned essentially verbatim.
 */
const MAX_TITLE_OVERLAP = 0.6;

const IdeaSchema = z.object({
  title: z.string().min(8).max(200),
  angle: z.string().min(10),
  rationale: z.string().min(10),
  /**
   * Phase 11 §7's opening line and trend justification.
   *
   * Optional in the parse, required in the JSON schema below. The asymmetry is
   * deliberate: the model is *asked* for both on every generation, but an idea that
   * arrives without a hook is still a usable idea, and failing the whole batch —
   * five good angles discarded because the sixth omitted one prose field — is the
   * worse outcome. The columns are nullable for the same reason.
   */
  hook: z.string().max(400).optional(),
  trendSignal: z.string().max(600).optional(),
  topic: z.string().min(2).max(160),
  targetKeywords: z.array(z.string()).max(12),
  /** 1-based indices into the evidence list the model was shown. */
  sourceIndices: z.array(z.number().int()),
});

const IdeaBatchSchema = z.object({
  ideas: z.array(IdeaSchema).min(1).max(12),
});

const IDEA_JSON_SCHEMA = jsonSchema({
  properties: {
    ideas: {
      type: "array",
      description: `Between 3 and ${IDEA_COUNT} original video ideas, best first.`,
      minItems: 1,
      maxItems: 12,
      items: jsonSchema({
        properties: {
          title: {
            type: "string",
            description:
              "A specific, original video title for THIS channel. Must not " +
              "restate any source title. No clickbait the video cannot deliver.",
          },
          angle: {
            type: "string",
            description:
              "What makes this different from the source videos — the specific " +
              "take, framing, or gap in the existing coverage. One or two sentences.",
          },
          rationale: {
            type: "string",
            description:
              "Why the evidence supports this idea: which signal (velocity, " +
              "engagement, an unanswered question in the comments-heavy videos) " +
              "points at unmet demand.",
          },
          hook: {
            type: "string",
            description:
              "The first one or two spoken sentences of the video — what makes a " +
              "viewer stay past three seconds. Written to be said aloud, not read. " +
              "Must not quote any source video.",
          },
          trendSignal: {
            type: "string",
            description:
              "One sentence naming the observed evidence behind this angle, e.g. " +
              "\"three uploads in the last two weeks are averaging 4x the topic's " +
              "usual velocity\". State what was measured, not a score.",
          },
          topic: {
            type: "string",
            description:
              "The underlying topic cluster in 2-6 words, not the title.",
          },
          targetKeywords: stringArray(
            "3-8 search phrases a viewer would actually type.",
            { maxItems: 12 },
          ),
          sourceIndices: {
            type: "array",
            description:
              "The evidence numbers (as shown in the EVIDENCE list) that led to " +
              "this idea. Required — every idea must be traceable to signals.",
            items: { type: "integer" },
          },
        },
        required: [
          "title",
          "angle",
          "rationale",
          "hook",
          "trendSignal",
          "topic",
          "targetKeywords",
          "sourceIndices",
        ],
      }),
    },
  },
  required: ["ideas"],
});

const SYSTEM_PROMPT = `You are Tally's research analyst. You study public YouTube performance data for one topic area and propose ORIGINAL video ideas.

Your discipline:
- Diagnose, do not copy. The evidence shows what earned attention; your job is to work out WHY and then propose something new that serves that same demand better or from a different angle.
- Never restate a source title. An idea that is a source video with different words is a failure, not an idea.
- Prefer specific over broad. "Why index funds beat picking stocks over 30 years" beats "Investing tips".
- Ground every idea in the evidence. If a signal does not support an idea, do not propose it.
- Respect the stated niche, language and audience. An idea outside the niche is useless however good it is.
- No misleading claims, no fabricated statistics, no titles the video could not honestly deliver.
- Never propose reusing, re-uploading, reacting to, or compiling someone else's footage. Every idea must be producible as original content.
- When a SOURCE VIDEO is given, it is research material: study what topic it serves and propose original videos serving that same audience. Never propose remaking it, re-titling it, responding to it, or reproducing its content.`;

export interface GeneratedIdea {
  title: string;
  angle: string;
  rationale: string;
  /** §7's opening line. Null when the model omitted it. */
  hook: string | null;
  /** §7's "why this angle": the observed evidence, in one sentence. */
  trendSignal: string | null;
  topic: string;
  targetKeywords: string[];
  /** `research_results.id` values this idea was derived from. */
  sourceResultIds: string[];
  scores: ScoredOpportunity;
}

/**
 * The pasted video, as the prompt sees it (Phase 11 §7).
 *
 * Title, channel and topics only — deliberately not the description, the tags or
 * anything resembling a transcript. §22 makes this a research source, and the
 * narrowest thing that still answers "what is this about" is the safest thing to
 * put in a prompt that generates original titles.
 */
export interface IdeaSourceSeed {
  title: string;
  channelTitle: string | null;
  niche: string | null;
  topics: string[];
  viewCount: number | null;
  durationSeconds: number | null;
}

export interface GenerateIdeasInput {
  userId: string;
  context: ResearchContext;
  /** Persisted evidence: the row id paired with the signal it came from. */
  evidence: Array<{ id: string; signal: CollectedSignal }>;
  ownTopPerformers: Array<{ title: string; views: number | null }>;
  /** Present only for a link-mode run. */
  source?: IdeaSourceSeed | null;
  jobId?: string | null;
  traceId?: string | null;
  now?: Date;
}

/**
 * Propose scored, original ideas from persisted evidence.
 *
 * Throws `NotConfiguredError` when the selected AI transport is unconfigured
 * (§48) — the worker turns that into a `blocked_not_configured` run so the UI
 * names the missing variable instead of showing an empty idea list.
 */
export async function generateIdeas(
  input: GenerateIdeasInput,
): Promise<GeneratedIdea[]> {
  const now = input.now ?? new Date();
  const evidence = input.evidence.slice(0, MAX_EVIDENCE);

  if (evidence.length === 0) {
    // No signals means no basis for an idea. Returning an empty list lets the
    // caller report "research found nothing" rather than inventing ideas from
    // the model's priors, which would be untraceable and unverifiable.
    return [];
  }

  const batch = await generateJson({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(
      input.context,
      evidence,
      input.ownTopPerformers,
      input.source ?? null,
    ),
    schema: IdeaBatchSchema,
    jsonSchema: IDEA_JSON_SCHEMA,
    maxTokens: 8_000,
    usage: {
      operation: "research.ideas",
      userId: input.userId,
      jobId: input.jobId ?? null,
      traceId: input.traceId ?? null,
    },
  });

  const weightOverrides = parseWeightOverrides(input.context.scoreWeights);
  const out: GeneratedIdea[] = [];

  for (const idea of batch.ideas) {
    // Map the model's 1-based evidence numbers back to real row ids, dropping
    // anything out of range rather than trusting the indices.
    const sourceResultIds = [
      ...new Set(
        idea.sourceIndices
          .map((n) => evidence[n - 1]?.id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    const supporting =
      sourceResultIds.length > 0
        ? evidence.filter((e) => sourceResultIds.includes(e.id))
        : // An idea with no usable citation is still scored, but against the
          // topic-matched evidence rather than nothing — otherwise every score
          // component would read 0 and the idea would look worthless.
          evidence.filter(
            (e) =>
              e.signal.topic &&
              tokenize(idea.topic).has(e.signal.topic.toLowerCase()),
          );

    const scoringSet = supporting.length > 0 ? supporting : evidence;

    // The pasted video's own title is checked alongside the evidence titles. §7
    // forbids copying the source title specifically, and the source is not
    // guaranteed to appear in `evidence` — §6 excludes it from its own results, so
    // without this line it would be the one title the check could not see.
    const forbiddenTitles = [
      ...scoringSet.map((e) => e.signal.title),
      ...(input.source ? [input.source.title] : []),
    ];

    if (isDerivative(idea.title, forbiddenTitles)) {
      log.warn("rejected derivative idea", {
        userId: input.userId,
        channelId: input.context.channelId ?? undefined,
        traceId: input.traceId ?? undefined,
        title: idea.title,
      });
      continue;
    }

    const scores = scoreOpportunity({
      signals: scoringSet.map((e) => toSignalInput(e.signal)),
      fit: {
        niche: input.context.niche,
        keywords: input.context.keywords,
        topic: idea.title,
        context: `${idea.topic} ${idea.angle} ${idea.targetKeywords.join(" ")}`,
      },
      weightOverrides,
      now,
    });

    out.push({
      title: idea.title,
      angle: idea.angle,
      rationale: idea.rationale,
      hook: idea.hook?.trim() || null,
      trendSignal: idea.trendSignal?.trim() || null,
      topic: idea.topic,
      targetKeywords: idea.targetKeywords,
      sourceResultIds,
      scores,
    });
  }

  return out.sort((a, b) => b.scores.tallyScore - a.scores.tallyScore);
}

function toSignalInput(signal: CollectedSignal): SignalInput {
  return {
    viewCount: signal.viewCount,
    likeCount: signal.likeCount,
    commentCount: signal.commentCount,
    viewsPerHour: signal.viewsPerHour,
    publishedAt: signal.publishedAt,
    channelSubscriberCount: signal.channelSubscriberCount,
  };
}

/**
 * True when a proposed title is substantially one of the source titles.
 *
 * Jaccard overlap on content words, so word order and filler do not hide a copy.
 * This is the mechanical backstop behind §7's "do not simply copy" — the prompt
 * asks, this verifies.
 */
export function isDerivative(
  title: string,
  sourceTitles: readonly string[],
): boolean {
  const candidate = tokenize(title);
  if (candidate.size === 0) return false;

  for (const source of sourceTitles) {
    const other = tokenize(source);
    if (other.size === 0) continue;

    let shared = 0;
    for (const token of candidate) if (other.has(token)) shared += 1;

    const union = candidate.size + other.size - shared;
    if (union > 0 && shared / union >= MAX_TITLE_OVERLAP) return true;
  }
  return false;
}

/**
 * The prompt.
 *
 * Evidence is numbered so the model can cite it, and every figure is labelled
 * with what it actually measures. Views alone would let the model equate a
 * 5-year-old hit with a breakout; views/hour is what distinguishes them.
 */
function buildPrompt(
  context: ResearchContext,
  evidence: Array<{ id: string; signal: CollectedSignal }>,
  ownTopPerformers: Array<{ title: string; views: number | null }>,
  source: IdeaSourceSeed | null,
): string {
  const lines: string[] = [];

  if (source) {
    // Stated before the brief and framed as reference material, because the
    // instruction that matters most is what *not* to do with it (§22).
    lines.push(
      "SOURCE VIDEO — the user pasted this link as a starting point. It is " +
        "RESEARCH MATERIAL ONLY. Do not remake it, re-title it, summarise it, " +
        "respond to it, or reuse its content. Use it only to understand which " +
        "topic and audience the user wants to make videos for.",
    );
    lines.push(`- Title: "${source.title}"`);
    if (source.channelTitle) lines.push(`- Published by: ${source.channelTitle}`);
    if (source.niche) lines.push(`- Apparent subject area: ${source.niche}`);
    if (source.topics.length > 0)
      lines.push(`- Topic signals: ${source.topics.join(", ")}`);
    if (source.viewCount !== null)
      lines.push(`- Views: ${formatNumber(source.viewCount)}`);
    if (source.durationSeconds !== null)
      lines.push(
        `- Length: ${Math.round(source.durationSeconds / 60)} minutes ` +
          "(a guide to the format the user has in mind)",
      );
    lines.push("");
  }

  lines.push(source ? "BRIEF" : "CHANNEL");
  lines.push(`- Niche: ${context.niche ?? "(not specified)"}`);
  lines.push(
    `- Keywords: ${context.keywords.length > 0 ? context.keywords.join(", ") : "(none given)"}`,
  );
  lines.push(`- Language: ${context.contentLanguage}`);
  lines.push(
    `- Typical video length: ${Math.round(context.preferredLengthSeconds / 60)} minutes`,
  );

  if (ownTopPerformers.length > 0) {
    lines.push("");
    lines.push(
      "THIS CHANNEL'S OWN BEST RECENT VIDEOS (what this specific audience responds to)",
    );
    for (const video of ownTopPerformers) {
      lines.push(
        `- ${video.title}${video.views === null ? "" : ` — ${formatNumber(video.views)} views`}`,
      );
    }
  }

  lines.push("");
  lines.push(
    "EVIDENCE — public YouTube data observed just now. Cite these numbers by index.",
  );
  lines.push(
    "views/hr is views since publication, the velocity signal; engagement is " +
      "(likes + 3x comments) / views.",
  );

  evidence.forEach((item, index) => {
    const s = item.signal;
    const parts: string[] = [];
    if (s.viewCount !== null) parts.push(`${formatNumber(s.viewCount)} views`);
    if (s.viewsPerHour !== null)
      parts.push(`${formatNumber(Math.round(s.viewsPerHour))} views/hr`);
    if (s.engagementRate !== null)
      parts.push(`${(s.engagementRate * 100).toFixed(2)}% engagement`);
    if (s.publishedAt) parts.push(`published ${s.publishedAt.toISOString().slice(0, 10)}`);
    if (s.channelSubscriberCount !== null)
      parts.push(`channel ${formatNumber(s.channelSubscriberCount)} subs`);

    lines.push(
      `${index + 1}. "${s.title}"${s.channelTitle ? ` — ${s.channelTitle}` : ""}` +
        (parts.length > 0 ? ` [${parts.join(", ")}]` : "") +
        (s.topic ? ` (found via: ${s.topic})` : ""),
    );
  });

  lines.push("");
  lines.push("TASK");
  lines.push(
    `Propose up to ${IDEA_COUNT} original video ideas ` +
      (source ? "for this topic and audience" : "for this channel") +
      ". For each, state the angle that makes it different from the evidence, the " +
      "rationale grounded in specific numbered signals, the hook the video opens " +
      "with, the trend signal that justifies it, and the evidence indices you " +
      "used. Do not restate any evidence title" +
      (source ? " or the source video's title" : "") +
      ".",
  );

  return lines.join("\n");
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Store generated ideas.
 *
 * `scoreBreakdown` holds the weights used, so a score read six weeks from now
 * can still be explained even after the defaults or the channel's overrides have
 * changed. §8 calls the formula configurable; that is only safe if history
 * records the configuration it was computed under.
 *
 * `channelId` is null for a link-mode run (Phase 11 §4): the idea belongs to the
 * user, and every read path already filters on `userId`.
 */
export async function persistIdeas(
  userId: string,
  channelId: string | null,
  runId: string,
  generated: readonly GeneratedIdea[],
): Promise<string[]> {
  if (generated.length === 0) return [];

  const inserted = await db
    .insert(ideas)
    .values(
      generated.map((idea) => ({
        userId,
        channelId,
        runId,
        title: idea.title,
        angle: idea.angle,
        rationale: idea.rationale,
        hook: idea.hook,
        trendSignal: idea.trendSignal,
        topic: idea.topic,
        targetKeywords: idea.targetKeywords,
        sourceResultIds: idea.sourceResultIds,
        trendScore: idea.scores.trend,
        opportunityScore: idea.scores.opportunity,
        competitionScore: idea.scores.competition,
        audienceFitScore: idea.scores.audienceFit,
        velocityScore: idea.scores.velocity,
        freshnessScore: idea.scores.freshness,
        tallyScore: idea.scores.tallyScore,
        // The weights in force when this idea was scored, so a score read six
        // weeks from now can still be explained even after the formula is tuned.
        // Spelled out field by field because the column is an untyped
        // `Record<string, number>` and a cast would hide a renamed factor.
        scoreBreakdown: {
          trend: idea.scores.weights.trend,
          opportunity: idea.scores.weights.opportunity,
          competition: idea.scores.weights.competition,
          audienceFit: idea.scores.weights.audienceFit,
          velocity: idea.scores.weights.velocity,
          freshness: idea.scores.weights.freshness,
        },
        state: "new",
        // The transport that actually produced the idea, not a fixed label (§29).
        generatedBy: aiProviderName(),
      })),
    )
    .returning({ id: ideas.id });

  return inserted.map((row) => row.id);
}

/** Update an idea's state (`saved` | `rejected`), scoped to its owner. */
export async function setIdeaState(
  userId: string,
  ideaId: string,
  state: "new" | "saved" | "rejected" | "used",
): Promise<boolean> {
  const updated = await db
    .update(ideas)
    .set({ state })
    .where(and(eq(ideas.id, ideaId), eq(ideas.userId, userId)))
    .returning({ id: ideas.id });
  return updated.length > 0;
}

/** Source result ids behind a set of ideas — the §29 provenance read. */
export async function sourcesForIdeas(
  userId: string,
  ideaIds: string[],
): Promise<Map<string, string[]>> {
  if (ideaIds.length === 0) return new Map();
  const rows = await db
    .select({ id: ideas.id, sourceResultIds: ideas.sourceResultIds })
    .from(ideas)
    .where(and(eq(ideas.userId, userId), inArray(ideas.id, ideaIds)));
  return new Map(rows.map((r) => [r.id, r.sourceResultIds ?? []]));
}

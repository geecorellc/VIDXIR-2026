/**
 * POST /api/youtube/analyze — read a pasted YouTube link (Phase 11 §4, §5).
 *
 * The first step of link mode, and deliberately a step that changes nothing: it
 * creates no project, enqueues no job and spends no generation credit. It answers
 * one question — *what is this video?* — so the user can see what Tally understood
 * before committing a video from their monthly allowance to it.
 *
 * Two things happen here rather than anywhere else. The URL is parsed **on the
 * server**, because §4 forbids trusting a client-supplied id and this is the only
 * place the raw paste exists. And the read is a *returned state* rather than an
 * exception: a private video, a deleted video, an exhausted quota and a missing API
 * key are all normal outcomes with different remedies, and each reaches the screen
 * as itself (§5, §48).
 *
 * §22: the video is a research source. Nothing here downloads it, and the only
 * media reference in the response is a thumbnail URL for display.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseJson, requireOnboarded } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { analyzeVideoId } from "@/lib/youtube/source-analysis";
import { parseYouTubeLink } from "@/lib/youtube/url";

const BodySchema = z.object({
  /**
   * The pasted link. Bounded here and validated by shape in `parseYouTubeLink`;
   * `z.string().url()` would be the wrong check, because a bare video id and a
   * scheme-less paste are both accepted forms and neither is a URL.
   */
  url: z.string().trim().min(1).max(2_048),
});

export async function POST(request: NextRequest) {
  return handle(request, async ({ traceId }) => {
    const { user } = await requireOnboarded();
    const body = await parseJson(request, BodySchema);

    /**
     * Parsed before the rate limit is consumed, on purpose.
     *
     * A malformed link costs nothing — no network call, no quota — so charging the
     * user's window for it would mean a few mistyped pastes locking them out of the
     * feature for ten minutes. The limit below exists to bound *YouTube quota*, and
     * this line is where a request stops being able to spend any.
     */
    const link = parseYouTubeLink(body.url);

    // Keyed by user, on the research rule rather than the looser mutation rule:
    // each analysis is a real YouTube Data API read against a project-wide daily
    // quota, so the ceiling has to be low enough that one account cannot drain it.
    await enforce(rules().research, `youtube-analyze:${user.id}`);

    const result = await analyzeVideoId(link.videoId, link.form, {
      userId: user.id,
      traceId,
    });

    if (result.state === "ok") {
      return {
        state: "ok" as const,
        videoId: result.analysis.videoId,
        canonicalUrl: link.canonicalUrl,
        linkForm: link.form,
        analysis: result.analysis,
      };
    }

    /**
     * A named non-answer, at 200.
     *
     * "This video is private" is a successful answer to "what is this video?" and
     * the screen renders it as one, next to the paste field, with the link still in
     * it. A 4xx would make the browser client treat it as a failed request and
     * discard the distinction between the six states (§5).
     *
     * `missingEnvVars` carries variable *names* only — that is what the type holds,
     * and §20 requires nothing more ever be sent.
     */
    return {
      state: result.state,
      videoId: result.videoId,
      canonicalUrl: link.canonicalUrl,
      linkForm: link.form,
      analysis: null,
      message: result.message,
      errorCode: result.errorCode,
      missingEnvVars: result.missingEnvVars,
      retryable: result.retryable,
    };
  });
}

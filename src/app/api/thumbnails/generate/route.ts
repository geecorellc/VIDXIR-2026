/**
 * POST /api/thumbnails/generate — design four thumbnail concepts (§16, §42).
 *
 * Returns once the job is queued. There is no image yet, and the Thumbnail tab
 * re-reads the project's own status while `THUMBNAIL_GENERATING` rather than
 * believing anything this response says about progress.
 *
 * The configuration and prerequisite checks happen here rather than in the worker
 * for the same reason as `/api/video/build`: the user is present to be told. A
 * missing font file or an unrendered video would otherwise move the project into
 * THUMBNAIL_GENERATING and straight back out, which reads as a bug rather than as
 * the configuration or workflow state it is (§37, §48).
 *
 * `GET` reads the current set, so a client that is not the server-rendered page
 * can poll without re-rendering it.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  currentTier,
  handle,
  parseJson,
  parseQuery,
  requireOnboarded,
  requireProjectAccess,
} from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { NotConfiguredError } from "@/lib/errors";
import { isCapabilityAvailable } from "@/lib/providers/config";
import { FONT_ENV_VARS, FONT_HINT } from "@/lib/media/fonts";
import {
  getThumbnails,
  startThumbnails,
  thumbnailReadiness,
} from "@/lib/thumbnails/service";

const BodySchema = z.object({ projectId: z.string().uuid() });
const QuerySchema = z.object({ projectId: z.string().uuid() });

export async function GET(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    const { projectId } = parseQuery(request, QuerySchema);

    await requireProjectAccess(user.id, projectId);
    await enforce(rules().read, `thumbnails:${user.id}`);

    // Null rather than an empty set: the studio says "No thumbnails yet", and a
    // shell with four blank cards would look like a generation that produced
    // nothing.
    return { thumbnails: await getThumbnails(user.id, projectId) };
  });
}

export async function POST(request: NextRequest) {
  return handle(request, async ({ traceId }) => {
    const { user } = await requireOnboarded();
    const body = await parseJson(request, BodySchema);

    await requireProjectAccess(user.id, body.projectId);

    // Claude writes the concepts and the stock library supplies the background.
    // Neither can be substituted, and both are what the Thumbnail tab's
    // `canGenerate` is computed from — checked again here because the client's
    // opinion is not authoritative (§34).
    if (!isCapabilityAvailable("ai")) {
      throw new NotConfiguredError(
        "Claude",
        ["ANTHROPIC_API_KEY"],
        "Thumbnail concepts are written from the script by Claude.",
      );
    }

    if (!isCapabilityAvailable("visuals")) {
      throw new NotConfiguredError(
        "Visual library",
        ["VISUAL_PROVIDERS", "PEXELS_API_KEY"],
        "A thumbnail needs a licensed background frame.",
      );
    }

    // ffmpeg plus a font file. `FONT_ENV_VARS` is named even when the shortfall is
    // the binary, because setting a font path is the only action an operator takes
    // here that the registry does not already describe.
    if (!thumbnailReadiness().ready) {
      throw new NotConfiguredError(
        "Thumbnail compositor",
        [...FONT_ENV_VARS],
        FONT_HINT,
      );
    }

    const tier = await currentTier(user.id);

    /**
     * No `requireFeature` gate. Thumbnails are part of the core flow on every
     * plan — §23 makes *A/B testing* the paid feature, not generation — and the
     * Thumbnail tab reflects that by showing the Studio note beneath a working
     * grid rather than hiding the grid.
     */
    await enforce(rules().generation, `thumbnails:${user.id}`);

    const { jobId, variantCount } = await startThumbnails({
      userId: user.id,
      projectId: body.projectId,
      tier,
      traceId,
    });

    return { jobId, variantCount, status: "queued" as const };
  });
}

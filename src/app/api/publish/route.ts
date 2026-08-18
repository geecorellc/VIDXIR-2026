/**
 * POST /api/publish — upload the finished video to YouTube (§18, §42).
 *
 * Returns once the job is queued. Nothing has reached YouTube when this responds,
 * and the Publish panel says as much ("Tally will mark this Published only once
 * YouTube confirms the upload") while it polls the project's own status.
 *
 * Every prerequisite is checked here as well as in the worker, for the reason
 * `/api/video/build` and `/api/thumbnails/generate` give: the user is present to
 * be told. A publish that moved the project to PUBLISHING and back to FAILED two
 * seconds later because no thumbnail was chosen reads as a bug rather than as the
 * workflow state it is (§37).
 *
 * `GET` reports readiness, so a client that is not the server-rendered page can
 * ask what is missing without attempting a publish to find out.
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
import { realPublishBlocked } from "@/lib/env";
import { NotConfiguredError, PublishBlockedError } from "@/lib/errors";
import { capabilityStatus } from "@/lib/providers/config";
import { youtubeMissingEnvVars } from "@/lib/providers/youtube";
import {
  publicationFor,
  publishReadiness,
  startPublish,
} from "@/lib/publish/service";

const BodySchema = z.object({
  projectId: z.string().uuid(),
  visibility: z.enum(["public", "unlisted", "private"]).default("public"),
  /**
   * ISO 8601. Optional, and a Studio feature — the service enforces the plan gate
   * and the future-time rule, so a client sending one on Starter is refused with
   * a sentence rather than silently publishing now.
   */
  scheduledFor: z.string().datetime().optional(),
  /**
   * YouTube's "made for kids" declaration. Omitted means "use the project's
   * metadata", which is where the user set it; this exists so the Publish panel
   * can override at the moment of publishing without a metadata save.
   */
  madeForKids: z.boolean().optional(),
});

const QuerySchema = z.object({ projectId: z.string().uuid() });

export async function GET(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    const { projectId } = parseQuery(request, QuerySchema);

    await requireProjectAccess(user.id, projectId);
    await enforce(rules().read, `publish:${user.id}`);

    const [readiness, published] = await Promise.all([
      publishReadiness(user.id, projectId),
      publicationFor(user.id, projectId),
    ]);

    return {
      ready: readiness.ready,
      blocked: readiness.blocked,
      // The §42 source of truth, not the project's status column.
      published,
    };
  });
}

export async function POST(request: NextRequest) {
  return handle(request, async ({ traceId }) => {
    const { user } = await requireOnboarded();
    const body = await parseJson(request, BodySchema);

    await requireProjectAccess(user.id, body.projectId);

    /**
     * The dev-mode block, first and explicitly. `uploadVideo` refuses too, but by
     * then the project has moved to PUBLISHING and a job has been queued — so the
     * refusal would look like a failed upload rather than the deliberate
     * development safeguard it is (§40).
     */
    if (realPublishBlocked()) {
      throw new PublishBlockedError();
    }

    if (capabilityStatus("youtube").state !== "ready") {
      throw new NotConfiguredError(
        "YouTube",
        youtubeMissingEnvVars(),
        "Publishing needs the Google OAuth client that channels are connected with.",
      );
    }

    const tier = await currentTier(user.id);

    /**
     * The generation limit rather than the read one. An upload spends YouTube
     * quota — 1,600 units of a 10,000-unit daily default per video — so repeated
     * clicks are worth rate limiting even though the service refuses a second
     * concurrent upload anyway.
     */
    await enforce(rules().generation, `publish:${user.id}`);

    const result = await startPublish({
      userId: user.id,
      projectId: body.projectId,
      tier,
      visibility: body.visibility,
      ...(body.scheduledFor
        ? { scheduledFor: new Date(body.scheduledFor) }
        : {}),
      ...(body.madeForKids === undefined
        ? {}
        : { madeForKids: body.madeForKids }),
      traceId,
    });

    return result;
  });
}

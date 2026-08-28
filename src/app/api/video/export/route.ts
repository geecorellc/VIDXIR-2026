/**
 * POST /api/video/export — render the editor's saved cut (§10, §23, §42).
 *
 * The Export button. Deliberately thin: it validates, checks the plan and the render
 * provider, then queues the *existing* render job. `executeRender` already prefers the
 * saved cut over the scene rows, so there is one render path and an export cannot
 * disagree with what the timeline showed.
 *
 * Two things this route does **not** do, both on purpose:
 *
 *  - It does not regenerate assets. Voiceover, visuals, music and captions already
 *    exist; an export re-cuts them. So `aiVoiceover` and the visual entitlements are not
 *    re-checked here — the user already paid for those when the video was built, and
 *    demanding them again would block an export for someone who downgraded after
 *    generating.
 *  - It does not accept a document. The cut comes from the database, written by
 *    `PUT /api/video/edit`, which rewrites every storage key from the tenant's own asset
 *    rows. A document in this body would be a second, unvalidated way to reach the
 *    renderer.
 *
 * What it does check is the render provider, because that is the one capability an
 * export actually consumes and the one whose absence would otherwise surface minutes
 * later as a failed job.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  currentTier,
  handle,
  parseJson,
  requireOnboarded,
  requireProjectAccess,
} from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { NotConfiguredError } from "@/lib/errors";
import { capabilityStatus } from "@/lib/providers/config";
import { startEditExport } from "@/lib/video/service";

const BodySchema = z.object({
  projectId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  return handle(request, async ({ traceId }) => {
    const { user } = await requireOnboarded();
    const body = await parseJson(request, BodySchema);

    await requireProjectAccess(user.id, body.projectId);

    const render = capabilityStatus("render");
    if (render.state === "not_configured") {
      throw new NotConfiguredError(
        render.label,
        render.missingEnvVars,
        "An export has to be rendered; there is no way to produce the file without a " +
          "render provider.",
      );
    }

    const tier = await currentTier(user.id);

    // Keyed by user, and on the generation rule rather than `mutation`: an export costs
    // real render time, so the spend follows the account rather than the machine.
    await enforce(rules().generation, `video-export:${user.id}`);

    const result = await startEditExport({
      userId: user.id,
      projectId: body.projectId,
      tier,
      traceId,
    });

    return {
      jobId: result.jobId,
      durationMs: result.durationMs,
      sceneCount: result.sceneCount,
      status: "queued" as const,
    };
  });
}

/**
 * POST /api/thumbnails/select — commit the thumbnail that will be uploaded (§16).
 *
 * Separate from the generation route because it is a different kind of act. A
 * preview click is local state in the Thumbnail tab; this is the user saying
 * "publish with this one", and it is what the publish stage reads. Nothing is
 * uploaded to YouTube here — the selection is a decision recorded against the
 * project, and the publish step is where a real upload happens (§42).
 *
 * A variant with no composited image is refused, not silently accepted: selecting
 * a concept whose picture does not exist would produce a video published without a
 * thumbnail while the UI showed a tick next to it.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  handle,
  parseJson,
  requireOnboarded,
  requireProjectAccess,
} from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { selectVariant } from "@/lib/thumbnails/service";

const BodySchema = z.object({
  projectId: z.string().uuid(),
  variantId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    const body = await parseJson(request, BodySchema);

    await requireProjectAccess(user.id, body.projectId);
    // The `mutation` limit, not the generation one: recording a choice spends no
    // provider credit, and a user comparing four options may well click twice
    // before settling. The generation budget would be the wrong thing to charge.
    // 60/minute still leaves that comfortable while bounding a scripted loop.
    await enforce(rules().mutation, `thumbnails:${user.id}`);

    const result = await selectVariant({
      userId: user.id,
      projectId: body.projectId,
      variantId: body.variantId,
    });

    return result;
  });
}

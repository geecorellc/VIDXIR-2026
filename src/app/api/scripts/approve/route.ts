/**
 * POST /api/scripts/approve — sign off the active script version (§9, §37).
 *
 * Approval is recorded and nothing else happens. It does not start the asset
 * pipeline: the video builder is what spends money on voiceover, visuals and a
 * render, and that is its own explicit request. Conflating the two would mean a
 * click labelled "Send to video builder" incurred provider cost before the
 * builder screen had even loaded.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  handle,
  parseJson,
  requireOnboarded,
  requireProjectAccess,
} from "@/lib/api/guard";
import { approveScript } from "@/lib/scripts/service";

const BodySchema = z.object({
  projectId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    const { projectId } = await parseJson(request, BodySchema);

    await requireProjectAccess(user.id, projectId);

    const approved = await approveScript(user.id, projectId);

    return {
      scriptId: approved.scriptId,
      versionId: approved.versionId,
      version: approved.version,
      approved: true as const,
    };
  });
}

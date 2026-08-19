/**
 * Script version history (§9 — "store scripts with versioning").
 *
 * `GET` lists every version of a project's script; `PATCH` makes an earlier one
 * active again. Versions are append-only, so reverting is a pointer move and no
 * draft is ever lost — which is the point of storing them at all. Without these
 * two endpoints the version rows would be write-only, and "versioning" would mean
 * nothing more than a number that increments.
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
import {
  activateScriptVersion,
  listScriptVersions,
} from "@/lib/scripts/service";

const QuerySchema = z.object({
  projectId: z.string().uuid(),
});

const PatchSchema = z.object({
  projectId: z.string().uuid(),
  versionId: z.string().uuid(),
});

export async function GET(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    const { projectId } = parseQuery(request, QuerySchema);

    await requireProjectAccess(user.id, projectId);
    await enforce(rules().read, `scripts:${user.id}`);

    return { versions: await listScriptVersions(user.id, projectId) };
  });
}

export async function PATCH(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    // Activating a version clears the previous approval, so this is a real state
    // change rather than a read.
    await enforce(rules().mutation, `scripts:${user.id}`);
    const { projectId, versionId } = await parseJson(request, PatchSchema);

    await requireProjectAccess(user.id, projectId);

    const { version } = await activateScriptVersion(
      user.id,
      projectId,
      versionId,
    );

    return {
      version,
      // Switching versions clears the previous approval, and the client needs to
      // know that rather than assume it carried over.
      approved: false as const,
    };
  });
}

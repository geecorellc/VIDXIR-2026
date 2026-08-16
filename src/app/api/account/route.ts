/**
 * PATCH /api/account — update the signed-in user's own profile fields.
 *
 * Email changes are deliberately not handled here: changing an address has to
 * re-run verification, so it belongs in its own flow rather than a general
 * profile PATCH (§4).
 */
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { handle, parseJson, requireUser } from "@/lib/api/guard";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { accountPatchSchema } from "@/lib/settings/config";

export async function PATCH(request: NextRequest) {
  return handle(request, async () => {
    const { user, log } = await requireUser();
    const patch = await parseJson(request, accountPatchSchema);

    if (patch.name !== undefined) {
      await db
        .update(users)
        .set({ name: patch.name, updatedAt: new Date() })
        // Scoped to the session's own id — a user can only edit themselves.
        .where(eq(users.id, user.id));
      log.info("account updated", { fields: ["name"] });
    }

    const rows = await db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

    const row = rows[0];
    if (!row) throw new Error("Signed-in user disappeared during update");
    return row;
  });
}

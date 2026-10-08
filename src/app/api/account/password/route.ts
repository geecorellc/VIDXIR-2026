import type { NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseJson, requireUser } from "@/lib/api/guard";
import { enforce } from "@/lib/api/rate-limit";
import { changePassword } from "@/lib/auth/service";
import { destroySession } from "@/lib/auth/session";
export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireUser();
    await enforce(
      { name: "change-password", limit: 10, windowSeconds: 900 },
      user.id,
    );
    const body = await parseJson(
      request,
      z.object({
        currentPassword: z.string().min(1).max(200),
        newPassword: z.string().min(10).max(200),
      }),
    );
    await changePassword(user.id, body.currentPassword, body.newPassword);
    await destroySession();
    return { ok: true };
  });
}

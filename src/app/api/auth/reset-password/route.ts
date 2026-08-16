/**
 * POST /api/auth/reset-password
 *
 * Consumes the reset token, sets the new password and revokes every existing
 * session — an attacker with a stale session must not survive the reset.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { clientIp, handle, parseJson } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { resetPassword } from "@/lib/auth/service";
import { destroySession } from "@/lib/auth/session";

const bodySchema = z.object({
  token: z.string().min(10).max(200),
  password: z.string().min(1).max(200),
});

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    await enforce(rules().authIp, clientIp(request));
    const body = await parseJson(request, bodySchema);

    await resetPassword(body.token, body.password);
    // Clear this browser's cookie too; revokeAllSessions invalidated the row,
    // so leaving the cookie in place would only produce confusing 401s.
    await destroySession();

    return { ok: true, message: "Password updated. Sign in with your new password." };
  });
}

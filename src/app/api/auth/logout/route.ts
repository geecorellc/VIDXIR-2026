/**
 * POST /api/auth/logout
 *
 * Revokes the session row and clears the cookie. Idempotent: logging out twice,
 * or without a session, succeeds rather than erroring.
 */
import type { NextRequest } from "next/server";
import { clientIp, handle } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { destroySession } from "@/lib/auth/session";

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    // Keyed by IP, not by user: logout deliberately does not require a session, so
    // there is no user id to key on. Grouped with the other auth-surface rules
    // because each call is a session lookup and a write.
    await enforce(rules().authIp, `logout:${clientIp(request)}`);
    await destroySession();
    return { ok: true };
  });
}

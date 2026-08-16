/**
 * POST /api/auth/logout
 *
 * Revokes the session row and clears the cookie. Idempotent: logging out twice,
 * or without a session, succeeds rather than erroring.
 */
import type { NextRequest } from "next/server";
import { handle } from "@/lib/api/guard";
import { destroySession } from "@/lib/auth/session";

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    await destroySession();
    return { ok: true };
  });
}

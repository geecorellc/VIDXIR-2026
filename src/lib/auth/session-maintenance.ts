/**
 * Session table maintenance (§11, §22).
 *
 * Separate from `lib/auth/session` for one reason: that module reads the request
 * cookie through `next/headers` and therefore carries `server-only`, whose runtime
 * export throws unconditionally. The scheduler is a plain `tsx` process, so
 * importing `pruneSessions` from there made `npm run scheduler` fail at its first
 * import — no session pruning, no channel-stats refresh, no analytics ingestion
 * and no automation ticks, from a process that logged nothing before dying.
 *
 * Nothing here touches a cookie, a header or a request. It is a scheduled delete
 * over the `sessions` table, which is why it can live outside the marked module
 * and be reachable from every runtime.
 */
import { lt, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";

/**
 * How long a revoked session row is kept.
 *
 * Expired rows go immediately — they authenticate nobody. Revoked ones are held
 * briefly because they are evidence: a logout or a password-change revocation is
 * the audit trail for "was this session active when the account was compromised",
 * and a week is long enough for that question to get asked.
 */
const REVOKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Delete expired sessions, and revoked ones past their retention. */
export async function pruneSessions(): Promise<number> {
  const revokedCutoff = new Date(Date.now() - REVOKED_RETENTION_MS);
  const deleted = await db
    .delete(sessions)
    .where(
      or(lt(sessions.expiresAt, new Date()), lt(sessions.revokedAt, revokedCutoff)),
    )
    .returning({ id: sessions.id });
  return deleted.length;
}

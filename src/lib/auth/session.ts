/**
 * Session management (§4).
 *
 * Design decisions:
 *  - Opaque random tokens, not JWTs. Revocation must be immediate (logout,
 *    password change, admin action); a stateless token cannot be revoked
 *    without a denylist, which is a session table with extra steps.
 *  - Only SHA-256(token) is stored, so a database dump yields no usable cookies.
 *  - `sessionEpoch` on the user row invalidates every session at once when the
 *    password changes, without a bulk UPDATE over sessions.
 *  - Cookie is httpOnly + SameSite=Lax + Secure in production. Lax (not Strict)
 *    so the OAuth redirect back from Google arrives authenticated.
 */
import "server-only";
import { cookies } from "next/headers";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { sessions, users } from "@/lib/db/schema";
import { generateToken, hashToken } from "@/lib/crypto";
import { isProduction } from "@/lib/env";
import { logger } from "@/lib/logger";

export const SESSION_COOKIE = "vidxir_session";
/** 30 days. Refreshed on activity, so an active user is not logged out. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Re-issue the expiry when less than this remains. */
const SESSION_REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role?: "user" | "admin";
  emailVerifiedAt: Date | null;
  onboardedAt: Date | null;
}

export interface ActiveSession {
  sessionId: string;
  user: SessionUser;
}

function cookieOptions(expires: Date) {
  return {
    httpOnly: true,
    // Lax rather than Strict: the Google OAuth callback is a cross-site
    // top-level GET and must carry the session.
    sameSite: "lax" as const,
    secure: isProduction(),
    path: "/",
    expires,
  };
}

/**
 * Create a session row and set the cookie. Returns the raw token, which is
 * never persisted anywhere else.
 */
export async function createSession(
  userId: string,
  meta: { userAgent?: string | null; ipAddress?: string | null } = {},
): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const [user] = await db
    .select({ sessionEpoch: users.sessionEpoch })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    epoch: user?.sessionEpoch ?? 0,
    userAgent: meta.userAgent?.slice(0, 512) ?? null,
    ipAddress: meta.ipAddress ?? null,
    expiresAt,
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, cookieOptions(expiresAt));

  logger.info("session created", { userId, component: "auth" });
  return token;
}

/**
 * Resolve the current session from the cookie. Returns null when absent,
 * expired, revoked, or superseded by a password change.
 *
 * Reads are a single indexed lookup on token_hash joined to the user.
 */
export async function getSession({
  refresh = false,
}: { refresh?: boolean } = {}): Promise<ActiveSession | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const rows = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
      sessionEpoch: sessions.epoch,
      userId: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      suspendedAt: users.suspendedAt,
      emailVerifiedAt: users.emailVerifiedAt,
      onboardedAt: users.onboardedAt,
      userEpoch: users.sessionEpoch,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, hashToken(token)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.revokedAt || row.suspendedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  // Password changed since this session was issued.
  if (row.sessionEpoch !== row.userEpoch) return null;

  // Sliding expiry: only write when meaningfully close to expiring, so a busy
  // dashboard does not issue an UPDATE per request.
  const remaining = row.expiresAt.getTime() - Date.now();
  // Server Components expose a read-only cookie store. Route handlers opt in
  // to renewal so a valid older session never makes page rendering fail.
  if (refresh && remaining < SESSION_TTL_MS - SESSION_REFRESH_THRESHOLD_MS) {
    const nextExpiry = new Date(Date.now() + SESSION_TTL_MS);
    await db
      .update(sessions)
      .set({ expiresAt: nextExpiry, lastSeenAt: new Date() })
      .where(eq(sessions.id, row.sessionId));
    store.set(SESSION_COOKIE, token, cookieOptions(nextExpiry));
  }

  return {
    sessionId: row.sessionId,
    user: {
      id: row.userId,
      email: row.email,
      name: row.name,
      role: row.role,
      emailVerifiedAt: row.emailVerifiedAt,
      onboardedAt: row.onboardedAt,
    },
  };
}

/** Revoke the current session and clear the cookie. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.tokenHash, hashToken(token)));
  }
  store.delete(SESSION_COOKIE);
}

/**
 * Revoke every session for a user. Called on password reset/change.
 *
 * The epoch bump is done in SQL (`epoch + 1`) rather than read-modify-write so
 * two concurrent password resets cannot both read the same value and leave one
 * generation of sessions alive.
 */
export async function revokeAllSessions(userId: string): Promise<void> {
  await db
    .update(users)
    .set({
      sessionEpoch: sql`${users.sessionEpoch} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  logger.info("all sessions revoked", { userId, component: "auth" });
}

/**
 * Session pruning lives in `lib/auth/session-maintenance`, not here.
 *
 * It is the scheduler's job, and the scheduler is a plain Node process that cannot
 * import this module at all: the `server-only` marker above is real — `cookies()`
 * from `next/headers` only exists inside a request — and its runtime export
 * throws. Keeping the prune here made `npm run scheduler` die at its first import.
 */
export { pruneSessions } from "@/lib/auth/session-maintenance";

/** Cookie TTL, exported for tests. */
export const sessionTtlMs = SESSION_TTL_MS;
export { hashToken as hashSessionToken };

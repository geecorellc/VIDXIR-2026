/**
 * Authentication and session integration tests (§39).
 *
 * Everything here runs against a real Postgres, because the properties being
 * asserted live in the database rather than in a function's return value: that a
 * password is never stored in plaintext, that a session is genuinely revoked,
 * that the epoch bump really does invalidate other browsers.
 *
 * Requires TEST_DATABASE_URL. See tests/integration/setup.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUser,
  hasDatabase,
  jar,
  resetDatabase,
  signIn,
  useDatabase,
} from "./setup";

// `lib/auth/session` reads and writes cookies through `next/headers`, which only
// exists inside a Next request. The jar makes the real code path runnable.
vi.mock("next/headers", () => ({
  cookies: async () => jar,
}));

const suite = hasDatabase ? describe : describe.skip;

suite("auth (integration)", () => {
  useDatabase();
  beforeEach(resetDatabase);

  describe("signup", () => {
    it("stores a scrypt hash and never the password", async () => {
      const { db } = await import("@/lib/db");
      const { users } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      const user = await createUser({ password: "Correct-Horse-Battery-1" });

      const [row] = await db
        .select({ hash: users.passwordHash })
        .from(users)
        .where(eq(users.id, user.id));

      expect(row?.hash).toBeTruthy();
      expect(row?.hash).toMatch(/^scrypt\$/);
      // The whole point of §4: the plaintext must not be recoverable from the row.
      expect(row?.hash).not.toContain("Correct-Horse-Battery-1");
      expect(row?.hash).not.toContain("Correct");
    });

    it("creates the free-tier subscription authorization reads", async () => {
      const { db } = await import("@/lib/db");
      const { subscriptions } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      const user = await createUser();
      const [row] = await db
        .select({ tier: subscriptions.tier, status: subscriptions.status })
        .from(subscriptions)
        .where(eq(subscriptions.userId, user.id));

      // Without this row every entitlement check would have to invent a default,
      // and inventing a default is how a paid feature gets granted for free.
      expect(row).toEqual({ tier: "starter", status: "active" });
    });

    it("refuses a duplicate email without confirming it is registered", async () => {
      const { signup } = await import("@/lib/auth/service");
      await createUser({ email: "taken@vidxir.test" });

      await expect(
        signup({
          name: "Impostor",
          email: "taken@vidxir.test",
          password: "Some-Other-Pass-9",
        }),
      ).rejects.toMatchObject({ code: "conflict" });

      // The message must not say "already registered" — that is an account oracle.
      await signup({
        name: "Impostor",
        email: "other@vidxir.test",
        password: "Some-Other-Pass-9",
      }).catch(() => undefined);
      await expect(
        signup({
          name: "Impostor",
          email: "taken@vidxir.test",
          password: "Some-Other-Pass-9",
        }),
      ).rejects.toThrow(/cannot be used to sign up/i);
    });

    it("treats email as case- and whitespace-insensitive for identity", async () => {
      const { signup, login } = await import("@/lib/auth/service");
      await signup({
        name: "Case Test",
        email: "  MiXeD@Vidxir AI.TEST ",
        password: "Case-Test-Pass-2",
      });

      // Same account, however it is typed.
      await expect(
        signup({
          name: "Case Test",
          email: "mixed@vidxir.test",
          password: "Case-Test-Pass-2",
        }),
      ).rejects.toMatchObject({ code: "conflict" });

      await expect(
        login("MIXED@VIDXIR.TEST", "Case-Test-Pass-2"),
      ).resolves.toMatchObject({ emailVerified: false });
    });

    it("rejects a password below the length floor", async () => {
      const { signup } = await import("@/lib/auth/service");
      await expect(
        signup({ name: "Short", email: "short@vidxir.test", password: "abc123" }),
      ).rejects.toMatchObject({ code: "validation_failed" });

      // And the account must not exist afterwards.
      const { db } = await import("@/lib/db");
      const { users } = await import("@/lib/db/schema");
      const rows = await db.select({ id: users.id }).from(users);
      expect(rows).toHaveLength(0);
    });
  });

  describe("login", () => {
    it("accepts the correct password and rejects a wrong one", async () => {
      const { login } = await import("@/lib/auth/service");
      const user = await createUser();

      await expect(login(user.email, user.password)).resolves.toMatchObject({
        userId: user.id,
      });
      await expect(login(user.email, `${user.password}x`)).rejects.toMatchObject({
        code: "unauthenticated",
      });
    });

    it("gives the same error for an unknown address as for a wrong password", async () => {
      const { login } = await import("@/lib/auth/service");
      const user = await createUser();

      const wrongPassword = await login(user.email, "definitely-wrong-1").catch(
        (e: Error) => e.message,
      );
      const noSuchUser = await login("nobody@vidxir.test", "definitely-wrong-1").catch(
        (e: Error) => e.message,
      );

      // Distinguishable messages would let an attacker enumerate customers.
      expect(noSuchUser).toBe(wrongPassword);
    });

    it("locks the account after repeated failures and clears the counter on success", async () => {
      const { login } = await import("@/lib/auth/service");
      const { db } = await import("@/lib/db");
      const { users } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      const user = await createUser();

      for (let i = 0; i < 8; i += 1) {
        await login(user.email, "wrong-password-here").catch(() => undefined);
      }

      const [locked] = await db
        .select({ lockedUntil: users.lockedUntil })
        .from(users)
        .where(eq(users.id, user.id));
      expect(locked?.lockedUntil).toBeInstanceOf(Date);

      // Locked means locked: even the right password is refused while it holds.
      await expect(login(user.email, user.password)).rejects.toThrow(
        /too many failed attempts/i,
      );

      // Clear the lock the way time would, then check the counter resets.
      await db
        .update(users)
        .set({ lockedUntil: null })
        .where(eq(users.id, user.id));
      await login(user.email, user.password);

      const [after] = await db
        .select({
          failed: users.failedLoginCount,
          lockedUntil: users.lockedUntil,
          lastLoginAt: users.lastLoginAt,
        })
        .from(users)
        .where(eq(users.id, user.id));
      expect(after?.failed).toBe(0);
      expect(after?.lockedUntil).toBeNull();
      expect(after?.lastLoginAt).toBeInstanceOf(Date);
    });
  });

  describe("sessions", () => {
    it("issues a cookie whose raw value is not stored in the database", async () => {
      const { db } = await import("@/lib/db");
      const { sessions } = await import("@/lib/db/schema");
      const { SESSION_COOKIE, hashSessionToken } = await import(
        "@/lib/auth/session"
      );

      const user = await createUser();
      const token = await signIn(user);

      expect(jar.get(SESSION_COOKIE)?.value).toBe(token);

      const rows = await db
        .select({ tokenHash: sessions.tokenHash })
        .from(sessions);
      expect(rows).toHaveLength(1);
      // A database dump must not yield usable cookies.
      expect(rows[0]?.tokenHash).not.toBe(token);
      expect(rows[0]?.tokenHash).toBe(hashSessionToken(token));
    });

    it("resolves the signed-in user from the cookie", async () => {
      const { getSession } = await import("@/lib/auth/session");
      const user = await createUser();
      await signIn(user);

      const session = await getSession();
      expect(session?.user.id).toBe(user.id);
      expect(session?.user.email).toBe(user.email);
    });

    it("returns null for a forged token", async () => {
      const { getSession, SESSION_COOKIE } = await import("@/lib/auth/session");
      const user = await createUser();
      await signIn(user);

      jar.inject(SESSION_COOKIE, "not-a-real-token-value");
      expect(await getSession()).toBeNull();
    });

    it("returns null after logout, and the row is marked revoked", async () => {
      const { db } = await import("@/lib/db");
      const { sessions } = await import("@/lib/db/schema");
      const { destroySession, getSession } = await import("@/lib/auth/session");

      const user = await createUser();
      const token = await signIn(user);
      await destroySession();

      expect(await getSession()).toBeNull();

      const rows = await db
        .select({ revokedAt: sessions.revokedAt })
        .from(sessions);
      expect(rows[0]?.revokedAt).toBeInstanceOf(Date);

      // Replaying the stolen cookie must not resurrect the session.
      const { SESSION_COOKIE } = await import("@/lib/auth/session");
      jar.inject(SESSION_COOKIE, token);
      expect(await getSession()).toBeNull();
    });

    it("rejects an expired session without deleting the row", async () => {
      const { db } = await import("@/lib/db");
      const { sessions } = await import("@/lib/db/schema");
      const { getSession } = await import("@/lib/auth/session");

      const { eq } = await import("drizzle-orm");
      const user = await createUser();
      await signIn(user);
      await db
        .update(sessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(sessions.userId, user.id));

      expect(await getSession()).toBeNull();

      // Expiry is a read-time check, not a delete — the row stays for the
      // scheduler to prune, so auditing "who was signed in when" still works.
      const rows = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, user.id));
      expect(rows).toHaveLength(1);
    });

    it("invalidates every session when the password changes", async () => {
      const { changePassword } = await import("@/lib/auth/service");
      const { getSession } = await import("@/lib/auth/session");

      const user = await createUser();
      await signIn(user);
      expect(await getSession()).not.toBeNull();

      await changePassword(user.id, user.password, "A-Brand-New-Password-3");

      // The epoch bump is what makes this immediate rather than eventual.
      expect(await getSession()).toBeNull();
    });
  });

  describe("email verification", () => {
    it("verifies with the emailed token and refuses to reuse it", async () => {
      const { db } = await import("@/lib/db");
      const { emailTokens, users } = await import("@/lib/db/schema");
      const { and, eq } = await import("drizzle-orm");
      const { verifyEmail } = await import("@/lib/auth/service");

      const user = await createUser();

      // The console email provider prints the token; the row proves it exists.
      // The raw token is not recoverable from the database (only its hash is),
      // so this test re-issues one it can hold onto.
      const { issueVerificationEmail } = await import("@/lib/auth/service");
      const captured = await captureToken(() =>
        issueVerificationEmail(user.id, user.email, user.name),
      );

      await verifyEmail(captured);

      const [row] = await db
        .select({ verifiedAt: users.emailVerifiedAt })
        .from(users)
        .where(eq(users.id, user.id));
      expect(row?.verifiedAt).toBeInstanceOf(Date);

      // Single use.
      await expect(verifyEmail(captured)).rejects.toMatchObject({
        code: "validation_failed",
      });

      const consumed = await db
        .select({ id: emailTokens.id })
        .from(emailTokens)
        .where(
          and(
            eq(emailTokens.userId, user.id),
            eq(emailTokens.purpose, "verify_email"),
          ),
        );
      expect(consumed.length).toBeGreaterThan(0);
    });

    it("rejects an expired token", async () => {
      const { db } = await import("@/lib/db");
      const { emailTokens } = await import("@/lib/db/schema");
      const { issueVerificationEmail, verifyEmail } = await import(
        "@/lib/auth/service"
      );

      const user = await createUser();
      const token = await captureToken(() =>
        issueVerificationEmail(user.id, user.email, user.name),
      );

      await db
        .update(emailTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) });

      await expect(verifyEmail(token)).rejects.toThrow(/invalid or expired/i);
    });
  });

  describe("password reset", () => {
    it("does not reveal whether the address is registered", async () => {
      const { requestPasswordReset } = await import("@/lib/auth/service");
      // Both paths resolve; only the side effect differs.
      await expect(
        requestPasswordReset("nobody-at-all@vidxir.test"),
      ).resolves.toBeUndefined();

      const user = await createUser();
      await expect(requestPasswordReset(user.email)).resolves.toBeUndefined();

      const { db } = await import("@/lib/db");
      const { emailTokens } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const issued = await db
        .select({ id: emailTokens.id })
        .from(emailTokens)
        .where(eq(emailTokens.purpose, "reset_password"));
      // Exactly one — the unknown address must not create a row.
      expect(issued).toHaveLength(1);
    });

    it("changes the password, verifies the email, and logs every session out", async () => {
      const { login, requestPasswordReset, resetPassword } = await import(
        "@/lib/auth/service"
      );
      const { getSession } = await import("@/lib/auth/session");
      const { db } = await import("@/lib/db");
      const { users } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      const user = await createUser();
      await signIn(user);

      const token = await captureToken(() => requestPasswordReset(user.email));
      await resetPassword(token, "Reset-To-This-Password-4");

      // Old password dead, new password live.
      await expect(login(user.email, user.password)).rejects.toMatchObject({
        code: "unauthenticated",
      });
      await expect(
        login(user.email, "Reset-To-This-Password-4"),
      ).resolves.toMatchObject({ userId: user.id });

      // A completed reset proves mailbox control.
      const [row] = await db
        .select({ verifiedAt: users.emailVerifiedAt })
        .from(users)
        .where(eq(users.id, user.id));
      expect(row?.verifiedAt).toBeInstanceOf(Date);

      // And whoever was signed in with the old password is out.
      expect(await getSession()).toBeNull();
    });

    it("refuses a reset token a second time", async () => {
      const { requestPasswordReset, resetPassword } = await import(
        "@/lib/auth/service"
      );
      const user = await createUser();
      const token = await captureToken(() => requestPasswordReset(user.email));

      await resetPassword(token, "First-Reset-Password-5");
      await expect(
        resetPassword(token, "Second-Reset-Password-6"),
      ).rejects.toThrow(/invalid or expired/i);
    });

    it("invalidates an older reset token when a new one is requested", async () => {
      const { requestPasswordReset, resetPassword } = await import(
        "@/lib/auth/service"
      );
      const user = await createUser();

      const first = await captureToken(() => requestPasswordReset(user.email));
      const second = await captureToken(() => requestPasswordReset(user.email));
      expect(first).not.toBe(second);

      // A stale link sitting in an inbox must stop working.
      await expect(resetPassword(first, "Stale-Link-Password-7")).rejects.toThrow(
        /invalid or expired/i,
      );
      await expect(
        resetPassword(second, "Fresh-Link-Password-8"),
      ).resolves.toBeUndefined();
    });

    it("still applies the password policy on reset", async () => {
      const { requestPasswordReset, resetPassword } = await import(
        "@/lib/auth/service"
      );
      const user = await createUser();
      const token = await captureToken(() => requestPasswordReset(user.email));

      await expect(resetPassword(token, "short")).rejects.toMatchObject({
        code: "validation_failed",
      });
    });
  });
});

/**
 * Run an action that sends an email and return the token from its body.
 *
 * The database only stores SHA-256(token), so the emailed value has to be read
 * from the delivery channel. This is also an assertion in itself: if the email
 * ever stopped containing a working link, every test using it would fail.
 */
async function captureToken(action: () => Promise<unknown>): Promise<string> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((chunk: any, ...rest: any[]) => {
    written.push(String(chunk));
    return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;

  try {
    await action();
  } finally {
    process.stdout.write = original;
  }

  const match = written.join("").match(/token=([A-Za-z0-9_-]+)/);
  if (!match?.[1]) {
    throw new Error("No token found in the sent email");
  }
  return decodeURIComponent(match[1]);
}

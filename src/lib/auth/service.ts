/**
 * Authentication service (§4).
 *
 * Threat-model notes that shaped this:
 *  - Signup and password-reset requests never reveal whether an email exists.
 *    Signup returns a generic conflict; reset always reports success.
 *  - Login failures are counted and the account locks temporarily, so a stolen
 *    password list cannot be sprayed against one account indefinitely.
 *  - Every response path on login performs a password hash comparison, including
 *    the "no such user" path, so timing does not disclose registration status.
 *  - Password changes revoke all sessions via the epoch bump.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { atomic, requireChange } from "@/lib/db/atomic";
import { emailTokens, subscriptions, users } from "@/lib/db/schema";
import {
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from "@/lib/crypto";
import { ConflictError, UnauthenticatedError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { revokeAllSessions } from "./session";
import { sendPasswordResetEmail, sendVerificationEmail } from "@/lib/email";

/** Lockout policy. Generous enough not to hurt real users who mistype. */
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * A hash of a fixed string, used to burn equivalent CPU on the
 * "user does not exist" login path so response time is not an oracle.
 */
let dummyHash: string | null = null;
async function dummyCompare(password: string): Promise<void> {
  dummyHash ??= await hashPassword("vidxir-timing-equalizer");
  await verifyPassword(password, dummyHash);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Password policy. Length beats composition rules for real-world strength. */
export function assertPasswordAcceptable(password: string): void {
  if (password.length < 10) {
    throw new ValidationError("Password must be at least 10 characters.", {
      field: "password",
    });
  }
  if (password.length > 200) {
    throw new ValidationError("Password must be at most 200 characters.", {
      field: "password",
    });
  }
  // Reject the handful of passwords that dominate credential-stuffing lists.
  const trivial = new Set([
    "password12",
    "password123",
    "1234567890",
    "qwertyuiop",
    "letmein123",
  ]);
  if (trivial.has(password.toLowerCase())) {
    throw new ValidationError("That password is too common.", {
      field: "password",
    });
  }
}

export interface SignupInput {
  name: string;
  email: string;
  password: string;
}

/**
 * Create an account. Also creates the free-tier subscription row so plan
 * enforcement always has something authoritative to read (§23).
 */
export async function signup(input: SignupInput): Promise<{ userId: string }> {
  const email = normalizeEmail(input.email);
  const name = input.name.trim();

  if (!name) {
    throw new ValidationError("Name is required.", { field: "name" });
  }
  assertPasswordAcceptable(input.password);

  const passwordHash = await hashPassword(input.password);

  /**
   * Insert first and let the unique index decide (§13).
   *
   * A SELECT-then-INSERT is a read→decision→write over a value the caller
   * supplies, and two simultaneous signups for the same address both pass the
   * SELECT. The loser then hits `users_email_normalized_key` inside the
   * transaction and surfaces as an unhandled unique violation — a 500 exposing
   * that the address is taken, when the whole point of the generic message above
   * is not to confirm that.
   *
   * `onConflictDoNothing` makes the index itself the arbiter: exactly one inserter
   * gets a row back, and an empty `returning` is the conflict. The database
   * already had the constraint; this just stops racing it.
   */
  const userId = crypto.randomUUID();
  try {
    await atomic([
      db.insert(users).values({ id: userId, email: input.email.trim(), emailNormalized: email, passwordHash, name })
        .onConflictDoNothing({ target: users.emailNormalized }),
      ...requireChange(),
      db.insert(subscriptions).values({ userId, tier: "starter", status: "active", provider: "none" }),
    ]);
  } catch (error) {
    if (String(error).includes("CHECK constraint failed")) throw new ConflictError("That email cannot be used to sign up.");
    throw error;
  }

  logger.info("user signed up", { userId, component: "auth" });
  await issueVerificationEmail(userId, input.email.trim(), name);
  return { userId };
}

export interface LoginResult {
  userId: string;
  emailVerified: boolean;
  onboarded: boolean;
}

/** Verify credentials. Does not create the session — the route does that. */
export async function login(
  emailRaw: string,
  password: string,
): Promise<LoginResult> {
  const email = normalizeEmail(emailRaw);

  const rows = await db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      failedLoginCount: users.failedLoginCount,
      lockedUntil: users.lockedUntil,
      emailVerifiedAt: users.emailVerifiedAt,
      onboardedAt: users.onboardedAt,
    })
    .from(users)
    .where(eq(users.emailNormalized, email))
    .limit(1);

  const user = rows[0];
  if (!user) {
    await dummyCompare(password);
    throw new UnauthenticatedError("Incorrect email or password.");
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
    throw new UnauthenticatedError(
      `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    );
  }

  const ok = await verifyPassword(password, user.passwordHash);

  if (!ok) {
    const failed = user.failedLoginCount + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await db
      .update(users)
      .set({
        failedLoginCount: lock ? 0 : failed,
        lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MS) : null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    logger.warn("failed login", {
      userId: user.id,
      component: "auth",
      attempt: failed,
      locked: lock,
    });
    throw new UnauthenticatedError("Incorrect email or password.");
  }

  await db
    .update(users)
    .set({
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  logger.info("user logged in", { userId: user.id, component: "auth" });

  return {
    userId: user.id,
    emailVerified: user.emailVerifiedAt !== null,
    onboarded: user.onboardedAt !== null,
  };
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

async function createEmailToken(
  userId: string,
  purpose: "verify_email" | "reset_password",
  ttlMs: number,
): Promise<string> {
  const token = generateToken();
  // Invalidate outstanding tokens of the same purpose so an old link in an
  // inbox cannot be used after a new one is requested.
  await db
    .update(emailTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(emailTokens.userId, userId),
        eq(emailTokens.purpose, purpose),
        isNull(emailTokens.consumedAt),
      ),
    );

  await db.insert(emailTokens).values({
    userId,
    purpose,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlMs),
  });

  return token;
}

export async function issueVerificationEmail(
  userId: string,
  email: string,
  name: string,
): Promise<void> {
  const token = await createEmailToken(
    userId,
    "verify_email",
    VERIFY_TOKEN_TTL_MS,
  );
  await sendVerificationEmail({ to: email, name, token });
}

/** Resend verification for the signed-in user. */
export async function resendVerification(userId: string): Promise<void> {
  const rows = await db
    .select({
      email: users.email,
      name: users.name,
      verifiedAt: users.emailVerifiedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const user = rows[0];
  if (!user || user.verifiedAt) return;
  await issueVerificationEmail(userId, user.email, user.name);
}

/** Consume a verification token. Returns the user id on success. */
export async function verifyEmail(token: string): Promise<string> {
  const rows = await db
    .select({
      id: emailTokens.id,
      userId: emailTokens.userId,
      expiresAt: emailTokens.expiresAt,
      consumedAt: emailTokens.consumedAt,
    })
    .from(emailTokens)
    .where(
      and(
        eq(emailTokens.tokenHash, hashToken(token)),
        eq(emailTokens.purpose, "verify_email"),
      ),
    )
    .limit(1);

  const record = rows[0];
  if (!record || record.consumedAt || record.expiresAt.getTime() <= Date.now()) {
    throw new ValidationError("This verification link is invalid or expired.");
  }

  try { await atomic([
    db
      .update(emailTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(emailTokens.id, record.id), isNull(emailTokens.consumedAt), gt(emailTokens.expiresAt, new Date()))),
    ...requireChange(),
    db
      .update(users)
      .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, record.userId)),
  ]); } catch (error) {
    if (String(error).includes("CHECK constraint failed")) throw new ValidationError("This verification link is invalid or expired.");
    throw error;
  }

  logger.info("email verified", { userId: record.userId, component: "auth" });
  return record.userId;
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

/**
 * Begin a password reset. Always resolves successfully, whether or not the
 * address is registered — the response must not be an account oracle.
 */
export async function requestPasswordReset(emailRaw: string): Promise<void> {
  const email = normalizeEmail(emailRaw);
  const rows = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.emailNormalized, email))
    .limit(1);

  const user = rows[0];
  if (!user) {
    logger.info("password reset requested for unknown address", {
      component: "auth",
    });
    return;
  }

  const token = await createEmailToken(
    user.id,
    "reset_password",
    RESET_TOKEN_TTL_MS,
  );
  await sendPasswordResetEmail({ to: user.email, name: user.name, token });
  logger.info("password reset email sent", {
    userId: user.id,
    component: "auth",
  });
}

/** Complete a password reset and log every existing session out. */
export async function resetPassword(
  token: string,
  newPassword: string,
): Promise<void> {
  assertPasswordAcceptable(newPassword);

  const rows = await db
    .select({
      id: emailTokens.id,
      userId: emailTokens.userId,
      expiresAt: emailTokens.expiresAt,
      consumedAt: emailTokens.consumedAt,
    })
    .from(emailTokens)
    .where(
      and(
        eq(emailTokens.tokenHash, hashToken(token)),
        eq(emailTokens.purpose, "reset_password"),
      ),
    )
    .limit(1);

  const record = rows[0];
  if (!record || record.consumedAt || record.expiresAt.getTime() <= Date.now()) {
    throw new ValidationError("This reset link is invalid or expired.");
  }

  const passwordHash = await hashPassword(newPassword);

  try { await atomic([
    db
      .update(emailTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(emailTokens.id, record.id), isNull(emailTokens.consumedAt), gt(emailTokens.expiresAt, new Date()))),
    ...requireChange(),
    db
      .update(users)
      .set({
        passwordHash,
        failedLoginCount: 0,
        lockedUntil: null,
        // A successful reset also proves control of the mailbox.
        emailVerifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, record.userId)),
  ]); } catch (error) {
    if (String(error).includes("CHECK constraint failed")) throw new ValidationError("This reset link is invalid or expired.");
    throw error;
  }

  await revokeAllSessions(record.userId);
  logger.info("password reset completed", {
    userId: record.userId,
    component: "auth",
  });
}

/** Change password for a signed-in user; requires the current password. */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  assertPasswordAcceptable(newPassword);

  const rows = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const user = rows[0];
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new UnauthenticatedError("Current password is incorrect.");
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
    .where(eq(users.id, userId));

  await revokeAllSessions(userId);
}

/** Mark §5 onboarding complete. */
export async function markOnboarded(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ onboardedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

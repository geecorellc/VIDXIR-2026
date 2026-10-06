/**
 * Blocked-state classification (§30, §37, §48).
 *
 * `blocked_not_configured` is one job status covering two causes: a credential
 * that was never set, and a provider account with no money in it. The status is
 * shared on purpose — both need an operator, and neither is worth retrying — but
 * the words on screen must not be. Telling someone whose `ANTHROPIC_API_KEY` is
 * valid that "credentials are missing" sends them to verify something already
 * correct while the real fix goes untouched.
 *
 * These tests pin that split, because the two errors are awkward to reproduce by
 * hand: one needs an unset variable, the other an exhausted billing account.
 */
import { describe, expect, it } from "vitest";
import {
  DatabaseError,
  NotConfiguredError,
  ProviderOutOfCreditError,
  asDatabaseError,
  blockedReasonLabel,
  errorCodeOf,
  isBlockingCode,
  isRetryable,
  userMessageOf,
  withDatabaseErrors,
} from "@/lib/errors";

describe("isBlockingCode", () => {
  it("covers both states an operator has to clear", () => {
    expect(isBlockingCode("provider_not_configured")).toBe(true);
    expect(isBlockingCode("provider_out_of_credit")).toBe(true);
  });

  it("excludes failures a retry could fix", () => {
    // These must stay `failed`, not `blocked_not_configured`: the queue should
    // try them again, and the UI should offer a retry rather than a config note.
    expect(isBlockingCode("provider_rate_limited")).toBe(false);
    expect(isBlockingCode("provider_timeout")).toBe(false);
    expect(isBlockingCode("provider_failed")).toBe(false);
  });

  it("excludes an invalid key, which is fixed by rotating not by topping up", () => {
    expect(isBlockingCode("provider_auth_failed")).toBe(false);
  });

  it("treats absent codes as non-blocking", () => {
    // Older rows predate the column; an unknown state must not be reported as a
    // configuration problem.
    expect(isBlockingCode(null)).toBe(false);
    expect(isBlockingCode(undefined)).toBe(false);
    expect(isBlockingCode("")).toBe(false);
  });
});

describe("blockedReasonLabel", () => {
  it("names credit, not credentials, for an exhausted balance", () => {
    const label = blockedReasonLabel("provider_out_of_credit", "Claude");
    expect(label).toBe("Claude is out of credit");
    // The key is present and valid, so this word would be a lie.
    expect(label).not.toMatch(/configur/i);
  });

  it("names configuration for a missing credential", () => {
    expect(blockedReasonLabel("provider_not_configured", "ElevenLabs")).toBe(
      "ElevenLabs is not configured",
    );
  });

  it("reads as a sentence when the provider is unknown", () => {
    // The research run row records a code but no provider name.
    expect(blockedReasonLabel("provider_not_configured")).toBe(
      "A provider is not configured",
    );
    expect(blockedReasonLabel("provider_out_of_credit")).toBe(
      "A provider is out of credit",
    );
  });

  it("falls back to the configuration wording for an unrecognised code", () => {
    // A row written before the column existed. "Not configured" is the safer of
    // the two guesses: it was the only cause this status had at the time.
    expect(blockedReasonLabel(null)).toBe("A provider is not configured");
  });
});

describe("the errors behind the labels", () => {
  it("is what NotConfiguredError and ProviderOutOfCreditError classify as", () => {
    // The chain the UI depends on: error -> code -> blocking -> label.
    const missing = new NotConfiguredError("Claude", ["ANTHROPIC_API_KEY"], "hint");
    const broke = new ProviderOutOfCreditError("Claude");

    for (const error of [missing, broke]) {
      expect(isBlockingCode(errorCodeOf(error))).toBe(true);
      // Neither is worth another attempt: nothing changes between tries.
      expect(isRetryable(error)).toBe(false);
    }

    expect(blockedReasonLabel(errorCodeOf(missing), "Claude")).toMatch(/not configured/);
    expect(blockedReasonLabel(errorCodeOf(broke), "Claude")).toMatch(/out of credit/);
  });
});

/**
 * Database failure classification (§14).
 *
 * The consequence is concrete rather than cosmetic. `shouldRetry()` in the worker
 * harness treats an unclassified `Error` as retryable, so before this class existed
 * every database fault — a dropped connection *and* a constraint violation — burned
 * the full attempt budget identically. These tests pin the split in both directions,
 * since getting either wrong is expensive: a permanent error retried three times
 * delays the failure a user needs to see, and a transient one marked permanent
 * abandons work a retry would have completed.
 *
 * Errors are shaped the way postgres.js delivers them (a `code` plus a `severity`
 * for a server error, a bare `code` for a socket failure) because that shape is the
 * only signal available at the boundary.
 */
describe("asDatabaseError", () => {
  /** What postgres.js throws for a server-side error. */
  function pgError(code: string, message = "db said no"): Error {
    return Object.assign(new Error(message), { code, severity: "ERROR" });
  }

  it("classifies a lost connection as retryable", () => {
    const classified = asDatabaseError("claim slot", pgError("08006"));
    expect(classified).toBeInstanceOf(DatabaseError);
    expect(classified.code).toBe("database_failure");
    expect(classified.retryable).toBe(true);
  });

  it("classifies a deadlock and a serialization failure as retryable", () => {
    // Retrying is the documented remedy: one transaction was chosen as the victim
    // precisely so the other could proceed.
    for (const state of ["40001", "40P01"]) {
      expect(asDatabaseError("write", pgError(state)).retryable).toBe(true);
    }
  });

  it("classifies our own statement_timeout as retryable", () => {
    // 57014 is what `DATABASE_STATEMENT_TIMEOUT_MS` produces. A query cancelled
    // because the database was momentarily overloaded may well succeed next time.
    expect(asDatabaseError("report", pgError("57014")).retryable).toBe(true);
  });

  it("classifies a syntax error as permanent", () => {
    // 42601. The identical statement fails identically forever; retrying only
    // delays the failure an operator needs to see.
    const classified = asDatabaseError("query", pgError("42601"));
    expect(classified).toBeInstanceOf(DatabaseError);
    expect(classified.retryable).toBe(false);
  });

  it("classifies a unique violation as permanent", () => {
    /**
     * 23505 is deliberately not in the retryable set. Unique violations are
     * load-bearing here — the billing webhook's idempotency guard and the analytics
     * upserts both rely on hitting one — and are handled at the call site with
     * `onConflictDoNothing`. One reaching this boundary is a real conflict.
     */
    expect(asDatabaseError("insert", pgError("23505")).retryable).toBe(false);
  });

  it("classifies a socket-level failure as retryable", () => {
    // No SQLSTATE: the connection died before Postgres answered.
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "CONNECTION_ENDED"]) {
      const classified = asDatabaseError("ping", Object.assign(new Error("gone"), { code }));
      expect(classified, code).toBeInstanceOf(DatabaseError);
      expect(classified.retryable, code).toBe(true);
    }
  });

  it("leaves an unrecognised error as internal_error rather than claiming a DB fault", () => {
    // Labelling an ordinary bug a "database failure" would send an operator to
    // inspect a perfectly healthy database.
    const classified = asDatabaseError("anything", new TypeError("x is not a function"));
    expect(classified).not.toBeInstanceOf(DatabaseError);
    expect(classified.code).toBe("internal_error");
    expect(classified.retryable).toBe(false);
  });

  it("passes an already-classified AppError straight through", () => {
    // A ForbiddenError raised inside a wrapped block is not a database failure and
    // must keep its 403 rather than becoming a 503.
    const original = new NotConfiguredError("Claude", ["ANTHROPIC_API_KEY"], "hint");
    expect(asDatabaseError("wrapped", original)).toBe(original);
  });

  it("never puts SQL, a DSN or bound parameters in the client-facing message", () => {
    /**
     * §14: production responses must not expose SQL. A postgres.js error carries
     * the failing statement and often the parameters, so the response body has to
     * come from a fixed string rather than from the driver.
     */
    const leaky = pgError(
      "42601",
      'syntax error at or near "SELCT" — ' +
        "SELECT * FROM users WHERE email = 'victim@example.com'; " +
        "dsn=postgresql://vidxir:hunter2@db.internal:5432/vidxir",
    );
    const classified = asDatabaseError("read users", leaky);
    const body = JSON.stringify(classified.toResponseBody());

    expect(body).not.toContain("SELECT");
    expect(body).not.toContain("victim@example.com");
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("42601");
    expect(userMessageOf(classified)).toMatch(/could not be completed/i);

    // The original survives as `cause`, so the logger — which redacts — still has
    // the full detail for diagnosis.
    expect(classified.cause).toBe(leaky);
  });

  it("returns the operation name, which is a caller literal and safe to expose", () => {
    const classified = asDatabaseError("claim automation slot", pgError("08006"));
    expect(classified.details).toMatchObject({ operation: "claim automation slot" });
  });
});

describe("withDatabaseErrors", () => {
  it("returns the value when nothing throws", async () => {
    await expect(withDatabaseErrors("read", async () => 42)).resolves.toBe(42);
  });

  it("classifies what the wrapped function throws", async () => {
    const thrown = Object.assign(new Error("connection closed"), {
      code: "CONNECTION_CLOSED",
    });
    await expect(
      withDatabaseErrors("mark job running", async () => {
        throw thrown;
      }),
    ).rejects.toMatchObject({ code: "database_failure", retryable: true });
  });
});

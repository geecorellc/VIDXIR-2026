/**
 * Provider error classification (§30, §48).
 *
 * These tests exist because two decisions hang off `translate()`, and both are
 * invisible until something is already going wrong in production:
 *
 *  - **Whether the worker retries.** `AppError.retryable` is what the harness
 *    reads. Classifying a permanent failure as retryable burns the whole attempt
 *    budget on identical failures; classifying a transient one as permanent
 *    fails a job that would have succeeded on the next try.
 *  - **What the operator is told to fix.** A missing key, a revoked key and an
 *    empty balance are three different actions, and the raw SDK message for the
 *    third is a JSON blob that would otherwise be written straight into
 *    `research_runs.error` and rendered on the Research screen.
 *
 * No network and no API key: `translate` is a pure function over an SDK error.
 */
import { describe, expect, it } from "vitest";
// Imported as a named class, not as `Anthropic.APIError`: the namespace member
// is a value only, so it cannot annotate the return type below.
import { APIError } from "@anthropic-ai/sdk";
import { translate } from "@/lib/providers/ai";
import { isAppError, isRetryable } from "@/lib/errors";

/**
 * Build a real `APIError` rather than a lookalike, so the `instanceof` branch
 * under test is the one that runs.
 */
function apiError(status: number, message: string, body?: unknown): APIError {
  return APIError.generate(
    status,
    body ?? { type: "error", error: { type: "invalid_request_error", message } },
    message,
    new Headers(),
  );
}

describe("translate", () => {
  describe("authentication", () => {
    it("names the env var on a 401 so the operator knows which key is wrong", () => {
      const error = translate(apiError(401, "invalid x-api-key"));
      expect(isAppError(error) && error.code).toBe("provider_auth_failed");
      // Never retried: a rejected key is rejected on every attempt.
      expect(isRetryable(error)).toBe(false);
      expect(error.message).toContain("ANTHROPIC_API_KEY");
    });

    it("treats 403 the same as 401", () => {
      const error = translate(apiError(403, "forbidden"));
      expect(isAppError(error) && error.code).toBe("provider_auth_failed");
      expect(isRetryable(error)).toBe(false);
    });
  });

  describe("billing", () => {
    /** The exact body the API returns for an exhausted balance. */
    const OUT_OF_CREDIT =
      "Your credit balance is too low to access the Anthropic API. " +
      "Please go to Plans & Billing to upgrade or purchase credits.";

    it("classifies an exhausted balance separately from an auth failure", () => {
      const error = translate(apiError(400, OUT_OF_CREDIT));

      // The key is valid, so this is not an auth problem; and no amount of
      // waiting adds credit, so it is not a rate limit either.
      expect(isAppError(error) && error.code).toBe("provider_out_of_credit");
      expect(isRetryable(error)).toBe(false);
      expect(isAppError(error) && error.status).toBe(402);
    });

    it("says what to do instead of forwarding the raw API blob", () => {
      const error = translate(apiError(400, OUT_OF_CREDIT));

      // This string reaches `research_runs.error` and the Research screen, so it
      // has to read as an instruction, not as a stack trace.
      expect(error.message).toMatch(/out of\s+credit/i);
      expect(error.message).toMatch(/top up/i);
      expect(error.message).not.toContain("{");
      expect(error.message).not.toContain("invalid_request_error");
    });

    it("does not mistake an ordinary bad request for a billing problem", () => {
      const error = translate(apiError(400, "max_tokens: must be >= 1"));
      expect(isAppError(error) && error.code).toBe("provider_failed");
      expect(isRetryable(error)).toBe(false);
    });
  });

  describe("transient failures", () => {
    it("retries a 429 and honours retry-after when the API sends one", () => {
      const headers = new Headers({ "retry-after": "17" });
      const raw = APIError.generate(
        429,
        { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
        "slow down",
        headers,
      );

      const error = translate(raw);
      expect(isAppError(error) && error.code).toBe("provider_rate_limited");
      expect(isRetryable(error)).toBe(true);
      expect(isAppError(error) && error.retryAfterSeconds).toBe(17);
    });

    it("falls back to a default wait when retry-after is absent", () => {
      const error = translate(apiError(429, "slow down"));
      expect(isAppError(error) && (error.retryAfterSeconds ?? 0)).toBeGreaterThan(0);
    });

    it("retries a 5xx", () => {
      const error = translate(apiError(503, "overloaded"));
      expect(isAppError(error) && error.code).toBe("provider_failed");
      expect(isRetryable(error)).toBe(true);
    });

    it("retries an unrecognised non-SDK error once", () => {
      // The usual cause is a socket fault. The attempt limit stops it looping.
      const error = translate(new Error("ECONNRESET"));
      expect(isAppError(error) && error.code).toBe("provider_failed");
      expect(isRetryable(error)).toBe(true);
      // The underlying message is not forwarded to the user.
      expect(error.message).not.toContain("ECONNRESET");
    });
  });
});

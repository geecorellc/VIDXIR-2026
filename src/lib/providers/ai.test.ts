/**
 * Provider error classification and transport selection (§30, §32, §48).
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
 * With two transports there is a third: **which credential store the message
 * points at.** Telling an operator on Bedrock to check `ANTHROPIC_API_KEY` sends
 * them to a console they do not use, so the remedy is asserted per provider.
 *
 * No network and no credentials: `translate` is a pure function over an SDK error
 * plus the selected provider, and the configuration helpers only read env.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Imported as a named class, not as `Anthropic.APIError`: the namespace member
// is a value only, so it cannot annotate the return type below.
import { APIError } from "@anthropic-ai/sdk";
import {
  aiMissingEnvVars,
  aiModelName,
  aiProviderName,
  isAiConfigured,
  translate,
} from "@/lib/providers/ai";
import { isAppError, isRetryable } from "@/lib/errors";
import { resetEnvCache } from "@/lib/env";

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

/**
 * The variables `lib/env` requires before it will parse at all. Local
 * placeholders, not credentials — nothing here connects to anything.
 */
const BASE = {
  DATABASE_URL: "postgresql://vidxir:vidxir@localhost:5432/vidxir_unit",
  REDIS_URL: "redis://127.0.0.1:6379",
  S3_BUCKET: "vidxir-unit",
  S3_ACCESS_KEY_ID: "unit",
  S3_SECRET_ACCESS_KEY: "unit",
  ENCRYPTION_KEY: "a".repeat(64),
  SESSION_SECRET: "b".repeat(64),
} as const;

/**
 * Every variable a case may set, cleared before each so a test starts from a
 * known state. A leaked `AI_PROVIDER` would silently retarget later cases, and a
 * leaked `AWS_REGION` would make the "no region" case pass for the wrong reason.
 */
const MANAGED = [
  "AI_PROVIDER",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "BEDROCK_REGION",
  "BEDROCK_MODEL",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  ...Object.keys(BASE),
] as const;

const original = new Map<string, string | undefined>(
  MANAGED.map((key) => [key, process.env[key]]),
);

/**
 * Point the module at one transport for the duration of a test.
 *
 * The env cache is what makes configuration a one-time cost in production, so it
 * has to be dropped for a change to be visible.
 */
function useProvider(
  provider: "anthropic" | "bedrock",
  extra: Record<string, string | undefined> = {},
): void {
  for (const key of MANAGED) delete process.env[key];
  const vars: Record<string, string | undefined> = {
    ...BASE,
    AI_PROVIDER: provider,
    ...extra,
  };
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
}

/**
 * Every case starts on a known transport rather than on whatever the developer's
 * shell happens to export. `translate()` reads the selected provider to choose a
 * remedy, so an ambient `AI_PROVIDER` would otherwise decide these assertions.
 */
beforeEach(() => {
  useProvider("anthropic", { ANTHROPIC_API_KEY: "unit-placeholder" });
});

afterEach(() => {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
});

describe("translate", () => {
  describe("authentication", () => {
    it("names the env var on a 401 so the operator knows which key is wrong", () => {
      useProvider("anthropic");
      const error = translate(apiError(401, "invalid x-api-key"));
      expect(isAppError(error) && error.code).toBe("provider_auth_failed");
      // Never retried: a rejected key is rejected on every attempt.
      expect(isRetryable(error)).toBe(false);
      expect(error.message).toContain("ANTHROPIC_API_KEY");
    });

    it("points at the AWS credential chain, not the Anthropic key, on Bedrock", () => {
      useProvider("bedrock", { BEDROCK_REGION: "us-east-1" });
      // The live API returns exactly this for an invalid SigV4 signature.
      const error = translate(
        apiError(401, "The security token included in the request is invalid."),
      );

      expect(isAppError(error) && error.code).toBe("provider_auth_failed");
      expect(isRetryable(error)).toBe(false);
      // The remedy is an AWS one. Naming the Anthropic key here would send the
      // operator to the wrong console entirely.
      expect(error.message).not.toContain("ANTHROPIC_API_KEY");
      expect(error.message).toMatch(/AWS/);
      expect(error.message).toContain("BEDROCK_REGION");
    });

    it("treats 403 the same as 401", () => {
      useProvider("anthropic");
      const error = translate(apiError(403, "forbidden"));
      expect(isAppError(error) && error.code).toBe("provider_auth_failed");
      expect(isRetryable(error)).toBe(false);
    });
  });

  describe("Bedrock model availability", () => {
    /**
     * Bedrock returns 404 for a model the account cannot reach in that region —
     * a configuration problem with a specific fix. Unclassified it reads as a
     * transient "not found" against a valid credential, which is the wrong
     * diagnosis and, if retried, a wasted attempt budget.
     */
    it("explains a 404 as a model-access problem and does not retry it", () => {
      useProvider("bedrock", { BEDROCK_REGION: "us-east-1" });
      const error = translate(
        apiError(404, "The model 'anthropic.claude-nonexistent-9' does not exist"),
      );

      expect(isAppError(error) && error.code).toBe("provider_failed");
      expect(isRetryable(error)).toBe(false);
      expect(error.message).toContain("BEDROCK_MODEL");
      expect(error.message).toContain("BEDROCK_REGION");
    });

    it("leaves a 404 on the first-party API as an ordinary permanent failure", () => {
      useProvider("anthropic");
      const error = translate(apiError(404, "not found"));
      expect(isAppError(error) && error.code).toBe("provider_failed");
      expect(isRetryable(error)).toBe(false);
      // No Bedrock advice on a transport that has no Bedrock configuration.
      expect(error.message).not.toContain("BEDROCK_MODEL");
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

/**
 * Transport selection (§32).
 *
 * These are the values written to `api_usage.provider`, `ideas.generated_by` and
 * `script_versions.provider`/`model`. Provenance is only worth recording if it is
 * accurate, so the mapping from configuration to recorded name is pinned here
 * (§29).
 */
describe("provider selection", () => {
  it("defaults to the first-party API so an existing deployment is unaffected", () => {
    useProvider("anthropic", { AI_PROVIDER: undefined });
    expect(aiProviderName()).toBe("anthropic");
  });

  it("reports the transport that will actually be called", () => {
    useProvider("bedrock", { BEDROCK_REGION: "us-east-1" });
    expect(aiProviderName()).toBe("bedrock");
  });

  describe("model naming", () => {
    /**
     * Bedrock namespaces model ids. Sending the bare first-party `claude-opus-5`
     * to Bedrock returns a 404 "does not exist" — verified against the live API —
     * so an operator who configures the bare name gets the prefix rather than a
     * confusing runtime failure.
     */
    it("adds the anthropic. prefix a Bedrock id requires", () => {
      useProvider("bedrock", {
        BEDROCK_REGION: "us-east-1",
        BEDROCK_MODEL: "claude-opus-5",
      });
      expect(aiModelName()).toBe("anthropic.claude-opus-5");
    });

    it("leaves an already-namespaced id alone", () => {
      useProvider("bedrock", {
        BEDROCK_REGION: "us-east-1",
        BEDROCK_MODEL: "anthropic.claude-haiku-4-5",
      });
      expect(aiModelName()).toBe("anthropic.claude-haiku-4-5");
    });

    it("does not touch the first-party model id", () => {
      useProvider("anthropic", { ANTHROPIC_MODEL: "claude-opus-5" });
      expect(aiModelName()).toBe("claude-opus-5");
    });
  });

  describe("configuration state (§48)", () => {
    it("names BEDROCK_REGION when Bedrock has no region", () => {
      useProvider("bedrock", {
        BEDROCK_REGION: undefined,
        AWS_REGION: undefined,
        AWS_DEFAULT_REGION: undefined,
      });
      expect(isAiConfigured()).toBe(false);
      expect(aiMissingEnvVars()).toEqual(["BEDROCK_REGION"]);
    });

    it("accepts the standard AWS_REGION so a deployment need not repeat itself", () => {
      useProvider("bedrock", {
        BEDROCK_REGION: undefined,
        AWS_REGION: "us-east-1",
      });
      expect(isAiConfigured()).toBe(true);
      expect(aiMissingEnvVars()).toEqual([]);
    });

    /**
     * Credentials are deliberately *not* part of this check. The AWS chain
     * resolves them asynchronously from sources this process cannot inspect —
     * an instance role, an SSO cache, a profile — so reporting them as present or
     * absent would be a guess presented as a fact (§42). An absent credential
     * surfaces as the auth error asserted above instead.
     */
    it("does not claim to have verified AWS credentials", () => {
      useProvider("bedrock", {
        BEDROCK_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: undefined,
        AWS_SECRET_ACCESS_KEY: undefined,
      });
      expect(isAiConfigured()).toBe(true);
      expect(aiMissingEnvVars()).toEqual([]);
    });

    it("still names ANTHROPIC_API_KEY on the first-party transport", () => {
      useProvider("anthropic", { ANTHROPIC_API_KEY: undefined });
      expect(isAiConfigured()).toBe(false);
      expect(aiMissingEnvVars()).toEqual(["ANTHROPIC_API_KEY"]);
    });

    /**
     * The Bedrock path must not require an Anthropic key. This is the regression
     * that would silently reintroduce the old coupling and block every AI feature
     * on a Bedrock-only deployment.
     */
    it("does not require an Anthropic key when Bedrock is selected", () => {
      useProvider("bedrock", {
        BEDROCK_REGION: "us-east-1",
        ANTHROPIC_API_KEY: undefined,
      });
      expect(isAiConfigured()).toBe(true);
      expect(aiMissingEnvVars()).toEqual([]);
    });
  });
});

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
  NotConfiguredError,
  ProviderOutOfCreditError,
  blockedReasonLabel,
  errorCodeOf,
  isBlockingCode,
  isRetryable,
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

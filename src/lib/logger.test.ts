/**
 * Log redaction (§15).
 *
 * §15's list of things that must never be logged is not satisfied by a key-name
 * filter alone. `{ accessToken: "ya29..." }` is caught by the key; the ways a
 * credential actually reaches a log line in this codebase are messier and all
 * arrive as a *value* under an innocent key:
 *
 *  - a provider error whose `message` quotes the request URL, query string included
 *  - an OAuth redirect logged as `url`, carrying `?access_token=`
 *  - a 401 body echoing back the `Authorization: Bearer ...` it rejected
 *  - a postgres.js connection error naming the DSN, password and all
 *
 * These tests exist because that class of leak is invisible in review — the call
 * site looks like `log.error("upload failed", { error })` in every case — and
 * because the patterns are the kind of thing a later edit silently weakens.
 *
 * The counter-requirement is tested too: redaction must not eat the identifiers
 * that make a trace usable. A rule that scrubbed anything long and random would
 * take every UUID with it and destroy the correlation §15 asks for.
 */
import { describe, expect, it } from "vitest";
import { redactValue } from "@/lib/logger";

describe("redactValue", () => {
  it("strips an access token from a query string but keeps the parameter name", () => {
    const line = redactValue(
      "GET /api/channels/callback?code=abc&access_token=ya29.A0ARrdaM-not-a-real-token",
    );
    expect(line).not.toContain("ya29.A0ARrdaM");
    // The name survives, so an operator can still see *which* credential was in
    // the URL — that is the diagnostic; the value is not.
    expect(line).toContain("access_token=[redacted]");
    expect(line).toContain("code=abc");
  });

  it("strips refresh tokens, id tokens and client secrets by parameter name", () => {
    for (const name of ["refresh_token", "id_token", "client_secret", "api_key"]) {
      const out = redactValue(`error: ${name}=super-secret-value-here`);
      expect(out).toContain(`${name}=[redacted]`);
      expect(out).not.toContain("super-secret-value-here");
    }
  });

  it("strips an Authorization header echoed into an error body", () => {
    const out = redactValue(
      'provider rejected: {"error":"invalid","sent":"Authorization: Bearer abcdefghijklmnop"}',
    );
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).toContain("Bearer [redacted]");
  });

  it("strips Basic credentials", () => {
    const out = redactValue("upstream sent Basic dXNlcjpwYXNzd29yZA==");
    expect(out).not.toContain("dXNlcjpwYXNzd29yZA");
    expect(out).toContain("Basic [redacted]");
  });

  it("strips provider key prefixes: Stripe, sk-, Google, JWT", () => {
    const cases = [
      "sk_live_51ABCdefGHIjklMNOpqrs",
      "sk_test_51ABCdefGHIjklMNOpqrs",
      "rk_live_51ABCdefGHIjklMNOpqrs",
      "whsec_ABCdefGHIjklMNOpqrstuvw",
      "sk-ant-api03-AAAAAAAAAAAAAAAAAAAA",
      "ya29.a0AfH6SMBexampleexample",
      "1//0gExampleRefreshTokenValue",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
    ];
    for (const secret of cases) {
      const out = redactValue(`failed with ${secret} attached`);
      expect(out, `leaked: ${secret}`).not.toContain(secret);
      expect(out).toContain("failed with");
    }
  });

  it("strips the password out of a connection string", () => {
    // The realistic shape: postgres.js quotes the DSN in a connection error, and
    // that error reaches `log.error(..., { error })` from the readiness probe.
    const out = redactValue(
      "connection to postgresql://vidxir:hunter2@db.internal:5432/vidxir failed",
    );
    expect(out).not.toContain("hunter2");
    expect(out).toContain("postgresql://[redacted]@");
    // The host is deliberately kept: it is not a credential, and it is the field
    // that tells an operator which database was unreachable.
    expect(out).toContain("db.internal:5432");
  });

  it("leaves ordinary diagnostics — including UUIDs — untouched", () => {
    const trace = "3f2b9c1e-4a7d-11ee-9c2b-0242ac120002";
    const message = `job ${trace} failed at stage RENDER after 4210ms`;
    // A general entropy heuristic would scrub this, and take every correlation
    // id in the system with it.
    expect(redactValue(message)).toBe(message);
  });

  it("leaves a bare URL with no credentials in it alone", () => {
    const url = "https://www.googleapis.com/youtube/v3/videos?part=snippet&id=abc123";
    expect(redactValue(url)).toBe(url);
  });

  it("redacts every occurrence, not just the first", () => {
    const out = redactValue(
      "first sk_live_AAAAAAAAAAAAAAAA then sk_live_BBBBBBBBBBBBBBBB",
    );
    expect(out).not.toContain("AAAAAAAAAAAAAAAA");
    expect(out).not.toContain("BBBBBBBBBBBBBBBB");
  });
});

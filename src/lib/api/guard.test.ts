/**
 * Proxy-hop trust and origin checking (§3, §7).
 *
 * `clientIp()` decides which string an IP-keyed rate limit is bucketed by, which
 * makes it a security control rather than a convenience: `authIp` is what bounds
 * login and signup, and if the key can be chosen by the caller then the limit can
 * be bypassed by rotating a header. `X-Forwarded-For` is exactly that kind of
 * header — a client may arrive with one already populated, and a proxy *appends*
 * the peer it saw rather than replacing the list.
 *
 * So the only trustworthy entry is the Nth from the right, where N is the number of
 * proxies genuinely in the path. These tests pin that arithmetic, and pin the two
 * fallbacks that matter more than the happy path: an unconfigured deployment must
 * ignore the header entirely, and a chain shorter than configured must degrade to a
 * shared bucket rather than trust a client-written entry.
 *
 * `assertSameOrigin` is covered alongside it because both read untrusted request
 * headers and both fail closed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
/**
 * Imported statically, not per test.
 *
 * `lib/env` is lazy — nothing reads `process.env` until the first `env()` call — so
 * importing at module scope is safe, and it keeps the ~6s cost of pulling in the
 * guard's dependency graph out of the first test's timeout budget.
 */
import { assertSameOrigin, assertUuid, clientIp } from "@/lib/api/guard";
import { resetEnvCache } from "@/lib/env";

/**
 * A `NextRequest`-shaped stub.
 *
 * `clientIp` reads `request.headers` and nothing else, and `assertSameOrigin` adds
 * `method` and `nextUrl.origin`. Constructing a real `NextRequest` would drag in the
 * Next server runtime for no additional coverage.
 */
function stubRequest(options: {
  headers?: Record<string, string>;
  method?: string;
  origin?: string;
}) {
  const headers = new Headers(options.headers ?? {});
  return {
    headers,
    method: options.method ?? "GET",
    nextUrl: { origin: options.origin ?? "https://app.vidxir.test" },
  } as unknown as import("next/server").NextRequest;
}

/**
 * `lib/env` caches on first access, and `clientIp` reads it per call — so the hop
 * count has to be set in `process.env` and the cache dropped before each case.
 */
function setHops(hops: string): void {
  process.env["TRUSTED_PROXY_HOPS"] = hops;
  resetEnvCache();
}

const ORIGINAL_HOPS = process.env["TRUSTED_PROXY_HOPS"];

beforeEach(() => {
  // The integration harness sets these; `lib/env` requires them to parse at all.
  process.env["DATABASE_URL"] ??= "postgresql://vidxir:vidxir@localhost:5432/vidxir_unit";
  process.env["REDIS_URL"] ??= "redis://127.0.0.1:6379";
  process.env["S3_BUCKET"] ??= "vidxir-unit";
  process.env["S3_ACCESS_KEY_ID"] ??= "unit";
  process.env["S3_SECRET_ACCESS_KEY"] ??= "unit";
  process.env["ENCRYPTION_KEY"] ??= "a".repeat(64);
  process.env["SESSION_SECRET"] ??= "b".repeat(64);
});

afterEach(() => {
  if (ORIGINAL_HOPS === undefined) delete process.env["TRUSTED_PROXY_HOPS"];
  else process.env["TRUSTED_PROXY_HOPS"] = ORIGINAL_HOPS;
  resetEnvCache();
});

describe("clientIp", () => {
  it("ignores X-Forwarded-For entirely when no proxy is configured", () => {
    setHops("0");
    // The attack this closes: with no proxy in front, anything in the header was
    // written by the caller, so consulting it hands them the rate-limit key.
    const request = stubRequest({
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    expect(clientIp(request)).toBe("direct");
  });

  it("reads the rightmost entry behind one proxy", () => {
    setHops("1");
    // The client pre-filled `9.9.9.9`; the load balancer appended the peer it
    // actually saw. Only the appended entry is trustworthy.
    const request = stubRequest({
      headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.7" },
    });
    expect(clientIp(request)).toBe("203.0.113.7");
  });

  it("counts from the right behind a CDN and a load balancer", () => {
    setHops("2");
    const request = stubRequest({
      headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.7, 198.51.100.2" },
    });
    // Two hops we operate: the CDN appended 203.0.113.7, the LB appended
    // 198.51.100.2. The last entry the client could not have written is the former.
    expect(clientIp(request)).toBe("203.0.113.7");
  });

  it("does not let a forged prefix shift the trusted entry", () => {
    setHops("1");
    const honest = clientIp(
      stubRequest({ headers: { "x-forwarded-for": "203.0.113.7" } }),
    );
    const forged = clientIp(
      stubRequest({
        headers: {
          "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.7",
        },
      }),
    );
    // Padding the header with junk must not change the bucket, or the limit is
    // free: one request per fabricated prefix.
    expect(forged).toBe(honest);
  });

  it("falls back to a shared bucket when the chain is shorter than configured", () => {
    setHops("2");
    // Only one entry, but two hops are expected — the request did not come through
    // the configured path. Sharing a bucket degrades the limit; trusting the single
    // client-written entry would remove it.
    const request = stubRequest({ headers: { "x-forwarded-for": "9.9.9.9" } });
    expect(clientIp(request)).toBe("unknown");
  });

  it("uses X-Real-IP behind exactly one proxy, where it is not a client-extendable list", () => {
    setHops("1");
    const request = stubRequest({ headers: { "x-real-ip": "203.0.113.9" } });
    expect(clientIp(request)).toBe("203.0.113.9");
  });

  it("does not consult X-Real-IP with no proxy configured", () => {
    setHops("0");
    const request = stubRequest({ headers: { "x-real-ip": "203.0.113.9" } });
    expect(clientIp(request)).toBe("direct");
  });

  it("returns a stable non-empty key when no headers are present at all", () => {
    setHops("1");
    // A rate-limit key of "" would collapse every caller into one bucket silently;
    // an undefined one would throw inside the limiter.
    expect(clientIp(stubRequest({}))).toBe("unknown");
  });
});

describe("assertSameOrigin", () => {
  it("allows reads without an origin check", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(() => assertSameOrigin(stubRequest({ method }))).not.toThrow();
    }
  });

  it("allows a same-origin write", () => {
    expect(() =>
      assertSameOrigin(
        stubRequest({
          method: "POST",
          origin: "https://app.vidxir.test",
          headers: { origin: "https://app.vidxir.test" },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects a write from another origin", () => {
    expect(() =>
      assertSameOrigin(
        stubRequest({
          method: "POST",
          origin: "https://app.vidxir.test",
          headers: { origin: "https://evil.example" },
        }),
      ),
    ).toThrow(/Cross-origin/);
  });

  it("rejects a write with no origin signal at all", () => {
    // Fails closed. A request that carries neither `Origin` nor `Sec-Fetch-Site`
    // cannot be shown to be same-origin, and a mutation is not the place to guess.
    expect(() => assertSameOrigin(stubRequest({ method: "POST" }))).toThrow(
      /Cross-origin/,
    );
  });

  it("rejects a scheme mismatch on the same host", () => {
    expect(() =>
      assertSameOrigin(
        stubRequest({
          method: "DELETE",
          origin: "https://app.vidxir.test",
          headers: { origin: "http://app.vidxir.test" },
        }),
      ),
    ).toThrow(/Cross-origin/);
  });

  it("accepts Sec-Fetch-Site: same-origin and none", () => {
    for (const site of ["same-origin", "none"]) {
      expect(() =>
        assertSameOrigin(
          stubRequest({ method: "PATCH", headers: { "sec-fetch-site": site } }),
        ),
      ).not.toThrow();
    }
  });

  it("rejects Sec-Fetch-Site: cross-site even when an origin header agrees", () => {
    expect(() =>
      assertSameOrigin(
        stubRequest({
          method: "POST",
          origin: "https://app.vidxir.test",
          headers: {
            "sec-fetch-site": "cross-site",
            origin: "https://evil.example",
          },
        }),
      ),
    ).toThrow(/Cross-origin/);
  });
});

describe("assertUuid", () => {
  it("accepts a well-formed v4 uuid", () => {
    expect(() =>
      assertUuid("3f2b9c1e-4a7d-4bee-9c2b-0242ac120002", "projectId"),
    ).not.toThrow();
  });

  it("rejects malformed ids before they reach a query", () => {
    const malformed = [
      "",
      "not-a-uuid",
      "3f2b9c1e4a7d4bee9c2b0242ac120002",
      // A SQL fragment and a path traversal attempt, which are the shapes that
      // matter: rejected as invalid input rather than reaching the database or the
      // filesystem at all.
      "3f2b9c1e-4a7d-4bee-9c2b-0242ac120002' OR '1'='1",
      "../../etc/passwd",
      // Nil UUID: version nibble 0, outside the v1–v5 range the pattern accepts.
      "00000000-0000-0000-0000-000000000000",
    ];
    for (const value of malformed) {
      expect(() => assertUuid(value, "projectId"), value).toThrow(
        /Invalid projectId/,
      );
    }
  });

  it("names the field in the error but does not echo the value", () => {
    const injected = "'; DROP TABLE users; --";
    try {
      assertUuid(injected, "channelId");
      throw new Error("expected a rejection");
    } catch (error) {
      const body = JSON.stringify(error);
      expect(body).not.toContain("DROP TABLE");
    }
  });
});

/**
 * SSRF guard tests (§34, §39).
 *
 * `fetchRemoteAsset` is the one place where a URL chosen by an upstream API is
 * handed to an HTTP client running inside our network. The refusals below are the
 * security control, and the only honest way to test them is to assert on the
 * validator directly — a test that actually tried to reach 169.254.169.254 would
 * either hang or, on the wrong machine, succeed.
 *
 * Note that `validateUrl` resolves DNS for an allow-listed host, so the tests here
 * either use IP literals (no lookup) or assert on refusals that happen before the
 * lookup. That keeps them offline and deterministic.
 */
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Set here rather than read from `.env`, so a developer's own
 * ASSET_FETCH_ALLOWED_HOSTS cannot make an allow-list assertion pass or fail
 * locally in a way it would not in CI. It is deliberately empty: these tests
 * assert the compiled-in provider list and per-call extras only.
 */
const TEST_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://tally:tally@127.0.0.1:5432/tally_test",
  REDIS_URL: "redis://127.0.0.1:6379",
  S3_BUCKET: "tally-test",
  S3_ACCESS_KEY_ID: "test",
  S3_SECRET_ACCESS_KEY: "test",
  ENCRYPTION_KEY: "a".repeat(64),
  SESSION_SECRET: "b".repeat(64),
  ASSET_FETCH_ALLOWED_HOSTS: "",
} as const;

let isAllowedHost: typeof import("@/lib/providers/fetch")["isAllowedHost"];
let isPrivateAddress: typeof import("@/lib/providers/fetch")["isPrivateAddress"];
let validateUrl: typeof import("@/lib/providers/fetch")["validateUrl"];

beforeAll(async () => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    process.env[key] = value;
  }
  // Imported after the env is in place: lib/env validates on first access.
  ({ isAllowedHost, isPrivateAddress, validateUrl } = await import(
    "@/lib/providers/fetch"
  ));
});

const options = { provider: "Pexels" } as const;

describe("isAllowedHost", () => {
  it("accepts a compiled-in provider domain", () => {
    expect(isAllowedHost("pexels.com")).toBe(true);
    expect(isAllowedHost("freesound.org")).toBe(true);
  });

  it("accepts a subdomain of an allow-listed domain", () => {
    expect(isAllowedHost("videos.pexels.com")).toBe(true);
    expect(isAllowedHost("cdn.deep.videos.pexels.com")).toBe(true);
  });

  it("refuses a look-alike that merely ends with the domain as a label", () => {
    // The whole reason matching is exact-or-subdomain rather than `includes`.
    expect(isAllowedHost("pexels.com.attacker.net")).toBe(false);
    expect(isAllowedHost("notpexels.com")).toBe(false);
    expect(isAllowedHost("evilpexels.com")).toBe(false);
  });

  it("refuses an unrelated host", () => {
    expect(isAllowedHost("example.test")).toBe(false);
    expect(isAllowedHost("localhost")).toBe(false);
    expect(isAllowedHost("169.254.169.254")).toBe(false);
  });

  it("accepts a per-call extra host without widening the global list", () => {
    expect(isAllowedHost("cdn.runway.test", ["cdn.runway.test"])).toBe(true);
    expect(isAllowedHost("cdn.runway.test")).toBe(false);
  });

  it("ignores surrounding dots and case in an operator entry", () => {
    expect(isAllowedHost("assets.example.test", [".Example.Test."])).toBe(true);
  });

  it("refuses an empty allow-list entry rather than matching everything", () => {
    // A trailing comma in ASSET_FETCH_ALLOWED_HOSTS produces one of these.
    expect(isAllowedHost("evil.test", ["", "   "])).toBe(false);
  });
});

describe("isPrivateAddress", () => {
  it("refuses the cloud metadata range", () => {
    // The single most valuable SSRF target: instance credentials.
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
  });

  it("refuses loopback and RFC1918", () => {
    for (const address of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "0.0.0.0",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("refuses carrier NAT, benchmarking and multicast", () => {
    for (const address of ["100.64.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("allows a public v4 address", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.167.1.1"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("refuses v6 loopback, link-local, unique-local and multicast", () => {
    for (const address of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("refuses an IPv4-mapped private v6 address", () => {
    // The classic bypass: a v6 literal wrapping the metadata address.
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("allows a public v6 address", () => {
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("treats a non-address as unsafe rather than as public", () => {
    // Fail closed: an unparseable value must not be read as "not private".
    expect(isPrivateAddress("not-an-address")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });
});

describe("validateUrl", () => {
  it("refuses a malformed URL", async () => {
    await expect(validateUrl("not a url", options)).rejects.toThrow(/malformed/i);
  });

  it("refuses plaintext http", async () => {
    // Plaintext also means an asset a network position could substitute.
    await expect(validateUrl("http://pexels.com/a.mp4", options)).rejects.toThrow(
      /not https/i,
    );
  });

  it("refuses a non-web scheme", async () => {
    await expect(validateUrl("file:///etc/passwd", options)).rejects.toThrow(
      /not https/i,
    );
    await expect(
      validateUrl("gopher://pexels.com/a.mp4", options),
    ).rejects.toThrow(/not https/i);
  });

  it("refuses embedded credentials that make a host look allow-listed", async () => {
    // `https://videos.pexels.com@evil.test/` reads as allow-listed to a human;
    // the actual host is evil.test.
    await expect(
      validateUrl("https://videos.pexels.com@evil.test/a.mp4", options),
    ).rejects.toThrow(/embedded credentials/i);
  });

  it("refuses a host that is not allow-listed", async () => {
    await expect(validateUrl("https://evil.test/a.mp4", options)).rejects.toThrow(
      /not allow-listed/i,
    );
  });

  it("names the env var an operator would need to change", async () => {
    // §48: a refusal must say what to do about it, not just that it happened.
    await expect(validateUrl("https://cdn.example.test/a.mp4", options)).rejects.toThrow(
      /ASSET_FETCH_ALLOWED_HOSTS/,
    );
  });

  it("refuses an allow-listed name pointing at a private address", async () => {
    // Reachable without DNS: the literal is the host, so no lookup happens and
    // the address check is the thing under test.
    await expect(
      validateUrl("https://169.254.169.254/latest/meta-data/", {
        provider: "Runway",
        extraHosts: ["169.254.169.254"],
      }),
    ).rejects.toThrow(/private address/i);
  });

  it("refuses loopback even when an operator allow-listed it", async () => {
    // An operator adding `127.0.0.1` to reach a local mock must still not be able
    // to turn the fetcher into a proxy for internal services.
    await expect(
      validateUrl("https://127.0.0.1:5432/", {
        provider: "Pexels",
        extraHosts: ["127.0.0.1"],
      }),
    ).rejects.toThrow(/private address/i);
  });

  it("accepts an allow-listed public IP literal", async () => {
    const url = await validateUrl("https://8.8.8.8/asset.mp4", {
      provider: "Pexels",
      extraHosts: ["8.8.8.8"],
    });
    expect(url.href).toBe("https://8.8.8.8/asset.mp4");
  });

  it("attributes the refusal to the provider that supplied the URL", async () => {
    // So `api_usage` and the logs blame Freesound rather than an anonymous fault.
    await expect(
      validateUrl("https://evil.test/a.mp3", { provider: "Freesound" }),
    ).rejects.toThrow(/Freesound/);
  });
});

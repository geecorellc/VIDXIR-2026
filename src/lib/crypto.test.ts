/**
 * Crypto tests (§4, §34, §39).
 *
 * The two properties worth asserting are the ones a reviewer cannot verify by
 * reading: that a stored password hash never contains the password, and that a
 * tampered ciphertext fails loudly instead of decrypting to garbage.
 *
 * ENCRYPTION_KEY / SESSION_SECRET are set here rather than read from .env so the
 * suite does not depend on a developer's local secrets.
 */
import { beforeAll, describe, expect, it } from "vitest";

const TEST_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://tally:tally@127.0.0.1:5432/tally_test",
  REDIS_URL: "redis://127.0.0.1:6379",
  S3_BUCKET: "tally-test",
  S3_ACCESS_KEY_ID: "test",
  S3_SECRET_ACCESS_KEY: "test",
  ENCRYPTION_KEY: "a".repeat(64),
  SESSION_SECRET: "b".repeat(64),
} as const;

let crypto: typeof import("@/lib/crypto");

beforeAll(async () => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    process.env[key] = value;
  }
  // Imported after the env is in place: lib/env validates on first access.
  crypto = await import("@/lib/crypto");
});

describe("password hashing", () => {
  it("never stores the password itself", async () => {
    const hash = await crypto.hashPassword("correct horse battery staple");
    expect(hash).not.toContain("correct horse battery staple");
    expect(hash).not.toContain("correct");
    expect(hash.startsWith("scrypt$")).toBe(true);
  });

  it("embeds the cost parameters so they can be raised later", async () => {
    const hash = await crypto.hashPassword("pw");
    const parts = hash.split("$");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("scrypt");
    expect(Number(parts[1])).toBeGreaterThanOrEqual(16384);
  });

  it("salts each hash, so identical passwords do not collide", async () => {
    const a = await crypto.hashPassword("same-password");
    const b = await crypto.hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("verifies the correct password", async () => {
    const hash = await crypto.hashPassword("s3cret-passphrase");
    await expect(crypto.verifyPassword("s3cret-passphrase", hash)).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await crypto.hashPassword("s3cret-passphrase");
    await expect(crypto.verifyPassword("s3cret-passphras", hash)).resolves.toBe(false);
    await expect(crypto.verifyPassword("", hash)).resolves.toBe(false);
    await expect(crypto.verifyPassword("S3cret-passphrase", hash)).resolves.toBe(false);
  });

  it("normalises unicode so an equivalent password still verifies", async () => {
    // The same password in NFC ("e-acute" as one codepoint) and NFD ("e" plus a
    // combining acute). Different byte sequences, same password: a user
    // switching keyboards or platforms must not be locked out, which is what the
    // NFKC pass in hashPassword is for.
    //
    // Both forms are derived with normalize() rather than written as literals,
    // so an editor normalising this file cannot collapse them and turn the test
    // into a tautology.
    const base = "café-password";
    const composed = base.normalize("NFC");
    const decomposed = base.normalize("NFD");
    expect(composed).not.toBe(decomposed);

    const hash = await crypto.hashPassword(composed);
    await expect(crypto.verifyPassword(decomposed, hash)).resolves.toBe(true);
  });

  it("returns false for a malformed hash instead of throwing", async () => {
    // A corrupt row must not turn the login route into a 500.
    for (const bad of ["", "not-a-hash", "scrypt$1$2$3", "bcrypt$1$2$3$4$5", "$$$$$"]) {
      await expect(crypto.verifyPassword("pw", bad)).resolves.toBe(false);
    }
  });
});

describe("opaque tokens", () => {
  it("generates URL-safe tokens with at least 256 bits of entropy", () => {
    const token = crypto.generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it("does not repeat", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => crypto.generateToken()));
    expect(tokens.size).toBe(200);
  });

  it("hashes deterministically so lookups can query by the hash", () => {
    const token = crypto.generateToken();
    expect(crypto.hashToken(token)).toBe(crypto.hashToken(token));
    expect(crypto.hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(crypto.hashToken(token)).not.toBe(token);
  });
});

describe("safeEqual", () => {
  it("compares equal strings as equal", () => {
    expect(crypto.safeEqual("abcdef", "abcdef")).toBe(true);
  });

  it("returns false for different values and different lengths", () => {
    expect(crypto.safeEqual("abcdef", "abcdeg")).toBe(false);
    expect(crypto.safeEqual("abc", "abcdef")).toBe(false);
    expect(crypto.safeEqual("", "a")).toBe(false);
  });
});

describe("secret encryption", () => {
  it("round-trips a value", () => {
    const secret = "ya29.a0AfB_byC-oauth-access-token";
    const sealed = crypto.encryptSecret(secret);
    expect(sealed).not.toContain(secret);
    expect(crypto.decryptSecret(sealed)).toBe(secret);
  });

  it("uses a fresh IV, so the same plaintext encrypts differently", () => {
    const a = crypto.encryptSecret("token");
    const b = crypto.encryptSecret("token");
    expect(a).not.toBe(b);
    expect(crypto.decryptSecret(a)).toBe(crypto.decryptSecret(b));
  });

  it("carries a version prefix for future key rotation", () => {
    expect(crypto.encryptSecret("x").startsWith("v1.")).toBe(true);
  });

  it("throws when the ciphertext is tampered with", () => {
    const parts = crypto.encryptSecret("refresh-token").split(".");
    // Flip a character of the ciphertext. GCM authentication must catch it.
    const ct = parts[3]!;
    const flipped = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    expect(() =>
      crypto.decryptSecret([parts[0], parts[1], parts[2], flipped].join(".")),
    ).toThrow();
  });

  it("throws when the auth tag is tampered with", () => {
    const parts = crypto.encryptSecret("refresh-token").split(".");
    const tag = parts[2]!;
    const flipped = (tag[0] === "A" ? "B" : "A") + tag.slice(1);
    expect(() =>
      crypto.decryptSecret([parts[0], parts[1], flipped, parts[3]].join(".")),
    ).toThrow();
  });

  it("rejects an unknown version and a malformed payload", () => {
    const parts = crypto.encryptSecret("x").split(".");
    expect(() =>
      crypto.decryptSecret(["v9", parts[1], parts[2], parts[3]].join(".")),
    ).toThrow(/Unsupported encryption version/);
    expect(() => crypto.decryptSecret("nonsense")).toThrow(/Malformed/);
  });

  it("passes null through the nullable wrappers", () => {
    expect(crypto.encryptNullable(null)).toBeNull();
    expect(crypto.encryptNullable("")).toBeNull();
    expect(crypto.decryptNullable(null)).toBeNull();
    const sealed = crypto.encryptNullable("value");
    expect(crypto.decryptNullable(sealed)).toBe("value");
  });
});

describe("purpose-scoped signatures", () => {
  it("verifies a signature made for the same purpose", () => {
    const sig = crypto.sign("oauth-state", "abc123");
    expect(crypto.verifySignature("oauth-state", "abc123", sig)).toBe(true);
  });

  it("refuses a signature replayed under a different purpose", () => {
    // This is why the keys are derived per purpose: a CSRF token must not be
    // usable as an OAuth state signature.
    const sig = crypto.sign("csrf", "abc123");
    expect(crypto.verifySignature("oauth-state", "abc123", sig)).toBe(false);
  });

  it("refuses a signature over a different value", () => {
    const sig = crypto.sign("oauth-state", "abc123");
    expect(crypto.verifySignature("oauth-state", "abc124", sig)).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of the empty string", () => {
    expect(crypto.sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes buffers and strings identically", () => {
    expect(crypto.sha256Hex(Buffer.from("abc"))).toBe(crypto.sha256Hex("abc"));
  });
});

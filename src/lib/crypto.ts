/**
 * Cryptographic primitives (§4, §34).
 *
 *  - Passwords: scrypt with a per-user random salt. Chosen over bcrypt/argon2
 *    because it ships in Node's stdlib — no native compilation step, so the
 *    same code runs on the web host, the worker and CI without a toolchain.
 *  - OAuth tokens and provider credentials: AES-256-GCM, authenticated so a
 *    tampered ciphertext fails loudly instead of decrypting to garbage.
 *  - Session/verification tokens: 32 random bytes, stored only as SHA-256.
 *    A database leak therefore does not yield usable session cookies.
 */
import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { env } from "@/lib/env";

/**
 * Promisified scrypt.
 *
 * Hand-wrapped rather than `promisify(scrypt)`: promisify resolves to the
 * three-argument overload, which drops the cost-parameter object we need in
 * order to raise N above Node's default.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

/** scrypt cost parameters. N=2^16 targets ~100ms on server hardware. */
const SCRYPT_N = 65536;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
/** Node caps scrypt memory at 32MB by default; N=65536,r=8 needs ~64MB. */
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

/**
 * Hash a password for storage. Output format:
 * `scrypt$N$r$p$<salt-hex>$<hash-hex>`
 * Parameters are embedded so cost can be raised later without breaking
 * existing hashes.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize("NFKC"), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("hex"),
    derived.toString("hex"),
  ].join("$");
}

/**
 * Verify a password against a stored hash. Returns false for malformed hashes
 * rather than throwing, so a corrupt row cannot become a 500 on the login path.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, nStr, rStr, pStr, saltHex, hashHex] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scrypt(password.normalize("NFKC"), salt, expected.length, {
    N,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ---------------------------------------------------------------------------
// Opaque tokens
// ---------------------------------------------------------------------------

/** A URL-safe 256-bit random token. Shown to the user exactly once. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Storage form of a token. Lookups query by this, never by the raw token. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of two hex/ASCII strings of equal expected length. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Symmetric encryption for credentials at rest
// ---------------------------------------------------------------------------

const ENC_VERSION = "v1";

function encryptionKey(): Buffer {
  return Buffer.from(env().ENCRYPTION_KEY, "hex");
}

/**
 * Encrypt a secret for database storage. Output:
 * `v1.<iv-base64url>.<tag-base64url>.<ciphertext-base64url>`
 *
 * The version prefix allows a future key rotation to re-encrypt lazily.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    ENC_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt a stored secret. Throws on tampering or an unknown version — callers
 * treat that as "credential unusable, require re-auth" rather than retrying.
 */
export function decryptSecret(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4) {
    throw new Error("Malformed encrypted payload");
  }
  const [version, ivB64, tagB64, ctB64] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (version !== ENC_VERSION) {
    throw new Error(`Unsupported encryption version: ${version}`);
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivB64, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** Nullable convenience wrappers — channels may have no token yet. */
export function encryptNullable(value: string | null | undefined): string | null {
  return value ? encryptSecret(value) : null;
}

export function decryptNullable(value: string | null | undefined): string | null {
  return value ? decryptSecret(value) : null;
}

// ---------------------------------------------------------------------------
// Derived signing keys
// ---------------------------------------------------------------------------

/**
 * Derive a purpose-scoped HMAC key from SESSION_SECRET. Using a distinct key
 * per purpose means a CSRF token can never be replayed as a session signature.
 */
function derivedKey(purpose: string): Buffer {
  return createHmac("sha256", Buffer.from(env().SESSION_SECRET, "hex"))
    .update(`tally:${purpose}`)
    .digest();
}

/** Sign a value for a specific purpose (e.g. CSRF, OAuth state). */
export function sign(purpose: string, value: string): string {
  return createHmac("sha256", derivedKey(purpose))
    .update(value)
    .digest("base64url");
}

/** Verify a signature produced by `sign`. */
export function verifySignature(
  purpose: string,
  value: string,
  signature: string,
): boolean {
  return safeEqual(sign(purpose, value), signature);
}

/** SHA-256 of a buffer, hex — used for asset checksums. */
export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

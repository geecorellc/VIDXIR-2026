/**
 * Production configuration safety (§17, §18, §23).
 *
 * `lib/env` is the only place that can refuse to boot, and §18 asks specifically
 * whether a *mode mistake* is possible: a production deployment that still carries
 * a development flag. Four of those mistakes are silent by nature — the process
 * starts, every page renders, and the damage only shows up later:
 *
 *  - `TALLY_USE_MOCK_PROVIDERS=true` in production means Tally reports work it
 *    never did (§40, §42). Nothing about the running app looks wrong.
 *  - `EMAIL_PROVIDER=console` means every verification and reset email goes to
 *    stdout. Signup appears to succeed; nobody can confirm an address.
 *  - `BILLING_PROVIDER=stripe` with no webhook secret means signature verification
 *    has nothing to verify against, so subscription state stops tracking reality
 *    while checkout keeps taking money.
 *  - An `http://` `APP_URL` in production means the Secure session cookie is never
 *    returned by the browser: login looks like it works and no session is ever
 *    established, and OAuth state crosses the network in clear text.
 *
 * Each is a refusal to start, and each is asserted here because none of them is
 * visible in a smoke test. The negative direction matters just as much: the same
 * flags must remain *permitted* outside production, or the development workflow the
 * rest of the suite depends on would be the thing this check broke.
 *
 * `resetEnvCache()` refuses to run in production, so every case restores
 * `NODE_ENV` to `test` before dropping the cache — the same ordering discipline
 * production startup has, in reverse.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, isProduction, realPublishBlocked, resetEnvCache, usingMockProviders } from "@/lib/env";

/**
 * The variables `lib/env` requires before it will parse at all. Local
 * placeholders, not credentials — nothing here connects to anything.
 */
const BASE = {
  DATABASE_URL: "postgresql://tally:tally@localhost:5432/tally_unit",
  REDIS_URL: "redis://127.0.0.1:6379",
  S3_BUCKET: "tally-unit",
  S3_ACCESS_KEY_ID: "unit",
  S3_SECRET_ACCESS_KEY: "unit",
  ENCRYPTION_KEY: "a".repeat(64),
  SESSION_SECRET: "b".repeat(64),
} as const;

/** Every variable a case may set, so each test starts from a known state. */
const MANAGED = [
  "NODE_ENV",
  "APP_URL",
  "TALLY_USE_MOCK_PROVIDERS",
  "TALLY_BLOCK_REAL_PUBLISH",
  "EMAIL_PROVIDER",
  "RESEND_API_KEY",
  "BILLING_PROVIDER",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  ...Object.keys(BASE),
] as const;

const original = new Map<string, string | undefined>(
  MANAGED.map((key) => [key, process.env[key]]),
);

/**
 * Assign an environment variable by name.
 *
 * Written through the index signature because Next declares `NODE_ENV` readonly
 * in its ambient types — sound advice for application code, and precisely what
 * these cases have to violate in order to exercise the production guards at all.
 * Confined to this helper so nothing else in the file needs the cast.
 */
function setEnv(key: string, value: string): void {
  (process.env as Record<string, string>)[key] = value;
}

/**
 * Apply a configuration and read it back through `env()`.
 *
 * `NODE_ENV` is forced back to `test` first: `resetEnvCache()` refuses to run
 * once it reads production, so a case that has already switched to production —
 * or a second iteration of a loop inside one — could not otherwise drop the cache.
 */
function configure(vars: Record<string, string | undefined>): void {
  setEnv("NODE_ENV", "test");
  resetEnvCache();
  for (const key of MANAGED) delete process.env[key];
  for (const [key, value] of Object.entries({ ...BASE, ...vars })) {
    if (value === undefined) delete process.env[key];
    else setEnv(key, value);
  }
}

/** A complete production configuration, which every case below then breaks. */
const VALID_PRODUCTION = {
  NODE_ENV: "production",
  APP_URL: "https://app.tally.example",
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "unit-placeholder",
  BILLING_PROVIDER: "mock",
} as const;

afterEach(() => {
  // Back to a non-production NODE_ENV first, or the cache drop would throw.
  setEnv("NODE_ENV", "test");
  resetEnvCache();
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else setEnv(key, value);
  }
  resetEnvCache();
});

describe("production configuration refusals (§18)", () => {
  it("accepts a complete production configuration", () => {
    // The control. Without this, a test asserting a refusal could be passing
    // because of an unrelated missing variable.
    configure(VALID_PRODUCTION);
    expect(env().NODE_ENV).toBe("production");
    expect(isProduction()).toBe(true);
  });

  it("refuses to start with mock providers in production", () => {
    configure({ ...VALID_PRODUCTION, TALLY_USE_MOCK_PROVIDERS: "true" });
    // §40. The alternative to a startup failure is an app that fabricates
    // voiceovers and visuals for paying customers.
    expect(() => env()).toThrow(/TALLY_USE_MOCK_PROVIDERS must be false in production/);
  });

  it("refuses to start with console email in production", () => {
    configure({ ...VALID_PRODUCTION, EMAIL_PROVIDER: "console", RESEND_API_KEY: undefined });
    expect(() => env()).toThrow(/EMAIL_PROVIDER=console/);
  });

  it("refuses Stripe in production without a secret key or a webhook secret", () => {
    for (const partial of [
      { STRIPE_SECRET_KEY: "sk_live_placeholder" },
      { STRIPE_WEBHOOK_SECRET: "whsec_placeholder" },
      {},
    ]) {
      configure({ ...VALID_PRODUCTION, BILLING_PROVIDER: "stripe", ...partial });
      // §17: "Stripe live configuration cannot be silently inferred." A half-set
      // Stripe boots fine and fails at the first checkout — or worse, verifies no
      // signatures and stops tracking subscription state.
      expect(() => env(), JSON.stringify(partial)).toThrow(
        /BILLING_PROVIDER=stripe requires/,
      );
    }
  });

  it("accepts Stripe in production once both secrets are present", () => {
    configure({
      ...VALID_PRODUCTION,
      BILLING_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_live_placeholder",
      STRIPE_WEBHOOK_SECRET: "whsec_placeholder",
    });
    expect(env().BILLING_PROVIDER).toBe("stripe");
  });

  it("refuses an http APP_URL in production", () => {
    configure({ ...VALID_PRODUCTION, APP_URL: "http://app.tally.example" });
    expect(() => env()).toThrow(/APP_URL must use https in production/);
  });

  it("names the variable but not its value when validation fails", () => {
    // §14/§15: a configuration error is the one error message an operator reads
    // most often, and it must not become a way to print a secret into a log.
    configure({ ...VALID_PRODUCTION, ENCRYPTION_KEY: "not-hex-and-far-too-short" });
    let message = "";
    try {
      env();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("ENCRYPTION_KEY");
    expect(message).not.toContain("not-hex-and-far-too-short");
  });
});

describe("development flags stay development-only (§17)", () => {
  it("permits mock providers and the publish guard outside production", () => {
    configure({
      NODE_ENV: "development",
      TALLY_USE_MOCK_PROVIDERS: "true",
      TALLY_BLOCK_REAL_PUBLISH: "true",
    });
    expect(usingMockProviders()).toBe(true);
    expect(realPublishBlocked()).toBe(true);
  });

  it("ignores the publish guard in production rather than trusting it", () => {
    /**
     * `TALLY_BLOCK_REAL_PUBLISH=true` is not a startup error — it is not dangerous
     * the way a mock provider is — but it must not be *honoured* in production
     * either. Honouring it would mean a production deployment silently refusing
     * every upload while the UI reported the pipeline as working, which is the
     * same class of lie §42 forbids, pointed the other way.
     */
    configure({ ...VALID_PRODUCTION, TALLY_BLOCK_REAL_PUBLISH: "true" });
    expect(env().TALLY_BLOCK_REAL_PUBLISH).toBe(true);
    expect(realPublishBlocked()).toBe(false);
    expect(usingMockProviders()).toBe(false);
  });

  it("defaults both flags off when unset", () => {
    // A deployment that forgot to set them must get the safe values, not the
    // convenient ones.
    configure({ NODE_ENV: "development" });
    expect(usingMockProviders()).toBe(false);
    expect(realPublishBlocked()).toBe(false);
  });

  it("does not consult X-Forwarded-For by default", () => {
    // `TRUSTED_PROXY_HOPS` defaulting to anything but 0 would make every IP-keyed
    // rate limit bypassable on a direct-to-Node deployment. See `clientIp`.
    configure({ NODE_ENV: "development" });
    expect(env().TRUSTED_PROXY_HOPS).toBe(0);
  });
});

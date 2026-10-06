/**
 * Billing configuration and price-mapping tests (§24, §42, §48).
 *
 * These run without Postgres, Redis or Stripe, because everything asserted here is
 * a decision made from the environment alone. Two families:
 *
 *  1. **Configuration states.** §48 requires a missing credential to surface as a
 *     configuration state rather than a fake success, and §40 requires that a mock
 *     billing provider can never grant a paid tier. The interesting cases are the
 *     *partial* ones — a secret key present but no price ids, or prices without a
 *     webhook secret — because those are the states a half-finished Stripe setup
 *     actually produces, and the one that must not be treated as "configured" is
 *     precisely the one where a customer could be charged with nothing to grant
 *     them the plan afterwards.
 *
 *  2. **Price → tier mapping.** `tierForPriceId` is the only thing standing between
 *     "this subscription is on some price" and "this account is on Scale". A price
 *     that is not in the environment must map to nothing at all; the alternative —
 *     guessing, or defaulting upward — would hand out the top plan to anyone whose
 *     subscription was created outside Vidxir AI.
 *
 * No network call is possible from these tests: the only Stripe API touched is the
 * constructor, and the key is a literal that is not a credential.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The core variables `lib/env` insists on before it will parse at all. Values are
 * local placeholders, not credentials — the point of the file is what happens
 * around them.
 */
const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://vidxir:vidxir@127.0.0.1:5432/vidxir_test",
  REDIS_URL: "redis://127.0.0.1:6379",
  S3_BUCKET: "vidxir-test",
  S3_ACCESS_KEY_ID: "test",
  S3_SECRET_ACCESS_KEY: "test",
  ENCRYPTION_KEY: "a".repeat(64),
  SESSION_SECRET: "b".repeat(64),
  LOG_LEVEL: "error",
} as const;

/** Not a Stripe key. Nothing here authenticates, and nothing calls the API. */
const FAKE_SECRET_KEY = "sk_test_not_a_real_key_0000000000";
const FAKE_WEBHOOK_SECRET = "whsec_not_a_real_secret_0000000000";
const STUDIO_PRICE = "price_unit_test_studio";
const SCALE_PRICE = "price_unit_test_scale";

/** Every billing variable, so a test can start from a known-empty state. */
const BILLING_KEYS = [
  "BILLING_PROVIDER",
  "VIDXIR_USE_MOCK_PROVIDERS",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_STUDIO",
  "STRIPE_PRICE_SCALE",
] as const;

const saved = new Map<string, string | undefined>();

/**
 * Load the modules once before the first assertion.
 *
 * The Stripe SDK and the Drizzle schema are several hundred modules between them,
 * and a cold `await import()` inside the first `it` legitimately exceeds the 5s
 * unit-test budget — which reads as a hang rather than as module loading. `beforeAll`
 * has the 60s hook budget, and this is the same warm-up the video and publish
 * suites already do. Nothing is cached across tests except the module graph itself;
 * `configure()` still resets the env and client caches per test.
 */
beforeAll(async () => {
  for (const [key, value] of Object.entries(BASE_ENV)) {
    process.env[key] = value;
  }
  await Promise.all([
    import("@/lib/env"),
    import("@/lib/billing"),
    import("@/lib/billing/stripe"),
    import("@/lib/plans"),
  ]);
}, 60_000);

beforeEach(() => {
  for (const [key, value] of Object.entries(BASE_ENV)) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  for (const key of BILLING_KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  const { resetEnvCache } = await import("@/lib/env");
  const { resetStripeClient } = await import("@/lib/billing/stripe");
  resetEnvCache();
  resetStripeClient();
});

/**
 * Apply a billing configuration and drop both caches, so the modules under test
 * read the environment this test just described rather than a previous one's.
 */
async function configure(vars: Record<string, string | undefined>): Promise<void> {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const { resetEnvCache } = await import("@/lib/env");
  const { resetStripeClient } = await import("@/lib/billing/stripe");
  resetEnvCache();
  resetStripeClient();
}

/** A complete, working Stripe configuration. */
async function configureFully(): Promise<void> {
  await configure({
    VIDXIR_USE_MOCK_PROVIDERS: "false",
    BILLING_PROVIDER: "stripe",
    STRIPE_SECRET_KEY: FAKE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
    STRIPE_PRICE_STUDIO: STUDIO_PRICE,
    STRIPE_PRICE_SCALE: SCALE_PRICE,
  });
}

// ---------------------------------------------------------------------------
// Configuration states
// ---------------------------------------------------------------------------

describe("billingAvailability", () => {
  it("reports mock billing as not configured", async () => {
    // §40: mock providers exist for development. A mock that reported "configured"
    // would let a development build hand out paid tiers.
    await configure({
      VIDXIR_USE_MOCK_PROVIDERS: "true",
      BILLING_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: FAKE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
      STRIPE_PRICE_STUDIO: STUDIO_PRICE,
      STRIPE_PRICE_SCALE: SCALE_PRICE,
    });

    const { billingAvailability, canUpgrade } = await import("@/lib/billing");
    const availability = billingAvailability();

    expect(availability.provider).toBe("mock");
    expect(availability.configured).toBe(false);
    expect(canUpgrade()).toBe(false);
  });

  it("names the missing credentials when Stripe is selected but unset", async () => {
    await configure({
      VIDXIR_USE_MOCK_PROVIDERS: "false",
      BILLING_PROVIDER: "stripe",
    });

    const { billingAvailability } = await import("@/lib/billing");
    const availability = billingAvailability();

    expect(availability.configured).toBe(false);
    expect(availability.provider).toBe("stripe");
    // The UI prints these verbatim, so the exact names matter.
    expect(availability.missingEnvVars).toEqual([
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ]);
    expect(availability.missingPriceEnvVars).toEqual([
      "STRIPE_PRICE_STUDIO",
      "STRIPE_PRICE_SCALE",
    ]);
  });

  it("is not configured when the keys are present but a price id is missing", async () => {
    await configure({
      VIDXIR_USE_MOCK_PROVIDERS: "false",
      BILLING_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: FAKE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
      STRIPE_PRICE_STUDIO: STUDIO_PRICE,
    });

    const { billingAvailability } = await import("@/lib/billing");
    const availability = billingAvailability();

    expect(availability.configured).toBe(false);
    expect(availability.missingEnvVars).toEqual([]);
    expect(availability.missingPriceEnvVars).toEqual(["STRIPE_PRICE_SCALE"]);
  });

  it("is not configured without a webhook secret, even with prices set", async () => {
    /**
     * The worst partial state, and the reason `canUpgrade` requires the webhook
     * secret: checkout would work, the customer would be charged, and no event
     * could ever be verified to grant them the plan.
     */
    await configure({
      VIDXIR_USE_MOCK_PROVIDERS: "false",
      BILLING_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: FAKE_SECRET_KEY,
      STRIPE_PRICE_STUDIO: STUDIO_PRICE,
      STRIPE_PRICE_SCALE: SCALE_PRICE,
    });

    const { billingAvailability, canUpgrade } = await import("@/lib/billing");
    expect(billingAvailability().missingEnvVars).toEqual(["STRIPE_WEBHOOK_SECRET"]);
    expect(canUpgrade()).toBe(false);
  });

  it("is configured, and upgradable, once everything is set", async () => {
    await configureFully();

    const { billingAvailability, canUpgrade } = await import("@/lib/billing");
    const availability = billingAvailability();

    expect(availability).toMatchObject({
      configured: true,
      provider: "stripe",
      missingEnvVars: [],
      missingPriceEnvVars: [],
    });
    expect(canUpgrade()).toBe(true);
  });
});

describe("getBillingProvider", () => {
  it("refuses to return a provider when billing is unconfigured", async () => {
    await configure({ VIDXIR_USE_MOCK_PROVIDERS: "false", BILLING_PROVIDER: "stripe" });

    const { getBillingProvider } = await import("@/lib/billing");
    // A stub returning success is exactly what §48 forbids; the API layer turns
    // this into a 503 that names the variables.
    expect(() => getBillingProvider()).toThrowError(
      expect.objectContaining({ code: "provider_not_configured" }),
    );
  });

  it("never returns a provider while mock billing is selected", async () => {
    await configure({
      VIDXIR_USE_MOCK_PROVIDERS: "true",
      STRIPE_SECRET_KEY: FAKE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
      STRIPE_PRICE_STUDIO: STUDIO_PRICE,
      STRIPE_PRICE_SCALE: SCALE_PRICE,
    });

    const { getBillingProvider } = await import("@/lib/billing");
    expect(() => getBillingProvider()).toThrowError(
      expect.objectContaining({ code: "provider_not_configured" }),
    );
  });

  it("returns the real Stripe provider when configured", async () => {
    await configureFully();

    const { getBillingProvider } = await import("@/lib/billing");
    const { stripeProvider } = await import("@/lib/billing/stripe");

    expect(getBillingProvider()).toBe(stripeProvider);
    expect(getBillingProvider().name).toBe("stripe");
  });

  it("exposes no way to grant a tier", async () => {
    await configureFully();

    const { getBillingProvider } = await import("@/lib/billing");
    const provider = getBillingProvider();

    /**
     * A structural assertion, deliberately. §24's rule is enforced by the shape of
     * the interface: if a future provider gains an `activate`/`setTier` method, the
     * webhook stops being the only writer and this test is where that shows up.
     *
     * `startCreditCheckout` (§11) is on this list because it passed that test rather
     * than because it was added to it: it opens a `mode: "payment"` session and
     * returns a URL, exactly as `startCheckout` opens a subscription one. Neither
     * grants anything — credits are added by `completeCreditPurchase`, which only the
     * webhook reaches.
     */
    expect(Object.keys(provider).sort()).toEqual([
      "createPortalSession",
      "name",
      "startCheckout",
      "startCreditCheckout",
    ]);

    /**
     * And the property the list is a proxy for, asserted directly so it survives the
     * list growing again: no method on the provider can move a tier or a balance.
     */
    for (const forbidden of [
      "activate",
      "setTier",
      "grantTier",
      "addCredits",
      "creditAccount",
    ]) {
      expect(provider).not.toHaveProperty(forbidden);
    }
  });
});

describe("stripeClient", () => {
  it("throws a configuration error rather than constructing without a key", async () => {
    await configure({ VIDXIR_USE_MOCK_PROVIDERS: "false", BILLING_PROVIDER: "stripe" });

    const { stripeClient } = await import("@/lib/billing/stripe");
    expect(() => stripeClient()).toThrowError(
      expect.objectContaining({
        code: "provider_not_configured",
        status: 503,
      }),
    );
  });

  it("memoises per key, so a rotated key is picked up", async () => {
    await configureFully();
    const { stripeClient } = await import("@/lib/billing/stripe");

    const first = stripeClient();
    expect(stripeClient()).toBe(first);

    await configure({ STRIPE_SECRET_KEY: `${FAKE_SECRET_KEY}_rotated` });
    // `configure` clears the memo; the point of the assertion is that the second
    // client is a different instance bound to the new key.
    expect(stripeClient()).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Price ↔ tier mapping
// ---------------------------------------------------------------------------

describe("priceIdFor", () => {
  it("resolves the configured price for each paid tier", async () => {
    await configureFully();
    const { priceIdFor } = await import("@/lib/billing/stripe");

    expect(priceIdFor("studio")).toBe(STUDIO_PRICE);
    expect(priceIdFor("scale")).toBe(SCALE_PRICE);
  });

  it("names the exact variable an operator must set", async () => {
    await configure({
      VIDXIR_USE_MOCK_PROVIDERS: "false",
      BILLING_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: FAKE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
      STRIPE_PRICE_STUDIO: STUDIO_PRICE,
    });

    const { priceIdFor } = await import("@/lib/billing/stripe");
    expect(() => priceIdFor("scale")).toThrowError(
      expect.objectContaining({
        code: "provider_not_configured",
        missingEnvVars: ["STRIPE_PRICE_SCALE"],
      }),
    );
  });
});

describe("tierForPriceId", () => {
  it("maps configured prices to their tiers", async () => {
    await configureFully();
    const { tierForPriceId } = await import("@/lib/billing/stripe");

    expect(tierForPriceId(STUDIO_PRICE)).toBe("studio");
    expect(tierForPriceId(SCALE_PRICE)).toBe("scale");
  });

  it("maps an unknown price to nothing", async () => {
    await configureFully();
    const { tierForPriceId } = await import("@/lib/billing/stripe");

    /**
     * The load-bearing case. A price created in the Stripe dashboard and never
     * wired into this deployment's environment entitles nothing; the webhook turns
     * `null` into Starter. Defaulting upward here would grant Scale to any
     * subscription Vidxir AI did not create.
     */
    expect(tierForPriceId("price_created_in_the_dashboard")).toBeNull();
    expect(tierForPriceId(null)).toBeNull();
    expect(tierForPriceId(undefined)).toBeNull();
    expect(tierForPriceId("")).toBeNull();
  });

  it("maps nothing at all when no prices are configured", async () => {
    await configure({ VIDXIR_USE_MOCK_PROVIDERS: "false", BILLING_PROVIDER: "stripe" });
    const { tierForPriceId } = await import("@/lib/billing/stripe");

    // An empty env var must not match an empty-ish price id.
    expect(tierForPriceId(STUDIO_PRICE)).toBeNull();
    expect(tierForPriceId("")).toBeNull();
  });

  it("does not confuse the two tiers when both prices are set", async () => {
    await configureFully();
    const { tierForPriceId } = await import("@/lib/billing/stripe");

    expect(tierForPriceId(`${STUDIO_PRICE}_extra`)).toBeNull();
    expect(tierForPriceId(STUDIO_PRICE.toUpperCase())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

describe("plan catalogue", () => {
  it("declares a price variable for every paid tier and none for the free one", async () => {
    const { PLAN_CATALOG } = await import("@/lib/plans");

    for (const plan of PLAN_CATALOG) {
      if (plan.priceCents === 0) {
        expect(plan.stripePriceEnvVar).toBeUndefined();
      } else {
        // `priceIdFor` treats a missing declaration as a catalogue defect rather
        // than a configuration state, so this is the test that keeps it a defect
        // that cannot ship.
        expect(plan.stripePriceEnvVar).toBeDefined();
      }
    }
  });
});

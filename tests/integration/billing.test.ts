/**
 * Billing integration tests (§24, §32, §34, §39, §42).
 *
 * The one rule this file exists to prove: **a plan tier changes only because a
 * signature-verified provider event said the money moved.** Every case below is a
 * way that invariant could be broken — an unsigned body, a tampered body, a
 * redelivery, an event that arrives out of order, an event for a customer Tally
 * cannot identify, a price Tally does not sell, a failed payment, a cancellation, a
 * second checkout — and the assertion is always the same pair: what
 * `subscriptions.tier`/`status` say, and what `currentTier()` will actually honour.
 *
 * ## What is real here, and what is not
 *
 * Real: Postgres, the migrations, `billing_events` and its unique index, the
 * idempotency behaviour of `onConflictDoNothing`, the out-of-order predicate inside
 * the UPDATE, `resolveContext`'s account matching, `tierForPriceId` reading the
 * environment, `currentTier`'s entitlement rule, the `handle()` wrapper with its
 * CSRF and error mapping, the real session cookie path, Redis rate limiting, and —
 * importantly — **the real Stripe HMAC**. Signatures are produced by the Stripe
 * SDK's own signer and verified by the SDK's own `constructEvent`, so the rejection
 * tests reject for the same reason production would.
 *
 * Mocked: the Stripe *transport*. `stripeClient()` is replaced by a stub whose
 * `webhooks` is a genuine Stripe instance (pure crypto, no network) and whose
 * `subscriptions.retrieve` / `customers.retrieve` return canned objects; and
 * `stripeProvider`'s two session-creating calls are replaced by recorders.
 *
 * That is not a shortcut, it is §48. All four Stripe variables are absent from this
 * repository's `.env.local`, so there is no account to call: a test that tried
 * would either fail on a missing credential or, worse, create real customers and
 * real subscriptions in someone's Stripe account. So, stated plainly for the §20
 * report: **these tests do not prove that Tally can talk to Stripe.** They prove
 * that everything on Tally's side of that boundary is correct, including every
 * failure ordering — which is the half that Stripe cannot verify for us.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import {
  createUser,
  hasDatabase,
  jar,
  resetDatabase,
  setTier,
  signIn,
  useDatabase,
} from "./setup";

vi.mock("next/headers", () => ({
  cookies: async () => jar,
}));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Placeholders, not credentials. Nothing in this file authenticates against Stripe;
 * the secret key exists only because `stripeClient()` refuses to construct without
 * one, and the webhook secret is used for real HMAC signing on both sides.
 */
const SECRET_KEY = "sk_test_integration_placeholder_0000";
const WEBHOOK_SECRET = "whsec_integration_placeholder_0000";
const STUDIO_PRICE = "price_integration_studio";
const SCALE_PRICE = "price_integration_scale";
/** One-off credit-pack prices (§11). Only two of the four packs are configured. */
const CREDITS_100_PRICE = "price_integration_credits_100";
const CREDITS_500_PRICE = "price_integration_credits_500";

/** Matches the version `lib/billing/stripe.ts` pins. */
const API_VERSION = "2025-02-24.acacia" as const;

/**
 * The transport stub.
 *
 * `webhooks` delegates to a real Stripe instance because signature verification is
 * the security property under test — a stubbed verifier would make every rejection
 * test vacuous. The two `retrieve` calls are recorders the tests program per case.
 */
const stripeStub = vi.hoisted(() => {
  return {
    subscriptionsRetrieve: vi.fn(),
    customersRetrieve: vi.fn(),
    checkoutCreate: vi.fn(),
    creditCheckoutCreate: vi.fn(),
    portalCreate: vi.fn(),
    listLineItems: vi.fn(),
  };
});

vi.mock("@/lib/billing/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/stripe")>();
  const StripeSdk = (await import("stripe")).default;
  /**
   * One instance, constructed with a placeholder key. `webhooks.constructEvent` is
   * local crypto — it never issues a request — so this cannot reach the network.
   */
  const real = new StripeSdk(SECRET_KEY, { apiVersion: API_VERSION });

  return {
    ...actual,
    /**
     * Only the transport is replaced. `tierForPriceId`, `priceIdFor`,
     * `ensureCustomer`, `billingIdentity` and `activeSubscriptionId` all stay real,
     * so the env-driven price mapping and the database reads are exercised.
     */
    stripeClient: () => ({
      webhooks: real.webhooks,
      subscriptions: { retrieve: stripeStub.subscriptionsRetrieve },
      customers: { retrieve: stripeStub.customersRetrieve },
      /**
       * Reached only by the orphaned-payment path — a paid credit session with no
       * `credit_purchases` row. Left unprogrammed by default, so a test that
       * unexpectedly reaches it gets an undefined result rather than a plausible one.
       */
      checkout: { sessions: { listLineItems: stripeStub.listLineItems } },
    }),
    /**
     * The provider's two session-creating calls. Replaced rather than driven through
     * a fake HTTP layer because what the *routes* must get right is ordering and
     * refusal — which guard runs before which, and what the response is allowed to
     * claim — not the shape of Stripe's request body.
     */
    stripeProvider: {
      name: "stripe",
      startCheckout: stripeStub.checkoutCreate,
      startCreditCheckout: stripeStub.creditCheckoutCreate,
      createPortalSession: stripeStub.portalCreate,
    },
  };
});

/** Signs payloads exactly as Stripe does. Local HMAC only. */
const signer = new Stripe(SECRET_KEY, { apiVersion: API_VERSION });

const suite = hasDatabase ? describe : describe.skip;

const savedEnv = new Map<string, string | undefined>();

function setEnv(vars: Record<string, string>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Event fixtures
// ---------------------------------------------------------------------------

/** Seconds since the epoch, the unit every Stripe timestamp uses. */
function secs(offsetMs = 0): number {
  return Math.floor((Date.now() + offsetMs) / 1000);
}

interface SubscriptionOptions {
  id?: string;
  customer?: string;
  status?: Stripe.Subscription.Status;
  priceId?: string | null;
  metadata?: Record<string, string>;
  cancelAtPeriodEnd?: boolean;
  trialEnd?: number | null;
}

/** A Stripe subscription in the shape the pinned API version returns. */
function subscriptionObject(options: SubscriptionOptions = {}): Record<string, unknown> {
  const priceId = options.priceId === undefined ? STUDIO_PRICE : options.priceId;
  return {
    id: options.id ?? "sub_test_default",
    object: "subscription",
    customer: options.customer ?? "cus_test_default",
    status: options.status ?? "active",
    cancel_at_period_end: options.cancelAtPeriodEnd ?? false,
    current_period_start: secs(-7 * 24 * 3600_000),
    current_period_end: secs(23 * 24 * 3600_000),
    trial_end: options.trialEnd ?? null,
    metadata: options.metadata ?? {},
    items: {
      object: "list",
      data: priceId === null ? [] : [{ id: "si_test", price: { id: priceId } }],
    },
  };
}

let eventCounter = 0;

interface EventOptions {
  /** Explicit id, so a redelivery can reuse one. */
  id?: string;
  /** Provider timestamp, which is what the staleness check compares. */
  created?: number;
}

function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  options: EventOptions = {},
): Record<string, unknown> {
  eventCounter += 1;
  return {
    id: options.id ?? `evt_test_${eventCounter}`,
    object: "event",
    api_version: API_VERSION,
    created: options.created ?? secs(),
    type,
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: { object },
  };
}

interface DeliveryResult {
  status: number;
  body: { received?: boolean; applied?: boolean; skipReason?: string | null; error?: string };
}

/**
 * POST an event to the real route.
 *
 * `signature` defaults to a valid one. Passing null omits the header, and passing a
 * string substitutes it — the two ways a forged delivery arrives.
 */
async function deliver(
  event: Record<string, unknown>,
  overrides: { signature?: string | null; secret?: string; body?: string } = {},
): Promise<DeliveryResult> {
  const { NextRequest } = await import("next/server");
  const { POST } = await import("@/app/api/billing/webhook/route");

  const payload = JSON.stringify(event);
  const signature =
    overrides.signature === undefined
      ? signer.webhooks.generateTestHeaderString({
          payload,
          secret: overrides.secret ?? WEBHOOK_SECRET,
        })
      : overrides.signature;

  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) headers.set("stripe-signature", signature);

  const request = new NextRequest("http://localhost:3000/api/billing/webhook", {
    method: "POST",
    // `body` overrides let a test tamper with the bytes *after* they were signed.
    body: overrides.body ?? payload,
    headers,
  });

  const response = await POST(request);
  return {
    status: response.status,
    body: (await response.json()) as DeliveryResult["body"],
  };
}

// ---------------------------------------------------------------------------
// Database readers
// ---------------------------------------------------------------------------

async function subscriptionRow(userId: string) {
  const { db } = await import("@/lib/db");
  const { subscriptions } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  return row;
}

async function billingEventRows(eventId?: string) {
  const { db } = await import("@/lib/db");
  const { billingEvents } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  const query = db.select().from(billingEvents);
  return eventId ? await query.where(eq(billingEvents.providerEventId, eventId)) : await query;
}

async function tierOf(userId: string) {
  const { currentTier } = await import("@/lib/plans/enforce");
  return currentTier(userId);
}

/** Give a user a Stripe customer id, as a completed checkout would have. */
async function attachCustomer(
  userId: string,
  customerId: string,
  subscriptionId?: string,
): Promise<void> {
  const { db } = await import("@/lib/db");
  const { subscriptions } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  await db
    .update(subscriptions)
    .set({
      provider: "stripe",
      providerCustomerId: customerId,
      ...(subscriptionId ? { providerSubscriptionId: subscriptionId } : {}),
    })
    .where(eq(subscriptions.userId, userId));
}

// ---------------------------------------------------------------------------

suite("billing (integration)", () => {
  useDatabase();

  beforeAll(async () => {
    /**
     * A complete Stripe configuration, for this file only.
     *
     * `TALLY_USE_MOCK_PROVIDERS` is deliberately flipped to false here: the harness
     * sets it true for every suite, and while it is true `billingAvailability()`
     * reports the provider as `mock` and refuses to be configured — which is
     * correct (§40) and is asserted in `src/lib/billing/billing.test.ts`, but means
     * no route under test would get past its 503. Restored in `afterAll`, and
     * integration files run sequentially, so no other suite sees this.
     */
    setEnv({
      TALLY_USE_MOCK_PROVIDERS: "false",
      BILLING_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_PRICE_STUDIO: STUDIO_PRICE,
      STRIPE_PRICE_SCALE: SCALE_PRICE,
      /**
       * Two of the four credit packs, not all four (§11).
       *
       * Deliberate: `credits_1000` and `credits_2500` are left unconfigured so the
       * "refuses an unconfigured pack" case has something real to refuse, and so the
       * picker's filtering is exercised rather than asserted against a fully-populated
       * environment where every pack happens to work.
       */
      STRIPE_PRICE_CREDITS_100: CREDITS_100_PRICE,
      STRIPE_PRICE_CREDITS_500: CREDITS_500_PRICE,
    });
    const { resetEnvCache } = await import("@/lib/env");
    resetEnvCache();

    // Warm the heavy graphs before the first assertion, as the other suites do.
    await Promise.all([
      import("@/lib/billing/webhook"),
      import("@/app/api/billing/webhook/route"),
      import("@/app/api/billing/checkout/route"),
      import("@/app/api/billing/portal/route"),
      import("@/app/api/credits/checkout/route"),
    ]);
  }, 60_000);

  afterAll(async () => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
    const { resetEnvCache } = await import("@/lib/env");
    resetEnvCache();
  });

  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Signature verification
  // -------------------------------------------------------------------------

  describe("signature verification", () => {
    it("refuses an unsigned delivery and records nothing", async () => {
      const user = await createUser({ email: "unsigned@tally.test" });
      await attachCustomer(user.id, "cus_unsigned");

      const result = await deliver(
        stripeEvent(
          "customer.subscription.updated",
          subscriptionObject({ customer: "cus_unsigned", priceId: SCALE_PRICE }),
        ),
        { signature: null },
      );

      expect(result.status).toBe(403);
      // Nothing was recorded, because nothing was parsed. An attacker who can POST
      // to a public URL must not even be able to fill this table.
      expect(await billingEventRows()).toHaveLength(0);
      expect(await tierOf(user.id)).toBe("starter");
    });

    it("refuses a body that was tampered with after signing", async () => {
      const user = await createUser({ email: "tampered@tally.test" });
      await attachCustomer(user.id, "cus_tampered");

      const event = stripeEvent(
        "customer.subscription.updated",
        subscriptionObject({ customer: "cus_tampered", priceId: STUDIO_PRICE }),
      );

      /**
       * The exact attack the HMAC exists to stop: a genuine event, resigned nowhere,
       * with the price swapped for the more expensive tier.
       */
      const forged = JSON.stringify(event).replace(STUDIO_PRICE, SCALE_PRICE);

      const result = await deliver(event, { body: forged });

      expect(result.status).toBe(403);
      expect(await billingEventRows()).toHaveLength(0);
      expect(await tierOf(user.id)).toBe("starter");
    });

    it("refuses a signature made with a different secret", async () => {
      const user = await createUser({ email: "wrongsecret@tally.test" });
      await attachCustomer(user.id, "cus_wrongsecret");

      const result = await deliver(
        stripeEvent(
          "customer.subscription.created",
          subscriptionObject({ customer: "cus_wrongsecret" }),
        ),
        { secret: "whsec_someone_elses_secret" },
      );

      expect(result.status).toBe(403);
      expect(await tierOf(user.id)).toBe("starter");
    });

    it("refuses a syntactically invalid signature header", async () => {
      const result = await deliver(
        stripeEvent("customer.subscription.created", subscriptionObject()),
        { signature: "t=1,v1=deadbeef" },
      );
      expect(result.status).toBe(403);
    });

    it("refuses a correctly-signed delivery replayed outside the timestamp window", async () => {
      /**
       * Replay resistance (§8), which the HMAC alone does not provide.
       *
       * A signature is valid forever: an attacker who captures one genuine upgrade
       * delivery off the wire — a misconfigured proxy log, a mirrored request, a
       * leaked webhook archive — holds a body and header pair that verify perfectly.
       * Without a bounded window they could re-POST it any number of times, and
       * `billing_events` only stops the *identical event id*; the danger is a captured
       * `customer.subscription.updated` replayed after a downgrade, which carries a
       * new-enough id in no sense but would reinstate the paid tier.
       *
       * What stops it is the `t=` timestamp inside the signature header, which is
       * part of the signed payload and therefore cannot be advanced without the
       * secret. Stripe's tolerance is 5 minutes, so this signs at 20 minutes old —
       * with a genuine secret and a genuine HMAC over a genuine body.
       */
      const user = await createUser({ email: "replayed@tally.test" });
      await attachCustomer(user.id, "cus_replayed");

      const event = stripeEvent(
        "customer.subscription.updated",
        subscriptionObject({ customer: "cus_replayed", priceId: SCALE_PRICE }),
      );
      const payload = JSON.stringify(event);

      const staleSignature = signer.webhooks.generateTestHeaderString({
        payload,
        secret: WEBHOOK_SECRET,
        timestamp: secs(-20 * 60_000),
      });

      const result = await deliver(event, { signature: staleSignature });

      expect(result.status).toBe(403);
      // Rejected before parsing, so the replay leaves no trace and grants nothing.
      expect(await billingEventRows()).toHaveLength(0);
      expect(await tierOf(user.id)).toBe("starter");

      // The control: the identical body and secret, signed now, is accepted. Without
      // this the test would also pass if the route rejected everything.
      const fresh = await deliver(event);
      expect(fresh.status).toBe(200);
    });

    it("reports a configuration state when the webhook secret is unset", async () => {
      const { resetEnvCache } = await import("@/lib/env");
      const previous = process.env["STRIPE_WEBHOOK_SECRET"];
      delete process.env["STRIPE_WEBHOOK_SECRET"];
      resetEnvCache();

      try {
        const result = await deliver(
          stripeEvent("customer.subscription.created", subscriptionObject()),
        );
        // 503, not 200: retryable, so an operator who sets the variable recovers the
        // backlog Stripe is still holding (§48).
        expect(result.status).toBe(503);
        expect(result.body.error).toBe("provider_not_configured");
      } finally {
        if (previous !== undefined) process.env["STRIPE_WEBHOOK_SECRET"] = previous;
        resetEnvCache();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Granting a tier
  // -------------------------------------------------------------------------

  describe("granting a tier", () => {
    it("grants the tier the price maps to, and records the event as applied", async () => {
      const user = await createUser({ email: "grant@tally.test" });
      await attachCustomer(user.id, "cus_grant");

      const event = stripeEvent(
        "customer.subscription.created",
        subscriptionObject({
          id: "sub_grant",
          customer: "cus_grant",
          priceId: STUDIO_PRICE,
          metadata: { tallyUserId: user.id, tallyTier: "studio" },
        }),
      );

      const result = await deliver(event);

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ received: true, applied: true, skipReason: null });

      const row = await subscriptionRow(user.id);
      expect(row).toMatchObject({
        tier: "studio",
        status: "active",
        provider: "stripe",
        providerCustomerId: "cus_grant",
        providerSubscriptionId: "sub_grant",
      });
      expect(row?.lastEventAt).toBeInstanceOf(Date);
      expect(await tierOf(user.id)).toBe("studio");

      const [recorded] = await billingEventRows(event["id"] as string);
      expect(recorded).toMatchObject({
        provider: "stripe",
        eventType: "customer.subscription.created",
        userId: user.id,
        applied: true,
        skipReason: null,
      });
    });

    it("grants the plan's monthly credits, once, when the tier is applied", async () => {
      /**
       * §7. Without this a new subscriber would see a zero balance immediately after
       * paying — which reads as a failed purchase, even though their first generation
       * would grant on its own.
       *
       * Once: the second delivery is a different event with a newer timestamp, so it
       * applies to `subscriptions` and reaches the grant again. The grant is keyed on
       * the period, not on the event, which is what makes that safe.
       */
      const { creditBalanceFor } = await import("@/lib/credits/service");
      const { planByTier } = await import("@/lib/plans");
      const user = await createUser({ email: "credits-grant@tally.test" });
      await attachCustomer(user.id, "cus_credits");

      expect((await creditBalanceFor(user.id)).available).toBe(0);

      const first = await deliver(
        stripeEvent(
          "customer.subscription.created",
          subscriptionObject({
            id: "sub_credits",
            customer: "cus_credits",
            priceId: STUDIO_PRICE,
            metadata: { tallyUserId: user.id },
          }),
        ),
      );
      expect(first.body).toMatchObject({ applied: true });
      expect(await tierOf(user.id)).toBe("studio");

      const granted = await creditBalanceFor(user.id);
      expect(granted.granted).toBe(planByTier("studio").monthlyCredits);
      expect(granted.available).toBe(planByTier("studio").monthlyCredits);
      expect(granted.grantedForTier).toBe("studio");

      const second = await deliver(
        stripeEvent(
          "customer.subscription.updated",
          subscriptionObject({
            id: "sub_credits",
            customer: "cus_credits",
            priceId: STUDIO_PRICE,
            metadata: { tallyUserId: user.id },
          }),
          { created: secs(60_000) },
        ),
      );
      expect(second.body).toMatchObject({ applied: true });

      const afterSecond = await creditBalanceFor(user.id);
      expect(afterSecond.granted).toBe(planByTier("studio").monthlyCredits);

      const { db } = await import("@/lib/db");
      const { creditLedger } = await import("@/lib/db/schema");
      const { and, eq } = await import("drizzle-orm");
      const grants = await db
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(
          and(
            eq(creditLedger.userId, user.id),
            eq(creditLedger.reason, "monthly_grant"),
          ),
        );
      expect(grants).toHaveLength(1);
    });

    it("grants Starter credits for a subscription that is not entitled", async () => {
      /**
       * A `past_due` subscription keeps its recorded tier so a cleared payment restores
       * the right plan, but must not be *credited* at that tier — otherwise a failed
       * payment would still buy 2,500 credits.
       */
      const { creditBalanceFor } = await import("@/lib/credits/service");
      const { planByTier } = await import("@/lib/plans");
      const user = await createUser({ email: "credits-pastdue@tally.test" });
      await attachCustomer(user.id, "cus_pastdue");

      await deliver(
        stripeEvent(
          "customer.subscription.updated",
          subscriptionObject({
            id: "sub_pastdue",
            customer: "cus_pastdue",
            priceId: STUDIO_PRICE,
            status: "past_due",
            metadata: { tallyUserId: user.id },
          }),
        ),
      );

      const balance = await creditBalanceFor(user.id);
      expect(balance.granted).toBe(planByTier("starter").monthlyCredits);
      expect(balance.grantedForTier).toBe("starter");
      // The tier itself is still recorded, so a cleared payment restores Studio.
      expect((await subscriptionRow(user.id))?.tier).toBe("studio");
    });

    it("resolves the account from the subscription metadata alone", async () => {
      // No stored customer id: this is the path a first-ever checkout takes.
      const user = await createUser({ email: "bymetadata@tally.test" });

      const result = await deliver(
        stripeEvent(
          "customer.subscription.created",
          subscriptionObject({
            customer: "cus_bymetadata",
            priceId: SCALE_PRICE,
            metadata: { tallyUserId: user.id, tallyTier: "scale" },
          }),
        ),
      );

      expect(result.body.applied).toBe(true);
      expect(await tierOf(user.id)).toBe("scale");
    });

    it("grants only Starter for a price this deployment does not sell", async () => {
      const user = await createUser({ email: "unknownprice@tally.test" });
      await attachCustomer(user.id, "cus_unknownprice");

      const result = await deliver(
        stripeEvent(
          "customer.subscription.updated",
          subscriptionObject({
            customer: "cus_unknownprice",
            priceId: "price_made_in_the_dashboard",
          }),
        ),
      );

      // Applied — the status and period really did change — but entitling nothing,
      // because Tally cannot know what an unrecognised price is meant to buy.
      expect(result.body.applied).toBe(true);
      expect((await subscriptionRow(user.id))?.tier).toBe("starter");
      expect(await tierOf(user.id)).toBe("starter");
    });

    it("grants Starter when the subscription carries no price at all", async () => {
      const user = await createUser({ email: "noprice@tally.test" });
      await attachCustomer(user.id, "cus_noprice");

      const result = await deliver(
        stripeEvent(
          "customer.subscription.updated",
          subscriptionObject({ customer: "cus_noprice", priceId: null }),
        ),
      );

      expect(result.body.applied).toBe(true);
      expect(await tierOf(user.id)).toBe("starter");
    });

    it("prefers the price over a metadata tier that disagrees with it", async () => {
      const user = await createUser({ email: "disagree@tally.test" });
      await attachCustomer(user.id, "cus_disagree");

      /**
       * The case that decides whether Tally bills honestly: the metadata says Scale
       * because that is what the user picked at checkout, but the subscription is on
       * the Studio price — a downgrade made in the portal. The customer is being
       * charged for Studio, so Studio is what they get.
       */
      await deliver(
        stripeEvent(
          "customer.subscription.updated",
          subscriptionObject({
            customer: "cus_disagree",
            priceId: STUDIO_PRICE,
            metadata: { tallyUserId: user.id, tallyTier: "scale" },
          }),
        ),
      );

      expect(await tierOf(user.id)).toBe("studio");
    });

    it("activates from checkout.session.completed only after re-reading the subscription", async () => {
      const user = await createUser({ email: "checkout@tally.test" });

      stripeStub.subscriptionsRetrieve.mockResolvedValue(
        subscriptionObject({
          id: "sub_checkout",
          customer: "cus_checkout",
          status: "active",
          priceId: SCALE_PRICE,
        }),
      );

      const result = await deliver(
        stripeEvent("checkout.session.completed", {
          id: "cs_test_checkout",
          object: "checkout_session",
          mode: "subscription",
          customer: "cus_checkout",
          subscription: "sub_checkout",
          client_reference_id: user.id,
          metadata: { tallyUserId: user.id, tallyTier: "scale" },
          payment_status: "paid",
        }),
      );

      expect(result.body.applied).toBe(true);
      // The session is not trusted for entitlement; the subscription is fetched.
      expect(stripeStub.subscriptionsRetrieve).toHaveBeenCalledWith("sub_checkout");
      expect(await tierOf(user.id)).toBe("scale");
    });

    it("does not entitle a completed checkout whose subscription is still incomplete", async () => {
      const user = await createUser({ email: "incomplete@tally.test" });

      /**
       * Exactly why the subscription is re-read. A session can complete with the
       * first payment unresolved; believing the session would switch on a paid plan
       * for a payment that never cleared (§42).
       */
      stripeStub.subscriptionsRetrieve.mockResolvedValue(
        subscriptionObject({
          id: "sub_incomplete",
          customer: "cus_incomplete",
          status: "incomplete",
          priceId: SCALE_PRICE,
        }),
      );

      await deliver(
        stripeEvent("checkout.session.completed", {
          id: "cs_test_incomplete",
          object: "checkout_session",
          mode: "subscription",
          customer: "cus_incomplete",
          subscription: "sub_incomplete",
          client_reference_id: user.id,
        }),
      );

      const row = await subscriptionRow(user.id);
      expect(row?.status).toBe("incomplete");
      expect(await tierOf(user.id)).toBe("starter");
    });

    it("grants no tier for a one-off payment session", async () => {
      const user = await createUser({ email: "onetime@tally.test" });

      /**
       * A `mode: "payment"` session is a credit top-up, not a plan purchase, and since
       * §11 landed it is routed to the top-up branch rather than falling out as
       * `unhandled`. This one has no cleared payment, so it credits nothing — the
       * `credit_` prefix on the skip reason is what tells an operator which branch
       * declined.
       *
       * What matters here, and the reason this case predates top-ups: a one-off
       * payment must never move a tier, whichever branch handles it.
       */
      const result = await deliver(
        stripeEvent("checkout.session.completed", {
          id: "cs_test_onetime",
          object: "checkout_session",
          mode: "payment",
          customer: "cus_onetime",
          subscription: null,
          client_reference_id: user.id,
        }),
      );

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        applied: false,
        skipReason: "credit_not_paid",
      });
      expect(await tierOf(user.id)).toBe("starter");
      expect((await subscriptionRow(user.id))?.tier).toBe("starter");
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  describe("idempotency", () => {
    it("applies a redelivered event exactly once", async () => {
      const user = await createUser({ email: "redelivery@tally.test" });
      await attachCustomer(user.id, "cus_redelivery");

      const event = stripeEvent(
        "customer.subscription.created",
        subscriptionObject({ customer: "cus_redelivery", priceId: STUDIO_PRICE }),
        { id: "evt_redelivered_once" },
      );

      const first = await deliver(event);
      expect(first.body).toMatchObject({ applied: true, skipReason: null });
      const afterFirst = await subscriptionRow(user.id);

      // Stripe redelivers on any non-2xx, and at-least-once even without one.
      const second = await deliver(event);
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ applied: false, skipReason: "duplicate" });

      // One row, because the unique index rejected the second insert.
      expect(await billingEventRows("evt_redelivered_once")).toHaveLength(1);

      const afterSecond = await subscriptionRow(user.id);
      expect(afterSecond?.tier).toBe("studio");
      expect(afterSecond?.updatedAt?.getTime()).toBe(afterFirst?.updatedAt?.getTime());
    });

    it("treats concurrent redeliveries of one event as a single application", async () => {
      const user = await createUser({ email: "concurrent@tally.test" });
      await attachCustomer(user.id, "cus_concurrent");

      const event = stripeEvent(
        "customer.subscription.created",
        subscriptionObject({ customer: "cus_concurrent", priceId: SCALE_PRICE }),
        { id: "evt_concurrent" },
      );

      /**
       * Both in flight at once, which is what makes the unique index the right
       * mechanism: a read-then-write idempotency check would let both see "not
       * processed yet" and apply twice.
       */
      const results = await Promise.all([deliver(event), deliver(event)]);

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.filter((r) => r.body.applied === true)).toHaveLength(1);
      expect(results.filter((r) => r.body.skipReason === "duplicate")).toHaveLength(1);
      expect(await billingEventRows("evt_concurrent")).toHaveLength(1);
      expect(await tierOf(user.id)).toBe("scale");
    });

    it("distinguishes two different events with identical contents", async () => {
      const user = await createUser({ email: "distinct@tally.test" });
      await attachCustomer(user.id, "cus_distinct");

      const object = subscriptionObject({ customer: "cus_distinct", priceId: STUDIO_PRICE });

      const older = stripeEvent("customer.subscription.updated", object, {
        id: "evt_distinct_a",
        created: secs(-60_000),
      });
      const newer = stripeEvent("customer.subscription.updated", object, {
        id: "evt_distinct_b",
        created: secs(),
      });

      expect((await deliver(older)).body.applied).toBe(true);
      // Same payload, different event id and a newer timestamp: not a duplicate.
      expect((await deliver(newer)).body).toMatchObject({
        applied: true,
        skipReason: null,
      });
      expect(await billingEventRows()).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Out-of-order delivery
  // -------------------------------------------------------------------------

  describe("delivery order", () => {
    it("does not let an older event revert a newer tier", async () => {
      const user = await createUser({ email: "stale@tally.test" });
      await attachCustomer(user.id, "cus_stale");

      // The upgrade, which arrived first.
      await deliver(
        stripeEvent(
          "customer.subscription.updated",
          subscriptionObject({ customer: "cus_stale", priceId: SCALE_PRICE }),
          { id: "evt_stale_new", created: secs() },
        ),
      );
      expect(await tierOf(user.id)).toBe("scale");

      /**
       * The event Stripe generated *before* it, arriving late. Applying it would
       * silently drop the customer to the plan they just left — a revert nobody
       * asked for and nothing in the UI would explain.
       */
      const late = await deliver(
        stripeEvent(
          "customer.subscription.updated",
          subscriptionObject({ customer: "cus_stale", priceId: STUDIO_PRICE }),
          { id: "evt_stale_old", created: secs(-5 * 60_000) },
        ),
      );

      expect(late.status).toBe(200);
      expect(late.body).toMatchObject({ applied: false, skipReason: "stale" });
      expect(await tierOf(user.id)).toBe("scale");

      // Recorded even though skipped: the audit trail is the point of the table.
      const [row] = await billingEventRows("evt_stale_old");
      expect(row).toMatchObject({ applied: false, skipReason: "stale", userId: user.id });
    });

    it("does not let a late cancellation revoke a newer active subscription", async () => {
      const user = await createUser({ email: "latecancel@tally.test" });
      await attachCustomer(user.id, "cus_latecancel");

      await deliver(
        stripeEvent(
          "customer.subscription.updated",
          subscriptionObject({ customer: "cus_latecancel", priceId: STUDIO_PRICE }),
          { created: secs() },
        ),
      );

      const late = await deliver(
        stripeEvent(
          "customer.subscription.deleted",
          subscriptionObject({
            customer: "cus_latecancel",
            status: "canceled",
            priceId: STUDIO_PRICE,
          }),
          { created: secs(-10 * 60_000) },
        ),
      );

      expect(late.body.skipReason).toBe("stale");
      // A paying customer is not locked out by a delayed event about a past state.
      expect(await tierOf(user.id)).toBe("studio");
    });
  });

  // -------------------------------------------------------------------------
  // Failed payments and cancellation
  // -------------------------------------------------------------------------

  describe("payment failure and cancellation", () => {
    it("suspends access on a failed payment without forgetting the plan", async () => {
      const user = await createUser({ email: "pastdue@tally.test" });
      await attachCustomer(user.id, "cus_pastdue", "sub_pastdue");

      await deliver(
        stripeEvent(
          "customer.subscription.created",
          subscriptionObject({
            id: "sub_pastdue",
            customer: "cus_pastdue",
            priceId: STUDIO_PRICE,
          }),
          { created: secs(-60_000) },
        ),
      );
      expect(await tierOf(user.id)).toBe("studio");

      stripeStub.subscriptionsRetrieve.mockResolvedValue(
        subscriptionObject({
          id: "sub_pastdue",
          customer: "cus_pastdue",
          status: "past_due",
          priceId: STUDIO_PRICE,
        }),
      );

      const failed = await deliver(
        stripeEvent("invoice.payment_failed", {
          id: "in_pastdue",
          object: "invoice",
          customer: "cus_pastdue",
          subscription: "sub_pastdue",
          attempt_count: 2,
        }),
      );

      expect(failed.body.applied).toBe(true);

      const row = await subscriptionRow(user.id);
      // The tier is *remembered* so a cleared payment restores the right plan…
      expect(row?.tier).toBe("studio");
      expect(row?.status).toBe("past_due");
      // …but it is not honoured, which is what §24 requires of a failed payment.
      expect(await tierOf(user.id)).toBe("starter");
    });

    it("restores access when a retried payment succeeds", async () => {
      const user = await createUser({ email: "recovered@tally.test" });
      await attachCustomer(user.id, "cus_recovered", "sub_recovered");

      stripeStub.subscriptionsRetrieve.mockResolvedValue(
        subscriptionObject({
          id: "sub_recovered",
          customer: "cus_recovered",
          status: "past_due",
          priceId: SCALE_PRICE,
        }),
      );
      await deliver(
        stripeEvent(
          "invoice.payment_failed",
          {
            id: "in_recovered_fail",
            object: "invoice",
            customer: "cus_recovered",
            subscription: "sub_recovered",
          },
          { created: secs(-120_000) },
        ),
      );
      expect(await tierOf(user.id)).toBe("starter");

      stripeStub.subscriptionsRetrieve.mockResolvedValue(
        subscriptionObject({
          id: "sub_recovered",
          customer: "cus_recovered",
          status: "active",
          priceId: SCALE_PRICE,
        }),
      );
      await deliver(
        stripeEvent(
          "invoice.payment_succeeded",
          {
            id: "in_recovered_ok",
            object: "invoice",
            customer: "cus_recovered",
            subscription: "sub_recovered",
          },
          { created: secs() },
        ),
      );

      expect(await tierOf(user.id)).toBe("scale");
    });

    it("revokes access when the subscription is deleted", async () => {
      const user = await createUser({ email: "deleted@tally.test" });
      await attachCustomer(user.id, "cus_deleted");

      await deliver(
        stripeEvent(
          "customer.subscription.created",
          subscriptionObject({ customer: "cus_deleted", priceId: SCALE_PRICE }),
          { created: secs(-60_000) },
        ),
      );
      expect(await tierOf(user.id)).toBe("scale");

      await deliver(
        stripeEvent(
          "customer.subscription.deleted",
          subscriptionObject({
            customer: "cus_deleted",
            status: "canceled",
            priceId: SCALE_PRICE,
          }),
          { created: secs() },
        ),
      );

      expect((await subscriptionRow(user.id))?.status).toBe("canceled");
      expect(await tierOf(user.id)).toBe("starter");
    });

    it("keeps access until the period ends when a cancellation is scheduled", async () => {
      const user = await createUser({ email: "cancelatend@tally.test" });
      await attachCustomer(user.id, "cus_cancelatend");

      await deliver(
        stripeEvent(
          "customer.subscription.updated",
          subscriptionObject({
            customer: "cus_cancelatend",
            priceId: STUDIO_PRICE,
            cancelAtPeriodEnd: true,
          }),
        ),
      );

      const row = await subscriptionRow(user.id);
      expect(row?.cancelAtPeriodEnd).toBe(true);
      expect(row?.status).toBe("active");
      // Still paid for, so still entitled. Stripe sends `deleted` when it lapses.
      expect(await tierOf(user.id)).toBe("studio");
    });

    it("treats a paused subscription as unpaid", async () => {
      const user = await createUser({ email: "paused@tally.test" });
      await attachCustomer(user.id, "cus_paused");

      await deliver(
        stripeEvent(
          "customer.subscription.updated",
          subscriptionObject({
            customer: "cus_paused",
            status: "paused",
            priceId: SCALE_PRICE,
          }),
        ),
      );

      // No `paused` value in the enum; `unpaid` already means "no access".
      expect((await subscriptionRow(user.id))?.status).toBe("unpaid");
      expect(await tierOf(user.id)).toBe("starter");
    });

    it("honours a trial", async () => {
      const user = await createUser({ email: "trial@tally.test" });
      await attachCustomer(user.id, "cus_trial");

      await deliver(
        stripeEvent(
          "customer.subscription.created",
          subscriptionObject({
            customer: "cus_trial",
            status: "trialing",
            priceId: STUDIO_PRICE,
            trialEnd: secs(14 * 24 * 3600_000),
          }),
        ),
      );

      const row = await subscriptionRow(user.id);
      expect(row?.status).toBe("trialing");
      expect(row?.trialEndsAt).toBeInstanceOf(Date);
      expect(await tierOf(user.id)).toBe("studio");
    });
  });

  // -------------------------------------------------------------------------
  // Events Tally cannot or should not act on
  // -------------------------------------------------------------------------

  describe("events that grant nothing", () => {
    it("acknowledges an event type Tally does not use", async () => {
      const user = await createUser({ email: "unhandled@tally.test" });
      await attachCustomer(user.id, "cus_unhandled");

      const result = await deliver(
        stripeEvent(
          "customer.subscription.trial_will_end",
          subscriptionObject({ customer: "cus_unhandled", priceId: SCALE_PRICE }),
        ),
      );

      // 200, because a non-2xx would make Stripe redeliver forever and eventually
      // disable the endpoint over an event we simply do not need.
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ applied: false, skipReason: "unhandled" });
      expect(await tierOf(user.id)).toBe("starter");
    });

    it("records an event it cannot match to an account, and grants nothing", async () => {
      const bystander = await createUser({ email: "bystander@tally.test" });

      stripeStub.customersRetrieve.mockResolvedValue({
        id: "cus_stranger",
        object: "customer",
        deleted: false,
        metadata: {},
      });

      const event = stripeEvent(
        "customer.subscription.created",
        subscriptionObject({ customer: "cus_stranger", priceId: SCALE_PRICE }),
      );
      const result = await deliver(event);

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ applied: false, skipReason: "unknown_customer" });

      // Recorded with a null user, which is why `billing_events` is truncated
      // explicitly by the harness rather than by the cascade from `users`.
      const [row] = await billingEventRows(event["id"] as string);
      expect(row).toMatchObject({
        userId: null,
        applied: false,
        skipReason: "unknown_customer",
        providerCustomerId: "cus_stranger",
      });

      expect(await tierOf(bystander.id)).toBe("starter");
    });

    it("ignores a metadata user id that does not name a real account", async () => {
      stripeStub.customersRetrieve.mockResolvedValue({
        id: "cus_forged",
        object: "customer",
        deleted: false,
        metadata: {},
      });

      const result = await deliver(
        stripeEvent(
          "customer.subscription.created",
          subscriptionObject({
            customer: "cus_forged",
            priceId: SCALE_PRICE,
            // A well-formed uuid belonging to nobody.
            metadata: { tallyUserId: "11111111-1111-4111-8111-111111111111" },
          }),
        ),
      );

      expect(result.body.skipReason).toBe("unknown_customer");
    });

    it("ignores a metadata user id that is not even a uuid", async () => {
      stripeStub.customersRetrieve.mockResolvedValue({
        id: "cus_sqli",
        object: "customer",
        deleted: false,
        metadata: {},
      });

      const result = await deliver(
        stripeEvent(
          "customer.subscription.created",
          subscriptionObject({
            customer: "cus_sqli",
            priceId: SCALE_PRICE,
            metadata: { tallyUserId: "' OR 1=1 --" },
          }),
        ),
      );

      // Rejected by the uuid check before it can reach a query at all.
      expect(result.body.skipReason).toBe("unknown_customer");
    });

    it("falls back to the customer's own metadata when the event carries none", async () => {
      const user = await createUser({ email: "viacustomer@tally.test" });

      /**
       * The dashboard-edited case: a subscription created outside checkout has no
       * Tally metadata of its own, and no `subscriptions` row points at the
       * customer yet, so the customer object is the only remaining link.
       */
      stripeStub.customersRetrieve.mockResolvedValue({
        id: "cus_viacustomer",
        object: "customer",
        deleted: false,
        metadata: { tallyUserId: user.id },
      });

      const result = await deliver(
        stripeEvent(
          "customer.subscription.created",
          subscriptionObject({ customer: "cus_viacustomer", priceId: STUDIO_PRICE }),
        ),
      );

      expect(result.body.applied).toBe(true);
      expect(await tierOf(user.id)).toBe("studio");
    });
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  describe("tenant isolation", () => {
    it("changes only the account the event belongs to", async () => {
      const paying = await createUser({ email: "paying@tally.test" });
      const other = await createUser({ email: "notpaying@tally.test" });
      await attachCustomer(paying.id, "cus_paying");
      await attachCustomer(other.id, "cus_notpaying");

      await deliver(
        stripeEvent(
          "customer.subscription.created",
          subscriptionObject({ customer: "cus_paying", priceId: SCALE_PRICE }),
        ),
      );

      expect(await tierOf(paying.id)).toBe("scale");
      expect(await tierOf(other.id)).toBe("starter");
      expect((await subscriptionRow(other.id))?.lastEventAt).toBeNull();
    });

    it("resolves by stored customer id in preference to a stranger's claim", async () => {
      const owner = await createUser({ email: "owner-cus@tally.test" });
      await attachCustomer(owner.id, "cus_owned");

      // No metadata at all: matching has to come from the stored id.
      await deliver(
        stripeEvent(
          "customer.subscription.updated",
          subscriptionObject({ customer: "cus_owned", priceId: STUDIO_PRICE }),
        ),
      );

      expect(await tierOf(owner.id)).toBe("studio");
      expect(stripeStub.customersRetrieve).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Checkout route
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Credit top-ups (§11, §13)
  // -------------------------------------------------------------------------

  /**
   * The property this block exists to prove: **credits appear only because a
   * signature-verified event said a one-off payment cleared, and the number credited is
   * the one Tally wrote before the customer ever reached Stripe.**
   *
   * That second half is the interesting one. Every case below that could plausibly be
   * satisfied by reading the credit count out of the session — the normal path — is
   * paired with one where the session *lies*: metadata claiming 99,999 credits, an
   * amount that does not match the pack. Those are not hypothetical, they are what a
   * leaked API key buys an attacker, and a test suite that only ever sends honest
   * sessions cannot tell the two implementations apart.
   */
  describe("credit top-ups", () => {
    /** A `mode: "payment"` checkout session, in the shape Stripe delivers. */
    function creditSession(options: {
      id?: string;
      customer?: string;
      userId?: string;
      paymentStatus?: string | null;
      paymentIntent?: string | null;
      metadata?: Record<string, string>;
      amountTotal?: number;
    } = {}): Record<string, unknown> {
      return {
        id: options.id ?? "cs_topup_default",
        object: "checkout_session",
        mode: "payment",
        customer: options.customer ?? "cus_topup",
        subscription: null,
        client_reference_id: options.userId ?? null,
        payment_status:
          options.paymentStatus === undefined ? "paid" : options.paymentStatus,
        payment_intent: options.paymentIntent ?? "pi_topup_default",
        amount_total: options.amountTotal ?? 900,
        currency: "usd",
        metadata: options.metadata ?? {},
      };
    }

    async function postTopUp(body: unknown) {
      const { NextRequest } = await import("next/server");
      const { POST } = await import("@/app/api/credits/checkout/route");
      const request = new NextRequest("http://localhost:3000/api/credits/checkout", {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
      });
      const response = await POST(request);
      return {
        status: response.status,
        body: (await response.json()) as {
          data?: {
            url?: string;
            pack?: string;
            creditsOnCompletion?: number;
            creditsAdded?: boolean;
            balanceBefore?: number;
            amountCents?: number;
          };
          error?: { code?: string; message?: string; details?: unknown };
        },
      };
    }

    async function balanceOf(userId: string) {
      const { creditBalanceFor } = await import("@/lib/credits/service");
      return creditBalanceFor(userId);
    }

    async function getCredits() {
      const { NextRequest } = await import("next/server");
      const { GET } = await import("@/app/api/credits/route");
      const response = await GET(
        new NextRequest("http://localhost:3000/api/credits", { method: "GET" }),
      );
      return {
        status: response.status,
        body: (await response.json()) as {
          data?: {
            balance?: {
              available?: number;
              granted?: number;
              purchased?: number;
              spent?: number;
            };
            history?: unknown[];
            purchases?: { pack?: string; credits?: number; status?: string }[];
            packs?: { id?: string; centsPerCredit?: number }[];
            topUpsAvailable?: boolean;
          };
          error?: { code?: string };
        },
      };
    }

    async function purchaseRows(userId?: string) {
      const { db } = await import("@/lib/db");
      const { creditPurchases } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const query = db.select().from(creditPurchases);
      return userId ? await query.where(eq(creditPurchases.userId, userId)) : await query;
    }

    async function purchaseLedgerRows(userId: string) {
      const { db } = await import("@/lib/db");
      const { creditLedger } = await import("@/lib/db/schema");
      const { and, eq } = await import("drizzle-orm");
      return db
        .select()
        .from(creditLedger)
        .where(
          and(eq(creditLedger.userId, userId), eq(creditLedger.reason, "purchase")),
        );
    }

    /**
     * Open a real purchase through the route, so the `credit_purchases` row under test
     * was written by production code rather than by the test.
     */
    async function openPurchase(
      user: { id: string },
      pack: string,
      sessionId: string,
    ): Promise<void> {
      await signIn(user as Parameters<typeof signIn>[0]);
      stripeStub.creditCheckoutCreate.mockResolvedValue({
        url: `https://checkout.stripe.com/c/pay/${sessionId}`,
        providerSessionId: sessionId,
        amountCents: pack === "credits_100" ? 200 : 900,
        currency: "usd",
      });
      const result = await postTopUp({ pack });
      expect(result.status).toBe(200);
    }

    // ---------------------------------------------------------------------
    // Opening a purchase
    // ---------------------------------------------------------------------

    describe("POST /api/credits/checkout", () => {
      it("refuses an unauthenticated caller", async () => {
        jar.clear();
        const result = await postTopUp({ pack: "credits_500" });
        expect(result.status).toBe(401);
        expect(await purchaseRows()).toHaveLength(0);
      });

      it("returns a URL, records a pending purchase, and credits nothing", async () => {
        const user = await createUser({ email: "topup-buyer@tally.test" });
        await signIn(user);

        stripeStub.creditCheckoutCreate.mockResolvedValue({
          url: "https://checkout.stripe.com/c/pay/cs_topup_buyer",
          providerSessionId: "cs_topup_buyer",
          amountCents: 900,
          currency: "usd",
        });

        const result = await postTopUp({ pack: "credits_500" });

        expect(result.status).toBe(200);
        expect(result.body.data?.url).toContain("checkout.stripe.com");
        /**
         * §42, and the exact mistake the Publish panel taught: a 200 from a route that
         * only created a payment page must not read as a completed purchase.
         */
        expect(result.body.data?.creditsAdded).toBe(false);
        expect(result.body.data?.creditsOnCompletion).toBe(500);
        expect(result.body.data?.balanceBefore).toBe(0);

        // The database agrees: a pending row, and not one credit.
        const rows = await purchaseRows(user.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          pack: "credits_500",
          credits: 500,
          status: "pending",
          providerSessionId: "cs_topup_buyer",
          ledgerId: null,
        });
        expect((await balanceOf(user.id)).available).toBe(0);
        expect(await purchaseLedgerRows(user.id)).toHaveLength(0);
      });

      it("passes a pack to the provider, never a price id or an amount", async () => {
        const user = await createUser({ email: "topup-pack@tally.test" });
        await signIn(user);

        stripeStub.creditCheckoutCreate.mockResolvedValue({
          url: "https://checkout.stripe.com/c/pay/cs_topup_pack",
          providerSessionId: "cs_topup_pack",
          amountCents: 200,
          currency: "usd",
        });

        await postTopUp({ pack: "credits_100" });

        const request = stripeStub.creditCheckoutCreate.mock.calls[0]?.[0] as
          | Record<string, unknown>
          | undefined;
        expect(request?.["pack"]).toBe("credits_100");
        expect(request?.["userId"]).toBe(user.id);
        // The two things a client must never be able to influence.
        expect(JSON.stringify(request)).not.toContain(CREDITS_100_PRICE);
        expect(request).not.toHaveProperty("amountCents");
        expect(request).not.toHaveProperty("credits");
      });

      it("rejects a body naming a price id, an amount, or a pack that does not exist", async () => {
        const user = await createUser({ email: "topup-bogus@tally.test" });
        await signIn(user);

        /**
         * A distinct session per call: `provider_session_id` is unique, so a constant
         * id would make the second accepted body fail on the index rather than on
         * anything under test.
         */
        let opened = 0;
        stripeStub.creditCheckoutCreate.mockImplementation(async () => {
          opened += 1;
          return {
            url: `https://checkout.stripe.com/c/pay/cs_topup_bogus_${opened}`,
            providerSessionId: `cs_topup_bogus_${opened}`,
            amountCents: 900,
            currency: "usd",
          };
        });

        for (const body of [
          { pack: CREDITS_500_PRICE },
          { pack: "credits_1000000" },
          { pack: "credits_500", credits: 99_999 },
          { pack: "credits_500", amountCents: 1 },
          { priceId: CREDITS_500_PRICE },
          {},
        ]) {
          const result = await postTopUp(body);
          /**
           * The two extra-field bodies are *accepted* — Zod strips unknown keys — but
           * what matters is that the extras changed nothing, which the assertions below
           * the loop check. Everything else is a 400.
           */
          if ("credits" in body || "amountCents" in body) {
            expect(result.status).toBe(200);
          } else {
            expect(result.status).toBe(400);
          }
        }

        /**
         * The two accepted bodies both bought `credits_500` at its catalogue price. A
         * client that could smuggle either field would have bought 99,999 credits or
         * paid a cent.
         */
        const rows = await purchaseRows(user.id);
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.credits).toBe(500);
          expect(row.amountCents).toBe(900);
        }
      });

      it("refuses a pack whose price is not configured, naming the variable to set", async () => {
        const user = await createUser({ email: "topup-unconfigured@tally.test" });
        await signIn(user);

        // `credits_1000` is deliberately absent from this suite's environment.
        const result = await postTopUp({ pack: "credits_1000" });

        expect(result.status).toBe(503);
        expect(result.body.error?.code).toBe("provider_not_configured");
        expect(JSON.stringify(result.body.error?.details)).toContain(
          "STRIPE_PRICE_CREDITS_1000",
        );
        // No session was opened and no row was written for a pack that cannot be bought.
        expect(stripeStub.creditCheckoutCreate).not.toHaveBeenCalled();
        expect(await purchaseRows(user.id)).toHaveLength(0);
      });

      it("refuses a cross-origin request", async () => {
        const user = await createUser({ email: "topup-csrf@tally.test" });
        await signIn(user);

        const { NextRequest } = await import("next/server");
        const { POST } = await import("@/app/api/credits/checkout/route");
        const response = await POST(
          new NextRequest("http://localhost:3000/api/credits/checkout", {
            method: "POST",
            body: JSON.stringify({ pack: "credits_500" }),
            headers: {
              "content-type": "application/json",
              origin: "https://attacker.example",
            },
          }),
        );

        expect(response.status).toBe(403);
        expect(await purchaseRows(user.id)).toHaveLength(0);
      });

      it("allows a second top-up, unlike a second subscription", async () => {
        /**
         * The one place this route deliberately diverges from
         * `/api/billing/checkout`, which refuses a second subscription. Buying credits
         * twice is normal, and refusing it would be a bug.
         */
        const user = await createUser({ email: "topup-twice@tally.test" });
        await openPurchase(user, "credits_500", "cs_topup_twice_a");
        await openPurchase(user, "credits_100", "cs_topup_twice_b");

        expect(await purchaseRows(user.id)).toHaveLength(2);
      });
    });

    // ---------------------------------------------------------------------
    // Completing a purchase
    // ---------------------------------------------------------------------

    describe("crediting a completed payment", () => {
      it("adds the credits the purchase row records, and marks it completed", async () => {
        const user = await createUser({ email: "topup-paid@tally.test" });
        await openPurchase(user, "credits_500", "cs_topup_paid");

        const result = await deliver(
          stripeEvent(
            "checkout.session.completed",
            creditSession({
              id: "cs_topup_paid",
              userId: user.id,
              paymentIntent: "pi_topup_paid",
            }),
          ),
        );

        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ applied: true, skipReason: null });

        const balance = await balanceOf(user.id);
        expect(balance.purchased).toBe(500);
        expect(balance.available).toBe(500);
        /**
         * `purchased`, not `granted`. The distinction is what makes bought credits
         * survive a period rollover, and a purchase that inflated `granted` would
         * vanish at the boundary.
         */
        expect(balance.granted).toBe(0);

        const rows = await purchaseRows(user.id);
        expect(rows[0]).toMatchObject({
          status: "completed",
          providerPaymentIntentId: "pi_topup_paid",
        });
        expect(rows[0]?.ledgerId).not.toBeNull();
        expect(rows[0]?.completedAt).not.toBeNull();

        // And the receipt points at the ledger row that actually credited.
        const ledger = await purchaseLedgerRows(user.id);
        expect(ledger).toHaveLength(1);
        expect(ledger[0]?.id).toBe(rows[0]?.ledgerId);
        expect(ledger[0]?.amount).toBe(500);
      });

      it("credits from its own row, not from what the session claims", async () => {
        /**
         * The case that separates this implementation from the obvious one. Stripe
         * metadata is writable by anything holding the API key, so a session arriving
         * with `tallyCredits: 99999` is exactly what a leaked key buys. The row Tally
         * wrote at session-creation time is the authority.
         */
        const user = await createUser({ email: "topup-liar@tally.test" });
        await openPurchase(user, "credits_100", "cs_topup_liar");

        await deliver(
          stripeEvent(
            "checkout.session.completed",
            creditSession({
              id: "cs_topup_liar",
              userId: user.id,
              metadata: {
                tallyUserId: user.id,
                tallyPack: "credits_2500",
                tallyCredits: "99999",
              },
              // A currency figure that would imply a far larger pack.
              amountTotal: 999_999,
            }),
          ),
        );

        const balance = await balanceOf(user.id);
        expect(balance.purchased).toBe(100);
        expect(balance.available).toBe(100);
      });

      it("credits a redelivered session exactly once", async () => {
        const user = await createUser({ email: "topup-replay@tally.test" });
        await openPurchase(user, "credits_500", "cs_topup_replay");

        const event = stripeEvent(
          "checkout.session.completed",
          creditSession({ id: "cs_topup_replay", userId: user.id }),
          { id: "evt_topup_replay" },
        );

        const first = await deliver(event);
        const second = await deliver(event);

        expect(first.body).toMatchObject({ applied: true });
        // The event-level guard catches this one before the credit branch is reached.
        expect(second.body).toMatchObject({ applied: false, skipReason: "duplicate" });

        expect((await balanceOf(user.id)).purchased).toBe(500);
        expect(await purchaseLedgerRows(user.id)).toHaveLength(1);
      });

      it("credits once when two different events report the same session", async () => {
        /**
         * The reason the idempotency key is `purchase:{sessionId}` rather than the
         * event id. A delayed payment method produces `checkout.session.completed`
         * followed by `checkout.session.async_payment_succeeded` — two genuinely
         * different events, neither a redelivery of the other, describing one payment.
         * Keying on the event id would credit twice.
         */
        const user = await createUser({ email: "topup-async@tally.test" });
        await openPurchase(user, "credits_500", "cs_topup_async");

        const unpaid = await deliver(
          stripeEvent(
            "checkout.session.completed",
            creditSession({ id: "cs_topup_async", userId: user.id, paymentStatus: "unpaid" }),
          ),
        );
        // Nothing yet: the money has not arrived.
        expect(unpaid.body).toMatchObject({
          applied: false,
          skipReason: "credit_not_paid",
        });
        expect((await balanceOf(user.id)).purchased).toBe(0);

        const cleared = await deliver(
          stripeEvent(
            "checkout.session.async_payment_succeeded",
            creditSession({ id: "cs_topup_async", userId: user.id }),
          ),
        );
        expect(cleared.body).toMatchObject({ applied: true });
        expect((await balanceOf(user.id)).purchased).toBe(500);

        // A third report of the same session adds nothing.
        const again = await deliver(
          stripeEvent(
            "checkout.session.completed",
            creditSession({ id: "cs_topup_async", userId: user.id }),
          ),
        );
        expect(again.body).toMatchObject({
          applied: false,
          skipReason: "credit_already_credited",
        });
        expect((await balanceOf(user.id)).purchased).toBe(500);
        expect(await purchaseLedgerRows(user.id)).toHaveLength(1);
      });

      it("credits nothing for a session whose payment never cleared", async () => {
        const user = await createUser({ email: "topup-unpaid@tally.test" });
        await openPurchase(user, "credits_500", "cs_topup_unpaid");

        for (const paymentStatus of ["unpaid", "no_payment_required", null]) {
          const result = await deliver(
            stripeEvent(
              "checkout.session.completed",
              creditSession({
                id: "cs_topup_unpaid",
                userId: user.id,
                paymentStatus,
              }),
            ),
          );
          expect(result.body).toMatchObject({ skipReason: "credit_not_paid" });
        }

        expect((await balanceOf(user.id)).purchased).toBe(0);
        // The row is untouched, so a later cleared payment still credits.
        expect((await purchaseRows(user.id))[0]?.status).toBe("pending");
      });

      it("credits nothing for a failed async payment", async () => {
        const user = await createUser({ email: "topup-failed@tally.test" });
        await openPurchase(user, "credits_500", "cs_topup_failed");

        const result = await deliver(
          stripeEvent(
            "checkout.session.async_payment_failed",
            creditSession({
              id: "cs_topup_failed",
              userId: user.id,
              paymentStatus: "unpaid",
            }),
          ),
        );

        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ skipReason: "credit_not_paid" });
        expect((await balanceOf(user.id)).purchased).toBe(0);
      });

      it("credits an orphaned payment from its configured price", async () => {
        /**
         * A paid session with no purchase row — created in the Stripe dashboard, or a
         * row lost to a rollback. The customer paid, so refusing outright would be
         * theft; the price is the only trustworthy signal left, and it is trustworthy
         * because it must match a `STRIPE_PRICE_CREDITS_*` variable.
         */
        const user = await createUser({ email: "topup-orphan@tally.test" });
        await attachCustomer(user.id, "cus_topup_orphan");

        stripeStub.listLineItems.mockResolvedValue({
          data: [{ id: "li_orphan", price: { id: CREDITS_100_PRICE } }],
        });

        const result = await deliver(
          stripeEvent(
            "checkout.session.completed",
            creditSession({ id: "cs_topup_orphan", userId: user.id }),
          ),
        );

        expect(result.body).toMatchObject({ applied: true });
        expect((await balanceOf(user.id)).purchased).toBe(100);
        expect(stripeStub.listLineItems).toHaveBeenCalledWith("cs_topup_orphan", {
          limit: 1,
        });
      });

      it("credits nothing for a price this deployment does not sell", async () => {
        /**
         * The counterpart. A one-off price created in the dashboard and never wired
         * into the environment must not be able to mint credits — otherwise anyone who
         * can create a price can create currency.
         */
        const user = await createUser({ email: "topup-strange@tally.test" });
        await attachCustomer(user.id, "cus_topup_strange");

        stripeStub.listLineItems.mockResolvedValue({
          data: [{ id: "li_strange", price: { id: "price_made_in_the_dashboard" } }],
        });

        const result = await deliver(
          stripeEvent(
            "checkout.session.completed",
            creditSession({ id: "cs_topup_strange", userId: user.id }),
          ),
        );

        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ skipReason: "credit_unknown_pack" });
        expect((await balanceOf(user.id)).purchased).toBe(0);
        expect(await purchaseLedgerRows(user.id)).toHaveLength(0);
      });

      it("credits nothing when the line items cannot be read", async () => {
        const user = await createUser({ email: "topup-lookupfail@tally.test" });
        await attachCustomer(user.id, "cus_topup_lookupfail");

        stripeStub.listLineItems.mockRejectedValue(new Error("stripe is down"));

        const result = await deliver(
          stripeEvent(
            "checkout.session.completed",
            creditSession({ id: "cs_topup_lookupfail", userId: user.id }),
          ),
        );

        /**
         * 200, not 500. A retry cannot help decide what an unidentifiable payment
         * bought, and returning an error would make Stripe redeliver forever and
         * eventually disable the endpoint.
         */
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ skipReason: "credit_unknown_pack" });
        expect((await balanceOf(user.id)).purchased).toBe(0);
      });

      it("does not credit one account for another's purchase", async () => {
        /**
         * §34. The forged claim cannot win even though it names a real account: the
         * purchase row's own `userId` is compared against the resolved one, and a
         * mismatch credits nobody.
         */
        const buyer = await createUser({ email: "topup-buyer-a@tally.test" });
        const stranger = await createUser({ email: "topup-stranger@tally.test" });
        await openPurchase(buyer, "credits_500", "cs_topup_owned");

        const result = await deliver(
          stripeEvent(
            "checkout.session.completed",
            creditSession({ id: "cs_topup_owned", userId: stranger.id }),
          ),
        );

        expect(result.body).toMatchObject({ skipReason: "credit_wrong_owner" });
        expect((await balanceOf(stranger.id)).purchased).toBe(0);
        expect((await balanceOf(buyer.id)).purchased).toBe(0);
        expect((await purchaseRows(buyer.id))[0]?.status).toBe("pending");
      });

      it("credits nothing for a session it cannot match to an account", async () => {
        const result = await deliver(
          stripeEvent(
            "checkout.session.completed",
            creditSession({ id: "cs_topup_nobody", customer: "cus_nobody" }),
          ),
        );

        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ skipReason: "unknown_customer" });
        expect(await purchaseLedgerRows("00000000-0000-4000-8000-000000000000")).toHaveLength(0);
      });

      it("leaves the tier alone when credits are bought", async () => {
        /**
         * The invariant the whole file is about, from the other direction: a top-up is
         * not an upgrade. A Starter customer who buys 500 credits is still on Starter.
         */
        const user = await createUser({ email: "topup-notier@tally.test" });
        await openPurchase(user, "credits_500", "cs_topup_notier");

        await deliver(
          stripeEvent(
            "checkout.session.completed",
            creditSession({ id: "cs_topup_notier", userId: user.id }),
          ),
        );

        expect((await balanceOf(user.id)).purchased).toBe(500);
        expect(await tierOf(user.id)).toBe("starter");
        expect((await subscriptionRow(user.id))?.tier).toBe("starter");
      });

      it("describes the purchase without naming the vendor", async () => {
        const user = await createUser({ email: "topup-wording@tally.test" });
        await openPurchase(user, "credits_500", "cs_topup_wording");

        await deliver(
          stripeEvent(
            "checkout.session.completed",
            creditSession({ id: "cs_topup_wording", userId: user.id }),
          ),
        );

        const ledger = await purchaseLedgerRows(user.id);
        expect(ledger[0]?.description).toBeTruthy();
        // §3: no vendor reaches a customer-facing line, Stripe included.
        expect(ledger[0]?.description).not.toMatch(/stripe|veo|gemini|minimax|seedance/i);
      });

      it("reports the balance and the purchase to the caller, and to nobody else", async () => {
        /**
         * `GET /api/credits` is what the billing screen reads. Two properties: the
         * figures come from the database rather than from anything the client held, and
         * the tenant predicate means a second account sees none of this.
         */
        const buyer = await createUser({ email: "topup-read@tally.test" });
        await openPurchase(buyer, "credits_500", "cs_topup_read");
        await deliver(
          stripeEvent(
            "checkout.session.completed",
            creditSession({ id: "cs_topup_read", userId: buyer.id }),
          ),
        );

        await signIn(buyer);
        const mine = await getCredits();
        expect(mine.status).toBe(200);
        expect(mine.body.data?.balance?.purchased).toBe(500);
        expect(mine.body.data?.balance?.available).toBe(500);
        expect(mine.body.data?.purchases).toHaveLength(1);
        expect(mine.body.data?.purchases?.[0]).toMatchObject({
          pack: "credits_500",
          credits: 500,
          status: "completed",
        });
        expect(mine.body.data?.topUpsAvailable).toBe(true);
        /**
         * Only the two configured packs, so the picker cannot render a button that was
         * never going to work (§48).
         */
        expect(mine.body.data?.packs?.map((pack) => pack.id)).toEqual([
          "credits_100",
          "credits_500",
        ]);
        // §3: nothing in the payload names a vendor, Stripe included.
        expect(JSON.stringify(mine.body.data)).not.toMatch(
          /stripe|veo|gemini|minimax|seedance|dashscope|runway/i,
        );

        const stranger = await createUser({ email: "topup-reader-b@tally.test" });
        await signIn(stranger);
        const theirs = await getCredits();
        expect(theirs.body.data?.balance?.purchased).toBe(0);
        expect(theirs.body.data?.purchases).toHaveLength(0);
        /**
         * Their history is *not* empty — the read granted them their own Starter
         * allowance, which is the behaviour the next test covers. What isolation means
         * here is that none of it is the buyer's: no purchase ever appears in an
         * account that did not make it.
         */
        expect(
          theirs.body.data?.history?.filter(
            (entry) => (entry as { reason?: string }).reason === "purchase",
          ),
        ).toHaveLength(0);
      });

      it("refuses an unauthenticated read of a balance", async () => {
        jar.clear();
        expect((await getCredits()).status).toBe(401);
      });

      it("grants the period's credits on a read without charging anything", async () => {
        /**
         * A Studio subscriber loading the page on the first day of a period must see
         * their allowance, not a zero that only appears once a generation happens to
         * grant it. Idempotent, so the second read grants nothing further.
         */
        const user = await createUser({ email: "topup-grantread@tally.test" });
        await setTier(user.id, "studio");
        await signIn(user);

        const { planByTier } = await import("@/lib/plans");
        const expected = planByTier("studio").monthlyCredits;

        const first = await getCredits();
        expect(first.body.data?.balance?.granted).toBe(expected);
        expect(first.body.data?.balance?.spent).toBe(0);

        const second = await getCredits();
        expect(second.body.data?.balance?.granted).toBe(expected);
        expect(second.body.data?.balance?.available).toBe(expected);
      });

      it("spends purchased credits on a generation the allowance cannot cover", async () => {
        /**
         * What a top-up is *for*, asserted end to end rather than assumed: the bought
         * credits are reachable by the same charge path a scene uses, and they are the
         * bucket that pays when the plan's allowance is exhausted.
         */
        const user = await createUser({ email: "topup-spend@tally.test" });
        await openPurchase(user, "credits_100", "cs_topup_spend");

        await deliver(
          stripeEvent(
            "checkout.session.completed",
            creditSession({ id: "cs_topup_spend", userId: user.id }),
          ),
        );

        const { chargeCredits, reconcile } = await import("@/lib/credits/service");
        const charge = await chargeCredits({
          userId: user.id,
          operation: "video_scene",
          modelId: "mock/placeholder",
          quality: "1080p",
          durationMs: 5_000,
          idempotencyKey: "topup-spend-test",
          description: "Scene 1",
        });

        expect(charge.charged).toBeGreaterThan(0);
        expect((await balanceOf(user.id)).available).toBe(100 - charge.charged);
        expect((await reconcile(user.id)).consistent).toBe(true);
      });
    });
  });

  describe("POST /api/billing/checkout", () => {
    async function postCheckout(body: unknown) {
      const { NextRequest } = await import("next/server");
      const { POST } = await import("@/app/api/billing/checkout/route");
      const request = new NextRequest("http://localhost:3000/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
      });
      const response = await POST(request);
      return {
        status: response.status,
        body: (await response.json()) as {
          data?: { url?: string; tierGranted?: boolean; message?: string };
          error?: { code?: string; message?: string };
        },
      };
    }

    it("refuses an unauthenticated caller", async () => {
      jar.clear();
      const result = await postCheckout({ tier: "studio" });
      expect(result.status).toBe(401);
    });

    it("returns a URL and states plainly that no tier was granted", async () => {
      const user = await createUser({ email: "buyer@tally.test" });
      await signIn(user);

      stripeStub.checkoutCreate.mockResolvedValue({
        url: "https://checkout.stripe.com/c/pay/cs_test_buyer",
        providerSessionId: "cs_test_buyer",
      });

      const result = await postCheckout({ tier: "studio" });

      expect(result.status).toBe(200);
      expect(result.body.data?.url).toContain("checkout.stripe.com");
      // §42: the client must not be able to read this response as an upgrade.
      expect(result.body.data?.tierGranted).toBe(false);

      // And the database agrees — nothing changed.
      expect(await tierOf(user.id)).toBe("starter");
      expect((await subscriptionRow(user.id))?.tier).toBe("starter");
    });

    it("passes a tier to the provider, never a price id", async () => {
      const user = await createUser({ email: "tierbuyer@tally.test" });
      await signIn(user);

      stripeStub.checkoutCreate.mockResolvedValue({
        url: "https://checkout.stripe.com/c/pay/cs_test_tier",
        providerSessionId: "cs_test_tier",
      });

      await postCheckout({ tier: "scale" });

      expect(stripeStub.checkoutCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: user.id,
          email: user.email,
          tier: "scale",
        }),
      );
      const call = stripeStub.checkoutCreate.mock.calls[0];
      // A caller who could name the price could name a free one, so nothing
      // resembling a price id may appear in what the route passes down.
      expect(JSON.stringify(call?.[0])).not.toContain("price_");
    });

    it("rejects a body that names a price id or a bogus tier", async () => {
      const user = await createUser({ email: "badbody@tally.test" });
      await signIn(user);

      for (const body of [
        { tier: "starter" },
        { tier: "enterprise" },
        { priceId: STUDIO_PRICE },
        { tier: STUDIO_PRICE },
        {},
      ]) {
        const result = await postCheckout(body);
        expect(result.status).toBe(400);
      }
      expect(stripeStub.checkoutCreate).not.toHaveBeenCalled();
    });

    it("refuses a cross-origin request", async () => {
      const user = await createUser({ email: "csrf@tally.test" });
      await signIn(user);

      const { NextRequest } = await import("next/server");
      const { POST } = await import("@/app/api/billing/checkout/route");
      const response = await POST(
        new NextRequest("http://localhost:3000/api/billing/checkout", {
          method: "POST",
          body: JSON.stringify({ tier: "studio" }),
          headers: {
            "content-type": "application/json",
            origin: "https://evil.example",
          },
        }),
      );

      expect(response.status).toBe(403);
      expect(stripeStub.checkoutCreate).not.toHaveBeenCalled();
    });

    it("refuses a second subscription for an account that already pays", async () => {
      const user = await createUser({ email: "already@tally.test" });
      await signIn(user);
      await attachCustomer(user.id, "cus_already", "sub_already");

      await deliver(
        stripeEvent(
          "customer.subscription.created",
          subscriptionObject({
            id: "sub_already",
            customer: "cus_already",
            priceId: STUDIO_PRICE,
          }),
        ),
      );
      expect(await tierOf(user.id)).toBe("studio");

      const result = await postCheckout({ tier: "scale" });

      // Stripe would happily bill two subscriptions in parallel; plan changes
      // belong in the portal, which swaps the price on the existing one.
      expect(result.status).toBe(409);
      expect(result.body.error?.code).toBe("conflict");
      expect(stripeStub.checkoutCreate).not.toHaveBeenCalled();
    });

    it("allows a new checkout after a cancellation", async () => {
      const user = await createUser({ email: "resub@tally.test" });
      await signIn(user);
      await attachCustomer(user.id, "cus_resub", "sub_resub");

      await deliver(
        stripeEvent(
          "customer.subscription.deleted",
          subscriptionObject({
            id: "sub_resub",
            customer: "cus_resub",
            status: "canceled",
            priceId: STUDIO_PRICE,
          }),
        ),
      );

      stripeStub.checkoutCreate.mockResolvedValue({
        url: "https://checkout.stripe.com/c/pay/cs_test_resub",
        providerSessionId: "cs_test_resub",
      });

      // A stale `providerSubscriptionId` is still on the row, so the refusal has to
      // key off entitlement rather than off the id being present.
      const result = await postCheckout({ tier: "studio" });
      expect(result.status).toBe(200);
    });

    it("returns a configuration state, not a URL, when Stripe is unset", async () => {
      const user = await createUser({ email: "unconfigured@tally.test" });
      await signIn(user);

      const { resetEnvCache } = await import("@/lib/env");
      const previous = process.env["STRIPE_PRICE_SCALE"];
      delete process.env["STRIPE_PRICE_SCALE"];
      resetEnvCache();

      try {
        const result = await postCheckout({ tier: "scale" });
        expect(result.status).toBe(503);
        expect(result.body.error?.code).toBe("provider_not_configured");
        // §48: the missing variable is named rather than faked around.
        expect(result.body.error?.message).toContain("STRIPE_PRICE_SCALE");
        expect(stripeStub.checkoutCreate).not.toHaveBeenCalled();
      } finally {
        if (previous !== undefined) process.env["STRIPE_PRICE_SCALE"] = previous;
        resetEnvCache();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Portal route
  // -------------------------------------------------------------------------

  describe("POST /api/billing/portal", () => {
    async function postPortal() {
      const { NextRequest } = await import("next/server");
      const { POST } = await import("@/app/api/billing/portal/route");
      const request = new NextRequest("http://localhost:3000/api/billing/portal", {
        method: "POST",
        body: "{}",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
      });
      const response = await POST(request);
      return {
        status: response.status,
        body: (await response.json()) as {
          data?: { url?: string };
          error?: { code?: string };
        },
      };
    }

    it("refuses an unauthenticated caller", async () => {
      jar.clear();
      expect((await postPortal()).status).toBe(401);
    });

    it("refuses when the account has no billing history", async () => {
      const user = await createUser({ email: "nohistory@tally.test" });
      await signIn(user);

      const result = await postPortal();

      // Rather than creating an empty Stripe customer for a curious click.
      expect(result.status).toBe(409);
      expect(result.body.error?.code).toBe("conflict");
      expect(stripeStub.portalCreate).not.toHaveBeenCalled();
    });

    it("returns the portal URL for the caller's own customer", async () => {
      const user = await createUser({ email: "manage@tally.test" });
      const other = await createUser({ email: "othercustomer@tally.test" });
      await signIn(user);
      await attachCustomer(user.id, "cus_manage");
      await attachCustomer(other.id, "cus_someoneelse");

      stripeStub.portalCreate.mockResolvedValue({
        url: "https://billing.stripe.com/p/session/test_manage",
      });

      const result = await postPortal();

      expect(result.status).toBe(200);
      expect(result.body.data?.url).toContain("billing.stripe.com");
      // The customer id comes from the session's own row, never from the request.
      expect(stripeStub.portalCreate).toHaveBeenCalledWith(
        expect.objectContaining({ userId: user.id, providerCustomerId: "cus_manage" }),
      );
    });
  });
});

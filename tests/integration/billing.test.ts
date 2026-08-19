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
import { createUser, hasDatabase, jar, resetDatabase, signIn, useDatabase } from "./setup";

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
    portalCreate: vi.fn(),
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
    });
    const { resetEnvCache } = await import("@/lib/env");
    resetEnvCache();

    // Warm the heavy graphs before the first assertion, as the other suites do.
    await Promise.all([
      import("@/lib/billing/webhook"),
      import("@/app/api/billing/webhook/route"),
      import("@/app/api/billing/checkout/route"),
      import("@/app/api/billing/portal/route"),
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

    it("acknowledges a checkout session that bought nothing subscribable", async () => {
      const user = await createUser({ email: "onetime@tally.test" });

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
      expect(result.body).toMatchObject({ applied: false, skipReason: "unhandled" });
      expect(await tierOf(user.id)).toBe("starter");
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

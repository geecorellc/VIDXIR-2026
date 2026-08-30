/**
 * The Stripe implementation of `BillingProvider` (§24, §32).
 *
 * Scope discipline, because this file is the one place a mistake charges a real
 * person real money:
 *
 *  - It creates checkout sessions and portal sessions. That is all. It has no
 *    method that grants a tier, because granting is the webhook's job and the
 *    webhook's alone (`lib/billing/webhook.ts`). A checkout session is a request
 *    to pay; §24 is explicit that the frontend saying "Studio" must never activate
 *    Studio.
 *  - Price ids come from the environment, never from the client. A request body
 *    carries a *tier*; this module looks up that tier's configured price. A client
 *    that could name a price id could name a $0 one.
 *  - `client_reference_id` and customer metadata carry Tally's `userId`, so the
 *    webhook can resolve an event to an account without trusting a redirect
 *    parameter. The success URL is decorative: it proves nothing and grants
 *    nothing.
 *
 * The secret key is read from the environment at call time and never logged, never
 * returned, and never sent to the client (§34, §39).
 */
import Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { subscriptions, users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { NotConfiguredError, ProviderAuthError, ProviderError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { PLAN_CATALOG, type PlanTier } from "@/lib/plans";
import { creditPack, priceIdForPack } from "@/lib/credits/packs";
import type {
  BillingProvider,
  CheckoutRequest,
  CheckoutSession,
  CreditCheckoutRequest,
  CreditCheckoutSession,
  PortalRequest,
} from "@/lib/billing";

const log = logger.child({ component: "billing", provider: "stripe" });

/**
 * Pinned rather than left to the SDK default, so a Stripe API upgrade cannot
 * silently change the shape of the objects the webhook parses. `stripe@17`'s typed
 * `LatestApiVersion`.
 *
 * Exported so tests and `scripts/verify-billing.ts` sign and construct against the
 * same version production uses, rather than repeating the literal and drifting from
 * it unnoticed.
 */
export const STRIPE_API_VERSION = "2025-02-24.acacia" as const;

const API_VERSION = STRIPE_API_VERSION;

/**
 * Paid tiers only. `starter` is free and has no price, which is why
 * `CheckoutRequest.tier` excludes it at the type level — there is nothing to buy.
 */
export type PaidTier = Exclude<PlanTier, "starter">;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

let cached: Stripe | null = null;
let cachedKey: string | null = null;

/**
 * The Stripe client, memoised on the key.
 *
 * Keyed on the secret so a test that swaps the environment gets a fresh client
 * rather than one bound to the previous key — the same in-process override
 * discipline the provider layer already uses elsewhere.
 */
export function stripeClient(): Stripe {
  const key = env().STRIPE_SECRET_KEY;
  if (!key) {
    throw new NotConfiguredError(
      "Stripe",
      ["STRIPE_SECRET_KEY"],
      "Create a secret key at https://dashboard.stripe.com/apikeys.",
    );
  }

  if (!cached || cachedKey !== key) {
    cached = new Stripe(key, {
      apiVersion: API_VERSION,
      // Identifies Tally in Stripe's request logs, which is how an operator tells
      // our calls apart from a dashboard action during an incident.
      appInfo: { name: "Tally", url: "https://tally.app" },
      // Stripe's own retry logic, for network errors and 5xxs only. It is
      // idempotent-safe: the SDK attaches an idempotency key to writes.
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
    cachedKey = key;
  }
  return cached;
}

/** Drop the memoised client. For tests that change the key mid-run. */
export function resetStripeClient(): void {
  cached = null;
  cachedKey = null;
}

// ---------------------------------------------------------------------------
// Tier ↔ price mapping
// ---------------------------------------------------------------------------

/**
 * The configured price id for a paid tier.
 *
 * Resolved from the catalogue's `stripePriceEnvVar` rather than a local table, so
 * adding a tier cannot leave a price mapping behind.
 */
export function priceIdFor(tier: PaidTier): string {
  const plan = PLAN_CATALOG.find((p) => p.tier === tier);
  const varName = plan?.stripePriceEnvVar;
  if (!varName) {
    // A catalogue defect, not a configuration state: a paid tier with no price
    // env var declared cannot be bought at all.
    throw new Error(`Plan tier "${tier}" declares no Stripe price env var.`);
  }

  const value = env()[varName];
  if (!value) {
    throw new NotConfiguredError(
      "Stripe",
      [varName],
      `Create the ${plan.name} product in Stripe and set its price id.`,
    );
  }
  return value;
}

/**
 * The tier a Stripe price id corresponds to, or null.
 *
 * The webhook's only mapping direction: Stripe reports which price a subscription
 * is on, and Tally decides what that entitles. An unrecognised price grants
 * nothing — a price created in the dashboard and never wired into the environment
 * must not silently unlock the highest tier.
 */
export function tierForPriceId(priceId: string | null | undefined): PlanTier | null {
  if (!priceId) return null;
  const e = env();
  for (const plan of PLAN_CATALOG) {
    if (!plan.stripePriceEnvVar) continue;
    const configured = e[plan.stripePriceEnvVar];
    if (configured && configured === priceId) return plan.tier;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/**
 * The user's Stripe customer id, created on first use and persisted.
 *
 * Reused rather than recreated, for a reason that matters to the user: a second
 * customer for the same person splits their invoice history and can leave two live
 * subscriptions billing in parallel. The id is stored on the `subscriptions` row,
 * which already exists for every user from signup.
 *
 * `metadata.tallyUserId` is the webhook's fallback path for resolving an event to
 * an account when `client_reference_id` is absent (portal-initiated changes, or a
 * subscription edited in the dashboard).
 */
export async function ensureCustomer(
  userId: string,
  email: string,
): Promise<string> {
  const [existing] = await db
    .select({ customerId: subscriptions.providerCustomerId })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);

  if (existing?.customerId) return existing.customerId;

  const stripe = stripeClient();
  const customer = await callStripe("customers.create", () =>
    stripe.customers.create({
      email,
      metadata: { tallyUserId: userId },
    }),
  );

  /**
   * Persisted with `userId` in the predicate and only when the column is still
   * unset, so two concurrent checkout attempts cannot overwrite each other's
   * customer. The loser's customer is orphaned in Stripe with no subscription
   * attached, which is harmless; a clobbered id would not be.
   */
  await db
    .update(subscriptions)
    .set({ providerCustomerId: customer.id, updatedAt: new Date() })
    .where(eq(subscriptions.userId, userId));

  log.info("stripe customer created", { userId });
  return customer.id;
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

export const stripeProvider: BillingProvider = {
  name: "stripe",

  async startCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const stripe = stripeClient();
    const price = priceIdFor(request.tier);
    const customerId = await ensureCustomer(request.userId, request.email);

    const session = await callStripe("checkout.sessions.create", () =>
      stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price, quantity: 1 }],
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
        /**
         * Both of these exist so the webhook never has to trust the browser.
         * `client_reference_id` comes back on `checkout.session.completed`, and the
         * subscription metadata survives onto every later subscription event.
         */
        client_reference_id: request.userId,
        subscription_data: {
          metadata: { tallyUserId: request.userId, tallyTier: request.tier },
        },
        metadata: { tallyUserId: request.userId, tallyTier: request.tier },
        // Let Stripe collect and remember the address it needs for tax.
        billing_address_collection: "auto",
        allow_promotion_codes: true,
      }),
    );

    if (!session.url) {
      // A session with no URL cannot be completed; surfacing it as a provider
      // error is honest, whereas returning "" would send the user to a dead link.
      throw new ProviderError(
        "stripe",
        "Stripe created a checkout session without a redirect URL.",
      );
    }

    log.info("checkout session created", {
      userId: request.userId,
      tier: request.tier,
      sessionId: session.id,
    });

    return { url: session.url, providerSessionId: session.id };
  },

  async startCreditCheckout(
    request: CreditCheckoutRequest,
  ): Promise<CreditCheckoutSession> {
    const stripe = stripeClient();
    /**
     * The pack becomes a price here and nowhere else, from the environment. The
     * request named `credits_500`; what that costs is not up to the caller.
     */
    const price = priceIdForPack(request.pack);
    const pack = creditPack(request.pack);
    const customerId = await ensureCustomer(request.userId, request.email);

    const session = await callStripe("checkout.sessions.create", () =>
      stripe.checkout.sessions.create({
        /**
         * `payment`, not `subscription`. This is the field the webhook keys on to
         * tell a top-up from a plan purchase, and getting it wrong would create a
         * recurring charge for what the customer bought once.
         */
        mode: "payment",
        customer: customerId,
        line_items: [{ price, quantity: 1 }],
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
        /**
         * `tallyPack` is recorded for diagnostics and for the abnormal path — a
         * session whose `credit_purchases` row is missing. It is deliberately *not*
         * what the webhook credits from: metadata is writable by anything holding
         * the API key, so the authoritative pack and credit count live in Tally's
         * own row, written before the customer ever reaches Stripe.
         */
        client_reference_id: request.userId,
        metadata: {
          tallyUserId: request.userId,
          tallyPack: request.pack,
          tallyCredits: String(pack.credits),
        },
        payment_intent_data: {
          metadata: { tallyUserId: request.userId, tallyPack: request.pack },
        },
        billing_address_collection: "auto",
        /**
         * No promotion codes on a credit pack, unlike a subscription. A discount here
         * would make `amount_total` disagree with the credits granted, and the credits
         * are fixed by the catalogue — so a promo would silently change the price per
         * credit with nothing recording why.
         */
        allow_promotion_codes: false,
      }),
    );

    if (!session.url) {
      throw new ProviderError(
        "stripe",
        "Stripe created a credit checkout session without a redirect URL.",
      );
    }

    log.info("credit checkout session created", {
      userId: request.userId,
      pack: request.pack,
      sessionId: session.id,
    });

    return {
      url: session.url,
      providerSessionId: session.id,
      amountCents: session.amount_total,
      currency: session.currency,
    };
  },

  async createPortalSession(request: PortalRequest): Promise<{ url: string }> {
    const stripe = stripeClient();
    const session = await callStripe("billingPortal.sessions.create", () =>
      stripe.billingPortal.sessions.create({
        customer: request.providerCustomerId,
        return_url: request.returnUrl,
      }),
    );

    log.info("portal session created", { userId: request.userId });
    return { url: session.url };
  },
};

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

/**
 * Run a Stripe call and translate its failures into Tally's error vocabulary.
 *
 * The distinction that matters: an invalid or revoked API key is an operator
 * problem and must not be retried or reported to the user as a payment failure,
 * whereas a rate limit or a connection error is transient. Stripe's own error
 * classes carry that information, so it is read rather than guessed.
 *
 * The key is never included in a message — `StripeAuthenticationError.message`
 * does not contain it, and nothing here interpolates `STRIPE_SECRET_KEY`.
 */
async function callStripe<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Stripe.errors.StripeAuthenticationError) {
      log.error("stripe rejected our credentials", { operation });
      throw new ProviderAuthError(
        "Stripe",
        "Stripe rejected the configured secret key. It may be revoked or from the wrong account.",
        error,
      );
    }

    if (
      error instanceof Stripe.errors.StripeRateLimitError ||
      error instanceof Stripe.errors.StripeConnectionError
    ) {
      throw new ProviderError("stripe", "Stripe is temporarily unavailable.", {
        retryable: true,
        cause: error,
      });
    }

    if (error instanceof Stripe.errors.StripeError) {
      /**
       * Everything else — invalid request, card declined at the API level, idempotency
       * conflict — is a permanent failure of *this* call. Stripe's `message` is
       * written for developers but contains no secret, and it is the only useful
       * diagnostic, so it is logged and a generic sentence goes to the user.
       */
      log.warn("stripe call failed", {
        operation,
        errorCode: error.code ?? error.type,
      });
      throw new ProviderError("stripe", "Stripe could not complete this request.", {
        retryable: false,
        cause: error,
      });
    }

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reads used by the API layer
// ---------------------------------------------------------------------------

export interface BillingIdentity {
  userId: string;
  email: string;
  providerCustomerId: string | null;
}

/** The caller's email and existing customer id, for checkout and portal routes. */
export async function billingIdentity(
  userId: string,
): Promise<BillingIdentity | null> {
  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      providerCustomerId: subscriptions.providerCustomerId,
    })
    .from(users)
    .leftJoin(subscriptions, eq(subscriptions.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);

  return row ?? null;
}

/**
 * Whether this user already has a live paid subscription at the provider.
 *
 * Used to refuse a second checkout: Stripe would happily create a parallel
 * subscription and bill for both, and the user would have no way to tell from
 * Tally's UI. Plan *changes* go through the portal, which swaps the price on the
 * existing subscription instead.
 */
export async function activeSubscriptionId(
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: subscriptions.providerSubscriptionId })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.provider, "stripe"),
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

/**
 * BillingProvider abstraction (§24, §32).
 *
 * The contract deliberately has no "activate this tier" method. Tiers change in
 * exactly one place — the webhook handler, reacting to what the billing provider
 * says actually happened. A checkout session is a *request* to pay, not a payment,
 * so `startCheckout` returns a URL and nothing else; the user's `subscriptions`
 * row is untouched until the provider confirms (§24: "Never activate paid
 * features solely because the frontend says the user selected 'Studio'").
 *
 * Stripe implements it in `lib/billing/stripe.ts`. When credentials are absent this
 * module exposes the *configuration state* so the billing screen can say precisely
 * which credential is missing rather than pretending an upgrade succeeded (§42, §48).
 */
import { NotConfiguredError } from "@/lib/errors";
import { env } from "@/lib/env";
import { capabilityStatus } from "@/lib/providers/config";
import type { PlanTier } from "@/lib/plans";
/**
 * A static import, not a dynamic one. `stripe.ts` imports only *types* from this
 * module, so the cycle is erased at compile time and there is no runtime
 * initialisation order to get wrong.
 */
import { stripeProvider } from "@/lib/billing/stripe";

export interface CheckoutRequest {
  userId: string;
  email: string;
  tier: Exclude<PlanTier, "starter">;
  /** Where the provider returns the user after a completed checkout. */
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  /** Provider-hosted page the user is redirected to. */
  url: string;
  providerSessionId: string;
}

export interface PortalRequest {
  userId: string;
  providerCustomerId: string;
  returnUrl: string;
}

export interface BillingProvider {
  readonly name: string;
  startCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  /** Provider-hosted page for changing card, invoices and cancellation. */
  createPortalSession(request: PortalRequest): Promise<{ url: string }>;
}

/** Whether a self-serve upgrade is possible right now, and why not if it isn't. */
export interface BillingAvailability {
  configured: boolean;
  provider: string;
  missingEnvVars: string[];
  /** Price ids that must also be set for a paid tier to be purchasable. */
  missingPriceEnvVars: string[];
}

export function billingAvailability(): BillingAvailability {
  const status = capabilityStatus("billing");
  const e = env();

  const missingPriceEnvVars: string[] = [];
  if (status.provider === "stripe") {
    if (!e.STRIPE_PRICE_STUDIO) missingPriceEnvVars.push("STRIPE_PRICE_STUDIO");
    if (!e.STRIPE_PRICE_SCALE) missingPriceEnvVars.push("STRIPE_PRICE_SCALE");
  }

  return {
    // "mock" is not "configured": a mock billing provider must never be able to
    // grant a paid tier, not even in development (§40).
    configured:
      status.state === "ready" && missingPriceEnvVars.length === 0,
    provider: status.provider,
    missingEnvVars: status.missingEnvVars,
    missingPriceEnvVars,
  };
}

/**
 * Resolve the billing provider.
 *
 * Throws `NotConfiguredError` when Stripe credentials are absent, which the API
 * layer turns into a 503 naming the exact env vars — the alternative (returning a
 * stub that reports success) is what §48 forbids.
 */
export function getBillingProvider(): BillingProvider {
  const availability = billingAvailability();

  if (!availability.configured) {
    throw new NotConfiguredError(
      "Billing",
      [...availability.missingEnvVars, ...availability.missingPriceEnvVars],
      availability.provider === "stripe"
        ? "Create the products in the Stripe dashboard and set their price ids."
        : "Set BILLING_PROVIDER=stripe and provide Stripe credentials.",
    );
  }

  if (availability.provider === "stripe") return stripeProvider;

  /**
   * `configured` is only true for a provider with credentials, and `mock` never
   * reports configured, so this is unreachable through `billingAvailability`. It
   * stays as a throw rather than a silent stub: a new provider added to the env
   * enum without an implementation must fail loudly, not grant tiers (§42, §48).
   */
  throw new Error(
    `Billing provider "${availability.provider}" is configured but not implemented.`,
  );
}

/**
 * True when a paid upgrade can actually be carried out end to end.
 *
 * Requires the webhook secret as well as the API key and prices, because checkout
 * without a verified webhook is the worst of the available states: the customer is
 * charged and nothing ever grants them the plan. Better to offer no button.
 */
export function canUpgrade(): boolean {
  const availability = billingAvailability();
  return availability.configured && availability.provider === "stripe";
}

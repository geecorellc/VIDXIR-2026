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
 * The Stripe implementation lands with Phase 8. Until then this module exposes
 * the *configuration state* so the billing screen can say precisely which
 * credential is missing rather than pretending an upgrade succeeded (§42, §48).
 */
import { NotConfiguredError } from "@/lib/errors";
import { env } from "@/lib/env";
import { capabilityStatus } from "@/lib/providers/config";
import type { PlanTier } from "@/lib/plans";

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

  // StripeProvider is implemented in the billing phase. Reaching this line means
  // the credentials are present but the implementation is not wired yet — that is
  // an unfinished code path, not a configuration state, so it must not be dressed
  // up as one. It throws, the route returns a 500 with a trace id, and no
  // subscription row is touched.
  throw new Error(
    `Billing provider "${availability.provider}" is configured but not implemented yet.`,
  );
}

/** True when a paid upgrade can actually be carried out end to end. */
export function canUpgrade(): boolean {
  // Deliberately conservative: the checkout implementation lands with Phase 8, so
  // until then the billing screen offers no purchase button at all rather than one
  // that fails after the user commits.
  return false;
}

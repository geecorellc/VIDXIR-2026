/**
 * POST /api/billing/portal — open the provider's billing portal (§24, §32).
 *
 * Card changes, invoice history, plan switches and cancellation all live on
 * Stripe's hosted pages. That is a deliberate choice rather than a shortcut: it
 * means Vidxir AI never receives a card number, so there is no cardholder data in this
 * codebase to protect (§34), and cancellation is always available to the user
 * without Vidxir AI mediating it.
 *
 * Whatever the user does there arrives back as a webhook. This route grants
 * nothing and revokes nothing.
 */
import type { NextRequest } from "next/server";
import { handle, requireUser } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { billingAvailability, getBillingProvider } from "@/lib/billing";
import { billingIdentity } from "@/lib/billing/stripe";
import { env } from "@/lib/env";
import { ConflictError, NotConfiguredError, NotFoundError } from "@/lib/errors";

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireUser();

    const availability = billingAvailability();
    if (!availability.configured) {
      throw new NotConfiguredError(
        "Billing",
        [...availability.missingEnvVars, ...availability.missingPriceEnvVars],
        "The billing portal needs Stripe credentials.",
      );
    }

    /**
     * The same bucket as checkout, and the `billing` rule rather than `read`.
     *
     * A portal session is not a read: it is a live Stripe API call that mints a
     * short-lived authenticated URL. Sharing the bucket with checkout is deliberate
     * — the thing worth bounding is this account's total outbound Stripe traffic,
     * not each endpoint's separately.
     */
    await enforce(rules().billing, `billing:${user.id}`);

    const identity = await billingIdentity(user.id);
    if (!identity) throw new NotFoundError("Account not found.");

    /**
     * No customer means the user has never started a checkout, so there is no
     * billing history to manage. Creating a customer here just to open a portal
     * would leave empty customers behind for anyone who clicked the button once.
     */
    if (!identity.providerCustomerId) {
      throw new ConflictError(
        "There is no billing account to manage yet. Start a subscription first.",
      );
    }

    const { url } = await getBillingProvider().createPortalSession({
      userId: user.id,
      providerCustomerId: identity.providerCustomerId,
      returnUrl: `${env().APP_URL}/dashboard/billing`,
    });

    return { url };
  });
}

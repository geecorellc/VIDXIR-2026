/**
 * POST /api/billing/checkout — start a paid subscription (§24).
 *
 * Returns a provider-hosted URL and nothing else. In particular it does **not**
 * change the caller's tier: the response means "here is where to pay", and the tier
 * moves only when the webhook confirms the payment. A client that follows the URL,
 * abandons the page and comes back is still on Starter, which is the correct
 * outcome and the whole reason the tier is not written here.
 *
 * The body names a *tier*, never a price id. Price ids come from the server's
 * environment (`priceIdFor`), so a caller cannot select what they will be charged.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseJson, requireUser } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { billingAvailability, getBillingProvider } from "@/lib/billing";
import { activeSubscriptionId, billingIdentity } from "@/lib/billing/stripe";
import { env } from "@/lib/env";
import { ConflictError, NotConfiguredError, NotFoundError } from "@/lib/errors";
import { currentTier } from "@/lib/plans/enforce";

const BodySchema = z.object({
  /** Paid tiers only — there is nothing to buy on Starter. */
  tier: z.enum(["studio", "scale"]),
});

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { user, log } = await requireUser();
    const body = await parseJson(request, BodySchema);

    /**
     * The configuration check first, so an operator who has not finished setting
     * Stripe up gets the 503 naming the missing variables rather than a failure
     * halfway through customer creation (§48).
     */
    const availability = billingAvailability();
    if (!availability.configured) {
      throw new NotConfiguredError(
        "Billing",
        [...availability.missingEnvVars, ...availability.missingPriceEnvVars],
        "Checkout cannot start until Stripe is fully configured.",
      );
    }

    /**
     * Keyed by user: checkout creates a Stripe customer on first use, and an
     * unbounded loop here would fill an account with orphaned customers.
     *
     * The `billing` rule rather than `generation`. `generation` is tuned for
     * provider-credit spend inside our own pipeline and is per-minute; every call
     * here is an outbound request to Stripe, and 10 per ten minutes is already far
     * more checkouts than any real user starts.
     */
    await enforce(rules().billing, `billing:${user.id}`);

    const identity = await billingIdentity(user.id);
    if (!identity) throw new NotFoundError("Account not found.");

    /**
     * Refuse a second subscription rather than letting Stripe create one. Two live
     * subscriptions would bill the customer twice with no way to tell from Tally's
     * UI; plan *changes* belong in the portal, which swaps the price on the
     * existing subscription.
     */
    const existing = await activeSubscriptionId(user.id);
    const tier = await currentTier(user.id);
    if (existing && tier !== "starter") {
      throw new ConflictError(
        "This account already has an active subscription. Use the billing portal to change plans.",
        { tier },
      );
    }

    const appUrl = env().APP_URL;
    const session = await getBillingProvider().startCheckout({
      userId: user.id,
      email: identity.email,
      tier: body.tier,
      /**
       * The success URL is informational. It carries no token and grants nothing —
       * the page it lands on reads the tier from the database like every other
       * page, so a user who edits the URL sees exactly what they are entitled to.
       */
      successUrl: `${appUrl}/dashboard/billing?checkout=complete`,
      cancelUrl: `${appUrl}/dashboard/billing?checkout=cancelled`,
    });

    log.info("checkout started", { tier: body.tier });

    return {
      url: session.url,
      /**
       * Stated in the response because the Publish panel's §42 lesson applies here
       * too: the client must not render "you are on Studio" off the back of a
       * successful call that only created a payment page.
       */
      tierGranted: false,
      message:
        "Complete payment at the returned URL. Your plan changes only once the payment is confirmed.",
    };
  });
}

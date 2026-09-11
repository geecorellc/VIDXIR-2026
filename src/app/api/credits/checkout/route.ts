/**
 * POST /api/credits/checkout — buy a credit top-up (§11, §24).
 *
 * Returns a provider-hosted URL and nothing else. It does **not** add credits: the
 * response means "here is where to pay", and the balance moves only when the webhook
 * confirms the payment cleared. A user who opens the URL, abandons it and comes back
 * has exactly the credits they started with, which is the whole reason nothing is
 * credited here.
 *
 * The body names a *pack*, never a price id and never an amount. Both come from the
 * server: the price from `STRIPE_PRICE_CREDITS_*`, the credit count from the pack
 * catalogue. A client that could name a price could name a $0 one; a client that could
 * name an amount could buy 10,000 credits for a cent.
 *
 * Modelled on `/api/billing/checkout` deliberately — same guard order, same
 * `NotConfiguredError` shape, same refusal to claim in the response body that anything
 * was granted. The one difference is that a second purchase is perfectly legitimate,
 * so there is no equivalent of that route's "already subscribed" conflict.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseJson, requireUser } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { billingAvailability } from "@/lib/billing";
import { billingIdentity } from "@/lib/billing/stripe";
import { creditBalanceFor } from "@/lib/credits/service";
import {
  CREDIT_PACK_IDS,
  availableCreditPacks,
  creditPack,
} from "@/lib/credits/packs";
import { openCreditPurchase } from "@/lib/credits/purchase";
import { env } from "@/lib/env";
import { NotConfiguredError, NotFoundError } from "@/lib/errors";

const BodySchema = z.object({
  /**
   * A closed enum built from the catalogue, so a body naming anything else is a 400
   * before it reaches Stripe. `z.enum` needs a non-empty tuple, which the spread of a
   * `readonly` const array satisfies.
   */
  pack: z.enum(CREDIT_PACK_IDS),
});

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { user, log } = await requireUser();
    const body = await parseJson(request, BodySchema);

    /**
     * Configuration first, so an operator who has not finished setting Stripe up gets
     * a 503 naming the missing variables rather than a failure part-way through
     * customer creation (§48).
     */
    const availability = billingAvailability();
    if (!availability.configured) {
      throw new NotConfiguredError(
        "Billing",
        [...availability.missingEnvVars, ...availability.missingPriceEnvVars],
        "Credit top-ups cannot be bought until Stripe is fully configured.",
      );
    }

    /**
     * Then the *pack's own* price, separately.
     *
     * Billing being configured does not mean this pack is purchasable — the pack
     * prices are their own four variables. Checked here rather than left to
     * `priceIdForPack` so the refusal names the specific variable and lists what can
     * actually be bought, instead of surfacing as a generic provider failure.
     */
    const purchasable = availableCreditPacks();
    if (!purchasable.some((pack) => pack.id === body.pack)) {
      throw new NotConfiguredError(
        "Stripe",
        [creditPack(body.pack).priceEnvVar],
        purchasable.length > 0
          ? `That credit pack is not available. Available packs: ${purchasable
              .map((pack) => pack.id)
              .join(", ")}.`
          : "No credit packs are configured in this deployment.",
      );
    }

    /**
     * Keyed by user, on the `billing` rule rather than `generation`.
     *
     * Every call here is an outbound request to Stripe and creates a customer on first
     * use, so an unbounded loop would fill the account with orphaned customers and
     * `credit_purchases` with pending rows. Ten per ten minutes is far more top-ups
     * than any real user starts.
     */
    await enforce(rules().billing, `billing:${user.id}`);

    const identity = await billingIdentity(user.id);
    if (!identity) throw new NotFoundError("Account not found.");

    const appUrl = env().APP_URL;
    const purchase = await openCreditPurchase({
      userId: user.id,
      email: identity.email,
      pack: body.pack,
      /**
       * Informational, exactly as the subscription route's are: the URL carries no
       * token and grants nothing, and the page it lands on reads the balance from the
       * database like every other page. A user who edits it sees their real balance.
       */
      successUrl: `${appUrl}/dashboard/billing?topup=complete`,
      cancelUrl: `${appUrl}/dashboard/billing?topup=cancelled`,
    });

    log.info("credit top-up started", {
      pack: purchase.pack,
      credits: purchase.credits,
    });

    /**
     * The balance is returned *as it is now* — before the payment — and named so the
     * client cannot mistake it for a post-purchase figure. §42's lesson from the
     * Publish panel: a successful response that only created a payment page must not
     * let the UI render credits the customer does not yet have.
     */
    const balance = await creditBalanceFor(user.id);

    return {
      url: purchase.url,
      pack: purchase.pack,
      creditsOnCompletion: purchase.credits,
      amountCents: purchase.amountCents,
      creditsAdded: false,
      balanceBefore: balance.available,
      message:
        "Complete payment at the returned URL. Credits are added once the payment is confirmed.",
    };
  });
}

/**
 * GET /api/credits — the caller's balance, their history, and what they can buy (§8, §11).
 *
 * Everything the billing screen's credit panel needs, in one authenticated read. Three
 * properties worth stating:
 *
 *  - **Server-authoritative.** The balance comes from `credit_balances`, not from
 *    anything the client held. A UI that tracked spend locally would drift the moment a
 *    worker charged for a scene.
 *  - **Only purchasable packs are listed.** `availableCreditPacks()` filters on
 *    configuration, so the picker cannot render a button that was never going to work
 *    (§48). `topUpsAvailable` lets the panel disappear entirely.
 *  - **No vendor names, anywhere.** History descriptions are written by the charge path
 *    and name the scene and the Tal model; nothing here reaches a provider or exposes
 *    which one served a generation (§3).
 *
 * Reading this grants nothing and charges nothing. It does call `ensureMonthlyGrant`,
 * which is idempotent per period — so a subscriber whose period has just rolled over
 * sees their new allowance rather than a stale zero, and a second load grants nothing
 * further.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseQuery, requireUser } from "@/lib/api/guard";
import { creditBalanceFor, creditHistoryFor, ensureMonthlyGrant } from "@/lib/credits/service";
import { availableCreditPacks, centsPerCredit } from "@/lib/credits/packs";
import { canBuyCredits, creditPurchasesFor } from "@/lib/credits/purchase";

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function GET(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireUser();
    const query = parseQuery(request, QuerySchema);

    /**
     * Grant before reading, so the number shown is the one a generation would actually
     * spend against. Non-fatal by construction — it is idempotent per `(user, period)`
     * and the charge path grants on its own anyway — but doing it here is what stops
     * the dashboard greeting a subscriber with a zero balance on the first day of a
     * period.
     */
    await ensureMonthlyGrant(user.id, {});

    const [balance, history, purchases] = await Promise.all([
      creditBalanceFor(user.id),
      creditHistoryFor(user.id, { ...(query.limit ? { limit: query.limit } : {}) }),
      creditPurchasesFor(user.id),
    ]);

    return {
      balance,
      history,
      purchases,
      topUpsAvailable: !balance.unlimited && canBuyCredits(),
      /**
       * `centsPerCredit` is computed server-side rather than left to the client so the
       * "best value" comparison cannot disagree between the two.
       */
      packs: availableCreditPacks().map((pack) => ({
        id: pack.id,
        credits: pack.credits,
        amountCents: pack.amountCents,
        label: pack.label,
        description: pack.description,
        highlight: pack.highlight ?? false,
        centsPerCredit: Number(centsPerCredit(pack).toFixed(3)),
      })),
    };
  });
}

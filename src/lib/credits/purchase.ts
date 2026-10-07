/**
 * Credit top-ups — opening a purchase, and completing one (§11, §13).
 *
 * The two halves of a top-up, and the seam between them is the point of the file: a
 * checkout session is a *request* to buy, and the credits appear only when a
 * signature-verified event says the money moved. This is the same division §24 draws
 * for tiers, for the same reason — a user who reaches the payment page, abandons it
 * and comes back must have exactly the credits they started with.
 *
 * ## Why the credit count is written before the customer pays
 *
 * `openCreditPurchase` writes a `credit_purchases` row carrying the pack and its
 * credit count *at session-creation time*, from the catalogue. The webhook then reads
 * the count from that row.
 *
 * The obvious alternative — read it back out of the completed session's metadata — is
 * the one thing this design refuses, and it is worth being explicit about why, because
 * the metadata is right there and reading it would be one line:
 *
 *  - Stripe metadata is writable by **anything holding the API key**, including a
 *    dashboard user and any other integration on the account. A credit count read from
 *    metadata is a credit count an attacker with a leaked key can edit before the
 *    webhook fires, and the webhook would be crediting a number it did not choose.
 *  - `amount_total` is a *currency* figure. Deriving credits from it means a promotion
 *    code, a tax line or a currency change silently changes how many credits a pack
 *    grants.
 *
 * Writing it first means the grant was decided at a moment when nothing external had
 * been consulted. The session metadata is still set, but only for diagnostics and for
 * the abnormal path below.
 *
 * ## What happens when the row is missing
 *
 * A payment for a Vidxir AI credit price with no matching purchase row — a session created
 * directly in the dashboard, or a row lost to a rolled-back transaction.
 * `completeCreditPurchase` falls back to `packForPriceId`, which maps a *configured*
 * price back to its pack, and credits from the catalogue. A price this deployment does
 * not sell credits nothing at all and is logged: an unattributable payment is a support
 * conversation, whereas guessing would be a way to mint credits by creating a price.
 *
 * ## Idempotency
 *
 * §13 applies to purchases as much as to charges. Stripe guarantees at-least-once
 * delivery, so the credit grant is keyed `purchase:{sessionId}` — the session id, not
 * the event id, because a payment could in principle be reported by more than one
 * event and the thing being paid for is the session. `addPurchasedCredits` loses its
 * ledger insert on a replay and credits zero.
 *
 * The ledger row and the `credit_purchases` row are updated in **one transaction**, so
 * "paid" and "credited" cannot disagree: there is no window in which the money is
 * recorded as taken and the credits are missing, or the reverse.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { creditPurchases } from "@/lib/db/schema";
import { canUpgrade, getBillingProvider } from "@/lib/billing";
import { logger } from "@/lib/logger";
import {
  creditPack,
  creditTopUpsAvailable,
  packForPriceId,
  type CreditPack,
  type CreditPackId,
} from "@/lib/credits/packs";
import { addPurchasedCredits } from "@/lib/credits/service";

const log = logger.child({ component: "credits", area: "purchase" });

/**
 * Whether a top-up can actually be carried out end to end.
 *
 * Two independent conditions: billing is fully configured *and* at least one pack has
 * a price id. A deployment that sells plans but has set no pack prices is a legitimate
 * state, so this is a different question from `canUpgrade()` rather than the same one —
 * and the UI needs to be able to hide the top-up panel without hiding the plan picker.
 */
export function canBuyCredits(): boolean {
  return canUpgrade() && creditTopUpsAvailable();
}

// ---------------------------------------------------------------------------
// Opening a purchase
// ---------------------------------------------------------------------------

export interface OpenPurchaseResult {
  url: string;
  providerSessionId: string;
  pack: CreditPackId;
  /** From the catalogue: what will be credited when the payment clears. */
  credits: number;
  amountCents: number;
}

/**
 * Create a payment session for a pack and record the pending purchase.
 *
 * Ordering: the provider session is created **first**, then the row is written. The
 * reverse would leave a `pending` row for a session that was never created if Stripe
 * failed, and that row's `provider_session_id` is `NOT NULL` and unique — there is no
 * value to put in it before Stripe has answered.
 *
 * The consequence of this order is the failure mode worth naming: if the insert throws
 * after Stripe created the session, the customer could pay for a session with no row.
 * That is exactly the abnormal path `completeCreditPurchase` handles via
 * `packForPriceId`, so the payment is still honoured. The opposite order has no such
 * recovery, which is why this one is chosen.
 */
export async function openCreditPurchase(input: {
  userId: string;
  email: string;
  pack: CreditPackId;
  successUrl: string;
  cancelUrl: string;
}): Promise<OpenPurchaseResult> {
  const pack = creditPack(input.pack);

  const session = await getBillingProvider().startCreditCheckout({
    userId: input.userId,
    email: input.email,
    pack: input.pack,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
  });

  /**
   * `amountCents` prefers what the provider actually reported over the catalogue's
   * display figure, so the receipt line records the real charge if the two have
   * drifted. The *credits* are never treated this way — see the module docblock.
   */
  const amountCents = session.amountCents ?? pack.amountCents;

  await db.insert(creditPurchases).values({
    userId: input.userId,
    pack: pack.id,
    credits: pack.credits,
    amountCents,
    currency: (session.currency ?? "usd").toLowerCase().slice(0, 3),
    providerSessionId: session.providerSessionId,
    status: "pending",
  });

  log.info("credit purchase opened", {
    userId: input.userId,
    pack: pack.id,
    credits: pack.credits,
    providerSessionId: session.providerSessionId,
  });

  return {
    url: session.url,
    providerSessionId: session.providerSessionId,
    pack: pack.id,
    credits: pack.credits,
    amountCents,
  };
}

// ---------------------------------------------------------------------------
// Completing a purchase
// ---------------------------------------------------------------------------

export interface CompletePurchaseResult {
  /** Credits actually added. Zero for a replay, an unpaid session or an unknown price. */
  credited: number;
  /** True when this exact session had already been credited. */
  alreadyCredited: boolean;
  /** Why nothing was credited, or null when it was. */
  skipReason:
    | "not_paid"
    | "already_credited"
    | "unknown_pack"
    | "wrong_owner"
    | null;
  balanceAfter: number | null;
}

/**
 * Credit a completed payment session.
 *
 * Called only from the billing webhook, after the signature verified — the same rule
 * tier activation follows. There is no route that reaches this, deliberately: a route
 * that credited an account on the browser's word would be a way to mint credits by
 * pressing the back button.
 */
export async function completeCreditPurchase(input: {
  userId: string;
  providerSessionId: string;
  /** Stripe's `payment_status`. Only `paid` credits anything. */
  paymentStatus: string | null;
  providerPaymentIntentId: string | null;
  /**
   * Resolves the price on the session's line item. Called **only** when no purchase
   * row exists, which is why it is a callback rather than a value.
   *
   * Reading line items means a request to the provider, and the normal path must not
   * pay for one: every ordinary top-up has its row and knows its credit count without
   * asking anybody. Passing a resolver rather than a price keeps that cost on the
   * abnormal path, and keeps this module free of any provider import.
   */
  resolvePriceId?: () => Promise<string | null>;
}): Promise<CompletePurchaseResult> {
  /**
   * The payment state is checked before anything is read or written. A session can
   * complete with the payment unresolved — `unpaid`, or an async method still
   * clearing — and crediting that would hand out credits for money that never
   * arrived. Stripe sends another event when it does clear, and that one is `paid`.
   */
  if (input.paymentStatus !== "paid") {
    log.warn("credit purchase session completed without a cleared payment", {
      userId: input.userId,
      providerSessionId: input.providerSessionId,
      paymentStatus: input.paymentStatus ?? "unknown",
    });
    return {
      credited: 0,
      alreadyCredited: false,
      skipReason: "not_paid",
      balanceAfter: null,
    };
  }

  const [existing] = await db
    .select({
      id: creditPurchases.id,
      userId: creditPurchases.userId,
      pack: creditPurchases.pack,
      credits: creditPurchases.credits,
      status: creditPurchases.status,
      ledgerId: creditPurchases.ledgerId,
    })
    .from(creditPurchases)
    .where(eq(creditPurchases.providerSessionId, input.providerSessionId))
    .limit(1);

  /**
   * The row belongs to someone else.
   *
   * Not reachable through the normal path — the webhook resolves the account from the
   * session's own `client_reference_id`, which Vidxir AI set — but the check is here
   * because the alternative is unbounded: crediting `input.userId` for a row owned by
   * another account would move credits between tenants on a forged
   * `client_reference_id`, and §34's rule is that the tenant predicate is part of the
   * query rather than something a caller is trusted to have got right.
   */
  if (existing && existing.userId !== input.userId) {
    log.error("credit purchase session does not belong to the resolved account", {
      userId: input.userId,
      providerSessionId: input.providerSessionId,
    });
    return {
      credited: 0,
      alreadyCredited: false,
      skipReason: "wrong_owner",
      balanceAfter: null,
    };
  }

  /**
   * The pack, from Vidxir AI's own row where there is one, and from the *configured*
   * price otherwise. `packForPriceId` returns null for a price this deployment does
   * not sell, which credits nothing — a price created in the dashboard must not be
   * able to mint credits.
   */
  let credits: number;
  let packId: string;

  if (existing) {
    credits = existing.credits;
    packId = existing.pack;
  } else {
    const priceId = input.resolvePriceId
      ? await input.resolvePriceId().catch((error: unknown) => {
          // A failed lookup is "unknown pack", which the caller already handles.
          log.warn("could not resolve the price of a session with no purchase row", {
            providerSessionId: input.providerSessionId,
            err: error,
          });
          return null;
        })
      : null;
    const fallback: CreditPack | null = packForPriceId(priceId);
    if (!fallback) {
      log.error("paid credit session has no purchase row and no recognised price", {
        userId: input.userId,
        providerSessionId: input.providerSessionId,
      });
      return {
        credited: 0,
        alreadyCredited: false,
        skipReason: "unknown_pack",
        balanceAfter: null,
      };
    }
    log.warn("crediting a paid session that had no purchase row", {
      userId: input.userId,
      providerSessionId: input.providerSessionId,
      pack: fallback.id,
    });
    credits = fallback.credits;
    packId = fallback.id;
  }

  /**
   * One transaction for the grant and the receipt.
   *
   * `addPurchasedCredits` takes the executor precisely so this is possible: the ledger
   * row, the balance increment and the `credit_purchases` row all commit together, so
   * there is no state in which the purchase reads `completed` with no credits, or
   * credits exist with the purchase still `pending`.
   */
  const outcome = await addPurchasedCredits({
    userId: input.userId, credits, idempotencyKey: `purchase:${input.providerSessionId}`,
    description: `${credits.toLocaleString("en-US")} credit top-up`,
    meta: { pack: packId, providerSessionId: input.providerSessionId,
      ...(input.providerPaymentIntentId ? { providerPaymentIntentId: input.providerPaymentIntentId } : {}),
    },
    receiptQueries: existing ? [db.update(creditPurchases).set({
      status: "completed",
      ledgerId: sql`(SELECT id FROM credit_ledger WHERE idempotency_key=${`purchase:${input.providerSessionId}`} AND user_id=${input.userId})`,
      ...(input.providerPaymentIntentId ? { providerPaymentIntentId: input.providerPaymentIntentId } : {}),
      completedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(creditPurchases.id, existing.id), eq(creditPurchases.status, "pending")))] : [],
  });

  if (outcome.alreadyCredited) {
    log.info("credit purchase already credited", {
      userId: input.userId,
      providerSessionId: input.providerSessionId,
    });
    return {
      credited: 0,
      alreadyCredited: true,
      skipReason: "already_credited",
      balanceAfter: outcome.balanceAfter,
    };
  }

  log.info("credit purchase completed", {
    userId: input.userId,
    pack: packId,
    credits: outcome.credited,
    balanceAfter: outcome.balanceAfter,
  });

  return {
    credited: outcome.credited,
    alreadyCredited: false,
    skipReason: null,
    balanceAfter: outcome.balanceAfter,
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface PurchaseRecord {
  id: string;
  pack: string;
  credits: number;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
}

/**
 * The caller's own top-ups, newest first.
 *
 * `userId` is in the WHERE clause, per §34. `pending` rows are included: a customer
 * who paid and is waiting on an async payment method needs to see that the purchase
 * exists, and hiding it invites a duplicate purchase.
 */
export async function creditPurchasesFor(
  userId: string,
  options: { limit?: number } = {},
): Promise<PurchaseRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const rows = await db
    .select({
      id: creditPurchases.id,
      pack: creditPurchases.pack,
      credits: creditPurchases.credits,
      amountCents: creditPurchases.amountCents,
      currency: creditPurchases.currency,
      status: creditPurchases.status,
      createdAt: creditPurchases.createdAt,
      completedAt: creditPurchases.completedAt,
    })
    .from(creditPurchases)
    .where(eq(creditPurchases.userId, userId))
    .orderBy(desc(creditPurchases.createdAt))
    .limit(limit);

  return rows;
}

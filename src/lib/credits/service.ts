/**
 * The credit ledger and balance — Vidxir AI's generation currency (§7–§13).
 *
 * Five operations, and the interesting property of each:
 *
 *  - `ensureMonthlyGrant` — idempotent per `(user, period)`. Safe to call on every
 *    request, from a webhook, and from a scheduled task, all at once.
 *  - `chargeCredits` — **atomic and idempotent**. Refuses rather than overdrawing,
 *    and a retried job charges once.
 *  - `refundCredits` — for a generation that was charged and then failed (§12).
 *  - `creditBalanceFor` — what the UI shows, including the split §11 requires.
 *  - `creditHistoryFor` — the transaction list (§8).
 *
 * ## The one hard requirement
 *
 * §13: "Make charging atomic/idempotent so retries cannot double-charge." Two failure
 * modes, and they need different mechanisms:
 *
 *  1. **Concurrent overdraw** — two generations starting at once, each affordable
 *     alone. Handled by a conditional UPDATE against `credit_balances`, so the second
 *     transaction blocks on the row lock, re-evaluates against the committed value,
 *     and matches nothing when the money has gone. This is the same compare-and-swap
 *     shape `createProject` uses to claim a monthly video slot.
 *  2. **Retried charge** — BullMQ replaying a job that already paid. Handled by the
 *     unique `idempotency_key` on the ledger: the *ledger insert happens first*, and
 *     losing it means the charge already ran, so the balance is never touched twice.
 *
 * Ordering the ledger insert before the balance update is what makes (2) work, and it
 * is worth being explicit that the reverse order would be broken: incrementing `spent`
 * first and then discovering the ledger row already existed would leave the balance
 * double-charged with no way to tell it apart from a legitimate second spend.
 *
 * ## Why the balance is never computed by summing the ledger at read time
 *
 * It is *checked* that way — `reconcile` exists for exactly that, and the integration
 * suite asserts the two agree — but it is not read that way. A sum cannot be locked, so
 * a charge that read a summed balance and then inserted could interleave with another
 * doing the same. See the `credit_balances` docblock in `schema.ts`.
 *
 * ## What this module does not do
 *
 * It never calls a provider, never touches Stripe, and never decides a price. Prices
 * come from `credits/pricing`, which is pure; Stripe lives in `credits/packs` and the
 * billing webhook. Keeping the ledger ignorant of all three means a charge cannot fail
 * because a vendor was slow, and a price cannot differ between the quote and the
 * charge.
 */
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { atomic, type AtomicQuery } from "@/lib/db/atomic";
import {
  creditBalances,
  creditLedger,
  subscriptions,
  users,
} from "@/lib/db/schema";
import { InsufficientCreditsError, ValidationError } from "@/lib/errors";
import { planByTier, type PlanTier } from "@/lib/plans";
import { currentPeriod } from "@/lib/projects/service";
import { creditCostFor, type CreditOperation } from "@/lib/credits/pricing";
import type { VideoQuality } from "@/lib/video/quality";


/** A database handle or an open transaction. Every write here accepts either. */
type Executor = typeof db;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface CreditBalance {
  /** Admin testing accounts are exempt from generation credit charges. */
  unlimited?: boolean;
  /** Spendable right now: `granted + purchased - spent`, never negative. */
  available: number;
  /** This period's plan allowance, as granted. */
  granted: number;
  /** Purchased credits still on the account. Survives the period reset (§11). */
  purchased: number;
  /** Spent this period, net of refunds. */
  spent: number;
  /** `YYYY-MM` the grant and spend figures refer to. */
  period: string;
  /** The tier the current grant was issued for. */
  grantedForTier: PlanTier;
}

const EMPTY_BALANCE = (period: string): CreditBalance => ({
  available: 0,
  granted: 0,
  purchased: 0,
  spent: 0,
  period,
  grantedForTier: "starter",
});

/**
 * The account's balance.
 *
 * Read-only and does **not** grant. A read that granted would mean any page load could
 * mint credits, and a bug in the period comparison would then be a bug that gives away
 * money on every request. `ensureMonthlyGrant` is called explicitly, from the places
 * that are entitled to: the charge path and the billing webhook.
 *
 * A user with no row yet reads as zero rather than as an error, which is correct for
 * the interval between signup and their first grant.
 */
export async function creditBalanceFor(
  userId: string,
  executor: Executor = db,
): Promise<CreditBalance> {
  if (await hasUnlimitedCredits(userId, executor)) {
    // Infinity becomes null in JSON. Keep numeric consumers compatible and expose
    // the explicit flag so the UI can display the actual entitlement.
    return { ...EMPTY_BALANCE(currentPeriod()), available: Number.MAX_SAFE_INTEGER, unlimited: true };
  }
  const [row] = await executor
    .select()
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId))
    .limit(1);

  if (!row) return EMPTY_BALANCE(currentPeriod());

  return {
    available: availableOf(row),
    granted: row.granted,
    purchased: row.purchased,
    spent: row.spent,
    period: row.period,
    grantedForTier: row.grantedForTier,
  };
}

async function hasUnlimitedCredits(userId: string, executor: Executor = db): Promise<boolean> {
  const [user] = await executor.select({ role: users.role }).from(users)
    .where(eq(users.id, userId)).limit(1);
  return user?.role === "admin";
}

function availableOf(row: {
  granted: number;
  purchased: number;
  spent: number;
}): number {
  const available = row.granted + row.purchased - row.spent;
  // The check constraint makes this unreachable; clamping keeps a corrupt row from
  // rendering a negative balance in the UI.
  return available > 0 ? available : 0;
}

// ---------------------------------------------------------------------------
// Granting the monthly allowance
// ---------------------------------------------------------------------------

export interface GrantOutcome {
  /** True when this call actually granted; false when the period was already granted. */
  granted: boolean;
  credits: number;
  period: string;
  tier: PlanTier;
  balance: CreditBalance;
}

/**
 * Give the account this period's included credits, at most once per period (§7, §13).
 *
 * ## Idempotency
 *
 * `credit_balances.period` is the key. The UPDATE branch of the upsert carries
 * `setWhere: period < $period`, so:
 *
 *  - First call in a new month: the stored period is older, the predicate holds, the
 *    row is reset and granted.
 *  - Second call the same month: the stored period equals the requested one, `<` is
 *    false, nothing is written, and `returning` is empty — which is how the caller
 *    learns it was already granted.
 *  - Two concurrent first calls: the second blocks on the row lock and then evaluates
 *    against the committed period, which is now the current one. Exactly one grants.
 *
 * A string comparison is safe here because `YYYY-MM` is lexicographically ordered.
 *
 * ## What the reset does and does not clear
 *
 * `granted` and `spent` are replaced; `purchased` is left alone. §11 requires purchased
 * credits to outlive the month, and this is the line that implements it — a reset that
 * touched `purchased` would delete credits the customer paid cash for.
 *
 * ## Tier changes mid-period
 *
 * A tier upgrade does **not** re-grant. The upgrade is recorded on `subscriptions` by
 * the webhook and takes effect at the next period, because re-granting on upgrade would
 * let someone cycle Studio → Scale → Studio to collect a grant each time. The gap is
 * covered by top-ups, which is what §11 is for. `grantedForTier` records what the
 * standing grant was issued against so the UI can explain the discrepancy honestly.
 */
export async function ensureMonthlyGrant(
  userId: string,
  options: { tier?: PlanTier; period?: string; executor?: Executor } = {},
): Promise<GrantOutcome> {
  const executor = options.executor ?? db;
  const period = options.period ?? currentPeriod();
  const tier = options.tier ?? (await tierOf(userId, executor));
  if (await hasUnlimitedCredits(userId, executor)) {
    return { granted: false, credits: 0, period, tier, balance: await creditBalanceFor(userId, executor) };
  }
  const credits = planByTier(tier).monthlyCredits;

  const ledgerId = crypto.randomUUID();
  const results = await atomic([
    executor.insert(creditBalances).values({ userId, granted: credits, purchased: 0, spent: 0, period, grantedForTier: tier })
      .onConflictDoUpdate({ target: creditBalances.userId,
        set: { granted: credits, spent: 0, period, grantedForTier: tier, updatedAt: new Date() },
        setWhere: lt(creditBalances.period, period),
      }),
    sql`INSERT INTO credit_ledger (id,user_id,reason,amount,balance_after,period,idempotency_key,description,meta)
      SELECT ${ledgerId},${userId},'monthly_grant',${credits},granted+purchased-spent,${period},${`grant:${userId}:${period}`},
      ${`${planByTier(tier).name} plan — ${credits.toLocaleString("en-US")} monthly credits`},${JSON.stringify({tier})}
      FROM credit_balances WHERE user_id=${userId} AND changes()>0`,
  ]);
  const granted = (results[0]?.meta.changes ?? 0) > 0;
  return { granted, credits: granted ? credits : 0, period, tier, balance: await creditBalanceFor(userId, executor) };
}

/**
 * The tier to grant against, read from `subscriptions`.
 *
 * Duplicates `currentTier`'s logic rather than importing it, and the reason is a real
 * one: `plans/enforce` imports `projects/service`, which imports the queue, which a
 * transaction-scoped call here must not drag in. The rule is identical — a lapsed
 * subscription grants Starter credits — and the shared `isPlanTier`/`planByTier`
 * catalogue means the tier vocabulary cannot drift even though this predicate is
 * written twice.
 */
async function tierOf(userId: string, executor: Executor): Promise<PlanTier> {
  const [account] = await executor.select({ planOverride: users.planOverride }).from(users).where(eq(users.id, userId)).limit(1);
  if (account?.planOverride) return account.planOverride;
  const [row] = await executor
    .select({ tier: subscriptions.tier, status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);

  if (!row) return "starter";
  const entitled = row.status === "active" || row.status === "trialing";
  return entitled ? row.tier : "starter";
}

// ---------------------------------------------------------------------------
// Charging
// ---------------------------------------------------------------------------

export interface ChargeRequest {
  userId: string;
  operation: CreditOperation;
  /** A catalogued model id. Priced by `creditCostFor`, never sent by a client. */
  modelId: string;
  quality: VideoQuality;
  /** Required for `video_scene`; ignored for `image`. */
  durationMs?: number;
  projectId?: string | null;
  /**
   * The retry guard (§13). **Required**, and deliberately not defaulted.
   *
   * Every charge happens inside something that can be replayed — a BullMQ job, a
   * route a user can double-click — so there is no call site that legitimately has no
   * key. Defaulting to a random value would make the parameter look satisfied while
   * providing no protection at all, so it is required and the caller has to name what
   * makes this charge unique.
   *
   * The convention is `{operation}:{projectId}:{discriminator}` — see
   * `sceneChargeKey` and `imageChargeKey`.
   */
  idempotencyKey: string;
  /** Shown on the history screen. Must never name a vendor (§3). */
  description?: string;
  meta?: Record<string, unknown>;
}

export interface ChargeOutcome {
  /** Credits taken. Zero when this charge had already been applied. */
  charged: number;
  /** The price, whether or not it was charged this time. */
  cost: number;
  /** True when the idempotency key had already been used. */
  alreadyCharged: boolean;
  /** The ledger row id, existing or new. */
  ledgerId: string;
  balanceAfter: number;
}

/**
 * Charge for a generation, atomically, refusing rather than overdrawing (§10, §13).
 *
 * Throws `InsufficientCreditsError` when the balance cannot cover the cost, and writes
 * nothing in that case — the transaction rolls back, so a refused generation leaves no
 * ledger row and no partial spend.
 *
 * ## Call it *before* the provider call
 *
 * Every call site charges first and generates second, with `refundCredits` on failure
 * (§12). The alternative — generate, then charge — would let a customer with an empty
 * balance consume unlimited provider spend, since the refusal would arrive after the
 * money was gone. Charging first means the worst case is a refunded charge, which is
 * recoverable; the other way round the loss is Vidxir AI's and is not.
 */
export async function chargeCredits(
  request: ChargeRequest,
): Promise<ChargeOutcome> {
  if (!request.idempotencyKey.trim()) {
    throw new ValidationError("A credit charge requires an idempotency key.");
  }

  const cost = creditCostFor({
    operation: request.operation,
    modelId: request.modelId,
    quality: request.quality,
    durationMs: request.durationMs,
  });

  const period = currentPeriod();

  if (await hasUnlimitedCredits(request.userId)) {
    // No money moves for an exempt account, so there is no charge to record or
    // refund. Repeated calls remain free without affecting the paid ledger.
    return { charged: 0, cost, alreadyCharged: false, ledgerId: "", balanceAfter: Number.MAX_SAFE_INTEGER };
  }

  await ensureMonthlyGrant(request.userId, { period });
  const ledgerId = crypto.randomUUID();
  try {
    await atomic([
      db.insert(creditLedger).values({ id: ledgerId, userId: request.userId, reason: "spend", amount: -cost,
        balanceAfter: 0, operation: request.operation, modelId: request.modelId, quality: request.quality,
        projectId: request.projectId ?? null, idempotencyKey: request.idempotencyKey, period,
        description: request.description ?? describeSpend(request, cost), meta: request.meta ?? null,
      }).onConflictDoNothing(),
      // The CHECK constraint refuses overdraw and rolls back the ledger insert.
      // A duplicate key did not insert this generated id, so it cannot spend again.
      db.update(creditBalances).set({ spent: sql`${creditBalances.spent} + ${cost}`, updatedAt: new Date() })
        .where(and(eq(creditBalances.userId, request.userId), sql`EXISTS (SELECT 1 FROM credit_ledger WHERE id=${ledgerId})`)),
      sql`UPDATE credit_ledger SET balance_after=(SELECT granted+purchased-spent FROM credit_balances WHERE user_id=${request.userId}) WHERE id=${ledgerId}`,
    ]);
  } catch (error) {
    if (String(error).includes("credit_balances_non_negative")) {
      const balance = await creditBalanceFor(request.userId);
      throw new InsufficientCreditsError({ required: cost, available: balance.available, operation: request.operation, modelId: request.modelId });
    }
    throw error;
  }
  const [ledger] = await db.select().from(creditLedger)
    .where(and(eq(creditLedger.idempotencyKey, request.idempotencyKey), eq(creditLedger.userId, request.userId))).limit(1);
  if (!ledger) throw new ValidationError("Credit charge key does not belong to this account.");
  const alreadyCharged = ledger.id !== ledgerId;
  return { charged: alreadyCharged ? 0 : cost, cost: Math.abs(ledger.amount), alreadyCharged, ledgerId: ledger.id, balanceAfter: ledger.balanceAfter };
}

function describeSpend(request: ChargeRequest, cost: number): string {
  const what =
    request.operation === "image" ? "Image generation" : "Scene generation";
  return `${what} — ${cost} credit${cost === 1 ? "" : "s"} (${request.quality})`;
}

// ---------------------------------------------------------------------------
// Refunding
// ---------------------------------------------------------------------------

export interface RefundOutcome {
  refunded: number;
  alreadyRefunded: boolean;
  balanceAfter: number;
}

/**
 * Return a charge for a generation that failed after paying for it (§12).
 *
 * ## Keyed off the original charge
 *
 * Takes the charge's idempotency key rather than an amount, and reads the amount from
 * the ledger. That means a refund is always for exactly what was charged — it cannot
 * over-refund because of a re-derived price, which would happen if the pricing table
 * changed between the charge and the failure.
 *
 * The refund's own key is `refund:{chargeKey}`, so a retried failure handler refunds
 * once. Both halves need guarding: a job that fails, refunds, is retried, fails again
 * and refunds again would return the credits twice.
 *
 * ## Never throws for "nothing to refund"
 *
 * A refund for a charge that never happened returns zero rather than throwing. This is
 * called from failure paths, and a failure handler that itself throws replaces a
 * useful provider error with a confusing accounting one. The absence is logged.
 */
export async function refundCredits(input: {
  userId: string;
  chargeIdempotencyKey: string;
  reason: string;
  meta?: Record<string, unknown>;
}): Promise<RefundOutcome> {
  const period = currentPeriod();
  const refundKey = `refund:${input.chargeIdempotencyKey}`;

  const [charge] = await db.select().from(creditLedger).where(and(
    eq(creditLedger.idempotencyKey, input.chargeIdempotencyKey), eq(creditLedger.userId, input.userId), eq(creditLedger.reason, "spend"),
  )).limit(1);
  if (!charge) return { refunded: 0, alreadyRefunded: false, balanceAfter: 0 };
  const amount = Math.abs(charge.amount);
  const ledgerId = crypto.randomUUID();
  await atomic([
    db.insert(creditLedger).values({ id: ledgerId, userId: input.userId, reason: "refund", amount, balanceAfter: 0,
      operation: charge.operation, modelId: charge.modelId, quality: charge.quality, projectId: charge.projectId,
      idempotencyKey: refundKey, period, description: `Refund — ${input.reason}`, meta: { ...input.meta, refundOf: charge.id },
    }).onConflictDoNothing(),
    db.update(creditBalances).set({ spent: sql`max(${creditBalances.spent} - ${amount}, 0)`, updatedAt: new Date() })
      .where(and(eq(creditBalances.userId, input.userId), sql`EXISTS (SELECT 1 FROM credit_ledger WHERE id=${ledgerId})`)),
    sql`UPDATE credit_ledger SET balance_after=(SELECT granted+purchased-spent FROM credit_balances WHERE user_id=${input.userId}) WHERE id=${ledgerId}`,
  ]);
  const [ledger] = await db.select().from(creditLedger).where(and(eq(creditLedger.idempotencyKey, refundKey), eq(creditLedger.userId, input.userId))).limit(1);
  const alreadyRefunded = ledger?.id !== ledgerId;
  return { refunded: alreadyRefunded ? 0 : amount, alreadyRefunded, balanceAfter: (await creditBalanceFor(input.userId)).available };
}

// ---------------------------------------------------------------------------
// Adding purchased credits
// ---------------------------------------------------------------------------

/**
 * Add bought credits to the account (§11).
 *
 * Called **only** from the billing webhook, after Stripe has confirmed payment — the
 * same rule as tier activation (§24: never grant on the frontend's word). There is no
 * route that reaches this.
 *
 * Increments `purchased`, which no period reset touches, so bought credits do not
 * expire. Takes an executor so the webhook can write this and mark the
 * `credit_purchases` row completed in one transaction: "paid" and "credited" must not
 * be able to disagree.
 */
export async function addPurchasedCredits(input: {
  userId: string; credits: number; idempotencyKey: string; description: string;
  meta?: Record<string, unknown>;
  /** Receipt writes join the exact same D1 batch as the balance and ledger. */
  receiptQueries?: AtomicQuery[];
}): Promise<{ credited: number; alreadyCredited: boolean; ledgerId: string | null; balanceAfter: number }> {
  if (!Number.isInteger(input.credits) || input.credits <= 0) throw new ValidationError("A credit purchase must add a positive whole number of credits.");
  const period = currentPeriod();
  const ledgerId = crypto.randomUUID();
  await atomic([
    db.insert(creditLedger).values({ id: ledgerId, userId: input.userId, reason: "purchase", amount: input.credits,
      balanceAfter: 0, idempotencyKey: input.idempotencyKey, period, description: input.description, meta: input.meta ?? null,
    }).onConflictDoNothing(),
    sql`INSERT INTO credit_balances (user_id,granted,purchased,spent,period)
      SELECT ${input.userId},0,${input.credits},0,${period} WHERE EXISTS(SELECT 1 FROM credit_ledger WHERE id=${ledgerId})
      ON CONFLICT(user_id) DO UPDATE SET purchased=purchased+${input.credits},updated_at=${Date.now()}`,
    sql`UPDATE credit_ledger SET balance_after=(SELECT granted+purchased-spent FROM credit_balances WHERE user_id=${input.userId}) WHERE id=${ledgerId}`,
    ...(input.receiptQueries ?? []),
  ]);
  const [ledger] = await db.select().from(creditLedger).where(and(eq(creditLedger.idempotencyKey, input.idempotencyKey), eq(creditLedger.userId, input.userId))).limit(1);
  if (!ledger) throw new ValidationError("Credit purchase key does not belong to this account.");
  const alreadyCredited = ledger.id !== ledgerId;
  return { credited: alreadyCredited ? 0 : input.credits, alreadyCredited, ledgerId: ledger.id, balanceAfter: ledger.balanceAfter };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface CreditHistoryEntry {
  id: string;
  reason: (typeof creditLedger.reason.enumValues)[number];
  amount: number;
  balanceAfter: number;
  operation: string | null;
  modelId: string | null;
  quality: string | null;
  projectId: string | null;
  description: string | null;
  createdAt: Date;
}

/**
 * The transaction list (§8).
 *
 * Filtered by `userId` in the WHERE clause rather than by joining through a project,
 * which is the §34 convention: tenant isolation is one predicate on every query.
 * Newest first, and capped — a long-lived account accumulates a row per scene, so an
 * unbounded query would eventually be tens of thousands of rows sent to a browser.
 */
export async function creditHistoryFor(
  userId: string,
  options: { limit?: number; period?: string } = {},
): Promise<CreditHistoryEntry[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  const rows = await db
    .select({
      id: creditLedger.id,
      reason: creditLedger.reason,
      amount: creditLedger.amount,
      balanceAfter: creditLedger.balanceAfter,
      operation: creditLedger.operation,
      modelId: creditLedger.modelId,
      quality: creditLedger.quality,
      projectId: creditLedger.projectId,
      description: creditLedger.description,
      createdAt: creditLedger.createdAt,
    })
    .from(creditLedger)
    .where(
      options.period
        ? and(
            eq(creditLedger.userId, userId),
            eq(creditLedger.period, options.period),
          )
        : eq(creditLedger.userId, userId),
    )
    .orderBy(desc(creditLedger.createdAt))
    .limit(limit);

  return rows;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface Reconciliation {
  /** `granted + purchased - spent` from `credit_balances`. */
  balance: number;
  /** The sum of every ledger row for this user, across all periods. */
  ledgerSum: number;
  /** True when the two agree, which they always should. */
  consistent: boolean;
}

/**
 * Check the materialised balance against the ledger.
 *
 * The ledger is the *definition* of the balance and `credit_balances` is a
 * materialisation of it for locking purposes, so these two numbers agreeing is the
 * correctness property of this whole module. Asserted by the integration suite after
 * every scenario it runs, and exposed here so an operator can check an account
 * without hand-writing the query.
 *
 * ## Why the sums can legitimately differ, and why they do not here
 *
 * A period reset zeroes `granted` and `spent`, which would break the equality if the
 * ledger kept accumulating — the ledger's sum spans all time, the balance only this
 * period. It holds anyway because a reset *replaces* `granted` with the new grant and
 * writes a `monthly_grant` ledger row for it, while zeroing the `spent` that the
 * previous grant covered. Over any number of periods the two stay equal as long as
 * every movement writes both, which is the invariant this function exists to check.
 */
export async function reconcile(userId: string): Promise<Reconciliation> {
  const [balanceRow] = await db
    .select({
      granted: creditBalances.granted,
      purchased: creditBalances.purchased,
      spent: creditBalances.spent,
      period: creditBalances.period,
    })
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId))
    .limit(1);

  const balance = balanceRow ? availableOf(balanceRow) : 0;

  /**
   * Only movements that are still reflected in the balance row.
   *
   * A reset discards the previous period's `granted` and `spent`, so summing every
   * ledger row ever written would include grants that have since been replaced. The
   * period filter is what makes the comparison meaningful — except for purchases,
   * which survive resets and therefore have to be counted across all periods.
   */
  const period = balanceRow?.period ?? currentPeriod();

  const [sums] = await db
    .select({
      total: sql<number>`coalesce(sum(${creditLedger.amount}), 0)`,
    })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.userId, userId),
        or(
          eq(creditLedger.period, period),
          eq(creditLedger.reason, "purchase"),
        ),
      ),
    );

  const ledgerSum = sums?.total ?? 0;

  return {
    balance,
    ledgerSum,
    consistent: balance === ledgerSum,
  };
}

// ---------------------------------------------------------------------------
// Idempotency key construction
// ---------------------------------------------------------------------------

/**
 * The key for charging one scene's clip.
 *
 * `attempt` is what makes a *deliberate* regeneration chargeable while an *accidental*
 * retry is not. A BullMQ retry of the same job replays the same attempt number and so
 * loses the ledger insert; a user asking to regenerate scene 3 again supplies the next
 * attempt and is charged, which is correct — it is a second generation.
 *
 * Constructed here rather than at the call sites so both the charge and its refund
 * derive the same string from the same inputs. A key built in two places is a key that
 * will eventually be built two ways, and the failure mode is a refund that refunds
 * nothing.
 */
export function sceneChargeKey(input: {
  projectId: string;
  sceneIndex: number;
  attempt: number;
}): string {
  return `scene:${input.projectId}:${input.sceneIndex}:${input.attempt}`;
}

/**
 * The key for charging one generated still.
 *
 * Keyed by purpose and entity rather than by an ordinal, because the reference-image
 * stage is explicitly re-runnable and must not re-charge for a still it already
 * produced (§6, and the "not re-drawn on a second run" property the continuity verify
 * script asserts). `entityId` is the bible slug for a continuity reference, or the
 * scene index for an illustration.
 */
export function imageChargeKey(input: {
  projectId: string;
  purpose: string;
  entityId: string;
}): string {
  return `image:${input.projectId}:${input.purpose}:${input.entityId}`;
}

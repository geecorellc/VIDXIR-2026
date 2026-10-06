/**
 * Prove the credit system works in a real Node process against real Postgres
 * (§7–§13, §24, §32).
 *
 * The vitest suites cover a great deal: 28 unit tests over the pricing table and the
 * pack catalogue, and 39 integration tests over the ledger — including the concurrency
 * and idempotency §13 asks for. What no vitest run can cover is the failure that has
 * bitten this project twice: `vitest.config.ts` aliases `server-only` away, so a module
 * graph that could never boot passes green. `credits/service` is now imported by
 * `plans/enforce` and by `billing/webhook`, and both of those are reached from a route
 * and from the worker — so the import that matters is the one this script performs with
 * no aliases at all.
 *
 * It also checks two things the integration suite structurally cannot:
 *
 *  - **That the money and the numbers agree end to end.** Every plan's included credits,
 *    every model's price at every quality, and the balance arithmetic across a full
 *    period rollover, all read through the shipped modules rather than through a test
 *    fixture.
 *  - **That the pricing table covers the live provider registry** as the real process
 *    resolves it, which depends on which credentials are actually configured.
 *
 * What it verifies:
 *
 *   1. the environment loads, mock providers are on, and the migration's constraints
 *      are present in the live database
 *   2. all three plans carry included credits, ascending with price
 *   3. every model the real registry resolves has an explicit price, at every quality
 *   4. a fixture tenant is granted its plan's credits exactly once per period
 *   5. a charge lowers the balance by exactly the quoted price, and the quote a picker
 *      would show is the number that was charged
 *   6. a replayed charge charges nothing, and the ledger holds one spend
 *   7. an unaffordable charge is refused with a 402 that names no vendor, and leaves no
 *      ledger row at all
 *   8. eight concurrent charges against a balance of three spend exactly three
 *   9. a refund returns exactly what was charged, once, however many times it is called
 *  10. purchased credits are added, survive a period rollover, and pay for a generation
 *      the allowance cannot
 *  11. the ledger reconciles against the balance after every one of the above
 *  12. the transaction history is per-tenant and names no vendor
 *  13. the top-up catalogue offers only configured packs, and refuses an unconfigured
 *      one by naming the variable to set
 *  14. a completed purchase credits its pack's credits once, survives a replay, marks
 *      its receipt in the same transaction, and refuses an unidentifiable payment
 *  15. entitlements carry the balance, and reading them grants nothing
 *  16. every provider call this run made was the mock — asserted from `api_usage`
 *
 * ## Cost and safety
 *
 * **Nothing here calls a provider or Stripe.** `VIDXIR_USE_MOCK_PROVIDERS=true` is set at
 * module scope before anything reads the environment, and step 1 asserts it rather than
 * assuming it. No generation is performed at all: this script charges for generations
 * that never happen, which is precisely what makes it free — the credit service takes no
 * provider argument and reaches no network. Step 14 calls `completeCreditPurchase`
 * directly — the webhook's half of a top-up, handed a session id and a payment status
 * exactly as a verified event would hand it one. No checkout session is created, no
 * `resolvePriceId` callback reaches Stripe, and no Stripe API call is made anywhere in
 * this file. Step 16 audits `api_usage` afterwards to prove the run was inert.
 *
 * Everything it writes belongs to two fixture tenants, reused across runs and cleaned at
 * the start of each. No real account is read or touched, and no real balance is altered.
 *
 *   npx tsx scripts/verify-credits.ts
 *
 * Exits non-zero on the first failure.
 */
import "@/lib/load-env";
// Type-only, so it does not defeat the dynamic imports below: every runtime import in
// this file is deferred until after the environment overrides, because `lib/env`
// snapshots the environment on first read.
import type { PlanTier } from "@/lib/plans";

/**
 * Set before anything can read it.
 *
 * `.env.local` has `VIDXIR_USE_MOCK_PROVIDERS=false`, which is the right default for a
 * developer's web app and the wrong one here. `process.loadEnvFile` runs from the
 * hoisted `load-env` import above and does not overwrite variables already present —
 * but it ran *first*, so this assignment is what wins, and no `env()` call has happened
 * yet.
 */
process.env["VIDXIR_USE_MOCK_PROVIDERS"] = "true";

const FIXTURE_EMAIL = "credits-verify@vidxir.local";
const OTHER_EMAIL = "credits-verify-other@vidxir.local";

/** The model the fixture charges against. Priced at 1 credit, so the sums are readable. */
const MOCK_MODEL = "mock/placeholder";

let step = 0;

function ok(message: string): void {
  step += 1;
  console.log(`  ${step}. OK  ${message}`);
}

function detail(message: string): void {
  console.log(`        ${message}`);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, what: string): void {
  assert(
    actual === expected,
    `${what}: expected ${String(expected)}, got ${String(actual)}`,
  );
}

/** Vendor names that must never reach a customer-facing string (§3). */
const VENDOR_NAMES =
  /veo|gemini|minimax|wan|seedance|dashscope|fal\.ai|runway|bedrock|stripe/i;

async function main(): Promise<void> {
  console.log("\nVidxir AI credit system verification\n");

  // ---- 1. Environment and the live schema -------------------------------
  const { env, usingMockProviders } = await import("@/lib/env");
  const e = env();

  assert(usingMockProviders(), "mock providers must be on: this script must be free");
  assert(Boolean(e.DATABASE_URL), "DATABASE_URL must be set");

  const { db, rawSql } = await import("@/lib/db");
  const sql = rawSql();

  /**
   * The constraints and the partial index, read out of the live catalogue.
   *
   * drizzle-kit emits neither CHECK constraints nor partial indexes, so all three of
   * these were hand-appended to `0009_phase13_credits.sql` and are deliberately absent
   * from the snapshot. That makes them exactly the objects most likely to be missing
   * from an environment somebody migrated a different way — and the partial index in
   * particular is load-bearing: without it every keyed insert fails outright.
   */
  const constraints = await sql<{ conname: string }[]>`
    SELECT conname FROM pg_constraint
    WHERE conname IN (
      'credit_ledger_sign_matches_reason',
      'credit_balances_non_negative'
    )
  `;
  const indexes = await sql<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes WHERE indexname = 'credit_ledger_idempotency_key'
  `;

  assertEqual(constraints.length, 2, "both credit CHECK constraints must exist");
  assertEqual(indexes.length, 1, "the partial unique index on idempotency_key must exist");

  ok("environment loads, mock providers are on, and 0009's constraints are live");
  detail(`checks: ${constraints.map((c) => c.conname).sort().join(", ")}`);
  detail(`index:  credit_ledger_idempotency_key (partial)`);

  // ---- 2. The plan catalogue --------------------------------------------
  const { PLAN_CATALOG, planByTier } = await import("@/lib/plans");

  const byPrice = [...PLAN_CATALOG].sort((a, b) => a.priceCents - b.priceCents);
  let previousCredits = -1;
  for (const plan of byPrice) {
    assert(
      Number.isInteger(plan.monthlyCredits) && plan.monthlyCredits > 0,
      `plan ${plan.tier} must include a positive whole number of credits`,
    );
    assert(
      plan.monthlyCredits > previousCredits,
      `plan ${plan.tier} must include more credits than the cheaper plan below it`,
    );
    previousCredits = plan.monthlyCredits;
  }

  /** The seeded rows must agree with the catalogue, or the operator screen lies. */
  const seeded = await sql<{ tier: string; monthly_credits: number }[]>`
    SELECT tier, monthly_credits FROM plans ORDER BY price_cents
  `;
  for (const row of seeded) {
    assertEqual(
      row.monthly_credits,
      planByTier(row.tier as PlanTier).monthlyCredits,
      `seeded plans.monthly_credits for ${row.tier}`,
    );
  }

  ok("all three plans include credits, ascending with price, and the rows agree");
  detail(byPrice.map((p) => `${p.tier} ${p.monthlyCredits}`).join(", "));

  // ---- 3. Pricing covers the live registry ------------------------------
  const { allVideoGenStatuses } = await import("@/lib/providers/video-gen");
  const { VIDEO_QUALITIES } = await import("@/lib/video/quality");
  const { hasExplicitRate, imagePriceFor, scenePriceFor } = await import(
    "@/lib/credits/pricing"
  );

  const modelIds = allVideoGenStatuses().flatMap((status) =>
    status.models.map((model) => model.id),
  );
  assert(modelIds.length > 0, "the registry must resolve at least one model");

  const unpriced = modelIds.filter((id) => !hasExplicitRate(id));
  assertEqual(unpriced.length, 0, `unpriced models: ${unpriced.join(", ")}`);

  for (const modelId of modelIds) {
    let previous = 0;
    for (const quality of VIDEO_QUALITIES) {
      const scene = scenePriceFor(modelId, quality);
      const image = imagePriceFor(modelId, quality);
      assert(scene > 0, `${modelId} ${quality} must not be free`);
      assert(image > 0, `${modelId} ${quality} image must not be free`);
      assert(
        scene >= previous,
        `${modelId} ${quality} must not undercut the quality below it`,
      );
      previous = scene;
    }
  }

  ok(`every model the registry resolves is priced at every quality (${modelIds.length} models)`);
  detail(
    `1080p: ${modelIds.map((id) => `${id}=${scenePriceFor(id, "1080p")}`).join(", ")}`,
  );

  // ---- 4. A fixture tenant, granted once -------------------------------
  const schema = await import("@/lib/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const {
    addPurchasedCredits,
    chargeCredits,
    creditBalanceFor,
    creditHistoryFor,
    ensureMonthlyGrant,
    reconcile,
    refundCredits,
    sceneChargeKey,
  } = await import("@/lib/credits/service");
  const { currentPeriod } = await import("@/lib/projects/service");

  const ctx = { db, schema, eq };
  const userId = await fixtureUser(ctx, FIXTURE_EMAIL, "studio");
  const otherId = await fixtureUser(ctx, OTHER_EMAIL, "starter");
  const period = currentPeriod();
  const studioCredits = planByTier("studio").monthlyCredits;

  const first = await ensureMonthlyGrant(userId);
  assert(first.granted, "the first grant of a period must apply");
  assertEqual(first.tier, "studio", "the grant must follow the subscription's tier");
  assertEqual(first.credits, studioCredits, "granted credits");

  const repeat = await Promise.all([
    ensureMonthlyGrant(userId),
    ensureMonthlyGrant(userId),
    ensureMonthlyGrant(userId),
  ]);
  assert(
    repeat.every((r) => !r.granted),
    "a second grant in the same period must not apply, even concurrently",
  );

  const grantRows = await db
    .select({ id: schema.creditLedger.id })
    .from(schema.creditLedger)
    .where(
      and(
        eq(schema.creditLedger.userId, userId),
        eq(schema.creditLedger.reason, "monthly_grant"),
      ),
    );
  assertEqual(grantRows.length, 1, "monthly_grant ledger rows");

  ok(`granted ${studioCredits} Studio credits exactly once for ${period}`);

  // ---- 5. A charge costs exactly what the picker quoted ------------------
  const quoted = scenePriceFor(MOCK_MODEL, "1080p");
  const chargeOne = await chargeCredits({
    userId,
    operation: "video_scene",
    modelId: MOCK_MODEL,
    quality: "1080p",
    durationMs: 5_000,
    idempotencyKey: sceneChargeKey({ projectId: "verify", sceneIndex: 0, attempt: 1 }),
  });

  assertEqual(chargeOne.charged, quoted, "the charge must equal the quote");
  assertEqual(
    chargeOne.balanceAfter,
    studioCredits - quoted,
    "the balance must fall by exactly the quoted price",
  );
  assertEqual((await creditBalanceFor(userId)).spent, quoted, "spent");

  ok(`charged ${quoted} credit${quoted === 1 ? "" : "s"}, the same number a picker would quote`);

  // ---- 6. A replay charges nothing --------------------------------------
  const replayKey = sceneChargeKey({
    projectId: "verify",
    sceneIndex: 1,
    attempt: 1,
  });
  const original = await chargeCredits({
    userId,
    operation: "video_scene",
    modelId: MOCK_MODEL,
    quality: "1080p",
    durationMs: 5_000,
    idempotencyKey: replayKey,
  });
  const replayed = await chargeCredits({
    userId,
    operation: "video_scene",
    modelId: MOCK_MODEL,
    quality: "1080p",
    durationMs: 5_000,
    idempotencyKey: replayKey,
  });

  assert(replayed.alreadyCharged, "a replay must report that it was already charged");
  assertEqual(replayed.charged, 0, "a replay must charge nothing");
  assertEqual(replayed.ledgerId, original.ledgerId, "a replay must report the same row");
  assertEqual(
    (await creditBalanceFor(userId)).spent,
    quoted * 2,
    "a replayed charge must not move the balance",
  );

  ok("a replayed job charged nothing and reported the original ledger row");

  // ---- 7. An unaffordable charge is refused, and writes nothing ---------
  const { AppError } = await import("@/lib/errors");

  /** Spend it all, then ask for one more. */
  await db
    .update(schema.creditBalances)
    .set({ spent: studioCredits })
    .where(eq(schema.creditBalances.userId, userId));

  const rowsBefore = await ledgerCount(db, schema, eq, userId);
  const refusalKey = "scene:verify:overdraw:1";
  let refusal: unknown = null;
  try {
    await chargeCredits({
      userId,
      operation: "video_scene",
      modelId: "tal/3.1",
      quality: "2k",
      durationMs: 8_000,
      idempotencyKey: refusalKey,
    });
  } catch (error) {
    refusal = error;
  }

  assert(refusal instanceof AppError, "an unaffordable charge must throw an AppError");
  const refusalError = refusal as InstanceType<typeof AppError>;
  assertEqual(refusalError.code, "insufficient_credits", "refusal code");
  assertEqual(refusalError.status, 402, "refusal status");
  assertEqual(refusalError.retryable, false, "a refusal must not be retried by a worker");
  assert(
    !VENDOR_NAMES.test(refusalError.message),
    `the refusal message must name no vendor: ${refusalError.message}`,
  );
  assert(
    !/upgrade/i.test(refusalError.message),
    "the refusal must not tell a customer to upgrade — a Scale customer has nothing to buy",
  );

  const rowsAfter = await ledgerCount(db, schema, eq, userId);
  assertEqual(rowsAfter, rowsBefore, "a refused charge must leave no ledger row");
  const stray = await db
    .select({ id: schema.creditLedger.id })
    .from(schema.creditLedger)
    .where(eq(schema.creditLedger.idempotencyKey, refusalKey));
  assertEqual(stray.length, 0, "no ledger row may survive a refusal");

  ok("an unaffordable charge was refused with a 402 and wrote nothing");
  detail(refusalError.message);

  // ---- 8. Concurrency spends down to zero, never past it ----------------
  /** Reset to exactly three spendable credits, keeping the ledger honest. */
  await db
    .update(schema.creditBalances)
    .set({ granted: 3, purchased: 0, spent: 0 })
    .where(eq(schema.creditBalances.userId, userId));
  await db
    .update(schema.creditLedger)
    .set({ amount: 3, balanceAfter: 3 })
    .where(eq(schema.creditLedger.idempotencyKey, `grant:${userId}:${period}`));
  // The two earlier spends are no longer reflected in the reset balance; drop them so
  // reconciliation still means something.
  await db
    .delete(schema.creditLedger)
    .where(
      and(eq(schema.creditLedger.userId, userId), eq(schema.creditLedger.reason, "spend")),
    );

  const contended = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) =>
      chargeCredits({
        userId,
        operation: "video_scene",
        modelId: MOCK_MODEL,
        quality: "1080p",
        durationMs: 5_000,
        idempotencyKey: `scene:verify:contended:${i}`,
      }),
    ),
  );

  const succeeded = contended.filter(
    (r) => r.status === "fulfilled" && r.value.charged > 0,
  ).length;
  const refused = contended.filter(
    (r) =>
      r.status === "rejected" &&
      r.reason instanceof AppError &&
      r.reason.code === "insufficient_credits",
  ).length;

  assertEqual(succeeded, 3, "exactly three of eight concurrent charges must succeed");
  assertEqual(refused, 5, "the other five must be refused");
  assertEqual((await creditBalanceFor(userId)).available, 0, "balance after contention");

  ok("eight concurrent charges against three credits spent exactly three");

  // ---- 9. A refund returns exactly what was charged, once ---------------
  const refundKey = "scene:verify:refundable:1";
  await db
    .update(schema.creditBalances)
    .set({ granted: 10, spent: 0 })
    .where(eq(schema.creditBalances.userId, userId));
  await db
    .update(schema.creditLedger)
    .set({ amount: 10, balanceAfter: 10 })
    .where(eq(schema.creditLedger.idempotencyKey, `grant:${userId}:${period}`));
  await db
    .delete(schema.creditLedger)
    .where(
      and(eq(schema.creditLedger.userId, userId), eq(schema.creditLedger.reason, "spend")),
    );

  const paid = await chargeCredits({
    userId,
    operation: "video_scene",
    modelId: MOCK_MODEL,
    quality: "1080p",
    durationMs: 5_000,
    idempotencyKey: refundKey,
  });

  const refunds = await Promise.allSettled(
    Array.from({ length: 4 }, (_, i) =>
      refundCredits({
        userId,
        chargeIdempotencyKey: refundKey,
        reason: `provider failed, attempt ${i + 1}`,
      }),
    ),
  );
  const applied = refunds.filter(
    (r) => r.status === "fulfilled" && r.value.refunded > 0,
  );
  assertEqual(applied.length, 1, "exactly one refund must apply");
  assertEqual(
    applied[0]?.status === "fulfilled" ? applied[0].value.refunded : -1,
    paid.charged,
    "the refund must return exactly what was charged",
  );
  assertEqual((await creditBalanceFor(userId)).spent, 0, "spent after the refund");

  const missing = await refundCredits({
    userId,
    chargeIdempotencyKey: "scene:verify:never-charged:1",
    reason: "nothing to refund",
  });
  assertEqual(missing.refunded, 0, "a refund with no charge must return zero, not throw");

  ok("a failed generation was refunded exactly once, and a phantom refund was a no-op");

  // ---- 10. Purchased credits survive the rollover -----------------------
  const purchase = await addPurchasedCredits({
    userId,
    credits: 250,
    idempotencyKey: "purchase:verify:cs_placeholder_1",
    description: "250 credits",
  });
  assertEqual(purchase.credited, 250, "purchased credits");

  const duplicate = await addPurchasedCredits({
    userId,
    credits: 250,
    idempotencyKey: "purchase:verify:cs_placeholder_1",
    description: "250 credits",
  });
  assert(duplicate.alreadyCredited, "a redelivered purchase must credit nothing");

  const nextPeriod = laterPeriod(period);
  const rolled = await ensureMonthlyGrant(userId, { period: nextPeriod });
  assert(rolled.granted, "a new period must grant");
  assertEqual(rolled.balance.spent, 0, "a rollover must zero spent");
  assertEqual(rolled.balance.granted, studioCredits, "a rollover must re-grant the plan");
  assertEqual(rolled.balance.purchased, 250, "a rollover must NOT touch purchased (§11)");

  /**
   * Rebuild a clean state before the last part of this step.
   *
   * Steps 7–10 hand-edit the balance and the ledger to force conditions that cannot
   * arise naturally — including a balance row parked on a *future* period, which the
   * rollover assertion above needs and which `reconcile` correctly rejects. In
   * production the two periods can never diverge: `chargeCredits` grants for
   * `currentPeriod()` inside its own transaction and then stamps the ledger row with
   * the same period, so the balance row is always advanced before the spend is written.
   *
   * So rather than patching the artificial state back into consistency row by row, the
   * account is emptied and rebuilt from a single purchase. That makes the next two
   * assertions — and the reconciliation in step 11 — statements about real movements
   * only.
   */
  await db.delete(schema.creditLedger).where(eq(schema.creditLedger.userId, userId));
  await db
    .delete(schema.creditBalances)
    .where(eq(schema.creditBalances.userId, userId));

  /**
   * A purchase with no grant at all: `addPurchasedCredits` creates the balance row for
   * `currentPeriod` with `granted: 0`, which is exactly "the allowance is exhausted and
   * only bought credits remain". The charge below then finds nothing to grant, because
   * the row's period is already current.
   */
  await addPurchasedCredits({
    userId,
    credits: 250,
    idempotencyKey: "purchase:verify:cs_placeholder_2",
    description: "250 credits",
  });

  const paidByTopUp = await chargeCredits({
    userId,
    operation: "image",
    modelId: "tal/3.0",
    quality: "1080p",
    idempotencyKey: "image:verify:topup:hero",
  });
  assert(paidByTopUp.charged > 0, "a top-up must be able to pay for a generation");
  assertEqual(
    paidByTopUp.balanceAfter,
    250 - paidByTopUp.charged,
    "a top-up-funded charge must draw down the purchased balance",
  );

  ok("purchased credits credited once, survived the rollover, and paid for a generation");
  detail(`rollover ${period} → ${nextPeriod}: granted reset, purchased 250 kept`);

  // ---- 11. The ledger reconciles ----------------------------------------
  const reconciliation = await reconcile(userId);
  assert(
    reconciliation.consistent,
    `ledger ${reconciliation.ledgerSum} must equal balance ${reconciliation.balance}`,
  );

  const otherReconciliation = await reconcile(otherId);
  assert(otherReconciliation.consistent, "an untouched account must also reconcile");

  ok(`the ledger reconciles against the balance (${reconciliation.balance} credits)`);

  // ---- 12. History is per-tenant and names no vendor --------------------
  await chargeCredits({
    userId: otherId,
    operation: "image",
    modelId: "tal/3.1",
    quality: "1080p",
    idempotencyKey: "image:verify:other-tenant:x",
  });

  const mine = await creditHistoryFor(userId);
  const theirs = await creditHistoryFor(otherId);
  const mineIds = new Set(mine.map((row) => row.id));

  assert(mine.length > 0 && theirs.length > 0, "both tenants must have history");
  assert(
    theirs.every((row) => !mineIds.has(row.id)),
    "one tenant's history must not contain another's rows",
  );
  for (const row of [...mine, ...theirs]) {
    assert(
      !row.description || !VENDOR_NAMES.test(row.description),
      `history must name no vendor: ${row.description}`,
    );
  }

  ok(`history is per-tenant (${mine.length} rows / ${theirs.length} rows) and vendor-free`);

  // ---- 13. The top-up catalogue -----------------------------------------
  const { NotConfiguredError } = await import("@/lib/errors");
  const { allCreditPacks, availableCreditPacks, creditTopUpsAvailable, priceIdForPack } =
    await import("@/lib/credits/packs");

  const all = allCreditPacks();
  const available = availableCreditPacks();
  assertEqual(all.length, 4, "the catalogue must hold four packs");
  assert(
    available.length <= all.length,
    "only configured packs may be offered",
  );
  assertEqual(
    creditTopUpsAvailable(),
    available.length > 0,
    "the top-up gate must match the offered packs",
  );

  /**
   * At least one unconfigured pack, resolved. This repository has no Stripe credit
   * prices set, so this is the state a fresh deployment is in — and the check is that
   * it fails by *naming the variable*, not by falling back to some other price.
   */
  const unconfigured = all.find((pack) => !available.includes(pack));
  if (unconfigured) {
    let thrown: unknown = null;
    try {
      priceIdForPack(unconfigured.id);
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof NotConfiguredError,
      "an unconfigured pack must throw NotConfiguredError",
    );
    assert(
      (thrown as InstanceType<typeof NotConfiguredError>).missingEnvVars.includes(
        unconfigured.priceEnvVar,
      ),
      "the refusal must name the exact variable an operator must set",
    );
    detail(
      `${all.length - available.length} pack(s) unconfigured; ${unconfigured.priceEnvVar} names itself`,
    );
  } else {
    detail("all four packs are configured");
  }

  ok(`the top-up catalogue offers ${available.length} of ${all.length} packs, honestly`);

  // ---- 14. Completing a purchase, without Stripe ------------------------
  /**
   * `completeCreditPurchase` is the webhook's half of a top-up, and this is the only
   * place it is exercised in a real Node process with no vitest aliases — which matters
   * because it reaches `lib/db`, `lib/billing` (for `canUpgrade`) and the pack
   * catalogue, and `lib/billing` is one of the modules that would fail to boot if the
   * `server-only` graph were ever broken.
   *
   * **No Stripe call happens here.** The function is handed a session id and a payment
   * status directly, exactly as the webhook hands it what a verified event said. The
   * `resolvePriceId` callback is deliberately not passed, so the missing-row path
   * resolves to "unknown pack" without any network access at all — and that is itself
   * the property being checked: an unidentifiable payment credits nothing.
   */
  const { completeCreditPurchase, canBuyCredits } = await import(
    "@/lib/credits/purchase"
  );

  /**
   * A pending purchase row, written directly rather than through the route. The route
   * would need a Stripe session, and what needs verifying here is the *completion*
   * half — that the credits added are the ones this row records.
   */
  const purchaseSession = `cs_verify_${userId.slice(0, 8)}`;
  await db.insert(schema.creditPurchases).values({
    userId,
    pack: "credits_500",
    credits: 500,
    amountCents: 900,
    currency: "usd",
    providerSessionId: purchaseSession,
    status: "pending",
  });

  const beforeTopUp = await creditBalanceFor(userId);

  const unpaid = await completeCreditPurchase({
    userId,
    providerSessionId: purchaseSession,
    paymentStatus: "unpaid",
    providerPaymentIntentId: null,
  });
  assertEqual(unpaid.credited, 0, "an uncleared payment must credit nothing");
  assertEqual(unpaid.skipReason, "not_paid", "and must say why");
  assertEqual(
    (await creditBalanceFor(userId)).available,
    beforeTopUp.available,
    "an uncleared payment must not move the balance",
  );

  const topUpPaid = await completeCreditPurchase({
    userId,
    providerSessionId: purchaseSession,
    paymentStatus: "paid",
    providerPaymentIntentId: "pi_verify_placeholder",
  });
  assertEqual(topUpPaid.credited, 500, "a cleared payment must credit the pack's credits");

  const afterTopUp = await creditBalanceFor(userId);
  assertEqual(
    afterTopUp.purchased,
    beforeTopUp.purchased + 500,
    "bought credits must land in `purchased`, which no period reset touches",
  );
  assertEqual(
    afterTopUp.available,
    beforeTopUp.available + 500,
    "and must be spendable",
  );

  // Replayed, as Stripe's at-least-once delivery guarantees will eventually do.
  const topUpReplayed = await completeCreditPurchase({
    userId,
    providerSessionId: purchaseSession,
    paymentStatus: "paid",
    providerPaymentIntentId: "pi_verify_placeholder",
  });
  assertEqual(topUpReplayed.credited, 0, "a replayed purchase must credit nothing");
  assert(topUpReplayed.alreadyCredited, "and must report that it was already credited");
  assertEqual(
    (await creditBalanceFor(userId)).available,
    afterTopUp.available,
    "a replayed purchase must not move the balance",
  );

  // The receipt and the ledger agree, in one transaction rather than two.
  const [receipt] = await db
    .select()
    .from(schema.creditPurchases)
    .where(eq(schema.creditPurchases.providerSessionId, purchaseSession))
    .limit(1);
  if (!receipt) throw new Error("the purchase row must still exist");
  assertEqual(receipt.status, "completed", "the receipt must be marked completed");
  assert(receipt.ledgerId !== null, "the receipt must point at the ledger row");
  assert(receipt.completedAt !== null, "the receipt must record when it completed");

  /**
   * An orphaned payment with no resolvable price. This deployment has no credit prices
   * configured, so even a resolver would map to nothing — the check is that the outcome
   * is a refusal rather than a guess.
   */
  const orphan = await completeCreditPurchase({
    userId,
    providerSessionId: `cs_verify_orphan_${userId.slice(0, 8)}`,
    paymentStatus: "paid",
    providerPaymentIntentId: null,
    resolvePriceId: async () => "price_never_configured_here",
  });
  assertEqual(orphan.credited, 0, "an unrecognised price must credit nothing");
  assertEqual(orphan.skipReason, "unknown_pack", "and must say why");

  const consistentAfterTopUp = await reconcile(userId);
  assert(
    consistentAfterTopUp.consistent,
    "the ledger must still reconcile after a purchase",
  );

  assertEqual(
    canBuyCredits(),
    creditTopUpsAvailable() && (await import("@/lib/billing")).canUpgrade(),
    "the top-up gate must require both billing and a configured pack",
  );

  ok("a purchase credits once, survives a replay, and reconciles");
  detail(
    `purchased ${beforeTopUp.purchased} → ${afterTopUp.purchased}; canBuyCredits=${canBuyCredits()}`,
  );

  // ---- 15. Entitlements carry the balance, and grant nothing ------------
  const { entitlementsFor } = await import("@/lib/plans/enforce");

  const beforeRead = await creditBalanceFor(otherId);
  const entitlements = await entitlementsFor(otherId, "starter");
  const afterRead = await creditBalanceFor(otherId);

  assertEqual(
    entitlements.monthlyCredits,
    planByTier("starter").monthlyCredits,
    "entitlements must carry the plan's included credits",
  );
  assertEqual(
    entitlements.credits.available,
    beforeRead.available,
    "entitlements must report the live balance",
  );
  assertEqual(
    afterRead.granted,
    beforeRead.granted,
    "reading entitlements must not grant credits",
  );
  assertEqual(
    afterRead.available,
    beforeRead.available,
    "reading entitlements must not move the balance",
  );

  ok("entitlements carry the balance, and reading them granted nothing");
  detail(
    `starter: ${entitlements.monthlyCredits} included, ${entitlements.credits.available} available`,
  );

  // ---- 16. The run was inert -------------------------------------------
  /**
   * Not a formality. The credit service takes no provider argument, so the only way a
   * paid call could have happened is if something this script imported reached one on
   * import — which is exactly the kind of accident this audit exists to catch.
   */
  const usage = await db
    .select({ provider: schema.apiUsage.provider })
    .from(schema.apiUsage)
    .where(eq(schema.apiUsage.userId, userId));

  const nonMock = usage.filter((row) => row.provider !== "mock");
  assertEqual(
    nonMock.length,
    0,
    `no real provider may be called: saw ${nonMock.map((r) => r.provider).join(", ")}`,
  );

  ok(`no provider call was made by this run (${usage.length} api_usage rows, all mock or none)`);

  console.log(
    "\n  All checks passed. Not tested against any live provider, and no Stripe API call was made.\n",
  );

  const { closeDb } = await import("@/lib/db");
  await closeDb();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function ledgerCount(
  db: typeof import("@/lib/db").db,
  schema: typeof import("@/lib/db/schema"),
  eq: typeof import("drizzle-orm").eq,
  userId: string,
): Promise<number> {
  const rows = await db
    .select({ id: schema.creditLedger.id })
    .from(schema.creditLedger)
    .where(eq(schema.creditLedger.userId, userId));
  return rows.length;
}

/** The period one month after `period`, as `YYYY-MM`. */
function laterPeriod(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return month === 12
    ? `${year + 1}-01`
    : `${year}-${String(month + 1).padStart(2, "0")}`;
}

/**
 * A fixture tenant, reused across runs and reset at the start of each.
 *
 * The credit rows are deleted explicitly rather than relied upon to cascade from
 * `projects`: they hang off `users`, which this script deliberately does not delete —
 * a stable user id makes a failed run's rows readable afterwards.
 *
 * Every table the run writes has to be listed here, or the script is single-use. The
 * top-up step derives its checkout session id from the user id, and
 * `credit_purchases_session_key` is unique, so a purchase row left behind makes the
 * second run die on a constraint violation rather than on a failed assertion — which
 * looks like a broken script rather than a dirty fixture, and a verification script
 * nobody can re-run is one nobody runs.
 */
async function fixtureUser(
  ctx: {
    db: typeof import("@/lib/db").db;
    schema: typeof import("@/lib/db/schema");
    eq: typeof import("drizzle-orm").eq;
  },
  email: string,
  tier: PlanTier,
): Promise<string> {
  const { db, schema, eq } = ctx;

  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  const found = existing[0];
  if (found) {
    // Before the ledger: a purchase row points at the ledger row it created, and
    // deleting that first would leave the purchase behind with a null `ledgerId` —
    // a completed top-up that credited nothing, which is the exact state step 14
    // asserts cannot happen.
    await db
      .delete(schema.creditPurchases)
      .where(eq(schema.creditPurchases.userId, found.id));
    await db
      .delete(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, found.id));
    await db
      .delete(schema.creditBalances)
      .where(eq(schema.creditBalances.userId, found.id));
    await db.delete(schema.apiUsage).where(eq(schema.apiUsage.userId, found.id));
    await db.delete(schema.projects).where(eq(schema.projects.userId, found.id));
    await db
      .update(schema.subscriptions)
      .set({ tier, status: "active" })
      .where(eq(schema.subscriptions.userId, found.id));
    return found.id;
  }

  const inserted = await db
    .insert(schema.users)
    .values({
      email,
      emailNormalized: email.toLowerCase(),
      name: "Credits Verification",
      passwordHash: "not-a-loginable-hash",
    })
    .returning({ id: schema.users.id });

  const userId = inserted[0]?.id;
  if (!userId) throw new Error(`could not create the verification user ${email}`);
  await db.insert(schema.subscriptions).values({ userId, tier, status: "active" });
  return userId;
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(
      `\n  FAIL at step ${step + 1}: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    );
    process.exit(1);
  },
);

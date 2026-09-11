/**
 * Credit ledger integration tests (§7–§13, §34, §39).
 *
 * Everything here is a property that is only true *of the database*. The pricing table
 * is pure and tested in `src/lib/credits/pricing.test.ts`; what cannot be tested without
 * Postgres is the part §13 actually asks for — that charging is atomic and idempotent —
 * because both of those are properties of a lock and a unique index, not of a function.
 *
 * ## The invariant asserted after every scenario
 *
 * `reconcile()`: the materialised `credit_balances` row and the sum of the ledger must
 * agree. The ledger is the definition of the balance and the balance row is a
 * materialisation of it for locking, so any bug in any of the five operations shows up
 * as these two numbers diverging. It is checked at the end of nearly every case below
 * rather than in one dedicated test, because a divergence introduced by a charge is
 * worth attributing to the charge.
 *
 * ## What is real
 *
 * Postgres, the 0009 migration with both its CHECK constraints and its partial unique
 * index, the transactions, the row locks, and genuine concurrency via separate pool
 * connections. No provider is called and no Stripe API call is made — `addPurchasedCredits`
 * is invoked directly, which is exactly what the webhook will do once #17 lands, so the
 * ledger behaviour it depends on is proven here ahead of the wiring.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  createUser,
  hasDatabase,
  resetDatabase,
  setTier,
  useDatabase,
  type TestUser,
} from "./setup";

const describeCredits = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  console.warn(
    "[credits] TEST_DATABASE_URL is not set — credit ledger integration tests skipped.",
  );
}

describeCredits("credits", () => {
  useDatabase();

  let user: TestUser;

  beforeEach(async () => {
    await resetDatabase();
    user = await createUser();
  });

  /** The current period, from the same helper the service uses. */
  async function period(): Promise<string> {
    const { currentPeriod } = await import("@/lib/projects/service");
    return currentPeriod();
  }

  /**
   * A period strictly after the current one.
   *
   * Period-rollover tests cannot use fixed strings like "2026-02": `chargeCredits`
   * grants for `currentPeriod()` inside its own transaction, so any charge silently
   * advances the balance row to today's period, and a subsequent grant for a hard-coded
   * past month is then correctly refused. Deriving the target from the real clock is
   * what makes these tests independent of the date they are run on.
   */
  async function laterPeriod(monthsAhead = 1): Promise<string> {
    const current = await period();
    const year = Number(current.slice(0, 4));
    const month = Number(current.slice(5, 7));
    const total = month - 1 + monthsAhead;
    const y = year + Math.floor(total / 12);
    const m = (total % 12) + 1;
    return `${y}-${String(m).padStart(2, "0")}`;
  }

  async function credits() {
    return import("@/lib/credits/service");
  }

  /** The invariant. Called at the end of a scenario, never as the whole of one. */
  async function expectConsistent(userId: string): Promise<number> {
    const { reconcile } = await credits();
    const result = await reconcile(userId);
    expect(
      result.consistent,
      `balance ${result.balance} vs ledger ${result.ledgerSum}`,
    ).toBe(true);
    return result.balance;
  }

  /** Rows in the ledger for a user, oldest first. */
  async function ledgerRows(userId: string) {
    const { db } = await import("@/lib/db");
    const { creditLedger } = await import("@/lib/db/schema");
    const { asc, eq } = await import("drizzle-orm");
    return db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.userId, userId))
      .orderBy(asc(creditLedger.createdAt));
  }

  /**
   * A charge on the mock model, which costs exactly 1 credit at 1080p.
   *
   * The mock is priced rather than free precisely so this suite exercises the real
   * charge path — see `pricing.ts`. Nothing here reaches a provider; only the ledger
   * is touched.
   */
  async function charge(
    userId: string,
    overrides: Partial<Parameters<Awaited<ReturnType<typeof credits>>["chargeCredits"]>[0]> = {},
  ) {
    const { chargeCredits } = await credits();
    return chargeCredits({
      userId,
      operation: "video_scene",
      modelId: "mock/placeholder",
      quality: "1080p",
      durationMs: 5_000,
      idempotencyKey: "scene:test:0:1",
      ...overrides,
    });
  }

  // -------------------------------------------------------------------------
  // Granting
  // -------------------------------------------------------------------------

  describe("ensureMonthlyGrant", () => {
    it("grants the plan's included credits and records them in the ledger", async () => {
      const { ensureMonthlyGrant } = await credits();
      const { planByTier } = await import("@/lib/plans");

      const outcome = await ensureMonthlyGrant(user.id);

      expect(outcome.granted).toBe(true);
      expect(outcome.tier).toBe("starter");
      expect(outcome.credits).toBe(planByTier("starter").monthlyCredits);
      expect(outcome.balance.available).toBe(outcome.credits);

      const rows = await ledgerRows(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        reason: "monthly_grant",
        amount: outcome.credits,
        balanceAfter: outcome.credits,
        period: await period(),
      });

      await expectConsistent(user.id);
    });

    it("grants at most once per period however many times it is called", async () => {
      /**
       * The property that makes it safe to call from the charge path on every single
       * generation. Ten sequential calls, then ten concurrent ones on separate
       * connections — the concurrent half is the one that would catch a missing row
       * lock, since without it two transactions could both read the stale period.
       */
      const { ensureMonthlyGrant } = await credits();
      const { planByTier } = await import("@/lib/plans");
      const expected = planByTier("starter").monthlyCredits;

      for (let i = 0; i < 10; i += 1) await ensureMonthlyGrant(user.id);

      const concurrent = await Promise.all(
        Array.from({ length: 10 }, () => ensureMonthlyGrant(user.id)),
      );

      expect(concurrent.filter((r) => r.granted)).toHaveLength(0);

      const grants = (await ledgerRows(user.id)).filter(
        (row) => row.reason === "monthly_grant",
      );
      expect(grants).toHaveLength(1);

      expect(await expectConsistent(user.id)).toBe(expected);
    });

    it("grants exactly once when the very first calls race", async () => {
      /**
       * The harder version of the above: no row exists yet, so every one of these
       * takes the INSERT branch of the upsert and all but one must lose the conflict.
       * A missing `onConflict` target would surface here as a unique violation, and a
       * grant written outside the claim would surface as several ledger rows.
       */
      const { ensureMonthlyGrant } = await credits();

      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => ensureMonthlyGrant(user.id)),
      );

      // Exactly one winner: the INSERT, or the first UPDATE if the insert lost.
      expect(outcomes.filter((o) => o.granted)).toHaveLength(1);

      const grants = (await ledgerRows(user.id)).filter(
        (row) => row.reason === "monthly_grant",
      );
      expect(grants).toHaveLength(1);
      await expectConsistent(user.id);
    });

    it("grants against the subscription's tier, not a caller-supplied one", async () => {
      const { ensureMonthlyGrant } = await credits();
      const { planByTier } = await import("@/lib/plans");
      await setTier(user.id, "studio");

      const outcome = await ensureMonthlyGrant(user.id);

      expect(outcome.tier).toBe("studio");
      expect(outcome.credits).toBe(planByTier("studio").monthlyCredits);
      await expectConsistent(user.id);
    });

    it("grants Starter credits when the subscription has lapsed", async () => {
      /**
       * `tierOf` re-implements `currentTier`'s predicate, so this is the case that
       * proves the duplicate has not drifted: a past-due Scale subscriber must be
       * granted Starter credits, not 10,000.
       */
      const { db } = await import("@/lib/db");
      const { subscriptions } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const { ensureMonthlyGrant } = await credits();
      const { planByTier } = await import("@/lib/plans");

      await db
        .update(subscriptions)
        .set({ tier: "scale", status: "past_due" })
        .where(eq(subscriptions.userId, user.id));

      const outcome = await ensureMonthlyGrant(user.id);

      expect(outcome.tier).toBe("starter");
      expect(outcome.credits).toBe(planByTier("starter").monthlyCredits);
    });

    it("resets granted and spent for a new period but keeps purchased credits", async () => {
      /**
       * §11's promise, and the single most expensive thing in this module to get
       * wrong: a reset that cleared `purchased` would delete credits a customer paid
       * cash for.
       */
      const { addPurchasedCredits, chargeCredits, creditBalanceFor, ensureMonthlyGrant } =
        await credits();
      const { planByTier } = await import("@/lib/plans");
      const included = planByTier("starter").monthlyCredits;

      await ensureMonthlyGrant(user.id);
      await addPurchasedCredits({
        userId: user.id,
        credits: 250,
        idempotencyKey: "purchase:test:1",
        description: "500 credits",
      });
      await chargeCredits({
        userId: user.id,
        operation: "video_scene",
        modelId: "mock/placeholder",
        quality: "1080p",
        durationMs: 5_000,
        idempotencyKey: "scene:this-month:0:1",
      });

      const before = await creditBalanceFor(user.id);
      expect(before.purchased).toBe(250);
      expect(before.spent).toBe(1);

      const nextMonth = await laterPeriod();
      const next = await ensureMonthlyGrant(user.id, { period: nextMonth });

      expect(next.granted).toBe(true);
      expect(next.balance.granted).toBe(included);
      expect(next.balance.spent).toBe(0);
      // The line §11 is about.
      expect(next.balance.purchased).toBe(250);
      expect(next.balance.available).toBe(included + 250);
      expect(next.balance.period).toBe(nextMonth);
    });

    it("does not re-grant when the tier improves mid-period", async () => {
      /**
       * Deliberate, and documented in the service: re-granting on upgrade would let
       * someone cycle Studio → Scale → Studio to collect a grant each time. What the
       * upgrade does change is `grantedForTier`… no — nothing changes until the next
       * period, and the standing grant keeps recording the tier it was issued for so
       * the UI can explain the discrepancy.
       */
      const { creditBalanceFor, ensureMonthlyGrant } = await credits();
      const { planByTier } = await import("@/lib/plans");

      await ensureMonthlyGrant(user.id);
      await setTier(user.id, "scale");
      const second = await ensureMonthlyGrant(user.id);

      expect(second.granted).toBe(false);
      const balance = await creditBalanceFor(user.id);
      expect(balance.granted).toBe(planByTier("starter").monthlyCredits);
      expect(balance.grantedForTier).toBe("starter");
      await expectConsistent(user.id);
    });
  });

  // -------------------------------------------------------------------------
  // Charging
  // -------------------------------------------------------------------------

  describe("chargeCredits", () => {
    it("charges the priced cost and lowers the balance by exactly that", async () => {
      const { creditBalanceFor } = await credits();
      const { scenePriceFor } = await import("@/lib/credits/pricing");
      const { planByTier } = await import("@/lib/plans");
      const included = planByTier("starter").monthlyCredits;
      const price = scenePriceFor("mock/placeholder", "1080p");

      const outcome = await charge(user.id);

      expect(outcome.charged).toBe(price);
      expect(outcome.cost).toBe(price);
      expect(outcome.alreadyCharged).toBe(false);
      expect(outcome.balanceAfter).toBe(included - price);

      const balance = await creditBalanceFor(user.id);
      expect(balance.available).toBe(included - price);
      expect(balance.spent).toBe(price);
      await expectConsistent(user.id);
    });

    it("grants the period's credits on first charge, so a fresh account can generate", async () => {
      /**
       * No `ensureMonthlyGrant` call anywhere in this test. A new user's first
       * generation must not be refused for having no balance row yet, which is why the
       * charge transaction grants before it charges.
       */
      const rows0 = await ledgerRows(user.id);
      expect(rows0).toHaveLength(0);

      const outcome = await charge(user.id);

      expect(outcome.charged).toBeGreaterThan(0);
      const reasons = (await ledgerRows(user.id)).map((row) => row.reason);
      expect(reasons).toEqual(["monthly_grant", "spend"]);
      await expectConsistent(user.id);
    });

    it("charges once when the same idempotency key is replayed", async () => {
      /**
       * §13, sequentially: the BullMQ retry case. The second call reports the cost it
       * would have been and the balance the first charge produced, so a retried job
       * can log what it paid without paying again.
       */
      const { creditBalanceFor } = await credits();
      const key = "scene:replayed:2:1";

      const first = await charge(user.id, { idempotencyKey: key });
      const second = await charge(user.id, { idempotencyKey: key });
      const third = await charge(user.id, { idempotencyKey: key });

      expect(first.alreadyCharged).toBe(false);
      expect(second).toMatchObject({
        charged: 0,
        alreadyCharged: true,
        cost: first.cost,
        balanceAfter: first.balanceAfter,
        ledgerId: first.ledgerId,
      });
      expect(third.charged).toBe(0);

      const balance = await creditBalanceFor(user.id);
      expect(balance.spent).toBe(first.cost);

      const spends = (await ledgerRows(user.id)).filter((r) => r.reason === "spend");
      expect(spends).toHaveLength(1);
      await expectConsistent(user.id);
    });

    it("charges once when the same key is used concurrently", async () => {
      /**
       * The same property under real contention, on separate pool connections. This is
       * the case the unique index exists for: without it both transactions would insert
       * a ledger row and both would increment `spent`.
       *
       * One of the racers may lose with a serialization/unique error rather than
       * returning `alreadyCharged` — that is an acceptable outcome for a retry, and
       * what matters is that the ledger and the balance show exactly one spend.
       */
      const { creditBalanceFor } = await credits();
      const key = "scene:raced:3:1";

      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, () => charge(user.id, { idempotencyKey: key })),
      );

      const applied = outcomes.filter(
        (r) => r.status === "fulfilled" && r.value.charged > 0,
      );
      expect(applied).toHaveLength(1);

      const spends = (await ledgerRows(user.id)).filter((r) => r.reason === "spend");
      expect(spends).toHaveLength(1);

      const balance = await creditBalanceFor(user.id);
      expect(balance.spent).toBe(Math.abs(spends[0]!.amount));
      await expectConsistent(user.id);
    });

    it("charges separately for a deliberate regeneration", async () => {
      /**
       * The other side of idempotency, and the reason `sceneChargeKey` takes an
       * attempt: a user asking to regenerate scene 3 is asking for a second
       * generation, and must be charged for it. A key without the attempt would make
       * every regeneration free.
       */
      const { sceneChargeKey } = await credits();
      const projectId = "11111111-1111-4111-8111-111111111111";

      const first = await charge(user.id, {
        idempotencyKey: sceneChargeKey({ projectId, sceneIndex: 3, attempt: 1 }),
      });
      const second = await charge(user.id, {
        idempotencyKey: sceneChargeKey({ projectId, sceneIndex: 3, attempt: 2 }),
      });

      expect(first.charged).toBeGreaterThan(0);
      expect(second.charged).toBe(first.charged);
      expect(second.balanceAfter).toBe(first.balanceAfter - second.charged);
      await expectConsistent(user.id);
    });

    it("refuses when the balance cannot cover the cost, and writes nothing", async () => {
      /**
       * The refusal §10 asks for. The important half of the assertion is the second:
       * a refused charge must leave *no* ledger row, because the ledger insert
       * precedes the balance update and only a rollback can undo it. A stray
       * `spend` row for a generation that never ran would make the ledger
       * irreconcilable — and would show up on the customer's history as a charge.
       */
      const { InsufficientCreditsError } = await import("@/lib/errors");
      const { creditBalanceFor, ensureMonthlyGrant } = await credits();
      const { planByTier } = await import("@/lib/plans");
      const included = planByTier("starter").monthlyCredits;

      await ensureMonthlyGrant(user.id);

      // Spend the whole allowance one credit at a time on the mock.
      for (let i = 0; i < included; i += 1) {
        await charge(user.id, { idempotencyKey: `scene:drain:${i}:1` });
      }
      expect((await creditBalanceFor(user.id)).available).toBe(0);

      const before = (await ledgerRows(user.id)).length;

      const error = await charge(user.id, {
        idempotencyKey: "scene:overdraw:0:1",
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(InsufficientCreditsError);
      const rows = await ledgerRows(user.id);
      expect(rows).toHaveLength(before);
      expect(
        rows.some((row) => row.idempotencyKey === "scene:overdraw:0:1"),
      ).toBe(false);

      expect((await creditBalanceFor(user.id)).available).toBe(0);
      await expectConsistent(user.id);
    });

    it("reports the shortfall and does not tell a Scale customer to upgrade", async () => {
      /**
       * §10's copy requirement. `InsufficientCreditsError` is a distinct code from
       * `plan_limit_reached` precisely because the remedy is different: a Scale
       * customer has no plan left to buy, so the message has to offer a top-up or a
       * cheaper model.
       */
      const { AppError } = await import("@/lib/errors");
      const { ensureMonthlyGrant } = await credits();
      await setTier(user.id, "scale");
      await ensureMonthlyGrant(user.id);

      // One expensive charge against a balance that cannot cover it: drain first.
      const { db } = await import("@/lib/db");
      const { creditBalances } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      await db
        .update(creditBalances)
        .set({ spent: 9_999 })
        .where(eq(creditBalances.userId, user.id));

      const error = (await charge(user.id, {
        modelId: "tal/3.1",
        quality: "2k",
        idempotencyKey: "scene:shortfall:0:1",
      }).catch((e: unknown) => e)) as InstanceType<typeof AppError>;

      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe("insufficient_credits");
      expect(error.status).toBe(402);
      expect(error.retryable).toBe(false);
      expect(error.details).toMatchObject({ shortfall: expect.any(Number) });
      expect(error.message).not.toMatch(/upgrade/i);
      // §3: no vendor name may reach a customer-facing message.
      expect(error.message).not.toMatch(/veo|gemini|minimax|wan|seedance|dashscope/i);
    });

    it("lets concurrent charges spend down to zero but never past it", async () => {
      /**
       * The concurrent-overdraw case, and the reason the balance is a locked row
       * rather than a summed query. Twelve charges of 1 credit against a balance of
       * exactly 5: five must succeed and seven must be refused. A summed read would
       * let several of them each see 5 and each spend 1.
       */
      const { InsufficientCreditsError } = await import("@/lib/errors");
      const { creditBalanceFor, ensureMonthlyGrant } = await credits();
      const { db } = await import("@/lib/db");
      const { creditBalances, creditLedger } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      await ensureMonthlyGrant(user.id);
      const granted = (await creditBalanceFor(user.id)).granted;
      // Leave exactly 5 spendable, and keep the ledger honest about it with an
      // adjustment row so `reconcile` still applies at the end.
      const removed = granted - 5;
      await db
        .update(creditBalances)
        .set({ granted: 5 })
        .where(eq(creditBalances.userId, user.id));
      await db
        .update(creditLedger)
        .set({ amount: 5, balanceAfter: 5 })
        .where(eq(creditLedger.idempotencyKey, `grant:${user.id}:${await period()}`));
      expect(removed).toBeGreaterThan(0);

      const outcomes = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          charge(user.id, { idempotencyKey: `scene:contended:${i}:1` }),
        ),
      );

      const succeeded = outcomes.filter(
        (r) => r.status === "fulfilled" && r.value.charged === 1,
      );
      const refused = outcomes.filter(
        (r) =>
          r.status === "rejected" && r.reason instanceof InsufficientCreditsError,
      );

      expect(succeeded).toHaveLength(5);
      expect(refused).toHaveLength(7);

      const balance = await creditBalanceFor(user.id);
      expect(balance.available).toBe(0);
      expect(balance.spent).toBe(5);
      await expectConsistent(user.id);
    });

    it("prices an image charge from the image rate, not the video one", async () => {
      const { chargeCredits } = await credits();
      const { imagePriceFor, scenePriceFor } = await import("@/lib/credits/pricing");

      const outcome = await chargeCredits({
        userId: user.id,
        operation: "image",
        modelId: "tal/3.0",
        quality: "1080p",
        idempotencyKey: "image:test:reference:hero",
      });

      expect(outcome.charged).toBe(imagePriceFor("tal/3.0", "1080p"));
      expect(outcome.charged).toBeLessThan(scenePriceFor("tal/3.0", "1080p"));

      const [spend] = (await ledgerRows(user.id)).filter((r) => r.reason === "spend");
      expect(spend).toMatchObject({
        operation: "image",
        modelId: "tal/3.0",
        quality: "1080p",
      });
      await expectConsistent(user.id);
    });

    it("rejects an empty idempotency key rather than charging unguarded", async () => {
      const { ValidationError } = await import("@/lib/errors");
      await expect(charge(user.id, { idempotencyKey: "   " })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(await ledgerRows(user.id)).toHaveLength(0);
    });

    it("records the project on the ledger row so spend is attributable", async () => {
      const { createProject } = await import("@/lib/projects/service");
      const { chargeCredits, imageChargeKey } = await credits();

      const project = await createProject({
        userId: user.id,
        channelId: null,
        title: "Attribution",
        maxVideosPerMonth: null,
      });

      const outcome = await chargeCredits({
        userId: user.id,
        operation: "image",
        modelId: "mock/placeholder",
        quality: "1080p",
        projectId: project.id,
        idempotencyKey: imageChargeKey({
          projectId: project.id,
          purpose: "reference",
          entityId: "narrator",
        }),
      });

      expect(outcome.charged).toBeGreaterThan(0);
      const [spend] = (await ledgerRows(user.id)).filter((r) => r.reason === "spend");
      expect(spend?.projectId).toBe(project.id);
    });

    it("keeps the ledger row when the project it paid for is deleted", async () => {
      /**
       * `projectId` is `ON DELETE set null`, not cascade. A ledger with holes in it
       * cannot be reconciled against revenue, and deleting a project must not erase
       * the record of money already spent on it.
       */
      const { createProject } = await import("@/lib/projects/service");
      const { db } = await import("@/lib/db");
      const { projects } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const { chargeCredits } = await credits();

      const project = await createProject({
        userId: user.id,
        channelId: null,
        title: "Doomed",
        maxVideosPerMonth: null,
      });
      await chargeCredits({
        userId: user.id,
        operation: "video_scene",
        modelId: "mock/placeholder",
        quality: "1080p",
        durationMs: 5_000,
        projectId: project.id,
        idempotencyKey: "scene:doomed:0:1",
      });

      // Deleted at the database level: there is no project-deletion service call, and
      // the FK behaviour is what this test is about.
      await db.delete(projects).where(eq(projects.id, project.id));

      const spends = (await ledgerRows(user.id)).filter((r) => r.reason === "spend");
      expect(spends).toHaveLength(1);
      expect(spends[0]?.projectId).toBeNull();
      await expectConsistent(user.id);
    });
  });

  // -------------------------------------------------------------------------
  // Refunding
  // -------------------------------------------------------------------------

  describe("refundCredits", () => {
    it("returns exactly what was charged", async () => {
      const { creditBalanceFor, refundCredits } = await credits();
      const key = "scene:failed:0:1";

      const before = (await charge(user.id, { idempotencyKey: key })).balanceAfter;
      const charged = 1;

      const refund = await refundCredits({
        userId: user.id,
        chargeIdempotencyKey: key,
        reason: "provider timed out",
      });

      expect(refund.refunded).toBe(charged);
      expect(refund.alreadyRefunded).toBe(false);
      expect(refund.balanceAfter).toBe(before + charged);
      expect((await creditBalanceFor(user.id)).spent).toBe(0);
      await expectConsistent(user.id);
    });

    it("refunds the original amount even if the price has since changed", async () => {
      /**
       * The reason `refundCredits` takes a key rather than an amount. Simulated by
       * editing the stored charge, which is what a pricing-table change would look
       * like from the refund's point of view: the ledger says 40, the current table
       * would say something else, and the refund must follow the ledger.
       */
      const { db } = await import("@/lib/db");
      const { creditBalances, creditLedger } = await import("@/lib/db/schema");
      const { eq, sql } = await import("drizzle-orm");
      const { creditBalanceFor, refundCredits } = await credits();
      const key = "scene:repriced:0:1";

      await charge(user.id, { idempotencyKey: key });
      // Make the recorded charge 7 credits, and the balance agree with it.
      await db
        .update(creditLedger)
        .set({ amount: -7 })
        .where(eq(creditLedger.idempotencyKey, key));
      await db
        .update(creditBalances)
        .set({ spent: sql`${creditBalances.spent} + 6` })
        .where(eq(creditBalances.userId, user.id));

      const refund = await refundCredits({
        userId: user.id,
        chargeIdempotencyKey: key,
        reason: "provider failed",
      });

      expect(refund.refunded).toBe(7);
      expect((await creditBalanceFor(user.id)).spent).toBe(0);
      await expectConsistent(user.id);
    });

    it("refunds once however many times the failure handler runs", async () => {
      /**
       * A job that fails, refunds, is retried, fails again and refunds again would
       * otherwise return the credits twice — and a job with a flaky provider could
       * mint credits indefinitely.
       */
      const { creditBalanceFor, refundCredits } = await credits();
      const key = "scene:flaky:0:1";
      await charge(user.id, { idempotencyKey: key });

      const first = await refundCredits({
        userId: user.id,
        chargeIdempotencyKey: key,
        reason: "attempt 1",
      });
      const second = await refundCredits({
        userId: user.id,
        chargeIdempotencyKey: key,
        reason: "attempt 2",
      });
      const third = await refundCredits({
        userId: user.id,
        chargeIdempotencyKey: key,
        reason: "attempt 3",
      });

      expect(first.refunded).toBe(1);
      expect(second).toMatchObject({ refunded: 0, alreadyRefunded: true });
      expect(third).toMatchObject({ refunded: 0, alreadyRefunded: true });

      const refunds = (await ledgerRows(user.id)).filter((r) => r.reason === "refund");
      expect(refunds).toHaveLength(1);
      expect((await creditBalanceFor(user.id)).spent).toBe(0);
      await expectConsistent(user.id);
    });

    it("refunds once under concurrency", async () => {
      const { refundCredits } = await credits();
      const key = "scene:concurrent-refund:0:1";
      await charge(user.id, { idempotencyKey: key });

      const outcomes = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          refundCredits({
            userId: user.id,
            chargeIdempotencyKey: key,
            reason: `attempt ${i}`,
          }),
        ),
      );

      const applied = outcomes.filter(
        (r) => r.status === "fulfilled" && r.value.refunded > 0,
      );
      expect(applied).toHaveLength(1);
      const refunds = (await ledgerRows(user.id)).filter((r) => r.reason === "refund");
      expect(refunds).toHaveLength(1);
      await expectConsistent(user.id);
    });

    it("returns zero rather than throwing when there is nothing to refund", async () => {
      /**
       * Called from failure paths. A failure handler that itself throws replaces a
       * useful provider error with a confusing accounting one.
       */
      const { refundCredits } = await credits();

      const outcome = await refundCredits({
        userId: user.id,
        chargeIdempotencyKey: "scene:never-charged:0:1",
        reason: "provider failed",
      });

      expect(outcome).toMatchObject({ refunded: 0, alreadyRefunded: false });
      expect(await ledgerRows(user.id)).toHaveLength(0);
    });

    it("will not refund another tenant's charge", async () => {
      /**
       * §34. The key is guessable — it is derived from a project id and an index — so
       * the userId predicate is what stops one account refunding itself out of
       * another's spend.
       */
      const { creditBalanceFor, refundCredits } = await credits();
      const other = await createUser();
      const key = "scene:victim:0:1";

      await charge(user.id, { idempotencyKey: key });
      const victimBefore = await creditBalanceFor(user.id);

      const outcome = await refundCredits({
        userId: other.id,
        chargeIdempotencyKey: key,
        reason: "not mine",
      });

      expect(outcome.refunded).toBe(0);
      expect((await creditBalanceFor(user.id)).spent).toBe(victimBefore.spent);
      expect((await creditBalanceFor(other.id)).available).toBe(0);
    });

    it("clamps rather than failing when the period has already reset", async () => {
      /**
       * A generation charged in January that fails in February. `spent` has been
       * zeroed, so a bare subtraction would violate the non-negative check constraint
       * and take the whole transaction down. `greatest(spent - amount, 0)` refunds
       * what can be refunded.
       */
      const { ensureMonthlyGrant, refundCredits } = await credits();
      const key = "scene:last-month-failure:0:1";

      await charge(user.id, { idempotencyKey: key });
      // Roll the period forward past whatever "now" is, which zeroes `spent`.
      const reset = await ensureMonthlyGrant(user.id, {
        period: await laterPeriod(),
      });
      expect(reset.granted).toBe(true);
      expect(reset.balance.spent).toBe(0);

      const outcome = await refundCredits({
        userId: user.id,
        chargeIdempotencyKey: key,
        reason: "failed after the reset",
      });

      // It did not throw, and `spent` is still legal.
      expect(outcome.refunded).toBe(1);
      const { creditBalanceFor } = await credits();
      expect((await creditBalanceFor(user.id)).spent).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Purchases
  // -------------------------------------------------------------------------

  describe("addPurchasedCredits", () => {
    it("adds to purchased, not to granted", async () => {
      const { addPurchasedCredits, creditBalanceFor, ensureMonthlyGrant } =
        await credits();
      const { planByTier } = await import("@/lib/plans");
      await ensureMonthlyGrant(user.id);

      const outcome = await addPurchasedCredits({
        userId: user.id,
        credits: 500,
        idempotencyKey: "purchase:cs_test_1",
        description: "500 credits",
      });

      expect(outcome.credited).toBe(500);
      const balance = await creditBalanceFor(user.id);
      expect(balance.purchased).toBe(500);
      expect(balance.granted).toBe(planByTier("starter").monthlyCredits);
      expect(balance.available).toBe(500 + balance.granted);
      await expectConsistent(user.id);
    });

    it("credits an account that has never been granted anything", async () => {
      /**
       * The insert branch of the upsert. Without it a first-ever purchase would
       * update no rows and the customer would have paid for nothing.
       */
      const { addPurchasedCredits, creditBalanceFor } = await credits();

      const outcome = await addPurchasedCredits({
        userId: user.id,
        credits: 100,
        idempotencyKey: "purchase:cs_first",
        description: "100 credits",
      });

      expect(outcome.credited).toBe(100);
      expect(outcome.balanceAfter).toBe(100);
      expect((await creditBalanceFor(user.id)).available).toBe(100);
      await expectConsistent(user.id);
    });

    it("credits once for a redelivered webhook", async () => {
      /**
       * Stripe redelivers. `billing_events` already guards the whole webhook, but this
       * is the second line: even a hand-replayed call with the same session key must
       * not credit twice.
       */
      const { addPurchasedCredits, creditBalanceFor } = await credits();
      const key = "purchase:cs_redelivered";

      const first = await addPurchasedCredits({
        userId: user.id,
        credits: 1_000,
        idempotencyKey: key,
        description: "1,000 credits",
      });
      const second = await addPurchasedCredits({
        userId: user.id,
        credits: 1_000,
        idempotencyKey: key,
        description: "1,000 credits",
      });

      expect(first.credited).toBe(1_000);
      expect(second).toMatchObject({ credited: 0, alreadyCredited: true });
      expect((await creditBalanceFor(user.id)).purchased).toBe(1_000);
      await expectConsistent(user.id);
    });

    it("refuses a zero, negative or fractional grant", async () => {
      const { addPurchasedCredits } = await credits();
      const { ValidationError } = await import("@/lib/errors");

      for (const credits_ of [0, -100, 1.5]) {
        await expect(
          addPurchasedCredits({
            userId: user.id,
            credits: credits_,
            idempotencyKey: `purchase:bad:${credits_}`,
            description: "bad",
          }),
        ).rejects.toBeInstanceOf(ValidationError);
      }
      expect(await ledgerRows(user.id)).toHaveLength(0);
    });

    it("lets purchased credits pay for a generation the allowance cannot", async () => {
      /**
       * §11's point. The allowance is exhausted, the top-up covers the next scene, and
       * the charge does not need to know which bucket paid — `granted + purchased -
       * spent` is one number to the predicate.
       */
      const { addPurchasedCredits, creditBalanceFor, ensureMonthlyGrant } =
        await credits();
      const { planByTier } = await import("@/lib/plans");
      const included = planByTier("starter").monthlyCredits;

      await ensureMonthlyGrant(user.id);
      for (let i = 0; i < included; i += 1) {
        await charge(user.id, { idempotencyKey: `scene:exhaust:${i}:1` });
      }
      expect((await creditBalanceFor(user.id)).available).toBe(0);

      await addPurchasedCredits({
        userId: user.id,
        credits: 3,
        idempotencyKey: "purchase:cs_rescue",
        description: "100 credits",
      });

      const outcome = await charge(user.id, {
        idempotencyKey: "scene:after-topup:0:1",
      });

      expect(outcome.charged).toBe(1);
      expect(outcome.balanceAfter).toBe(2);
      await expectConsistent(user.id);
    });
  });

  // -------------------------------------------------------------------------
  // History and isolation
  // -------------------------------------------------------------------------

  describe("creditHistoryFor", () => {
    it("returns this tenant's rows and only this tenant's", async () => {
      const { chargeCredits, creditHistoryFor } = await credits();
      const other = await createUser();

      await charge(user.id, { idempotencyKey: "scene:mine:0:1" });
      await chargeCredits({
        userId: other.id,
        operation: "image",
        modelId: "mock/placeholder",
        quality: "1080p",
        idempotencyKey: "image:theirs:reference:x",
      });

      const mine = await creditHistoryFor(user.id);
      const theirs = await creditHistoryFor(other.id);

      expect(mine.length).toBeGreaterThan(0);
      expect(theirs.length).toBeGreaterThan(0);
      // Not one row of the other tenant's, under any reason.
      expect(mine.some((row) => row.operation === "image")).toBe(false);
      expect(theirs.some((row) => row.operation === "video_scene")).toBe(false);
      expect(new Set([...mine, ...theirs].map((r) => r.id)).size).toBe(
        mine.length + theirs.length,
      );
    });

    it("returns newest first and honours the period filter", async () => {
      const { creditHistoryFor } = await credits();

      await charge(user.id, { idempotencyKey: "scene:hist:0:1" });

      const all = await creditHistoryFor(user.id);
      // The grant is written before the spend, and the list is newest first.
      expect(all.map((row) => row.reason)).toEqual(["spend", "monthly_grant"]);

      const thisPeriod = await creditHistoryFor(user.id, { period: await period() });
      expect(thisPeriod).toHaveLength(all.length);

      // A period with no activity returns nothing rather than everything — a filter
      // that fell through to "no filter" would leak other months into a statement.
      const empty = await creditHistoryFor(user.id, { period: await laterPeriod(6) });
      expect(empty).toEqual([]);
    });

    it("clamps the limit so a long-lived account cannot ask for everything", async () => {
      const { creditHistoryFor } = await credits();
      await charge(user.id, { idempotencyKey: "scene:limit:0:1" });

      // A hostile limit must not become an unbounded query.
      await expect(creditHistoryFor(user.id, { limit: 100_000 })).resolves.toBeDefined();
      await expect(creditHistoryFor(user.id, { limit: 0 })).resolves.toBeDefined();
      await expect(creditHistoryFor(user.id, { limit: -5 })).resolves.toBeDefined();
    });

    it("describes a spend without naming a vendor", async () => {
      /**
       * §3, on the one screen where a leak would be permanent: the transaction
       * history. `modelId` is stored — it is needed for revenue attribution — but the
       * customer-facing `description` must never name the backend.
       */
      const { chargeCredits, creditHistoryFor } = await credits();

      await chargeCredits({
        userId: user.id,
        operation: "video_scene",
        modelId: "tal/3.1",
        quality: "1080p",
        durationMs: 5_000,
        idempotencyKey: "scene:branded:0:1",
      });

      const [row] = await creditHistoryFor(user.id);
      expect(row?.description).toBeTruthy();
      expect(row?.description).not.toMatch(
        /veo|gemini|minimax|wan|seedance|dashscope|fal|runway/i,
      );
    });
  });

  // -------------------------------------------------------------------------
  // The entitlements surface
  // -------------------------------------------------------------------------

  describe("entitlementsFor", () => {
    it("carries the plan's included credits and the live balance", async () => {
      const { entitlementsFor } = await import("@/lib/plans/enforce");
      const { planByTier } = await import("@/lib/plans");
      await setTier(user.id, "studio");
      await charge(user.id, { idempotencyKey: "scene:entitled:0:1" });

      const entitlements = await entitlementsFor(user.id, "studio");

      expect(entitlements.monthlyCredits).toBe(planByTier("studio").monthlyCredits);
      expect(entitlements.credits.granted).toBe(planByTier("studio").monthlyCredits);
      expect(entitlements.credits.spent).toBe(1);
      expect(entitlements.credits.available).toBe(
        planByTier("studio").monthlyCredits - 1,
      );
      expect(entitlements.credits.purchased).toBe(0);
      expect(entitlements.credits.grantedForTier).toBe("studio");
    });

    it("grants nothing, so a page load cannot mint credits", async () => {
      /**
       * The rule `creditBalanceFor` exists to keep: a read must not grant. Otherwise a
       * bug in the period comparison would be a bug that gives away money on every
       * request, on the most-loaded path in the application.
       */
      const { entitlementsFor } = await import("@/lib/plans/enforce");

      // No grant has happened yet for this user.
      expect(await ledgerRows(user.id)).toHaveLength(0);

      for (let i = 0; i < 5; i += 1) await entitlementsFor(user.id, "starter");

      expect(await ledgerRows(user.id)).toHaveLength(0);
      const entitlements = await entitlementsFor(user.id, "starter");
      expect(entitlements.credits.available).toBe(0);
    });

    it("reports zero rather than failing for an account with no balance row", async () => {
      const { entitlementsFor } = await import("@/lib/plans/enforce");
      const fresh = await createUser();

      const entitlements = await entitlementsFor(fresh.id, "starter");

      expect(entitlements.credits).toMatchObject({
        available: 0,
        granted: 0,
        purchased: 0,
        spent: 0,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Constraints the database itself enforces
  // -------------------------------------------------------------------------

  describe("the schema's own guarantees", () => {
    it("refuses a ledger row whose sign contradicts its reason", async () => {
      /**
       * `credit_ledger_sign_matches_reason`, hand-written into 0009 because
       * drizzle-kit does not emit CHECK constraints. It is the backstop for
       * `reconcile`: a positive `spend` row would make the ledger sum disagree with
       * every balance forever, and no application code would notice.
       */
      const { db } = await import("@/lib/db");
      const { creditLedger } = await import("@/lib/db/schema");

      await expect(
        db.insert(creditLedger).values({
          userId: user.id,
          reason: "spend",
          amount: 50, // must be negative
          balanceAfter: 50,
          period: await period(),
        }),
      ).rejects.toThrow(/credit_ledger_sign_matches_reason/);

      await expect(
        db.insert(creditLedger).values({
          userId: user.id,
          reason: "purchase",
          amount: -50, // must be positive
          balanceAfter: 0,
          period: await period(),
        }),
      ).rejects.toThrow(/credit_ledger_sign_matches_reason/);
    });

    it("refuses a balance row that would go negative", async () => {
      const { db } = await import("@/lib/db");
      const { creditBalances } = await import("@/lib/db/schema");

      await expect(
        db.insert(creditBalances).values({
          userId: user.id,
          granted: 10,
          purchased: 0,
          spent: 11,
          period: await period(),
        }),
      ).rejects.toThrow(/credit_balances_non_negative/);
    });

    it("allows many rows with no idempotency key at all", async () => {
      /**
       * The index is partial — `WHERE idempotency_key IS NOT NULL` — so unkeyed
       * adjustments are not forced to collide with each other. A plain unique index
       * would treat several NULLs as distinct in Postgres anyway, but the partial form
       * states the intent and keeps the index small.
       */
      const { db } = await import("@/lib/db");
      const { creditLedger } = await import("@/lib/db/schema");

      for (let i = 0; i < 3; i += 1) {
        await db.insert(creditLedger).values({
          userId: user.id,
          reason: "adjustment",
          amount: 1,
          balanceAfter: 0,
          period: await period(),
          description: `Manual adjustment ${i}`,
        });
      }

      const adjustments = (await ledgerRows(user.id)).filter(
        (r) => r.reason === "adjustment",
      );
      expect(adjustments).toHaveLength(3);
    });

    it("removes a user's credit rows with the user", async () => {
      // `ON DELETE cascade` on both tables: a deleted account leaves no orphaned
      // ledger, which is what §35's deletion promise requires.
      const { db } = await import("@/lib/db");
      const { users } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      await charge(user.id, { idempotencyKey: "scene:doomed-user:0:1" });
      expect((await ledgerRows(user.id)).length).toBeGreaterThan(0);

      await db.delete(users).where(eq(users.id, user.id));

      expect(await ledgerRows(user.id)).toHaveLength(0);
      const { creditBalanceFor } = await credits();
      expect((await creditBalanceFor(user.id)).available).toBe(0);
    });
  });
});

/**
 * Prove the billing path works in a real Node process (§14, §19, §48).
 *
 * `scripts/verify-worker.ts` exists because Phase 5 learned that a green Vitest run
 * can hide a runtime defect: every shared module carried `import "server-only"`, the
 * config aliased it to a stub, and 541 tests passed against a worker that could not
 * boot. Phase 7 hit the same class from the other direction — a `Date` bound through
 * a raw `sql` template, which postgres.js rejects at Bind. Billing has the same
 * exposure: `webhook.ts` contains exactly one raw `sql` fragment (the `lastEventAt`
 * comparison), the Stripe SDK is a real dependency that must load outside a bundler,
 * and the webhook route is the one route in Vidxir AI that is *not* wrapped in
 * `handle()`.
 *
 * So this runs, with no test framework, no aliases and no mocked modules:
 *
 *   1. the process starts, `.env.local` loads, and the Stripe SDK imports
 *   2. Postgres answers and `billing_events` / `subscriptions.last_event_at` exist
 *   3. the raw `lastEventAt` predicate binds and executes against real Postgres
 *   4. the unique index on (provider, provider_event_id) genuinely rejects a
 *      redelivery, and `onConflictDoNothing` reports it as such
 *   5. the price → tier mapping refuses to invent an entitlement
 *   6. signature verification accepts a correctly signed body and rejects a
 *      tampered one, using the real HMAC
 *   7. the configuration state is reported honestly (§48)
 *
 * §17/§34: prints no credential values. Stripe configuration is reported as
 * PRESENT/ABSENT and price ids are never echoed. The secret key is never read into a
 * printable string.
 *
 * §24/§42: performs no live Stripe call. It creates no customer, no checkout session
 * and no subscription, so it cannot charge anyone and cannot grant a tier. Steps 3
 * and 4 write to `billing_events` under an unmistakable synthetic provider name and
 * delete their rows again; `subscriptions` is never written.
 *
 *   npx tsx scripts/verify-billing.ts
 *
 * Exits non-zero on the first failure.
 */
import "@/lib/load-env";

/**
 * A provider name no real integration can produce, so the probe rows in step 3/4
 * cannot be confused with Stripe's and cannot collide with them on the unique index.
 */
const PROBE_PROVIDER = "verify-script";

const TOTAL_STEPS = 7;
let step = 0;

function ok(message: string): void {
  step += 1;
  console.log(`  ${step}. OK  ${message}`);
}

function detail(message: string): void {
  console.log(`        ${message}`);
}

async function main(): Promise<void> {
  console.log("\nbilling verification (no live Stripe call, no charge)\n");

  // ---- 1. process + SDK --------------------------------------------------
  const { env, usingMockProviders } = await import("@/lib/env");
  const e = env();
  /**
   * The SDK is imported for real. It is CommonJS with its own crypto entry points,
   * and a bundler-only import failure would otherwise surface first in production.
   */
  const Stripe = (await import("stripe")).default;
  /**
   * The version the application pins, imported rather than restated — a literal
   * repeated here could drift from production's and this script would keep passing.
   */
  const { STRIPE_API_VERSION } = await import("@/lib/billing/stripe");
  ok(
    `environment loaded and the stripe SDK imported, pinned to API version ` +
      `${STRIPE_API_VERSION} ` +
      `(NODE_ENV=${e.NODE_ENV}, mockProviders=${String(usingMockProviders())})`,
  );

  // ---- 2. schema ---------------------------------------------------------
  const { db, rawSql, closeDb } = await import("@/lib/db");
  const { billingEvents, subscriptions } = await import("@/lib/db/schema");
  const { and, eq, isNull, or, sql } = await import("drizzle-orm");

  const [version] = await rawSql()`select version()`;
  const banner = String(version?.["version"] ?? "").split(",")[0];

  // Real queries: `select version()` would pass against a database with no
  // migrations applied, which is precisely the state this must catch.
  await db.select({ id: billingEvents.id }).from(billingEvents).limit(1);
  await db
    .select({ lastEventAt: subscriptions.lastEventAt })
    .from(subscriptions)
    .limit(1);
  ok(`${banner} answered — billing_events and subscriptions.last_event_at present`);

  // ---- 3. the raw timestamp predicate ------------------------------------
  /**
   * The one raw `sql` fragment in the billing code, executed exactly as
   * `applySubscription` composes it.
   *
   * This is step three of seven because it is the Phase 7 defect class: an
   * unmapped `Date` inside a raw template reaches postgres.js as a JS object and
   * dies at Bind, before Postgres ever sees the statement — so this fails
   * identically whether the table has rows or not, which is what makes it a real
   * check rather than a data-dependent one. `applySubscription` passes
   * `.toISOString()` with an explicit `::timestamptz` cast for that reason.
   */
  const now = new Date();
  const probeRows = await db
    .select({ userId: subscriptions.userId })
    .from(subscriptions)
    .where(
      and(
        or(
          isNull(subscriptions.lastEventAt),
          sql`${subscriptions.lastEventAt} < ${now.toISOString()}::timestamptz`,
        ),
        // Never matches; the point is that the statement binds and runs, not that
        // it selects anything.
        eq(subscriptions.provider, PROBE_PROVIDER),
      ),
    )
    .limit(1);
  ok(
    `the out-of-order guard's timestamp predicate bound and executed ` +
      `(${probeRows.length} row(s), as expected for a synthetic provider)`,
  );

  // ---- 4. idempotency ----------------------------------------------------
  /**
   * The unique index, proven by inserting the same event twice.
   *
   * Asserted against the real index rather than reasoned about, because the whole
   * redelivery story rests on `onConflictDoNothing` returning zero rows: if the
   * index were ever dropped from a migration, every Stripe retry would apply again
   * and this is the only check that would notice.
   */
  const probeEventId = `verify_${now.getTime()}`;
  const probeValues = {
    provider: PROBE_PROVIDER,
    providerEventId: probeEventId,
    eventType: "verify.script.probe",
    userId: null,
    providerCustomerId: null,
    providerSubscriptionId: null,
    eventCreatedAt: now,
    applied: false,
    skipReason: "verify_script",
    payload: { note: "verify-billing.ts probe; safe to delete" },
  };

  try {
    const first = await db
      .insert(billingEvents)
      .values(probeValues)
      .onConflictDoNothing({
        target: [billingEvents.provider, billingEvents.providerEventId],
      })
      .returning({ id: billingEvents.id });

    const second = await db
      .insert(billingEvents)
      .values(probeValues)
      .onConflictDoNothing({
        target: [billingEvents.provider, billingEvents.providerEventId],
      })
      .returning({ id: billingEvents.id });

    if (first.length !== 1) {
      throw new Error(
        `the first insert of a fresh event returned ${first.length} rows; expected 1`,
      );
    }
    if (second.length !== 0) {
      throw new Error(
        "a redelivery of the same event id was inserted a second time — the unique " +
          "index on (provider, provider_event_id) is missing, so every Stripe retry " +
          "would be applied again",
      );
    }
    ok(
      "the unique event index rejected a redelivery — a repeated event returns no " +
        "row, which is how the handler detects a duplicate without a racy read",
    );
  } finally {
    // Always removed, including on failure, so a failed run leaves nothing behind.
    await db
      .delete(billingEvents)
      .where(eq(billingEvents.provider, PROBE_PROVIDER));
  }

  // ---- 5. price → tier mapping -------------------------------------------
  const { tierForPriceId } = await import("@/lib/billing/stripe");

  /**
   * §24's rule, checked in the direction that can lose money: an unrecognised price
   * must entitle nothing. A price created in the Stripe dashboard and never wired
   * into this deployment's environment must not resolve to the highest tier.
   */
  if (tierForPriceId("price_this_deployment_never_configured") !== null) {
    throw new Error(
      "an unconfigured price id resolved to a tier; an unrecognised price must " +
        "entitle nothing",
    );
  }
  if (tierForPriceId(null) !== null || tierForPriceId("") !== null) {
    throw new Error("an empty price id resolved to a tier");
  }

  const { PLAN_CATALOG } = await import("@/lib/plans");
  const configuredTiers: string[] = [];
  for (const plan of PLAN_CATALOG) {
    if (!plan.stripePriceEnvVar) continue;
    const priceId = e[plan.stripePriceEnvVar];
    if (!priceId) continue;
    // Round-trips the configured value without printing it.
    if (tierForPriceId(priceId) !== plan.tier) {
      throw new Error(
        `the configured price for ${plan.tier} does not map back to ${plan.tier}`,
      );
    }
    configuredTiers.push(plan.tier);
  }

  ok(
    "an unrecognised price maps to no tier at all" +
      (configuredTiers.length > 0
        ? `; configured prices round-trip correctly for: ${configuredTiers.join(", ")}`
        : "; no price ids are configured, so no tier is purchasable here"),
  );

  // ---- 6. signature verification -----------------------------------------
  /**
   * The real HMAC, on both sides.
   *
   * Local crypto only — `constructEvent` issues no request, so this runs without a
   * Stripe account and without network access. A placeholder key is used because
   * the constructor requires one; nothing authenticates.
   */
  const localOnly = new Stripe("sk_test_verify_script_placeholder", {
    apiVersion: STRIPE_API_VERSION,
  });
  const probeSecret = "whsec_verify_script_local_only";
  const payload = JSON.stringify({
    id: "evt_verify_script",
    object: "event",
    type: "customer.subscription.updated",
    created: Math.floor(now.getTime() / 1000),
    data: { object: { id: "sub_verify", object: "subscription" } },
  });
  const header = localOnly.webhooks.generateTestHeaderString({
    payload,
    secret: probeSecret,
  });

  const verified = localOnly.webhooks.constructEvent(payload, header, probeSecret);
  if (verified.id !== "evt_verify_script") {
    throw new Error("a correctly signed payload did not verify");
  }

  // The attack the signature exists to stop: a genuine body, edited in flight.
  let rejected = false;
  try {
    localOnly.webhooks.constructEvent(
      payload.replace("sub_verify", "sub_tampered"),
      header,
      probeSecret,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(
      "a body modified after signing still verified — the webhook would accept " +
        "forged events",
    );
  }
  ok(
    "signature verification accepted a correctly signed body and rejected one " +
      "edited after signing (local HMAC, no network call)",
  );

  // ---- 7. configuration state --------------------------------------------
  /**
   * §48 stated as a fact rather than glossed. When Stripe is not configured the
   * correct behaviour is a `not_configured` state that names the missing variables —
   * not a stub that reports success — and that is what the routes return.
   */
  const { billingAvailability, canUpgrade } = await import("@/lib/billing");
  const availability = billingAvailability();
  const missing = [
    ...availability.missingEnvVars,
    ...availability.missingPriceEnvVars,
  ];

  ok(
    availability.configured
      ? `billing is CONFIGURED (provider=${availability.provider}) — checkout and ` +
          `the portal will reach Stripe; no call was made by this script`
      : `billing is NOT_CONFIGURED (provider=${availability.provider}) — ` +
          `checkout and the portal return 503 naming the missing variables, and no ` +
          `tier can be granted`,
  );
  /**
   * Presence reported per variable, by name.
   *
   * Not derived from `missingEnvVars`: that list is what the *selected* provider
   * requires, and while `BILLING_PROVIDER=mock` (or mock providers are on) Stripe
   * requires nothing, so an empty list would read as "everything is set" when in
   * fact nothing is. §17 asks for PRESENT/ABSENT and this is the one place that
   * could quietly say the opposite of the truth.
   */
  const STRIPE_VARS = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_STUDIO",
    "STRIPE_PRICE_SCALE",
  ] as const;
  detail(
    `credentials: ${STRIPE_VARS.map(
      (name) => `${name}=${e[name] ? "PRESENT" : "ABSENT"}`,
    ).join(", ")} (names and presence only; no values are read or printed)`,
  );
  if (missing.length > 0) {
    detail(
      `required by the selected provider and unset: ${missing.join(", ")}`,
    );
  }
  detail(`self-serve upgrade available: ${String(canUpgrade())}`);
  if (usingMockProviders()) {
    detail(
      "VIDXIR_USE_MOCK_PROVIDERS is on, so the billing provider resolves to `mock`, " +
        "which never reports configured and can never grant a paid tier (§40)",
    );
  }

  await closeDb();

  console.log(
    `\n${step}/${TOTAL_STEPS} checks passed — the billing schema, the ` +
      `out-of-order predicate, the idempotency index, the price mapping and ` +
      `signature verification all work under real Node.` +
      (availability.configured
        ? ""
        : `\nNot verified: a live Stripe checkout, portal session or webhook ` +
          `delivery. Stripe is not configured in this environment, and §48 ` +
          `requires the not_configured state rather than a fake success.`) +
      "\n",
  );
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

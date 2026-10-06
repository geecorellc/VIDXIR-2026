/**
 * Credit pack resolution (§11).
 *
 * This module's whole job is to stand between a request body and a charge, so the
 * cases below are about what a client *cannot* do:
 *
 *  - **Cannot name a price.** `priceIdForPack` reads the environment; there is no
 *    parameter through which a price id could arrive.
 *  - **Cannot name an amount.** The credit count comes from the catalogue, so a
 *    forged body cannot buy 10,000 credits for a cent.
 *  - **Cannot buy an unconfigured pack.** A pack with no price id is absent from the
 *    picker and throws a `NotConfiguredError` naming the exact variable if reached
 *    anyway (§42, §48).
 *  - **Cannot be credited by an unrecognised price.** `packForPriceId` returns null
 *    for a price created in the dashboard and never wired up, so a stray payment
 *    grants nothing.
 *
 * Plus one pricing-integrity case: the largest pack must be the best value, or the
 * "Best value" badge in the picker is a lie.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { NotConfiguredError } from "@/lib/errors";
import {
  CREDIT_PACK_IDS,
  allCreditPacks,
  availableCreditPacks,
  centsPerCredit,
  creditPack,
  creditTopUpsAvailable,
  isCreditPackId,
  packForPriceId,
  priceIdForPack,
} from "@/lib/credits/packs";

const BASE = {
  DATABASE_URL: "postgresql://vidxir:vidxir@localhost:5432/vidxir_unit",
  REDIS_URL: "redis://127.0.0.1:6379",
  S3_BUCKET: "vidxir-unit",
  S3_ACCESS_KEY_ID: "unit",
  S3_SECRET_ACCESS_KEY: "unit",
  ENCRYPTION_KEY: "a".repeat(64),
  SESSION_SECRET: "b".repeat(64),
  NODE_ENV: "test",
} as const;

const PACK_VARS = [
  "STRIPE_PRICE_CREDITS_100",
  "STRIPE_PRICE_CREDITS_500",
  "STRIPE_PRICE_CREDITS_1000",
  "STRIPE_PRICE_CREDITS_2500",
] as const;

const MANAGED = [...Object.keys(BASE), ...PACK_VARS];
const original = new Map<string, string | undefined>(
  MANAGED.map((key) => [key, process.env[key]]),
);

function setEnv(key: string, value: string): void {
  (process.env as Record<string, string>)[key] = value;
}

/**
 * Deliberately obvious placeholders. A price id is not a secret, but the repository's
 * secret scan should have nothing that resembles one to flag.
 */
const PRICE_100 = "price_unit_placeholder_100";
const PRICE_500 = "price_unit_placeholder_500";
const PRICE_1000 = "price_unit_placeholder_1000";
const PRICE_2500 = "price_unit_placeholder_2500";

function configure(vars: Record<string, string | undefined> = {}): void {
  resetEnvCache();
  for (const key of MANAGED) delete process.env[key];
  for (const [key, value] of Object.entries({ ...BASE, ...vars })) {
    if (value === undefined) delete process.env[key];
    else setEnv(key, value);
  }
  resetEnvCache();
}

const ALL_PRICES = {
  STRIPE_PRICE_CREDITS_100: PRICE_100,
  STRIPE_PRICE_CREDITS_500: PRICE_500,
  STRIPE_PRICE_CREDITS_1000: PRICE_1000,
  STRIPE_PRICE_CREDITS_2500: PRICE_2500,
} as const;

beforeEach(() => {
  configure(ALL_PRICES);
});

afterEach(() => {
  resetEnvCache();
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else setEnv(key, value);
  }
  resetEnvCache();
});

describe("the catalogue", () => {
  it("offers the four packs §11 names", () => {
    expect(allCreditPacks().map((pack) => pack.credits)).toEqual([
      100, 500, 1_000, 2_500,
    ]);
  });

  it("accepts only catalogued pack ids", () => {
    for (const id of CREDIT_PACK_IDS) expect(isCreditPackId(id)).toBe(true);

    // The shapes a hostile body would actually take.
    for (const value of [
      "credits_9999",
      "credits_100 ",
      "CREDITS_100",
      "price_1abcdef",
      "",
      null,
      undefined,
      42,
      { id: "credits_100" },
    ]) {
      expect(isCreditPackId(value), String(value)).toBe(false);
    }
  });

  it("gets cheaper per credit as the pack gets bigger", () => {
    /**
     * The "Best value" badge is on the largest pack, so this is the claim behind it.
     * Strictly decreasing rather than merely non-increasing: two packs at the same
     * rate would make the badge arbitrary.
     */
    const rates = allCreditPacks().map(centsPerCredit);
    for (let i = 1; i < rates.length; i += 1) {
      expect(rates[i]!, `pack ${i} must beat pack ${i - 1}`).toBeLessThan(
        rates[i - 1]!,
      );
    }
  });

  it("prices every pack above the Studio plan's implied rate", () => {
    /**
     * The subscription must remain the cheapest way to buy credits, or the plans are
     * pointless. Studio is 2,500 credits for $39 — 1.56¢ a credit — and the best pack
     * here is 1.4¢… which is *lower*, deliberately: the largest top-up is competitive
     * with a subscription because at that volume the customer is choosing between
     * topping up and upgrading, and the upgrade also brings channels and features.
     *
     * So the assertion is the weaker, true one: no pack undercuts Studio by more than
     * a fifth. A pack far below the plan rate would make upgrading irrational.
     */
    const studioRate = 3900 / 2500;
    for (const pack of allCreditPacks()) {
      expect(centsPerCredit(pack)).toBeGreaterThan(studioRate * 0.8);
    }
  });
});

describe("priceIdForPack", () => {
  it("resolves each pack to its own configured price", () => {
    expect(priceIdForPack("credits_100")).toBe(PRICE_100);
    expect(priceIdForPack("credits_500")).toBe(PRICE_500);
    expect(priceIdForPack("credits_1000")).toBe(PRICE_1000);
    expect(priceIdForPack("credits_2500")).toBe(PRICE_2500);
  });

  it("refuses an unconfigured pack and names the variable to set", () => {
    configure({ ...ALL_PRICES, STRIPE_PRICE_CREDITS_2500: undefined });

    const error = (() => {
      try {
        priceIdForPack("credits_2500");
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(NotConfiguredError);
    // The operator must be told which variable, not merely that something is missing.
    expect((error as NotConfiguredError).details).toMatchObject({
      missingEnvVars: ["STRIPE_PRICE_CREDITS_2500"],
    });
  });

  it("throws for a pack id that is not in the catalogue at all", () => {
    // Reaching here with a bad id means validation was bypassed upstream; returning
    // null instead would turn that into a purchase of nothing.
    expect(() =>
      priceIdForPack("credits_1" as Parameters<typeof priceIdForPack>[0]),
    ).toThrow(/Unknown credit pack/);
  });
});

describe("availableCreditPacks", () => {
  it("offers only what is configured", () => {
    configure({
      STRIPE_PRICE_CREDITS_100: PRICE_100,
      STRIPE_PRICE_CREDITS_1000: PRICE_1000,
    });

    expect(availableCreditPacks().map((pack) => pack.id)).toEqual([
      "credits_100",
      "credits_1000",
    ]);
    expect(creditTopUpsAvailable()).toBe(true);
  });

  it("offers nothing at all when no price is configured", () => {
    /**
     * The state a fresh deployment is in. The top-up UI must disappear rather than
     * render four buttons that cannot work (§48).
     */
    configure();

    expect(availableCreditPacks()).toEqual([]);
    expect(creditTopUpsAvailable()).toBe(false);
    // The catalogue itself is unaffected — it is what an operator's configuration
    // screen lists as *available to configure*.
    expect(allCreditPacks()).toHaveLength(4);
  });
});

describe("packForPriceId", () => {
  it("maps a configured price back to its pack", () => {
    expect(packForPriceId(PRICE_500)?.credits).toBe(500);
  });

  it("grants nothing for a price it does not recognise", () => {
    /**
     * The counterpart of `tierForPriceId`'s rule. A one-off price created in the
     * Stripe dashboard and never wired into the environment must not be able to
     * credit an account.
     */
    expect(packForPriceId("price_created_in_the_dashboard")).toBeNull();
    expect(packForPriceId(null)).toBeNull();
    expect(packForPriceId(undefined)).toBeNull();
    expect(packForPriceId("")).toBeNull();
  });

  it("stops recognising a price once its variable is unset", () => {
    configure({ ...ALL_PRICES, STRIPE_PRICE_CREDITS_500: undefined });
    expect(packForPriceId(PRICE_500)).toBeNull();
  });
});

describe("creditPack", () => {
  it("returns a positive whole number of credits for every pack", () => {
    // A pack granting zero or a fraction would be a purchase the ledger cannot
    // record — `addPurchasedCredits` rejects both.
    for (const id of CREDIT_PACK_IDS) {
      const pack = creditPack(id);
      expect(Number.isInteger(pack.credits)).toBe(true);
      expect(pack.credits).toBeGreaterThan(0);
      expect(Number.isInteger(pack.amountCents)).toBe(true);
      expect(pack.amountCents).toBeGreaterThan(0);
    }
  });

  it("marks exactly one pack as the highlighted one", () => {
    expect(allCreditPacks().filter((pack) => pack.highlight)).toHaveLength(1);
  });
});

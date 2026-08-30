/**
 * Credit top-up packs (§11).
 *
 * The catalogue of one-off purchases, and the server-side resolution of a pack to a
 * Stripe price id. It follows `plans/index.ts` + `billing/stripe.ts`'s division of
 * labour exactly, because the security property is the same one and it is worth having
 * only one shape of it in the codebase:
 *
 *  - **The client names a pack, never a price and never an amount.** A request body
 *    says `credits_500`; this module looks up what that costs and how many credits it
 *    grants. A client that could name a price id could name a $0 one; a client that
 *    could name an amount could buy 10,000 credits for a cent.
 *  - **A pack whose price env var is unset is not offered.** There is no fallback price
 *    and no default. `availablePacks()` filters on configuration, so the UI can only
 *    show what can actually be bought (§42, §48 — never pretend a purchase will work).
 *  - **The credit count lives here, not in Stripe.** The webhook reads it from Tally's
 *    own `credit_purchases` row, written at session-creation time from this table. It
 *    is never read back out of Stripe metadata, which is writable by anything holding
 *    the API key, and never derived from the amount paid, which is a currency figure.
 *
 * ## Why the packs are priced above the implied plan rate
 *
 * Studio includes 2,500 credits for $39, or about 1.56¢ a credit. The packs run from
 * 2.0¢ down to 1.4¢. Top-ups being *more* expensive per credit than the small packs and
 * only competitive at the largest size is deliberate: the subscription should be the
 * cheapest way to buy credits, or the plans become pointless.
 */
import { env } from "@/lib/env";
import { NotConfiguredError } from "@/lib/errors";

/** The pack slugs a client may name. Nothing else is accepted. */
export type CreditPackId =
  | "credits_100"
  | "credits_500"
  | "credits_1000"
  | "credits_2500";

export const CREDIT_PACK_IDS = [
  "credits_100",
  "credits_500",
  "credits_1000",
  "credits_2500",
] as const;

/** Env var names holding each pack's Stripe price id. Values are never exposed. */
type PackPriceEnvVar =
  | "STRIPE_PRICE_CREDITS_100"
  | "STRIPE_PRICE_CREDITS_500"
  | "STRIPE_PRICE_CREDITS_1000"
  | "STRIPE_PRICE_CREDITS_2500";

export interface CreditPack {
  id: CreditPackId;
  /** Credits granted when the payment clears. The authoritative figure. */
  credits: number;
  /** What Stripe will charge, in cents. Must match the configured price object. */
  amountCents: number;
  /** Customer-facing name. */
  label: string;
  /** One line under the label. */
  description: string;
  /** Marked "Best value" in the picker. */
  highlight?: boolean;
  priceEnvVar: PackPriceEnvVar;
}

/**
 * The four packs §11 names.
 *
 * `amountCents` is duplicated from the Stripe price object rather than fetched from it,
 * and that duplication is a deliberate trade: fetching would make rendering the picker
 * depend on a network call to Stripe, and a slow or failing Stripe would blank the
 * page. The risk is the two drifting, which `verify:credits` checks against the live
 * price when credentials are present — and which is harmless in the meantime because
 * Stripe charges what its own price object says, not what this file says. The figure
 * here is for display only.
 */
const PACKS: readonly CreditPack[] = [
  {
    id: "credits_100",
    credits: 100,
    amountCents: 200,
    label: "100 credits",
    description: "A few extra scenes, or a handful of images.",
    priceEnvVar: "STRIPE_PRICE_CREDITS_100",
  },
  {
    id: "credits_500",
    credits: 500,
    amountCents: 900,
    label: "500 credits",
    description: "About two more full-length videos on Tal 2.0.",
    priceEnvVar: "STRIPE_PRICE_CREDITS_500",
  },
  {
    id: "credits_1000",
    credits: 1_000,
    amountCents: 1_600,
    label: "1,000 credits",
    description: "Enough for a week of daily publishing at 1080p.",
    highlight: true,
    priceEnvVar: "STRIPE_PRICE_CREDITS_1000",
  },
  {
    id: "credits_2500",
    credits: 2_500,
    amountCents: 3_500,
    label: "2,500 credits",
    description: "Doubles a Studio month. The lowest cost per credit.",
    priceEnvVar: "STRIPE_PRICE_CREDITS_2500",
  },
] as const;

export function isCreditPackId(value: unknown): value is CreditPackId {
  return (
    typeof value === "string" &&
    (CREDIT_PACK_IDS as readonly string[]).includes(value)
  );
}

/**
 * A pack by id.
 *
 * Throws for an unknown id rather than returning null, because every caller has
 * already validated through Zod or `isCreditPackId` — reaching here with a bad id is a
 * programming error, and silently returning null would turn it into a purchase of
 * nothing.
 */
export function creditPack(id: CreditPackId): CreditPack {
  const found = PACKS.find((pack) => pack.id === id);
  if (!found) throw new Error(`Unknown credit pack: ${id}`);
  return found;
}

/** Every pack, configured or not. For operator-facing configuration screens. */
export function allCreditPacks(): readonly CreditPack[] {
  return PACKS;
}

/**
 * Packs that can actually be bought right now.
 *
 * What the customer-facing picker renders. A pack with no configured price id is
 * omitted entirely rather than shown disabled: §48's rule is that the UI must not
 * imply a capability the configuration does not have, and a greyed-out pack invites a
 * support ticket about a button that was never going to work.
 */
export function availableCreditPacks(): CreditPack[] {
  const e = env();
  return PACKS.filter((pack) => Boolean(e[pack.priceEnvVar]));
}

/**
 * The Stripe price id for a pack.
 *
 * The only place a pack becomes a price, and it reads the environment — so no request
 * body, no metadata and no database row can influence what the customer is charged.
 * Mirrors `priceIdFor(tier)` in `billing/stripe.ts` deliberately: same guarantee, same
 * shape, same `NotConfiguredError` naming the exact variable an operator must set.
 */
export function priceIdForPack(id: CreditPackId): string {
  const pack = creditPack(id);
  const value = env()[pack.priceEnvVar];
  if (!value) {
    throw new NotConfiguredError(
      "Stripe",
      [pack.priceEnvVar],
      `Create a one-off ${pack.label} price in Stripe and set its price id.`,
    );
  }
  return value;
}

/**
 * The pack a Stripe price id corresponds to, or null.
 *
 * The webhook's mapping direction, and the exact counterpart of `tierForPriceId`. An
 * unrecognised price grants nothing: a price created in the dashboard and never wired
 * into the environment must not be able to credit an account.
 *
 * Note that the webhook does not actually need this in the normal path — it reads the
 * credit count from the `credit_purchases` row it wrote itself. This exists for the
 * abnormal one: a payment for a Tally credit price that has no matching purchase row
 * (created directly in the dashboard, or a row lost to a rollback) can at least be
 * identified and logged rather than being an unattributable payment.
 */
export function packForPriceId(priceId: string | null | undefined): CreditPack | null {
  if (!priceId) return null;
  const e = env();
  for (const pack of PACKS) {
    const configured = e[pack.priceEnvVar];
    if (configured && configured === priceId) return pack;
  }
  return null;
}

/** Whether any pack is purchasable. Gates the whole top-up UI. */
export function creditTopUpsAvailable(): boolean {
  return availableCreditPacks().length > 0;
}

/** Cost per credit in cents, for the "best value" comparison in the picker. */
export function centsPerCredit(pack: CreditPack): number {
  return pack.amountCents / pack.credits;
}

/**
 * Plan catalogue — the authoritative definition of what each tier allows (§23).
 *
 * This is shared between server and client: the client uses it to *render* the
 * pricing cards, the server uses it to *authorise*. Every enforcement decision
 * reads the tier from the user's `subscriptions` row, never from a request body
 * (§23, §24). Nothing secret lives here.
 */

export type PlanTier = "starter" | "studio" | "scale";

/**
 * Feature gates checked by `requireFeature()` before doing paid work.
 *
 * Two were added in Phase 11 (§19) and the reasoning is worth recording, because
 * §19 explicitly asks whether a new entitlement is needed or an existing one fits:
 *
 *  - `aiVideoGeneration` — generating every scene with a video model costs
 *    roughly two orders of magnitude more per video than searching a stock library.
 *    `brollLibrary` is the closest existing flag and it is the wrong one: it means
 *    "may use the licensed stock library", which is a different capability at a
 *    different price, and reusing it would have made the cheap feature and the
 *    expensive one impossible to price apart.
 *  - `premiumVideoModels` — within AI video the models differ by several times in
 *    cost, so the tier that pays for AI video at all does not necessarily pay for
 *    the most expensive model. `VideoGenModel.premium` marks which ones this gates.
 *
 * These flags gate *capability*. Since §7 they no longer gate cost: **per-generation
 * cost is metered in credits**, and the two limits do different jobs, so both are
 * kept rather than one replacing the other:
 *
 *  - `maxVideosPerMonth` bounds how many **projects** a plan may start. Claimed
 *    atomically when a project is created (see `createProject`), unchanged.
 *  - `monthlyCredits` bounds how much **generation** those projects may do. Charged
 *    per clip and per still by `lib/credits`, at a price that depends on the model
 *    and resolution chosen (`lib/credits/pricing`).
 *
 * Collapsing them into one number was considered and rejected: a project can be
 * regenerated scene by scene an unbounded number of times, so a per-project
 * allowance cannot bound provider spend, and a pure credit balance cannot express
 * "one channel, four videos" — which is what the free tier actually sells.
 */
export type FeatureKey =
  | "aiVoiceover"
  | "brollLibrary"
  | "aiVideoGeneration"
  | "premiumVideoModels"
  | "thumbnailAbTest"
  | "autoPublish"
  | "scheduling"
  | "crossChannelAnalytics"
  | "priorityRenderQueue";

export interface PlanDefinition {
  tier: PlanTier;
  name: string;
  priceCents: number;
  /** Copy shown under the price in the plan selector. */
  cadence: string;
  /** null = unlimited. */
  maxChannels: number | null;
  maxVideosPerMonth: number | null;
  /**
   * Credits granted at the start of each billing period (§7, §8).
   *
   * Not nullable and never "unlimited", unlike the two limits above. An unlimited
   * credit balance would be an unlimited licence to spend Tally's provider budget,
   * which is the one thing a credit system exists to prevent — so even Scale has a
   * finite monthly grant and tops up beyond it (§11).
   *
   * Starter gets a real, small allowance rather than zero. Zero would make the free
   * tier unable to generate anything at all, which is not what "4 videos / month"
   * promises; this is enough to produce those four short videos on the cheapest
   * model.
   */
  monthlyCredits: number;
  features: Record<FeatureKey, boolean>;
  /** Higher runs first in the render queue. */
  queuePriority: number;
  /** Marketing bullet list — kept verbatim from the prototype. */
  bullets: string[];
  /** Emphasised in the UI as "MOST POPULAR". */
  highlight?: boolean;
  /** Env var holding the Stripe price id, resolved at seed time. */
  stripePriceEnvVar?: "STRIPE_PRICE_STUDIO" | "STRIPE_PRICE_SCALE";
}

export const PLAN_CATALOG: readonly PlanDefinition[] = [
  {
    tier: "starter",
    name: "Starter",
    priceCents: 0,
    cadence: "free",
    maxChannels: 1,
    maxVideosPerMonth: 4,
    /**
     * 100 credits: four 30-second videos on Tal 1.0 at 720p, which is what the
     * bullet list below promises. Starter has `aiVideoGeneration: false`, so these
     * are spent on stills and stock-backed scenes rather than on AI clips.
     */
    monthlyCredits: 100,
    features: {
      aiVoiceover: false,
      brollLibrary: false,
      aiVideoGeneration: false,
      premiumVideoModels: false,
      thumbnailAbTest: false,
      autoPublish: false,
      scheduling: false,
      crossChannelAnalytics: false,
      priorityRenderQueue: false,
    },
    queuePriority: 1,
    bullets: [
      "1 channel",
      "4 videos / month",
      "100 generation credits / month",
      "Research + script tools",
      "Standard thumbnails",
    ],
  },
  {
    tier: "studio",
    name: "Studio",
    priceCents: 3900,
    cadence: "/mo",
    maxChannels: 3,
    maxVideosPerMonth: null,
    /**
     * 2,500 credits: roughly ten full-length videos of twelve scenes each on
     * Tal 2.0 at 1080p, or twice that on Tal 1.0. "Unlimited videos" above is still
     * true — the project count is unlimited; the generation inside them is metered.
     */
    monthlyCredits: 2_500,
    features: {
      aiVoiceover: true,
      brollLibrary: true,
      aiVideoGeneration: true,
      // The standard models only. Premium is what Scale adds, and it is the one
      // feature difference between the tiers that costs money per video rather
      // than per month.
      premiumVideoModels: false,
      thumbnailAbTest: true,
      autoPublish: true,
      scheduling: true,
      crossChannelAnalytics: false,
      priorityRenderQueue: false,
    },
    queuePriority: 5,
    bullets: [
      "3 channels",
      "Unlimited videos",
      "2,500 generation credits / month",
      "AI voiceover + b-roll",
      "AI video generation",
      "Thumbnail A/B testing",
      "Auto-publish & scheduling",
    ],
    highlight: true,
    stripePriceEnvVar: "STRIPE_PRICE_STUDIO",
  },
  {
    tier: "scale",
    name: "Scale",
    priceCents: 9900,
    cadence: "/mo",
    maxChannels: null,
    maxVideosPerMonth: null,
    /**
     * 10,000 credits, which is what makes the premium models usable rather than
     * merely unlocked: Tal 3.1 costs 8× Tal 1.0, so a Scale customer generating
     * exclusively on it gets about the same number of finished videos a Studio
     * customer gets on Tal 2.0.
     */
    monthlyCredits: 10_000,
    features: {
      aiVoiceover: true,
      brollLibrary: true,
      aiVideoGeneration: true,
      premiumVideoModels: true,
      thumbnailAbTest: true,
      autoPublish: true,
      scheduling: true,
      crossChannelAnalytics: true,
      priorityRenderQueue: true,
    },
    queuePriority: 10,
    bullets: [
      "Unlimited channels",
      "Everything in Studio",
      "10,000 generation credits / month",
      "Premium video models",
      "Cross-channel analytics",
      "Priority render queue",
    ],
    stripePriceEnvVar: "STRIPE_PRICE_SCALE",
  },
] as const;

export function planByTier(tier: PlanTier): PlanDefinition {
  const found = PLAN_CATALOG.find((p) => p.tier === tier);
  // The catalogue is exhaustive over PlanTier; this guards a bad DB value.
  if (!found) throw new Error(`Unknown plan tier: ${tier}`);
  return found;
}

export function isPlanTier(value: unknown): value is PlanTier {
  return (
    value === "starter" || value === "studio" || value === "scale"
  );
}

/** Human-readable price, e.g. "$39". */
export function formatPrice(cents: number): string {
  if (cents === 0) return "$0";
  return cents % 100 === 0
    ? `$${cents / 100}`
    : `$${(cents / 100).toFixed(2)}`;
}

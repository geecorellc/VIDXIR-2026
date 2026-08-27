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
 * Note what is deliberately absent: **there is no credit system.** §19 asks for
 * that decision to be stated rather than silently invented, so — Tally meters video
 * generation by the plan's monthly `maxVideosPerMonth` allowance, atomically claimed
 * when a project is created (see `createProject`), and gates *capability* by these
 * flags. Per-generation credits would be a second billing system alongside Stripe
 * subscriptions, with its own balance, top-up, refund-on-failure and expiry rules,
 * and Phase 11 is not the place to introduce one.
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

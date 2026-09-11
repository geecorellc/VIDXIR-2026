/**
 * Server-side plan enforcement (§23, §24).
 *
 * Every one of these functions reads the tier from the `subscriptions` table via
 * `currentTier()`. None of them accepts a tier from a caller, because a request
 * body is not evidence of entitlement — §24 is explicit: "Never activate paid
 * features solely because the frontend says the user selected 'Studio'."
 *
 * Limits are read from the `plans` table shape via the shared catalogue, so the
 * UI and the enforcement point cannot disagree about what a plan includes.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, subscriptions, usageCounters } from "@/lib/db/schema";
import { FeatureNotInPlanError, PlanLimitError } from "@/lib/errors";
import { isPlanTier, planByTier, type FeatureKey, type PlanTier } from "@/lib/plans";
import { currentPeriod } from "@/lib/projects/service";
/**
 * One-way by construction: `credits/service` re-implements `currentTier`'s predicate
 * rather than importing it, precisely so this direction stays acyclic.
 */
import { creditBalanceFor } from "@/lib/credits/service";

/**
 * The user's authoritative plan tier, read from the database (§23, §24).
 *
 * Lives here rather than in `api/guard` because the scheduler needs it too: the
 * automation engine decides whether a channel may auto-publish, and `guard` is
 * `server-only` — importable from a route, not from a worker process. `guard`
 * re-exports this so route code keeps its single import.
 */
export async function currentTier(userId: string): Promise<PlanTier> {
  const rows = await db
    .select({ tier: subscriptions.tier, status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);

  const row = rows[0];
  if (!row) return "starter";
  // A lapsed subscription falls back to the free tier rather than keeping paid
  // capabilities alive (§24: payment failure must actually downgrade access).
  const entitled = row.status === "active" || row.status === "trialing";
  if (!entitled) return "starter";
  return isPlanTier(row.tier) ? row.tier : "starter";
}

export interface Entitlements {
  tier: PlanTier;
  planName: string;
  maxChannels: number | null;
  maxVideosPerMonth: number | null;
  /** Generation credits the plan includes each period (§7). */
  monthlyCredits: number;
  features: Record<FeatureKey, boolean>;
  queuePriority: number;
  usage: {
    period: string;
    channelsConnected: number;
    videosStartedThisMonth: number;
    videosPublishedThisMonth: number;
  };
  /**
   * The live credit balance (§8).
   *
   * Carried on entitlements rather than fetched separately by the UI because it is
   * the same kind of fact as the video allowance — what this account may do right now
   * — and because a second endpoint would be a second chance for the two to disagree.
   * A charge is still authorised by `chargeCredits` against the locked row; this is
   * for display, and is stale the moment it is read.
   */
  credits: {
    available: number;
    granted: number;
    purchased: number;
    spent: number;
    /** The tier the standing grant was issued for, which may lag `tier`. */
    grantedForTier: PlanTier;
  };
}

/** Everything the UI needs to show limits honestly, resolved from the database. */
export async function entitlementsFor(
  userId: string,
  tier: PlanTier,
): Promise<Entitlements> {
  const plan = planByTier(tier);
  const period = currentPeriod();

  const [connected, counter, credits] = await Promise.all([
    db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.userId, userId), isNull(channels.disconnectedAt))),
    db
      .select({
        videosStarted: usageCounters.videosStarted,
        videosPublished: usageCounters.videosPublished,
      })
      .from(usageCounters)
      .where(
        and(eq(usageCounters.userId, userId), eq(usageCounters.period, period)),
      )
      .limit(1),
    /**
     * Read, never granted.
     *
     * `creditBalanceFor` is deliberately the read-only half of the credit service: a
     * page load must not be able to mint credits, or a bug in the period comparison
     * would become a bug that gives away money on every request. An account between
     * signup and its first grant reads as zero here and is granted by its first
     * charge.
     */
    creditBalanceFor(userId),
  ]);

  return {
    tier,
    planName: plan.name,
    maxChannels: plan.maxChannels,
    maxVideosPerMonth: plan.maxVideosPerMonth,
    monthlyCredits: plan.monthlyCredits,
    features: plan.features,
    queuePriority: plan.queuePriority,
    usage: {
      period,
      channelsConnected: connected.length,
      videosStartedThisMonth: counter[0]?.videosStarted ?? 0,
      videosPublishedThisMonth: counter[0]?.videosPublished ?? 0,
    },
    credits: {
      available: credits.available,
      granted: credits.granted,
      purchased: credits.purchased,
      spent: credits.spent,
      grantedForTier: credits.grantedForTier,
    },
  };
}

/** Throw unless the plan includes a feature. */
export function requireFeature(tier: PlanTier, feature: FeatureKey): void {
  const plan = planByTier(tier);
  if (!plan.features[feature]) {
    throw new FeatureNotInPlanError(feature, plan.name);
  }
}

export function hasFeature(tier: PlanTier, feature: FeatureKey): boolean {
  return planByTier(tier).features[feature];
}

/**
 * Throw unless another channel may be connected. Called before the OAuth flow
 * starts, so the user is not sent to Google only to be refused on return.
 */
export async function assertCanConnectChannel(
  userId: string,
  tier: PlanTier,
): Promise<void> {
  const plan = planByTier(tier);
  if (plan.maxChannels === null) return;

  const connected = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.userId, userId), isNull(channels.disconnectedAt)));

  if (connected.length >= plan.maxChannels) {
    throw new PlanLimitError(
      plan.maxChannels === 1
        ? `${plan.name} includes one channel. Upgrade to connect more.`
        : `${plan.name} includes ${plan.maxChannels} channels. Upgrade to connect more.`,
      {
        limit: plan.maxChannels,
        used: connected.length,
        tier: plan.tier,
        resource: "channels",
      },
    );
  }
}

/**
 * Throw unless another video may be started this month.
 *
 * Counts *started*, not published: the monthly allowance pays for generation
 * work, and a video that was produced then abandoned still consumed it.
 */
export async function assertCanStartVideo(
  userId: string,
  tier: PlanTier,
): Promise<void> {
  const plan = planByTier(tier);
  if (plan.maxVideosPerMonth === null) return;

  const period = currentPeriod();
  const [counter] = await db
    .select({ videosStarted: usageCounters.videosStarted })
    .from(usageCounters)
    .where(
      and(eq(usageCounters.userId, userId), eq(usageCounters.period, period)),
    )
    .limit(1);

  const used = counter?.videosStarted ?? 0;
  if (used >= plan.maxVideosPerMonth) {
    throw new PlanLimitError(
      `${plan.name} includes ${plan.maxVideosPerMonth} videos a month and you have used all of them. Upgrade for unlimited videos.`,
      {
        limit: plan.maxVideosPerMonth,
        used,
        tier: plan.tier,
        resource: "videos",
      },
    );
  }
}

/**
 * BullMQ job priority. Lower numbers run first in BullMQ, so the plan's
 * queuePriority (higher = better) is inverted here.
 */
export function queuePriorityFor(tier: PlanTier): number {
  const plan = planByTier(tier);
  return 11 - plan.queuePriority;
}

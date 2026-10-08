/**
 * GET /api/auth/me
 *
 * The client's single source of truth for who is signed in, what plan they are
 * entitled to, and whether onboarding is complete. Plan data is read from the
 * database, never echoed from the client (§23).
 */
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { currentTier, handle, requireUser } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { db } from "@/lib/db";
import { channels, subscriptions } from "@/lib/db/schema";
import { and, isNull } from "drizzle-orm";
import { planByTier } from "@/lib/plans";

export async function GET(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireUser();
    // Three queries per call and polled by the client shell. The `read` rule's
    // ceiling is well above any real UI cadence.
    await enforce(rules().read, `me:${user.id}`);

    const tier = await currentTier(user.id);
    const plan = planByTier(tier);

    const [subscription] = await db
      .select({
        status: subscriptions.status,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
        trialEndsAt: subscriptions.trialEndsAt,
      })
      .from(subscriptions)
      .where(eq(subscriptions.userId, user.id))
      .limit(1);

    const connected = await db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(eq(channels.userId, user.id), isNull(channels.disconnectedAt)),
      );

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        emailVerified: user.emailVerifiedAt !== null,
        onboarded: user.onboardedAt !== null,
      },
      plan: {
        tier,
        name: plan.name,
        maxChannels: plan.maxChannels,
        maxVideosPerMonth: plan.maxVideosPerMonth,
        features: plan.features,
        status: subscription?.status ?? "active",
        currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
        trialEndsAt: subscription?.trialEndsAt ?? null,
      },
      channelCount: connected.length,
    };
  });
}

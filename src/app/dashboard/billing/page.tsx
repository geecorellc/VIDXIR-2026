/**
 * Plan & billing.
 *
 * The plan cards are the prototype's `PlanSelect` grid, reused here so upgrading
 * looks like the screen the user already saw at signup. Everything numeric comes
 * from `entitlementsFor()`, which reads the subscriptions and usage tables — the
 * client is never asked what plan it thinks it has (§23, §24).
 */
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { BillingPanel } from "@/components/billing/BillingPanel";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { getSession } from "@/lib/auth/session";
import { currentTier } from "@/lib/api/guard";
import { db } from "@/lib/db";
import { subscriptions } from "@/lib/db/schema";
import { entitlementsFor } from "@/lib/plans/enforce";
import { billingAvailability, canUpgrade } from "@/lib/billing";

export const metadata = { title: "Plan & billing — Tally" };

export default async function BillingPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=%2Fdashboard%2Fbilling");
  const userId = session.user.id;

  const tier = await currentTier(userId);
  const [entitlements, rows] = await Promise.all([
    entitlementsFor(userId, tier),
    db
      .select({
        status: subscriptions.status,
        provider: subscriptions.provider,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
        trialEndsAt: subscriptions.trialEndsAt,
      })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1),
  ]);

  const subscription = rows[0];
  const availability = billingAvailability();

  return (
    <div>
      <SectionHeader
        eyebrow="Billing"
        title="Plan & usage"
        sub="Change plans anytime — nothing is locked in."
      />
      <BillingPanel
        tier={tier}
        planName={entitlements.planName}
        usage={{
          period: entitlements.usage.period,
          channelsConnected: entitlements.usage.channelsConnected,
          maxChannels: entitlements.maxChannels,
          videosStartedThisMonth: entitlements.usage.videosStartedThisMonth,
          maxVideosPerMonth: entitlements.maxVideosPerMonth,
          videosPublishedThisMonth: entitlements.usage.videosPublishedThisMonth,
        }}
        subscription={{
          status: subscription?.status ?? "active",
          provider: subscription?.provider ?? "none",
          // Dates cross to the client as ISO strings; the panel formats them in
          // the viewer's locale.
          currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
          trialEndsAt: subscription?.trialEndsAt?.toISOString() ?? null,
        }}
        upgradeAvailable={availability.configured && canUpgrade()}
        missingBillingEnvVars={[
          ...availability.missingEnvVars,
          ...availability.missingPriceEnvVars,
        ]}
        billingProvider={availability.provider}
      />
    </div>
  );
}

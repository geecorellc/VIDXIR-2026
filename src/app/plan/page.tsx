/**
 * /plan — the prototype's plan-selection step, shown after signup.
 *
 * The prototype's `choosePlan()` set React state and the dashboard trusted it.
 * Here the page only *renders* the catalogue: the authoritative tier is read from
 * the subscriptions row, and continuing never writes a tier (§24).
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PlanChooser } from "@/components/billing/PlanChooser";
import { getSession } from "@/lib/auth/session";
import { currentTier } from "@/lib/api/guard";
import { billingAvailability, canUpgrade } from "@/lib/billing";

export const metadata: Metadata = { title: "Pick your setup — Tally" };

export default async function PlanPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=%2Fplan");

  const tier = await currentTier(session.user.id);
  const availability = billingAvailability();

  return (
    <PlanChooser
      currentTier={tier}
      upgradeAvailable={availability.configured && canUpgrade()}
      missingBillingEnvVars={[
        ...availability.missingEnvVars,
        ...availability.missingPriceEnvVars,
      ]}
      continueHref={session.user.onboardedAt ? "/dashboard" : "/onboarding"}
    />
  );
}

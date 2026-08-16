"use client";

/**
 * Plan chooser — the prototype's `PlanSelect` screen, shown straight after signup.
 *
 * Preserved: the centred logo, "Pick your setup", the "Change plans anytime —
 * nothing is locked in." line, the plan grid with Studio selected by default, and
 * the `Continue with {sel}` button with its trailing arrow.
 *
 * Changed: choosing "Studio" here does not make the account a Studio account. The
 * prototype set `plan` in React state and the dashboard believed it; §24 requires
 * the opposite — the tier follows a confirmed payment, and until checkout exists
 * this screen says so and continues onto onboarding on the free tier.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArrowRight, Info } from "lucide-react";
import { PlanCards } from "@/components/billing/PlanCards";
import { Btn } from "@/components/ui/Btn";
import { Card } from "@/components/ui/Card";
import { TallyLogo } from "@/components/ui/TallyLogo";
import { color, eyebrow, font } from "@/lib/design/tokens";
import { planByTier, type PlanTier } from "@/lib/plans";

export interface PlanChooserProps {
  /** The tier the database currently records for this user. */
  currentTier: PlanTier;
  /** Whether a paid plan can actually be purchased right now. */
  upgradeAvailable: boolean;
  missingBillingEnvVars: string[];
  /** Where "Continue" goes — onboarding for a new account, otherwise the dashboard. */
  continueHref: string;
}

export function PlanChooser({
  currentTier,
  upgradeAvailable,
  missingBillingEnvVars,
  continueHref,
}: PlanChooserProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The prototype defaulted to Studio; keep that, since it is also the plan the
  // "MOST POPULAR" badge points at.
  const [selected, setSelected] = useState<PlanTier>("studio");

  const paidSelected = selected !== "starter";
  const wouldNeedPayment = paidSelected && selected !== currentTier;

  function proceed() {
    startTransition(() => router.push(continueHref));
  }

  return (
    <div
      className="tally-scroll"
      style={{ minHeight: "100vh", overflowY: "auto", padding: "50px 20px" }}
    >
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <TallyLogo size={24} />
          <h1
            style={{
              fontFamily: font.display,
              fontSize: 32,
              fontWeight: 600,
              letterSpacing: 0.5,
              textTransform: "uppercase",
              color: color.text,
              margin: "22px 0 8px",
            }}
          >
            Pick your setup
          </h1>
          <p style={{ color: color.textDim, fontSize: 14.5, margin: 0 }}>
            Change plans anytime — nothing is locked in.
          </p>
        </div>

        <PlanCards
          selected={selected}
          onSelect={setSelected}
          currentTier={currentTier}
        />

        {wouldNeedPayment && !upgradeAvailable && (
          <Card tone="warning" pad={16} style={{ marginTop: 24 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <Info
                size={16}
                color={color.warning}
                style={{ marginTop: 2, flexShrink: 0 }}
                aria-hidden="true"
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ ...eyebrow, color: color.warning, marginBottom: 6 }}>
                  {planByTier(selected).name} needs payment
                </div>
                <p
                  style={{
                    margin: 0,
                    fontSize: 13,
                    lineHeight: 1.6,
                    color: color.textMuted,
                  }}
                >
                  Checkout is not available on this server
                  {missingBillingEnvVars.length > 0 ? (
                    <>
                      {" "}
                      —{" "}
                      <code style={{ fontFamily: font.mono, fontSize: 12 }}>
                        {missingBillingEnvVars.join(", ")}
                      </code>{" "}
                      {missingBillingEnvVars.length === 1 ? "is" : "are"} not set
                    </>
                  ) : null}
                  . You will continue on {planByTier(currentTier).name} and can upgrade
                  from Plan &amp; billing once payments are configured. Nothing is
                  charged and no paid feature is switched on.
                </p>
              </div>
            </div>
          </Card>
        )}

        <div style={{ textAlign: "center", marginTop: 32 }}>
          <Btn onClick={proceed} loading={pending}>
            {wouldNeedPayment && !upgradeAvailable
              ? `Continue on ${planByTier(currentTier).name}`
              : `Continue with ${planByTier(selected).name}`}{" "}
            <ArrowRight size={16} />
          </Btn>
        </div>
      </div>
    </div>
  );
}

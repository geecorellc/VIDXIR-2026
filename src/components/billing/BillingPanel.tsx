"use client";

/**
 * Plan & billing.
 *
 * Two things here are load-bearing for §23/§24:
 *
 *  1. Every number on this screen — the tier, the usage counts, the limits — was
 *     resolved server-side from the `subscriptions` and `usage_counters` tables.
 *     Selecting a card changes what is *highlighted*, never what the user is
 *     entitled to.
 *  2. When billing is not configured, there is no purchase button. The screen says
 *     which credential is missing instead of offering an upgrade that would fail
 *     silently or, worse, appear to work (§42, §48).
 */
import { useState } from "react";
import { CreditCard, Info } from "lucide-react";
import { PlanCards } from "@/components/billing/PlanCards";
import { Btn } from "@/components/ui/Btn";
import { Card } from "@/components/ui/Card";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { color, eyebrow, font } from "@/lib/design/tokens";
import type { PlanTier } from "@/lib/plans";

export interface BillingUsage {
  period: string;
  channelsConnected: number;
  maxChannels: number | null;
  videosStartedThisMonth: number;
  maxVideosPerMonth: number | null;
  videosPublishedThisMonth: number;
}

export interface BillingSubscription {
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: string | null;
  /** "none" until a real billing provider owns the subscription. */
  provider: string;
}

export interface BillingPanelProps {
  tier: PlanTier;
  planName: string;
  usage: BillingUsage;
  subscription: BillingSubscription;
  /** Whether a self-serve upgrade can actually be completed right now. */
  upgradeAvailable: boolean;
  /** Env vars an operator must set before upgrades work. */
  missingBillingEnvVars: string[];
  billingProvider: string;
}

export function BillingPanel({
  tier,
  planName,
  usage,
  subscription,
  upgradeAvailable,
  missingBillingEnvVars,
  billingProvider,
}: BillingPanelProps) {
  const [selected, setSelected] = useState<PlanTier>(tier);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ---------------------------------------------------------------- */}
      {/* Current plan + this month's usage                                 */}
      {/* ---------------------------------------------------------------- */}
      <Card>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
            marginBottom: 20,
          }}
        >
          <div>
            <div style={{ ...eyebrow, marginBottom: 7 }}>Current plan</div>
            <div
              style={{
                fontFamily: font.display,
                fontSize: 26,
                fontWeight: 600,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                color: color.text,
              }}
            >
              {planName}
            </div>
            <p
              style={{
                margin: "8px 0 0",
                fontSize: 12.5,
                lineHeight: 1.55,
                color: color.textDim,
              }}
            >
              {planSummary(subscription)}
            </p>
          </div>

          {subscription.provider === "none" ? (
            <span
              style={{
                fontSize: 11.5,
                color: color.textFaint,
                fontFamily: font.body,
                maxWidth: 260,
                lineHeight: 1.55,
              }}
            >
              No payment method on file — you are on the free tier.
            </span>
          ) : (
            <Btn variant="ghost" disabled icon={<CreditCard size={14} />}>
              Manage payment
            </Btn>
          )}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 18,
          }}
        >
          <UsageMeter
            label="Channels connected"
            used={usage.channelsConnected}
            limit={usage.maxChannels}
          />
          <UsageMeter
            label={`Videos started · ${usage.period}`}
            used={usage.videosStartedThisMonth}
            limit={usage.maxVideosPerMonth}
          />
          <UsageMeter
            label={`Published · ${usage.period}`}
            used={usage.videosPublishedThisMonth}
            limit={null}
          />
        </div>
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* Plan comparison                                                   */}
      {/* ---------------------------------------------------------------- */}
      <div>
        <div style={{ ...eyebrow, marginBottom: 12 }}>Plans</div>
        <PlanCards selected={selected} onSelect={setSelected} currentTier={tier} />
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Upgrade action, or an honest reason there isn't one                */}
      {/* ---------------------------------------------------------------- */}
      {upgradeAvailable ? (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <Btn disabled={selected === tier}>
            {selected === tier ? `You're on ${planName}` : `Switch to ${labelFor(selected)}`}
          </Btn>
          <span style={{ fontSize: 12, color: color.textFaint }}>
            Change plans anytime — nothing is locked in.
          </span>
        </div>
      ) : (
        <Card tone="warning" pad={16}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <Info
              size={16}
              color={color.warning}
              style={{ marginTop: 2, flexShrink: 0 }}
              aria-hidden="true"
            />
            <div style={{ minWidth: 0 }}>
              <div style={{ ...eyebrow, color: color.warning, marginBottom: 6 }}>
                Checkout unavailable
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: 13,
                  lineHeight: 1.6,
                  color: color.textMuted,
                }}
              >
                {missingBillingEnvVars.length > 0 ? (
                  <>
                    Paid plans cannot be purchased because this server has no billing
                    credentials. An operator needs to set{" "}
                    <code style={{ fontFamily: font.mono, fontSize: 12 }}>
                      {missingBillingEnvVars.join(", ")}
                    </code>
                    .
                  </>
                ) : (
                  <>
                    Self-serve checkout through {billingProvider} is not switched on for
                    this deployment yet. Your plan is whatever the billing records say
                    it is — nothing on this screen can change it.
                  </>
                )}
              </p>
              <p
                style={{
                  margin: "10px 0 0",
                  fontSize: 12,
                  lineHeight: 1.6,
                  color: color.textFaint,
                }}
              >
                Paid features stay locked until a real payment is confirmed, so
                selecting a card above does not grant anything.
              </p>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function UsageMeter({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number | null;
}) {
  const pct = limit === null || limit === 0 ? 0 : Math.min(100, (used / limit) * 100);
  const atLimit = limit !== null && used >= limit;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <span style={eyebrow}>{label}</span>
        <span
          style={{
            fontFamily: font.display,
            fontSize: 15,
            fontWeight: 600,
            color: atLimit ? color.warning : color.text,
          }}
        >
          {limit === null ? used : `${used} / ${limit}`}
        </span>
      </div>
      {limit === null ? (
        <div style={{ fontSize: 11.5, color: color.textFaint }}>Unlimited</div>
      ) : (
        <ProgressBar
          pct={pct}
          color={atLimit ? color.warning : color.accent}
          label={label}
        />
      )}
    </div>
  );
}

function labelFor(tier: PlanTier): string {
  return tier === "starter" ? "Starter" : tier === "studio" ? "Studio" : "Scale";
}

/** Plain-language state of the subscription, with no invented renewal dates. */
function planSummary(subscription: BillingSubscription): string {
  if (subscription.trialEndsAt) {
    return `Trial ends ${formatDate(subscription.trialEndsAt)}.`;
  }
  if (subscription.cancelAtPeriodEnd && subscription.currentPeriodEnd) {
    return `Cancels ${formatDate(subscription.currentPeriodEnd)}. Paid features stay on until then.`;
  }
  if (subscription.status === "past_due") {
    return "The last payment failed. Paid features are suspended until it clears.";
  }
  if (subscription.currentPeriodEnd) {
    return `Renews ${formatDate(subscription.currentPeriodEnd)}.`;
  }
  return "No renewal date — this plan has no billing period.";
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "on an unknown date"
    : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

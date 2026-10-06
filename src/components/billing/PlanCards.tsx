"use client";

/**
 * Plan cards — ported from the prototype's `PlanSelect` grid.
 *
 * Preserved exactly: the auto-fit 240px grid, the red border plus red glow on the
 * selected card, the floating `MOST POPULAR` badge at top -10/left 20, the 32px
 * Oswald price with the cadence beside it, the red check bullets, and the radio
 * dot in the bottom-right corner.
 *
 * Changed: the prototype's `plans` array is gone. Copy and limits come from
 * `PLAN_CATALOG`, which is also what the server enforces against — so a card can
 * never advertise a limit the backend does not apply (§23).
 */
import { Check } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { accentRing, color, font, radius } from "@/lib/design/tokens";
import { PLAN_CATALOG, formatPrice, type PlanTier } from "@/lib/plans";

/** One-line positioning copy, kept verbatim from the prototype's `blurb`. */
const BLURB: Record<PlanTier, string> = {
  starter: "Try the full loop on one channel.",
  studio: "For a channel you're actually growing.",
  scale: "Run a network, not just a channel.",
};

export interface PlanCardsProps {
  /** Which card shows as selected. */
  selected: PlanTier;
  onSelect: (tier: PlanTier) => void;
  /** The plan the database says the user is on; gets a "Current plan" marker. */
  currentTier?: PlanTier;
}

export function PlanCards({ selected, onSelect, currentTier }: PlanCardsProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Plans"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        gap: 16,
      }}
    >
      {PLAN_CATALOG.map((plan) => {
        const active = plan.tier === selected;
        const current = plan.tier === currentTier;

        return (
          <Card
            key={plan.tier}
            style={{
              position: "relative",
              display: "flex",
              flexDirection: "column",
              borderColor: active ? color.accent : color.border,
              boxShadow: active
                ? accentRing
                : "none",
              padding: 0,
            }}
          >
            {plan.highlight && (
              <span
                style={{
                  position: "absolute",
                  top: -10,
                  left: 20,
                  background: color.accent,
                  color: color.onAccent,
                  fontSize: 10.5,
                  fontWeight: 700,
                  padding: "3px 9px",
                  borderRadius: radius.pill,
                  letterSpacing: "0.04em",
                  zIndex: 1,
                }}
              >
                MOST POPULAR
              </span>
            )}

            {/*
              A real radio input rather than a clickable div: the prototype's cards
              were unreachable by keyboard, and this grid is a single choice.
            */}
            <label
              style={{
                display: "flex",
                flexDirection: "column",
                flex: 1,
                padding: 20,
                cursor: "pointer",
              }}
            >
              <input
                type="radio"
                name="plan"
                value={plan.tier}
                checked={active}
                onChange={() => onSelect(plan.tier)}
                style={{
                  position: "absolute",
                  width: 1,
                  height: 1,
                  opacity: 0,
                  pointerEvents: "none",
                }}
              />

              <h3
                style={{
                  fontFamily: font.display,
                  fontSize: 18,
                  fontWeight: 600,
                  letterSpacing: 0.4,
                  textTransform: "uppercase",
                  color: color.text,
                  margin: "6px 0 2px",
                }}
              >
                {plan.name}
              </h3>
              <p
                style={{
                  fontSize: 13,
                  color: color.textDim,
                  margin: "0 0 16px",
                  lineHeight: 1.55,
                }}
              >
                {BLURB[plan.tier]}
              </p>

              <div style={{ marginBottom: 18 }}>
                <span
                  style={{
                    fontFamily: font.display,
                    fontSize: 32,
                    fontWeight: 700,
                    letterSpacing: 0.4,
                    color: color.text,
                  }}
                >
                  {plan.priceCents === 0 ? "Free" : formatPrice(plan.priceCents)}
                </span>
                {plan.priceCents !== 0 && (
                  <span style={{ color: color.textDim, fontSize: 13 }}>
                    {plan.cadence}
                  </span>
                )}
              </div>

              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  gap: 9,
                  marginBottom: 20,
                }}
              >
                {plan.bullets.map((bullet) => (
                  <span
                    key={bullet}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "flex-start",
                      fontSize: 13,
                      lineHeight: 1.45,
                      color: color.textBright,
                    }}
                  >
                    <Check
                      size={14}
                      color={color.accent}
                      style={{ marginTop: 2, flexShrink: 0 }}
                      aria-hidden="true"
                    />
                    {bullet}
                  </span>
                ))}
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                    fontFamily: font.display,
                    color: current ? color.positive : "transparent",
                  }}
                >
                  {current ? "Current plan" : " "}
                </span>
                <span
                  aria-hidden="true"
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    flexShrink: 0,
                    border: `2px solid ${active ? color.accent : color.controlBorder}`,
                    background: active ? color.accent : "transparent",
                  }}
                />
              </div>
            </label>
          </Card>
        );
      })}
    </div>
  );
}

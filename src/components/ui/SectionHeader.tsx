/**
 * Section header (eyebrow / title / sub) and the empty-state CTA card.
 * Both ported from the prototype's `SectionHeader` and `EmptyCTA`.
 */
import type { ReactNode } from "react";
import { color, display, eyebrow, font } from "@/lib/design/tokens";
import { Card } from "./Card";

export interface SectionHeaderProps {
  eyebrow?: string;
  title: string;
  sub?: ReactNode;
  /** Right-aligned actions, e.g. a Regenerate button. */
  actions?: ReactNode;
}

export function SectionHeader({
  eyebrow: eyebrowText,
  title,
  sub,
  actions,
}: SectionHeaderProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
        marginBottom: 20,
      }}
    >
      <div style={{ minWidth: 0 }}>
        {eyebrowText && (
          <div style={{ ...eyebrow, marginBottom: 7 }}>{eyebrowText}</div>
        )}
        <h1 style={display(25)}>{title}</h1>
        {sub && (
          <p
            style={{
              margin: "9px 0 0",
              fontSize: 13.5,
              lineHeight: 1.6,
              color: color.textDim,
              maxWidth: 620,
            }}
          >
            {sub}
          </p>
        )}
      </div>
      {actions && (
        <div style={{ display: "flex", gap: 9, flexShrink: 0 }}>{actions}</div>
      )}
    </div>
  );
}

export interface EmptyCTAProps {
  icon?: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}

/**
 * Empty state. The prototype used this to gate the Video and Publish tabs behind
 * "generate a script first"; production keeps that gating but drives it from
 * persisted project status rather than React state.
 */
export function EmptyCTA({ icon, title, body, action }: EmptyCTAProps) {
  return (
    <Card pad={34}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          gap: 12,
        }}
      >
        {icon && <div style={{ color: color.textFaint }}>{icon}</div>}
        <div
          style={{
            fontFamily: font.display,
            fontSize: 16,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            color: color.text,
          }}
        >
          {title}
        </div>
        <p
          style={{
            margin: 0,
            fontSize: 13,
            lineHeight: 1.65,
            color: color.textDim,
            maxWidth: 420,
          }}
        >
          {body}
        </p>
        {action && <div style={{ marginTop: 6 }}>{action}</div>}
      </div>
    </Card>
  );
}

/**
 * Card — the prototype's panel surface (#141216, 1px #241F22, radius 12, pad 20).
 * `pad` and `tone` are additions so callers stop re-declaring inline overrides.
 */
import type { CSSProperties, ReactNode } from "react";
import { color, radius } from "@/lib/design/tokens";

export interface CardProps {
  children: ReactNode;
  /** Padding in px. The prototype's default is 20. */
  pad?: number;
  /** `accent` tints the border red for selected/active cards. */
  tone?: "default" | "accent" | "dashed" | "warning";
  style?: CSSProperties;
  className?: string;
}

export function Card({
  children,
  pad = 20,
  tone = "default",
  style,
  className,
}: CardProps) {
  const border =
    tone === "accent"
      ? `1px solid ${color.accent}`
      : tone === "warning"
        ? `1px solid #4A3A20`
        : tone === "dashed"
          ? `1px dashed ${color.borderLight}`
          : `1px solid ${color.border}`;

  return (
    <div
      className={className}
      style={{
        background: tone === "dashed" ? "transparent" : color.card,
        border,
        borderRadius: radius.lg,
        padding: pad,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

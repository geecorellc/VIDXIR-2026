"use client";

/**
 * Button — ported from the prototype's `Btn` with its three variants
 * (primary / ghost / subtle) and the brightness-filter hover.
 *
 * Production additions over the prototype:
 *  - renders a real <button> with type="button" by default, so it cannot
 *    accidentally submit a form
 *  - `loading` shows a spinner and blocks repeat clicks, which the prototype
 *    could not express because its "generating" state lived elsewhere
 *  - disabled state is communicated with aria-disabled as well as opacity
 */
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useState } from "react";
import { color, font, radius } from "@/lib/design/tokens";

export type BtnVariant = "primary" | "ghost" | "subtle" | "danger";
export type BtnSize = "sm" | "md";

export interface BtnProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "style"> {
  variant?: BtnVariant;
  size?: BtnSize;
  loading?: boolean;
  /** Leading icon element, e.g. <Sparkles size={14} />. */
  icon?: ReactNode;
  full?: boolean;
  children?: ReactNode;
}

const VARIANT_STYLE: Record<
  BtnVariant,
  { background: string; color: string; border: string }
> = {
  primary: {
    background: color.accent,
    color: "#FFFFFF",
    border: `1px solid ${color.accent}`,
  },
  ghost: {
    background: "transparent",
    color: color.textBright,
    border: `1px solid ${color.borderLight}`,
  },
  subtle: {
    background: color.subtle,
    color: color.text,
    border: `1px solid ${color.border}`,
  },
  danger: {
    background: "transparent",
    color: color.rose,
    border: `1px solid #4A2A2A`,
  },
};

export function Btn({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  full = false,
  disabled,
  children,
  ...rest
}: BtnProps) {
  const [hover, setHover] = useState(false);
  const isDisabled = Boolean(disabled) || loading;
  const palette = VARIANT_STYLE[variant];

  return (
    <button
      type="button"
      {...rest}
      disabled={isDisabled}
      aria-disabled={isDisabled}
      aria-busy={loading}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        width: full ? "100%" : undefined,
        padding: size === "sm" ? "7px 12px" : "10px 16px",
        fontFamily: font.body,
        fontSize: size === "sm" ? 12.5 : 13.5,
        fontWeight: 600,
        letterSpacing: 0.2,
        borderRadius: radius.md,
        cursor: isDisabled ? "not-allowed" : "pointer",
        opacity: isDisabled ? 0.5 : 1,
        // The prototype's hover effect: brighten rather than change colour.
        filter: hover && !isDisabled ? "brightness(1.12)" : "none",
        transition: "filter 140ms ease, opacity 140ms ease",
        whiteSpace: "nowrap",
        ...palette,
      }}
    >
      {loading ? (
        <Loader2 size={14} className="tally-spin" aria-hidden="true" />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}

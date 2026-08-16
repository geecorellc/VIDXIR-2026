/**
 * Shared frame for the narrow auth screens (forgot password, reset password,
 * email verification). Same card geometry as `AuthForm` so the flow does not
 * visually jump between steps.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { TallyLogo } from "@/components/ui/TallyLogo";
import { color, display, font, radius } from "@/lib/design/tokens";

export interface AuthShellProps {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  /** Link shown beneath the card. Defaults to the login page. */
  footerHref?: string;
  footerLabel?: string;
}

export function AuthShell({
  title,
  intro,
  children,
  footerHref = "/login",
  footerLabel = "Back to log in",
}: AuthShellProps) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 20px",
        position: "relative",
      }}
    >
      <div className="grain" aria-hidden="true" />

      <div style={{ position: "relative", width: "100%", maxWidth: 404 }}>
        <div
          style={{ display: "flex", justifyContent: "center", marginBottom: 26 }}
        >
          <TallyLogo size={17} />
        </div>

        <div
          style={{
            background: color.card,
            border: `1px solid ${color.border}`,
            borderRadius: radius.lg,
            padding: 26,
          }}
        >
          <h1 style={{ ...display(21), marginBottom: intro ? 6 : 20 }}>{title}</h1>
          {intro && (
            <p
              style={{
                margin: "0 0 22px",
                fontSize: 13,
                lineHeight: 1.6,
                color: color.textDim,
              }}
            >
              {intro}
            </p>
          )}
          {children}
        </div>

        <div style={{ marginTop: 20, textAlign: "center" }}>
          <Link
            href={footerHref}
            style={{
              fontFamily: font.display,
              fontSize: 11,
              letterSpacing: 1.3,
              textTransform: "uppercase",
              color: color.textFaint,
              textDecoration: "none",
            }}
          >
            {footerLabel}
          </Link>
        </div>
      </div>
    </div>
  );
}

/** Inline status banner used across the auth screens. */
export function AuthNotice({
  tone,
  children,
}: {
  tone: "error" | "success" | "info";
  children: ReactNode;
}) {
  const palette =
    tone === "error"
      ? { bg: "#2A1618", border: "#4A2A2A", fg: color.rose }
      : tone === "success"
        ? { bg: "#132218", border: "#23402C", fg: color.positive }
        : { bg: color.subtle, border: color.border, fg: color.textDim };

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      style={{
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: radius.md,
        padding: "10px 12px",
        fontSize: 12.5,
        lineHeight: 1.55,
        color: palette.fg,
        marginBottom: 16,
      }}
    >
      {children}
    </div>
  );
}

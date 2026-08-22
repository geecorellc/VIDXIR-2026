/**
 * 404 page.
 *
 * A server component: nothing here is interactive, so there is no reason to ship
 * it to the browser. It also completes the set of error components the App Router
 * looks for — Next resolves `not-found` alongside the error boundaries when it
 * renders a non-200, and a missing one is part of what leaves the framework with
 * nothing to render.
 */
import Link from "next/link";
import { TallyLogo } from "@/components/ui/TallyLogo";
import { color, font, radius } from "@/lib/design/tokens";

export default function NotFound() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        gap: 22,
      }}
    >
      <TallyLogo size={14} />

      <div style={{ textAlign: "center", maxWidth: 440 }}>
        <div
          style={{
            fontFamily: font.display,
            fontSize: 11,
            letterSpacing: 1.4,
            textTransform: "uppercase",
            color: color.textFaint,
            marginBottom: 12,
          }}
        >
          Error 404
        </div>

        <h1
          style={{
            fontFamily: font.display,
            textTransform: "uppercase",
            fontSize: 26,
            lineHeight: 1.15,
            margin: "0 0 12px",
            color: color.text,
          }}
        >
          This page does not exist
        </h1>

        <p
          style={{
            margin: "0 0 24px",
            fontSize: 14,
            lineHeight: 1.65,
            color: color.textDim,
          }}
        >
          The link may be out of date, or the project it pointed to may have been
          deleted.
        </p>

        <Link
          href="/dashboard"
          style={{
            display: "inline-block",
            padding: "11px 20px",
            background: color.accent,
            color: "#fff",
            borderRadius: radius.md,
            fontSize: 14,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}

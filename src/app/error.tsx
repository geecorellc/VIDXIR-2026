"use client";

/** Reloading starts a fresh server render and clears a failed cached route. */
import { useEffect } from "react";
import { color, font, radius } from "@/lib/design/tokens";

export default function RouteError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Client-visible surface of a server-side throw. The server has the stack;
    // this records that the user actually saw a failure, with the digest as the
    // join key between the two.
    console.error("route error boundary", {
      digest: error.digest,
      message: error.message,
    });
  }, [error]);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: color.bg,
      }}
    >
      <div
        style={{
          maxWidth: 520,
          width: "100%",
          background: color.card,
          border: `1px solid ${color.border}`,
          borderRadius: radius.lg,
          padding: 28,
        }}
      >
        <div
          style={{
            fontFamily: font.display,
            fontSize: 11,
            letterSpacing: 1.4,
            textTransform: "uppercase",
            color: color.accent,
            marginBottom: 14,
          }}
        >
          Something went wrong
        </div>

        <h1
          style={{
            fontFamily: font.display,
            textTransform: "uppercase",
            fontSize: 24,
            lineHeight: 1.15,
            margin: "0 0 12px",
            color: color.text,
          }}
        >
          This page could not be loaded
        </h1>

        <p
          style={{
            margin: "0 0 22px",
            fontSize: 14,
            lineHeight: 1.65,
            color: color.textDim,
          }}
        >
          Try again to reload this page, or return to your dashboard. If the
          problem continues, share the reference below with support.
        </p>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: "11px 20px",
              background: color.accent,
              color: color.onAccent,
              border: `1px solid ${color.accent}`,
              borderRadius: radius.md,
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          <a
            href="/dashboard"
            style={{
              padding: "11px 20px",
              background: "transparent",
              border: `1px solid ${color.borderLight}`,
              color: color.textBright,
              borderRadius: radius.md,
              fontSize: 14,
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            Back to dashboard
          </a>
        </div>

        {error.digest ? (
          <p
            style={{
              margin: "20px 0 0",
              fontFamily: font.mono,
              fontSize: 11.5,
              color: color.textFaint,
            }}
          >
            Reference: {error.digest}
          </p>
        ) : null}
      </div>
    </div>
  );
}

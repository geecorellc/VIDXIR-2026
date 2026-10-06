"use client";

/**
 * Route error boundary (§3, §30).
 *
 * The App Router needs a client error component to render *any* server-side
 * throw below the root layout. Without one, Next falls back to the framework's
 * internal error page — and in development, when that fallback cannot be
 * resolved either, the browser is handed the bare
 * `missing required error components, refreshing...` document, which reveals
 * nothing about what actually failed and reload-loops.
 *
 * This does not swallow anything. `reset()` re-renders the segment, which is the
 * right affordance for the transient class of failure Vidxir AI actually produces
 * (a provider timing out, Redis briefly unreachable); anything structural throws
 * again immediately and lands back here. The real diagnosis stays on the server:
 * a thrown error is already logged there with its stack and trace id, and §33
 * forbids putting provider detail in front of a browser — so what is shown here
 * is the framework-supplied `digest`, which is the handle an operator uses to
 * find that server log line.
 */
import Link from "next/link";
import { useEffect } from "react";
import { color, font, radius } from "@/lib/design/tokens";

export default function RouteError({
  error,
  reset,
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
          The error has been logged. Trying again is worth a moment — most
          failures here are a provider or queue being briefly unavailable rather
          than anything wrong with your project.
        </p>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: "11px 20px",
              background: color.accent,
              color: "#fff",
              border: `1px solid ${color.accent}`,
              borderRadius: radius.md,
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          <Link
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
          </Link>
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

"use client";

/**
 * Root error boundary — the last one (§3).
 *
 * `error.tsx` renders *inside* the root layout, so it cannot catch a throw from
 * the root layout itself. This one replaces the whole document, which is why it
 * has to supply its own `<html>` and `<body>`: at this point React has nothing
 * else mounted.
 *
 * It is deliberately dependency-free — no `GlobalStyle`, no `Link`, no token
 * import. If a shared module is what threw, a boundary that imports it throws
 * too, and a boundary that throws is the exact condition that produces
 * `missing required error components`. The palette is inlined here for that
 * reason, not by oversight; the duplication buys the guarantee that this file
 * can always render.
 */
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("global error boundary", {
      digest: error.digest,
      message: error.message,
    });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "#0B0A0C",
          color: "#F5F3F1",
          fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 520,
            width: "100%",
            background: "#141216",
            border: "1px solid #241F22",
            borderRadius: 12,
            padding: 28,
          }}
        >
          <div
            style={{
              fontFamily: "Oswald, 'Arial Narrow', sans-serif",
              fontSize: 11,
              letterSpacing: 1.4,
              textTransform: "uppercase",
              color: "#E8332B",
              marginBottom: 14,
            }}
          >
            Tally could not start
          </div>

          <h1
            style={{
              fontFamily: "Oswald, 'Arial Narrow', sans-serif",
              textTransform: "uppercase",
              fontSize: 24,
              lineHeight: 1.15,
              margin: "0 0 12px",
            }}
          >
            The application failed to load
          </h1>

          <p
            style={{
              margin: "0 0 22px",
              fontSize: 14,
              lineHeight: 1.65,
              color: "#948B8E",
            }}
          >
            This is a failure in the application shell rather than in one page.
            The error has been logged with the reference below.
          </p>

          <button
            type="button"
            onClick={reset}
            style={{
              padding: "11px 20px",
              background: "#E8332B",
              color: "#fff",
              border: "1px solid #E8332B",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload
          </button>

          {error.digest ? (
            <p
              style={{
                margin: "20px 0 0",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 11.5,
                color: "#6E666A",
              }}
            >
              Reference: {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}

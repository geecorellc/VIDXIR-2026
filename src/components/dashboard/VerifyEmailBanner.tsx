"use client";

/**
 * Unverified-email reminder (§4).
 *
 * Non-blocking: an unverified user can still explore the studio. Publishing is
 * the action that requires a verified address, and that check lives server-side
 * at the publish endpoint — this banner is the prompt, not the enforcement.
 */
import { useState } from "react";
import { MailWarning, X } from "lucide-react";
import { color, radius } from "@/lib/design/tokens";
import { api, messageOf } from "@/services/api-client";

export function VerifyEmailBanner({ name }: { name: string }) {
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (dismissed) return null;

  async function resend() {
    setSending(true);
    setError(null);
    try {
      await api.put("/api/auth/verify-email");
      setSent(true);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        background: "#221A10",
        border: "1px solid #4A3A20",
        borderRadius: radius.md,
        padding: "11px 13px",
        marginBottom: 20,
      }}
    >
      <MailWarning size={16} color={color.warning} aria-hidden="true" />
      <span style={{ flex: 1, minWidth: 200, fontSize: 12.5, lineHeight: 1.55, color: color.textBright }}>
        {error
          ? error
          : sent
            ? "Verification email sent — check your inbox."
            : `${name}, confirm your email address to enable publishing.`}
      </span>
      {!sent && (
        <button
          type="button"
          onClick={resend}
          disabled={sending}
          style={{
            background: "transparent",
            border: `1px solid ${color.borderLight}`,
            borderRadius: radius.sm,
            padding: "6px 11px",
            fontSize: 12,
            fontWeight: 600,
            color: color.textBright,
            cursor: sending ? "wait" : "pointer",
          }}
        >
          {sending ? "Sending…" : "Resend"}
        </button>
      )}
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        style={{
          background: "transparent",
          border: "none",
          color: color.textFaint,
          cursor: "pointer",
          padding: 4,
          display: "inline-flex",
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}

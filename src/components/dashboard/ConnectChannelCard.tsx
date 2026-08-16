"use client";

/**
 * "Add a channel" — the prototype's dashed tile, wired to the real OAuth flow.
 *
 * Connecting is a plain navigation to `/api/channels/connect`, which builds the
 * Google consent URL server-side and redirects. Doing it that way keeps the
 * client id, the state nonce and the scope list out of the browser bundle (§34),
 * and means the user's credentials only ever go to Google (§6).
 *
 * When the flow is unavailable — plan limit reached, or the server has no Google
 * credentials — the tile explains why instead of failing on click (§37).
 */
import { AlertCircle, Plus } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Btn } from "@/components/ui/Btn";
import { color, radius } from "@/lib/design/tokens";

export interface ConnectChannelCardProps {
  variant?: "card" | "button";
  disabled?: boolean;
  /** Shown in place of the prompt when disabled. */
  reason?: string;
}

const CONNECT_URL = "/api/channels/connect";

export function ConnectChannelCard({
  variant = "card",
  disabled = false,
  reason,
}: ConnectChannelCardProps) {
  function connect() {
    // A full-page navigation, not fetch(): Google's consent screen has to be
    // rendered in the top-level window.
    window.location.assign(CONNECT_URL);
  }

  if (variant === "button") {
    return (
      <Btn onClick={connect} disabled={disabled} icon={<Plus size={15} />}>
        Connect a YouTube channel
      </Btn>
    );
  }

  return (
    <Card
      tone="dashed"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: 8,
        minHeight: 130,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <button
        type="button"
        onClick={connect}
        disabled={disabled}
        aria-disabled={disabled}
        style={{
          all: "unset",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          cursor: disabled ? "not-allowed" : "pointer",
          borderRadius: radius.md,
        }}
      >
        {disabled ? (
          <AlertCircle size={20} color={color.warning} aria-hidden="true" />
        ) : (
          <Plus size={20} color={color.textDim} aria-hidden="true" />
        )}
        <span style={{ fontSize: 13, color: color.textDim }}>
          Add a channel
        </span>
        {disabled && reason && (
          <span
            style={{
              fontSize: 11.5,
              lineHeight: 1.5,
              color: color.textFaint,
              maxWidth: 180,
            }}
          >
            {reason}
          </span>
        )}
      </button>
    </Card>
  );
}

/**
 * Outcome of a Google authorisation round-trip (§37).
 *
 * `/api/channels/connect` and `/api/channels/callback` are navigations, so they
 * report back through a `?connect=` code rather than a JSON body. This turns each
 * code into copy that says what actually happened and what to do next — the
 * alternative is a redirect that silently looks like nothing occurred.
 *
 * `partial_scopes` and `no_channel` matter most: both are "we saved something,
 * but it will not publish yet", and collapsing them into "connected" would be the
 * kind of optimistic half-truth §42 forbids.
 */
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { color, font } from "@/lib/design/tokens";

export type ConnectResultCode =
  | "connected"
  | "reconnected"
  | "partial_scopes"
  | "denied"
  | "no_channel"
  | "invalid_state"
  | "wrong_account"
  | "not_configured"
  | "plan_limit"
  | "rate_limited"
  | "forbidden"
  | "error";

type Tone = "success" | "warning" | "info";

interface Message {
  tone: Tone;
  title: string;
  body: string;
}

const MESSAGES: Record<ConnectResultCode, Message> = {
  connected: {
    tone: "success",
    title: "Channel connected",
    body: "Vidxir AI can now read your channel and publish on your behalf. Statistics have been fetched.",
  },
  reconnected: {
    tone: "success",
    title: "Channel reconnected",
    body: "Access was renewed. Any work that was waiting on authorisation can continue.",
  },
  partial_scopes: {
    tone: "warning",
    title: "Connected, but not everything was granted",
    body:
      "The channel is saved, but Vidxir AI was not given the permissions it needs to upload. " +
      "Reconnect and accept all the requested permissions before publishing.",
  },
  denied: {
    tone: "info",
    title: "Authorisation cancelled",
    body: "Nothing was connected. You can start again whenever you are ready.",
  },
  no_channel: {
    tone: "warning",
    title: "That Google account has no YouTube channel",
    body:
      "Create a channel on YouTube first, then connect it here. Vidxir AI cannot publish to an " +
      "account without one.",
  },
  invalid_state: {
    tone: "warning",
    title: "That connection link expired",
    body: "Connection links are single-use and short-lived. Start the connection again.",
  },
  wrong_account: {
    tone: "warning",
    title: "That was a different YouTube channel",
    body:
      "You were reconnecting an existing channel, but authorised a different one. Sign in to " +
      "the matching Google account, or connect it as a new channel.",
  },
  not_configured: {
    tone: "warning",
    title: "YouTube is not configured on this server",
    body:
      "Connecting needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Until they are set, the " +
      "OAuth flow is unavailable — Vidxir AI will not pretend a channel is linked.",
  },
  plan_limit: {
    tone: "warning",
    title: "Channel limit reached",
    body: "Your plan does not include another channel. Upgrade to connect more.",
  },
  rate_limited: {
    tone: "info",
    title: "Too many attempts",
    body: "Wait a moment before starting another connection.",
  },
  forbidden: {
    tone: "warning",
    title: "That channel is not available",
    body: "The channel you tried to reconnect does not belong to this account.",
  },
  error: {
    tone: "warning",
    title: "The connection did not complete",
    body:
      "Something went wrong talking to Google and nothing was saved. Try again; if it keeps " +
      "failing, the server log has the trace id.",
  },
};

const TONE_STYLE: Record<Tone, { accent: string; cardTone: "accent" | "warning" }> = {
  success: { accent: color.positive, cardTone: "accent" },
  warning: { accent: color.warning, cardTone: "warning" },
  info: { accent: color.info, cardTone: "warning" },
};

export function isConnectResultCode(value: string): value is ConnectResultCode {
  return value in MESSAGES;
}

export function ConnectResultBanner({ code }: { code: ConnectResultCode }) {
  const message = MESSAGES[code];
  const tone = TONE_STYLE[message.tone];
  const Icon =
    message.tone === "success"
      ? CheckCircle2
      : message.tone === "info"
        ? Info
        : AlertTriangle;

  return (
    <Card tone={tone.cardTone} pad={16} style={{ marginBottom: 16 }}>
      <div
        role="status"
        style={{ display: "flex", gap: 12, alignItems: "flex-start" }}
      >
        <Icon
          size={16}
          color={tone.accent}
          style={{ marginTop: 2, flexShrink: 0 }}
          aria-hidden="true"
        />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontFamily: font.display,
              fontSize: 11,
              letterSpacing: 1.3,
              textTransform: "uppercase",
              color: tone.accent,
              marginBottom: 6,
            }}
          >
            {message.title}
          </div>
          <p
            style={{
              margin: 0,
              fontSize: 13,
              lineHeight: 1.6,
              color: color.textMuted,
            }}
          >
            {message.body}
          </p>
        </div>
      </div>
    </Card>
  );
}

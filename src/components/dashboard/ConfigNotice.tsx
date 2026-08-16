/**
 * Provider configuration notice (§42, §48).
 *
 * When a capability has no credentials, the feature that depends on it says so —
 * naming the exact env vars an operator has to set. This is the visible half of
 * the rule that Tally never fakes success: an unconfigured provider produces a
 * banner and a disabled action, not a fabricated result.
 *
 * The mock state gets its own, louder treatment. Mock providers exist so the
 * pipeline can be exercised in development (§40); anything the user sees while
 * they are active must be labelled as not real.
 */
import { AlertTriangle, KeyRound, FlaskConical } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { color, font, radius } from "@/lib/design/tokens";
import type { CapabilityStatus } from "@/lib/providers/config";

export function ConfigNotice({ status }: { status: CapabilityStatus }) {
  if (status.state === "ready") return null;

  const mock = status.state === "mock";
  const Icon = mock ? FlaskConical : AlertTriangle;

  return (
    <Card tone="warning" pad={16} style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <Icon
          size={16}
          color={color.warning}
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
              color: color.warning,
              marginBottom: 6,
            }}
          >
            {mock
              ? `${status.label} · mock provider`
              : `${status.label} · not configured`}
          </div>
          <p
            style={{
              margin: 0,
              fontSize: 13,
              lineHeight: 1.6,
              color: color.textMuted,
            }}
          >
            {mock ? (
              <>
                Tally is using a development stand-in for {status.label.toLowerCase()}.
                Anything it produces is placeholder output and must not be treated
                as a finished asset.
              </>
            ) : (
              <>
                This step needs credentials before it can run. Nothing will be
                generated until they are set.
              </>
            )}
          </p>

          {status.missingEnvVars.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                marginTop: 10,
              }}
            >
              {status.missingEnvVars.map((name) => (
                <code
                  key={name}
                  style={{
                    fontFamily: font.mono,
                    fontSize: 11.5,
                    background: color.inputBg,
                    border: `1px solid ${color.border}`,
                    borderRadius: radius.sm,
                    padding: "4px 8px",
                    color: color.textBright,
                  }}
                >
                  {name}
                </code>
              ))}
            </div>
          )}

          {status.hint && (
            <p
              style={{
                margin: "10px 0 0",
                fontSize: 12,
                lineHeight: 1.55,
                color: color.textFaint,
                display: "flex",
                gap: 7,
                alignItems: "flex-start",
              }}
            >
              <KeyRound
                size={12}
                style={{ marginTop: 3, flexShrink: 0 }}
                aria-hidden="true"
              />
              {status.hint}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

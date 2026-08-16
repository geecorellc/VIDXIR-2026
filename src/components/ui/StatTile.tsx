/**
 * Stat tile — ported from the prototype's `stat()` helper (label, value, icon,
 * green delta).
 *
 * §25/§42 note: `value` is `string | null`. The prototype hard-coded
 * "817K subscribers"; production passes null while data has not yet been fetched
 * from YouTube, and the tile renders an explicit "—" with a reason instead of a
 * plausible-looking number.
 */
import type { ReactNode } from "react";
import { color, font } from "@/lib/design/tokens";
import { Card } from "./Card";

export interface StatTileProps {
  label: string;
  /** null renders a dash — never a placeholder number. */
  value: string | null;
  icon?: ReactNode;
  /** e.g. "+12.4%". Rendered green for positive, rose for negative. */
  delta?: string | null;
  /** Shown under the value when `value` is null, e.g. "Connect a channel". */
  emptyHint?: string;
  /** Skeleton state while the request is in flight. */
  loading?: boolean;
}

export function StatTile({
  label,
  value,
  icon,
  delta,
  emptyHint,
  loading = false,
}: StatTileProps) {
  const negative = Boolean(delta && delta.trim().startsWith("-"));

  return (
    <Card pad={17}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <span
          style={{
            fontFamily: font.display,
            fontSize: 10.5,
            letterSpacing: 1.3,
            textTransform: "uppercase",
            color: color.textFaint,
          }}
        >
          {label}
        </span>
        {icon && <span style={{ color: color.textFaint }}>{icon}</span>}
      </div>

      {loading ? (
        <div
          aria-hidden="true"
          style={{
            height: 26,
            width: "62%",
            borderRadius: 5,
            background: `linear-gradient(90deg, ${color.borderFaint} 0%, ${color.border} 50%, ${color.borderFaint} 100%)`,
            backgroundSize: "800px 100%",
            animation: "shimmer 1.3s linear infinite",
          }}
        />
      ) : (
        <div
          style={{
            fontFamily: font.display,
            fontSize: 26,
            fontWeight: 600,
            letterSpacing: 0.5,
            color: value === null ? color.textFaint : color.text,
            lineHeight: 1.1,
          }}
        >
          {value ?? "—"}
        </div>
      )}

      {!loading && value === null && emptyHint && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: color.textFaint }}>
          {emptyHint}
        </div>
      )}

      {!loading && value !== null && delta && (
        <div
          style={{
            marginTop: 7,
            fontSize: 12,
            fontWeight: 500,
            color: negative ? color.rose : color.positive,
          }}
        >
          {delta}
        </div>
      )}
    </Card>
  );
}

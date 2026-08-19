/**
 * Metric presentation for the analytics surfaces (Phase 9 §14).
 *
 * One job: render a `MetricValue` so the three states stay visually distinct. A
 * measured zero shows "0"; an unmeasured metric shows an em dash with the reason;
 * a metric the provider does not offer says so, because "not collected yet"
 * implies it eventually will be and that would be untrue of impression CTR.
 *
 * Uses the existing tokens and `Card` — no new visual language (§14).
 */
import { color, font } from "@/lib/design/tokens";
import type { MetricValue } from "@/lib/analytics/report";

/** Human wording for a machine reason. Kept here so the copy lives in one place. */
const REASONS: Record<string, string> = {
  no_measurement: "Not collected yet",
  provider_unsupported: "YouTube's API does not report this",
  provider_returned_null: "YouTube reported no value",
  mixed_currency: "Spans multiple currencies",
  scope_missing: "Needs YouTube revenue access",
  not_monetized: "Channel is not monetised",
  unavailable: "Not reported for this period",
  not_requested: "Needs YouTube revenue access",
};

export function reasonLabel(reason: string | undefined): string {
  if (!reason) return "Unavailable";
  return REASONS[reason] ?? "Unavailable";
}

export interface MetricRowProps {
  label: string;
  metric: MetricValue<number | string>;
  /** Formats a present value. Absence is handled here, not by the caller. */
  format?: (value: number | string) => string;
  /** Extra note shown beside a present value, e.g. "Estimated". */
  note?: string | null;
}

export function MetricRow({ label, metric, format, note }: MetricRowProps) {
  const present = metric.state === "available" && metric.value !== null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 12,
        padding: "9px 0",
        borderBottom: `1px solid ${color.borderFaint}`,
      }}
    >
      <span style={{ fontSize: 12.5, color: color.textDim }}>{label}</span>
      <span style={{ textAlign: "right", minWidth: 0 }}>
        <span
          style={{
            fontFamily: font.display,
            fontSize: 15,
            fontWeight: 600,
            // A dash is dimmed so it never competes with a real figure.
            color: present ? color.text : color.textFaint,
          }}
        >
          {present
            ? format
              ? format(metric.value as number | string)
              : String(metric.value)
            : "—"}
        </span>
        {!present && (
          <span
            style={{
              display: "block",
              fontSize: 11,
              color: color.textFaint,
              marginTop: 2,
            }}
          >
            {reasonLabel(metric.reason)}
          </span>
        )}
        {present && note && (
          <span
            style={{
              display: "block",
              fontSize: 11,
              color: color.warning,
              marginTop: 2,
            }}
          >
            {note}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * Provenance banner.
 *
 * §14 requires the UI to distinguish live provider data from stored history. Every
 * Phase 9 read is stored — there is no live-read path — so this states that
 * plainly with the collection time, rather than letting a stale figure look
 * current.
 */
export function DataSourceNote({
  lastIngestedAt,
  reauthRequired,
}: {
  lastIngestedAt: Date | null;
  reauthRequired: boolean;
}) {
  return (
    <p
      style={{
        margin: "0 0 16px",
        fontSize: 11.5,
        lineHeight: 1.6,
        color: reauthRequired ? color.warning : color.textFaint,
        fontFamily: font.body,
      }}
    >
      {reauthRequired
        ? "This channel needs reconnecting, so these figures stop at the last successful collection."
        : lastIngestedAt
          ? `Stored figures, collected from YouTube Analytics up to ${lastIngestedAt.toISOString().slice(0, 10)}.`
          : "No analytics have been collected from YouTube for this channel yet."}
    </p>
  );
}

/** Percentage from a fraction. Two places — more would imply precision. */
export function percent(value: number | string): string {
  return `${(Number(value) * 100).toFixed(2)}%`;
}

/** Thousands-separated integer. */
export function integer(value: number | string): string {
  return Math.round(Number(value)).toLocaleString("en-US");
}

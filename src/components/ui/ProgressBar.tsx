/**
 * Progress bar — ported from the prototype's `ProgressBar` (pct, color, clamped).
 *
 * §37/§42 constraint: every `pct` passed here must come from real backend job
 * state. `indeterminate` exists precisely so callers never have to invent a
 * number when a provider reports no percentage — an animated stripe is honest
 * about "working, progress unknown", a fake 40% is not.
 */
import { color as tokens, radius } from "@/lib/design/tokens";

export interface ProgressBarProps {
  /** 0-100. Clamped. Ignored when `indeterminate` is set. */
  pct?: number;
  color?: string;
  height?: number;
  /** Working, but the provider gives no percentage. */
  indeterminate?: boolean;
  /** Accessible name, e.g. "Rendering progress". */
  label?: string;
}

export function ProgressBar({
  pct = 0,
  color = tokens.accent,
  height = 5,
  indeterminate = false,
  label,
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : 100}
      aria-valuenow={indeterminate ? undefined : Math.round(clamped)}
      style={{
        width: "100%",
        height,
        background: tokens.borderFaint,
        borderRadius: radius.pill,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: "100%",
          width: indeterminate ? "35%" : `${clamped}%`,
          background: indeterminate
            ? `linear-gradient(90deg, transparent, ${color}, transparent)`
            : color,
          borderRadius: radius.pill,
          transition: indeterminate ? undefined : "width 420ms ease",
          animation: indeterminate
            ? "tally-indeterminate 1.4s ease-in-out infinite"
            : undefined,
        }}
      />
      {indeterminate && (
        <style
          // Static keyframes — no interpolated user input.
          dangerouslySetInnerHTML={{
            __html: `@keyframes tally-indeterminate {
              0% { transform: translateX(-120%); }
              100% { transform: translateX(340%); }
            }`,
          }}
        />
      )}
    </div>
  );
}

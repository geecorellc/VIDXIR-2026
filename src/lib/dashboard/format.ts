/**
 * Number and duration formatting shared by server and client components.
 *
 * Deliberately dependency-free and *not* `server-only`: the same helpers format
 * a figure in a server-rendered stat tile and in a client-side board, and two
 * implementations would eventually disagree about what "817K" means.
 */

/** 817000 → "817K". Matches the prototype's number formatting. */
export function compact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000_000) return `${trim(value / 1_000_000_000)}B`;
  if (Math.abs(value) >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (Math.abs(value) >= 1_000) return `${trim(value / 1_000)}K`;
  return String(Math.round(value));
}

function trim(value: number): string {
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return String(rounded);
}

/** 327 → "5:27". The prototype's `fmtTime`. */
export function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Milliseconds → "5:27", for timeline and chapter positions. */
export function formatMs(ms: number): string {
  return formatTime(ms / 1000);
}

/** "2 minutes ago" / "in 3 hours" — relative, locale-formatted. */
export function relativeTime(date: Date, now = new Date()): string {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];

  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return rtf.format(Math.round(seconds / size), unit);
    }
  }
  return rtf.format(seconds, "second");
}

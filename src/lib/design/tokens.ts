/**
 * Vidxir AI design tokens.
 *
 * These values are lifted verbatim from the JSX prototype (vidxir-app.jsx),
 * which §3/§44 of the spec designate as the source of truth for the visual
 * direction. The prototype styled everything with inline style objects; rather
 * than re-implement the look in a CSS framework (which would inevitably drift),
 * the palette and type scale live here and every component references them.
 *
 * Do not "improve" these colours. Accessibility fixes belong in component
 * markup (focus rings, contrast on small text, hit areas), not in the palette.
 */

export const color = {
  /** Page background — near-black with a violet cast. */
  bg: "#0B0A0C",
  /** Card / panel surface. */
  card: "#141216",
  /** Input and inset surface, slightly darker than a card. */
  inputBg: "#0F0E10",
  /** Raised surface for subtle buttons and chips. */
  subtle: "#1F1B1D",

  /** Default card border. */
  border: "#241F22",
  /** Slightly lighter border for hover/emphasis. */
  borderLight: "#2A2426",
  /** Nearly invisible divider. */
  borderFaint: "#1C1719",

  /** Vidxir AI red — the single accent colour. */
  accent: "#E8332B",
  accentLight: "#FF5A50",
  accentDark: "#9E1F19",
  /** Background of the active nav item. */
  accentBgSoft: "#1F1315",

  /** Primary body text. */
  text: "#F5F3F1",
  /** Bright secondary text. */
  textBright: "#D7D1D3",
  /** Standard secondary text. */
  textMuted: "#B5AEB1",
  /** Tertiary text — labels, metadata. */
  textDim: "#948B8E",
  /** Lowest-emphasis text — eyebrows, timestamps. */
  textFaint: "#6E666A",

  /** Positive delta / success. */
  positive: "#4ADE80",
  /** Warning / degraded. */
  warning: "#E5A84B",
  /** Soft negative, used for muted error copy. */
  rose: "#C9807C",
  /** Hard failure. */
  danger: "#EF4444",
  /** Informational / queued. */
  info: "#7AA2E8",
} as const;

/** The accent gradient used by the logo dot and primary emphasis surfaces. */
export const accentGradient = `linear-gradient(135deg, ${color.accentLight} 0%, ${color.accent} 55%, ${color.accentDark} 100%)`;

export const font = {
  /** Oswald — uppercase display type for headings and numbers. */
  display: "'Oswald', 'Arial Narrow', system-ui, sans-serif",
  /** Inter — body copy and UI. */
  body: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
  /** Monospace for IDs, timecodes and log output. */
  mono: "'JetBrains Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
} as const;

export const radius = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  pill: 999,
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  xxxl: 40,
} as const;

/** Shared shadow for elevated surfaces (menus, modals, toasts). */
export const shadow = {
  panel: "0 18px 48px rgba(0,0,0,0.55)",
  focus: `0 0 0 2px ${color.bg}, 0 0 0 4px ${color.accent}`,
} as const;

export const layout = {
  sidebarWidth: 236,
  contentMaxWidth: 1180,
  headerHeight: 64,
} as const;

/** Uppercase eyebrow/label style used throughout the prototype. */
export const eyebrow = {
  fontFamily: font.display,
  fontSize: 11,
  letterSpacing: 1.4,
  textTransform: "uppercase" as const,
  color: color.textFaint,
  fontWeight: 500,
};

/** Display heading style, sized by the caller. */
export function display(size: number, weight = 600) {
  return {
    fontFamily: font.display,
    fontSize: size,
    fontWeight: weight,
    letterSpacing: 0.4,
    textTransform: "uppercase" as const,
    color: color.text,
    margin: 0,
    lineHeight: 1.08,
  };
}

/**
 * Vidxir AI design tokens.
 *
 * Every colour below is a `var(--vx-*)` reference, not a literal. The literals
 * live once per theme in `GlobalStyle`, so switching `.vx-dark` on <html>
 * retheme s the whole app without a single component re-render — the 55 modules
 * that import this file inherit the change for free.
 *
 * The palette and type scale follow the vidxr-dashboard reference: a light
 * default surface, a single purple accent, Mulish throughout, and softer radii.
 * The previous dark/red/Oswald direction is preserved verbatim as the dark
 * theme, so nothing from it is lost — it is one toggle away.
 *
 * Do not inline a hex value in a component. If a colour is missing, add a token
 * here and define it in both themes; a literal in markup is invisible to the
 * theme switch and will be wrong in one of the two.
 *
 * Two places cannot consume a `var()` and must use a literal:
 *   - `color.accentGlow`, because `${accent}66` alpha concatenation needs a real
 *     colour; it is defined as a complete translucent value instead.
 *   - `viewport.themeColor` in the root layout, which the browser reads before
 *     any stylesheet applies.
 */

export const color = {
  /** Page background. */
  bg: "var(--vx-bg)",
  /** Card / panel surface. */
  card: "var(--vx-card)",
  /** Input and inset surface. */
  inputBg: "var(--vx-input-bg)",
  /** Raised surface for subtle buttons and chips. */
  subtle: "var(--vx-subtle)",

  /** Default card border. */
  border: "var(--vx-border)",
  /** Slightly stronger border for hover/emphasis. */
  borderLight: "var(--vx-border-light)",
  /** Faint divider. */
  borderFaint: "var(--vx-border-faint)",

  /** Vidxir accent — the single brand colour. */
  accent: "var(--vx-accent)",
  accentLight: "var(--vx-accent-light)",
  accentDark: "var(--vx-accent-dark)",
  /** Background of the active nav item. */
  accentBgSoft: "var(--vx-accent-bg-soft)",
  /**
   * Translucent accent for glows and rings. A complete colour rather than a
   * token to concatenate alpha onto — see the file header.
   */
  accentGlow: "var(--vx-accent-glow)",

  /** Primary body text. */
  text: "var(--vx-text)",
  /** Bright secondary text. */
  textBright: "var(--vx-text-bright)",
  /** Standard secondary text. */
  textMuted: "var(--vx-text-muted)",
  /** Tertiary text — labels, metadata. */
  textDim: "var(--vx-text-dim)",
  /** Lowest-emphasis text — eyebrows, timestamps. */
  textFaint: "var(--vx-text-faint)",
  /** Text that sits on top of an accent fill. */
  onAccent: "var(--vx-on-accent)",

  /** Positive delta / success. */
  positive: "var(--vx-positive)",
  /** Warning / degraded. */
  warning: "var(--vx-warning)",
  /** Border/background pair for warning surfaces. */
  warningBorder: "var(--vx-warning-border)",
  warningBg: "var(--vx-warning-bg)",
  /** Soft negative, used for muted error copy. */
  rose: "var(--vx-rose)",
  /** Hard failure. */
  danger: "var(--vx-danger)",
  /** Border/background pair for danger surfaces. */
  dangerBorder: "var(--vx-danger-border)",
  dangerBg: "var(--vx-danger-bg)",
  /** Informational / queued. */
  info: "var(--vx-info)",
  /** Border/background pair for informational surfaces. */
  infoBorder: "var(--vx-info-border)",
  infoBg: "var(--vx-info-bg)",
  /** Border/background pair for positive surfaces. */
  positiveBorder: "var(--vx-positive-border)",
  positiveBg: "var(--vx-positive-bg)",
  /** Scrim behind modals and drawers. */
  scrim: "var(--vx-scrim)",

  /** Unselected radio/checkbox rim — needs more presence than a card border. */
  controlBorder: "var(--vx-control-border)",
  /** Border of a field in its error state. */
  fieldErrorBorder: "var(--vx-field-error-border)",

  /**
   * Letterbox behind video and image previews. Black in both themes by intent:
   * it is the neutral backing a frame is judged against, not app chrome.
   */
  mediaBg: "#000000",
  /** Text and shadow burned over media, where the backing is always dark. */
  onMedia: "#FFFFFF",
} as const;

/**
 * Timeline clip fills, keyed by track kind.
 *
 * Six low-chroma tints that have to stay distinguishable from each other and
 * from the track bed, which is why they are their own scale rather than reuses
 * of the semantic colours.
 */
export const trackFill = {
  video: "var(--vx-track-video)",
  image: "var(--vx-track-image)",
  text: "var(--vx-track-text)",
  caption: "var(--vx-track-caption)",
  voiceover: "var(--vx-track-voiceover)",
  music: "var(--vx-track-music)",
} as const;

/** Focus/selected ring for cards that indicate choice by elevation. */
export const accentRing = `0 0 0 1px ${color.accent}, 0 0 22px ${color.accentGlow}`;

/** The accent gradient used by the logo dot and primary emphasis surfaces. */
export const accentGradient = `linear-gradient(135deg, ${color.accentLight} 0%, ${color.accent} 55%, ${color.accentDark} 100%)`;

export const font = {
  /**
   * Display type. The reference uses one family at different weights rather
   * than a condensed second face, which is most of why it reads as calm.
   */
  display: "'Mulish', system-ui, -apple-system, 'Segoe UI', sans-serif",
  /** Body copy and UI — the same family, by design. */
  body: "'Mulish', system-ui, -apple-system, 'Segoe UI', sans-serif",
  /** Monospace for IDs, timecodes and log output. */
  mono: "'JetBrains Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
} as const;

/** Radii follow the reference's `--radius: 0.6rem` scale. */
export const radius = {
  sm: 6,
  md: 8,
  lg: 10,
  xl: 15,
  /** The reference's large rounding, used by the prompt box and tiles. */
  xxl: 20,
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
  panel: "var(--vx-shadow-panel)",
  focus: `0 0 0 2px ${color.bg}, 0 0 0 4px ${color.accent}`,
} as const;

export const layout = {
  sidebarWidth: 192,
  sidebarCollapsedWidth: 80,
  contentMaxWidth: 1180,
  /** Width of the overview prompt column, from the reference's 740px. */
  promptMaxWidth: 740,
  headerHeight: 64,
} as const;

/**
 * Uppercase eyebrow/label style.
 *
 * Kept uppercase but de-emphasised: the reference has no condensed display face,
 * so the letterspaced caps now carry the hierarchy on their own.
 */
export const eyebrow = {
  fontFamily: font.display,
  fontSize: 11,
  letterSpacing: 1.1,
  textTransform: "uppercase" as const,
  color: color.textFaint,
  fontWeight: 600,
};

/**
 * Display heading style, sized by the caller.
 *
 * No longer uppercase. The old style was Oswald condensed caps; the reference
 * sets headings in the body family at 700, which is the single biggest reason it
 * reads as "simple and clean" rather than editorial.
 */
export function display(size: number, weight = 700) {
  return {
    fontFamily: font.display,
    fontSize: size,
    fontWeight: weight,
    letterSpacing: -0.2,
    color: color.text,
    margin: 0,
    lineHeight: 1.2,
  };
}

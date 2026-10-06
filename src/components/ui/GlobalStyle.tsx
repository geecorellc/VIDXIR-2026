/**
 * Global stylesheet and the single home of every colour literal.
 *
 * `tokens.ts` exports `var(--vx-*)` references; this file defines what those
 * variables mean, once per theme. Light is the `:root` default, matching the
 * vidxr-dashboard reference; `.vx-dark` on <html> restores the original
 * dark/red direction verbatim. Because the tokens are indirections, switching
 * the class retheme s all 55 consuming modules with no re-render.
 *
 * Kept as an injected stylesheet rather than a CSS module because the app styles
 * everything with inline style objects, and this covers what inline styles
 * cannot express: variables, font imports, keyframes, scrollbars, selection and
 * focus-visible rings.
 *
 * Accessibility: a visible focus ring, and prefers-reduced-motion honoured for
 * every animation rather than only the pulse (§3).
 */

export function GlobalStyle() {
  return (
    <style
      // Static, authored CSS only — no interpolated user input.
      dangerouslySetInnerHTML={{
        __html: `
@import url('https://fonts.googleapis.com/css2?family=Mulish:ital,wght@0,200..1000;1,200..1000&display=swap');

/* ---------------------------------------------------------------------------
   Light theme — the default, from the reference's :root.
   --------------------------------------------------------------------------- */
:root {
  --vx-bg: hsl(0 0% 100%);
  --vx-card: hsl(0 0% 100%);
  --vx-input-bg: hsl(0 0% 98%);
  --vx-subtle: hsl(0 0% 96.1%);

  --vx-border: hsl(0 0% 91.76%);
  --vx-border-light: hsl(0 0% 86%);
  --vx-border-faint: hsl(0 0% 94.5%);

  --vx-accent: hsl(295 100% 43%);
  --vx-accent-light: hsl(266 100% 64%);
  --vx-accent-dark: hsl(295 100% 26%);
  --vx-accent-bg-soft: hsl(295 100% 97%);
  --vx-accent-glow: hsla(295 100% 43% / 0.4);
  --vx-on-accent: hsl(0 0% 100%);

  --vx-text: hsl(0 0% 12%);
  --vx-text-bright: hsl(0 0% 20%);
  --vx-text-muted: hsl(0 0% 32%);
  --vx-text-dim: hsl(0 0% 45.1%);
  --vx-text-faint: hsl(0 0% 56%);

  --vx-positive: hsl(142 71% 36%);
  --vx-warning: hsl(32 81% 39%);
  --vx-warning-border: hsl(32 70% 80%);
  --vx-warning-bg: hsl(38 100% 96%);
  --vx-rose: hsl(0 60% 48%);
  --vx-danger: hsl(0 72% 46%);
  --vx-danger-border: hsl(0 72% 85%);
  --vx-danger-bg: hsl(0 86% 97%);
  --vx-info: hsl(217 70% 48%);
  --vx-info-border: hsl(217 70% 85%);
  --vx-info-bg: hsl(217 100% 97%);
  --vx-positive-border: hsl(142 50% 80%);
  --vx-positive-bg: hsl(142 70% 96.5%);

  --vx-control-border: hsl(0 0% 80%);
  --vx-field-error-border: hsl(0 72% 72%);

  --vx-track-video: hsl(295 38% 92%);
  --vx-track-image: hsl(266 40% 92.5%);
  --vx-track-text: hsl(210 40% 92%);
  --vx-track-caption: hsl(160 34% 91.5%);
  --vx-track-voiceover: hsl(10 44% 93%);
  --vx-track-music: hsl(255 40% 93%);

  --vx-scrim: hsla(0 0% 0% / 0.32);
  --vx-shadow-panel: 0 10px 30px hsla(0 0% 0% / 0.1);
  --vx-grain-strength: 0;
}

/* ---------------------------------------------------------------------------
   Dark theme — the original Vidxir palette, preserved value for value.
   --------------------------------------------------------------------------- */
.vx-dark {
  --vx-bg: #0B0A0C;
  --vx-card: #141216;
  --vx-input-bg: #0F0E10;
  --vx-subtle: #1F1B1D;

  --vx-border: #241F22;
  --vx-border-light: #2A2426;
  --vx-border-faint: #1C1719;

  --vx-accent: #E8332B;
  --vx-accent-light: #FF5A50;
  --vx-accent-dark: #9E1F19;
  --vx-accent-bg-soft: #1F1315;
  --vx-accent-glow: rgba(232, 51, 43, 0.4);
  --vx-on-accent: #FFFFFF;

  --vx-text: #F5F3F1;
  --vx-text-bright: #D7D1D3;
  --vx-text-muted: #B5AEB1;
  --vx-text-dim: #948B8E;
  --vx-text-faint: #6E666A;

  --vx-positive: #4ADE80;
  --vx-warning: #E5A84B;
  --vx-warning-border: #4A3A20;
  --vx-warning-bg: #241B10;
  --vx-rose: #C9807C;
  --vx-danger: #EF4444;
  --vx-danger-border: #4A2A2A;
  --vx-danger-bg: #2A1618;
  --vx-info: #7AA2E8;
  --vx-info-border: #24384F;
  --vx-info-bg: #13202E;
  --vx-positive-border: #23402C;
  --vx-positive-bg: #132218;

  --vx-control-border: #3A3336;
  --vx-field-error-border: #5A2A28;

  --vx-track-video: #2A1E22;
  --vx-track-image: #241E2A;
  --vx-track-text: #1E2429;
  --vx-track-caption: #1E2922;
  --vx-track-voiceover: #291E1E;
  --vx-track-music: #221E29;

  --vx-scrim: rgba(0, 0, 0, 0.6);
  --vx-shadow-panel: 0 18px 48px rgba(0, 0, 0, 0.55);
  --vx-grain-strength: 0.5;
}

*, *::before, *::after { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--vx-bg);
  color: var(--vx-text);
  font-family: 'Mulish', system-ui, -apple-system, 'Segoe UI', sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.vidxir-root {
  background: var(--vx-bg);
  color: var(--vx-text);
  font-family: 'Mulish', system-ui, -apple-system, 'Segoe UI', sans-serif;
  min-height: 100vh;
}

/* Thin scrollbars so panels do not gain heavy chrome. */
.vidxir-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.vidxir-scroll::-webkit-scrollbar-track { background: transparent; }
.vidxir-scroll::-webkit-scrollbar-thumb {
  background: var(--vx-border-light);
  border-radius: 999px;
}
.vidxir-scroll::-webkit-scrollbar-thumb:hover { background: var(--vx-text-faint); }
.vidxir-scroll { scrollbar-width: thin; scrollbar-color: var(--vx-border-light) transparent; }

::selection { background: var(--vx-accent); color: var(--vx-on-accent); }

/* Accessibility: :focus-visible keeps the ring off mouse clicks. */
:focus-visible {
  outline: 2px solid var(--vx-accent);
  outline-offset: 2px;
  border-radius: 4px;
}

a { color: inherit; }

@keyframes vidxir-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.55; transform: scale(0.88); }
}

@keyframes fadeUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@keyframes shimmer {
  0% { background-position: -400px 0; }
  100% { background-position: 400px 0; }
}

/* Film-grain overlay. Driven by a variable so it disappears on the light
   theme, where speckled white reads as noise rather than texture. */
.grain {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: var(--vx-grain-strength);
  background-image:
    radial-gradient(rgba(255,255,255,0.028) 1px, transparent 1px),
    radial-gradient(rgba(255,255,255,0.018) 1px, transparent 1px);
  background-size: 3px 3px, 5px 5px;
  background-position: 0 0, 1px 2px;
}

.vidxir-fade-up { animation: fadeUp 320ms ease both; }
.vidxir-spin { animation: spin 900ms linear infinite; }

/* Live-status dot. Colour and size stay inline so callers can tint per status. */
.vidxir-dot { animation: vidxir-pulse 1.9s ease-in-out infinite; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}
`,
      }}
    />
  );
}

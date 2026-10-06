/**
 * Global stylesheet, ported from the prototype's injected <style> block.
 *
 * Kept as an injected stylesheet rather than a CSS module because the prototype
 * styles everything with inline style objects and this only needs to cover what
 * inline styles cannot express: font imports, keyframes, scrollbars, selection,
 * focus-visible rings and the grain texture.
 *
 * Additions beyond the prototype are accessibility fixes required by §3:
 * a visible focus ring, and honouring prefers-reduced-motion for every
 * animation rather than only the pulse.
 */
import { color, font } from "@/lib/design/tokens";

export function GlobalStyle() {
  return (
    <style
      // Static, authored CSS only — no interpolated user input.
      dangerouslySetInnerHTML={{
        __html: `
@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Inter:wght@300;400;500;600;700&display=swap');

*, *::before, *::after { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: ${color.bg};
  color: ${color.text};
  font-family: ${font.body};
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.vidxir-root {
  background: ${color.bg};
  color: ${color.text};
  font-family: ${font.body};
  min-height: 100vh;
}

/* Thin dark scrollbars so panels do not gain bright chrome. */
.vidxir-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.vidxir-scroll::-webkit-scrollbar-track { background: transparent; }
.vidxir-scroll::-webkit-scrollbar-thumb {
  background: ${color.borderLight};
  border-radius: 999px;
}
.vidxir-scroll::-webkit-scrollbar-thumb:hover { background: #3A3236; }
.vidxir-scroll { scrollbar-width: thin; scrollbar-color: ${color.borderLight} transparent; }

::selection { background: ${color.accent}; color: #fff; }

/* Accessibility: the prototype had no visible focus indicator. Keyboard users
   need one, and :focus-visible keeps it off mouse clicks. */
:focus-visible {
  outline: 2px solid ${color.accent};
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

/* Film-grain texture overlay used behind hero sections. */
.grain {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.5;
  background-image:
    radial-gradient(rgba(255,255,255,0.028) 1px, transparent 1px),
    radial-gradient(rgba(255,255,255,0.018) 1px, transparent 1px);
  background-size: 3px 3px, 5px 5px;
  background-position: 0 0, 1px 2px;
}

.vidxir-fade-up { animation: fadeUp 320ms ease both; }
.vidxir-spin { animation: spin 900ms linear infinite; }

/* Live-status dot (prototype: the pulsing indicator beside a connected channel).
   Colour and size stay inline so callers can tint it per status. */
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

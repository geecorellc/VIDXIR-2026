/**
 * Applies the saved theme before first paint.
 *
 * This has to be a blocking inline script in <head>. The alternative — setting
 * the class from a `useEffect` — runs after hydration, so a dark-theme user
 * would see a white flash on every navigation. Reading localStorage here is
 * synchronous and happens before the first paint, so there is none.
 *
 * Light is the default, so the script only ever *adds* a class: no stored
 * preference and no OS preference means the `:root` light tokens apply as-is.
 *
 * Kept deliberately tiny and dependency-free, and wrapped in try/catch because
 * localStorage throws in Safari's private mode rather than returning null.
 */

/** Shared with the toggle so the key cannot drift between the two. */
export const THEME_STORAGE_KEY = "vidxir-theme";

/** The class that activates the dark token block in `GlobalStyle`. */
export const DARK_CLASS = "vx-dark";

export function ThemeScript() {
  const script = `
(function () {
  try {
    var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    var dark = stored === 'dark' ||
      (stored === null && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('${DARK_CLASS}');
  } catch (e) {
    /* Storage unavailable — the light default is already correct. */
  }
})();
`;

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}

/**
 * Applies the saved theme before first paint.
 *
 * This has to be a blocking inline script in <head>. The alternative — setting
 * the class from a `useEffect` — runs after hydration, so a dark-theme user
 * would see a white flash on every navigation. Reading localStorage here is
 * synchronous and happens before the first paint, so there is none.
 *
 * Dark is the first-visit default. A saved light preference overrides it;
 * the operating system's theme does not affect the choice.
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
  var dark = true;
  try {
    var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    dark = stored !== 'light';
  } catch (e) {
    /* Storage unavailable — keep the dark default. */
  }
  document.documentElement.classList.toggle('${DARK_CLASS}', dark);
})();
`;

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}

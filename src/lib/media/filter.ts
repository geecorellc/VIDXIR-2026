/**
 * Escaping for ffmpeg filter arguments.
 *
 * One caller: `providers/render.ts`, for the `subtitles=` filter, whose path is a
 * temp file the renderer chose but whose *directory* is the OS temp directory and
 * therefore arbitrary. It lives in its own module because the escaping is subtle,
 * it is only wrong on Windows, and it fails by silently becoming a *different
 * filter option* rather than by erroring — so it wants to be named and tested
 * rather than inlined.
 *
 * Not general. The rule below is for an **unquoted** filter option value, which is
 * how `render.ts` uses it; a *quoted* value takes one backslash before a colon
 * rather than two, so this function is wrong there. And no escaping works at all
 * for a path containing a comma or an apostrophe, because the graph parser splits
 * on `,` and `:` before it honours quotes. The thumbnail compositor hit that limit
 * and stopped putting paths in filter graphs entirely — it spawns ffmpeg with `cwd`
 * and names bare files. `render.ts`'s path is `<tmp>/vidxir-render-XXXXXX/subs.ass`,
 * so the remaining exposure is a username with a comma or apostrophe in it; if that
 * ever surfaces, the fix is the compositor's, not a cleverer escape.
 */

/**
 * Escape a path for use inside an **unquoted** filter argument.
 *
 * Windows paths are the reason this exists: `C:\Users\...` contains both a colon
 * (the filter option separator) and backslashes (the filter escape character),
 * so an unescaped path silently becomes a different filter option.
 */
export function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\\\:").replace(/'/g, "\\\\'");
}

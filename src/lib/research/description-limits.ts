/**
 * Length bounds on a typed description.
 *
 * Split out of `description.ts` so a client component can import them. That
 * module reaches `research/signals.ts` and therefore `googleapis`, which pulls
 * `fs` and `child_process` — fine on the server, a build failure in a browser
 * bundle. These two numbers are the only part of it the UI needs.
 *
 * `description.ts` re-exports both, so every existing server-side importer and
 * the test that pins these values keep working through their original path.
 */

/** Shortest description accepted. Below this there is no subject to research. */
export const MIN_DESCRIPTION_CHARS = 12;

/**
 * Longest description accepted.
 *
 * The string reaches a model, so an unbounded one is an unbounded bill and a
 * prompt of unbounded shape. Mirrored by `from-description`'s zod schema, which
 * is the real enforcement — the character counter in the UI is a courtesy.
 */
export const MAX_DESCRIPTION_CHARS = 2_000;

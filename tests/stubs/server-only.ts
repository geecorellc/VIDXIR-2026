/**
 * Test stub for the `server-only` marker package.
 *
 * The real module is resolved by Next's bundler and throws when imported outside
 * a server context, which would make every server module untestable in Node.
 * Aliased in `vitest.config.ts`; see the comment there.
 */
export {};

/**
 * Vitest configuration.
 *
 * Two projects, because they need different guarantees:
 *
 *  - `unit` runs anywhere with no services. These tests must not import modules
 *    that open a Postgres or Redis connection at module scope.
 *  - `integration` covers the flows §39 requires end-to-end (auth, tenant
 *    isolation, job transitions). It is opt-in via TEST_DATABASE_URL so a plain
 *    `npm test` on a laptop without Docker still passes honestly rather than
 *    reporting green by skipping silently.
 *
 * `NODE_ENV=test` matters: `src/lib/env.ts` only tolerates mock providers outside
 * production (§40).
 */
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      /**
       * `server-only` is a marker package Next resolves through its bundler; the
       * real module throws on import. Aliasing it to a stub lets server modules be
       * unit-tested directly. This does not weaken the guarantee — the build still
       * fails if a client component imports one, which is where it matters.
       */
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  /**
   * `googleapis` is a barrel over every Google API surface — thousands of
   * modules. Left to Vite's transform pipeline it takes minutes to load and made
   * the channel tests look like a hang. Externalising it means Node requires the
   * built CommonJS directly, which is both correct (it is a dependency, not code
   * under test) and roughly 20x faster.
   */
  ssr: {
    external: ["googleapis", "googleapis-common", "google-auth-library", "gaxios"],
  },
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    server: {
      deps: {
        external: [/googleapis/, /google-auth-library/, /gaxios/],
      },
    },
    exclude: ["node_modules/**", ".next/**"],
    // Integration tests touch a shared database; running files sequentially
    // avoids cross-file interference on the same schema.
    fileParallelism: !process.env["TEST_DATABASE_URL"],
    /**
     * Password hashing is deliberately expensive (scrypt N=65536), so a test
     * that exercises the lockout policy performs ten hashes and legitimately
     * takes seconds. The default 5s budget would make that look like a hang.
     * Unit tests are unaffected — they finish in milliseconds either way.
     */
    testTimeout: process.env["TEST_DATABASE_URL"] ? 30_000 : 5_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: "test",
    },
  },
});

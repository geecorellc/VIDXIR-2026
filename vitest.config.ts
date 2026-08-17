/**
 * Vitest configuration.
 *
 * One project, two kinds of test, separated by directory rather than by a Vitest
 * `projects` entry — so select them by path (`vitest run tests/integration`), not
 * with `--project`, which matches nothing here and exits zero having run nothing:
 *
 *  - `src/**\/*.test.ts` runs anywhere with no services. These must not import
 *    modules that open a Postgres or Redis connection at module scope.
 *  - `tests/integration/**` covers the flows §39 requires end-to-end (auth, tenant
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
       * `server-only` is a bundler directive: its `default` export throws
       * unconditionally, and only Next's `react-server` condition resolves it to
       * the empty module. Node cannot import it at all, so a test touching a
       * module that carries the marker needs this stub.
       *
       * Scope worth knowing: only four modules still carry it — `lib/api/guard`,
       * `lib/api/rate-limit`, `lib/auth/session` and `lib/channels/oauth-state`,
       * all of which import `next/server` or `next/headers` and genuinely cannot
       * run outside Next. The shared service, provider, queue and database layers
       * had the marker removed, because the standalone BullMQ worker imports them
       * as a plain Node process and this alias was hiding that they were
       * unimportable there. The client-bundle boundary is enforced by
       * `no-restricted-imports` in `eslint.config.mjs`, which applies to both
       * runtimes; this alias no longer stands in for it.
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

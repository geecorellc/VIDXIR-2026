/**
 * ESLint flat config (ESLint 9).
 *
 * `next/core-web-vitals` and `next/typescript` are still published as eslintrc
 * shareable configs, so they are pulled in through FlatCompat rather than being
 * imported directly.
 *
 * The extra rules below encode two project rules that are easy to break silently:
 *  - `no-restricted-imports` keeps server-side modules (db, env, providers) out of
 *    client bundles, which is how provider keys and OAuth secrets leak (§34).
 *  - `no-floating-promises` is off by default here because the type-aware ruleset
 *    is not enabled; `npm run typecheck` is the backstop for that class of bug.
 *
 * Why the client boundary is enforced *here* rather than by the `server-only`
 * marker package: `server-only` is a bundler directive whose runtime
 * implementation throws unconditionally, so any module carrying it cannot be
 * imported by the standalone BullMQ worker — a plain Node process, not an RSC
 * runtime. The worker legitimately needs `env`, `db`, `queue` and every provider,
 * so the check has to live somewhere both runtimes share. Lint is that place: it
 * runs in the same gate as typecheck and tests, and it names the offending line.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  {
    ignores: [
      ".next/**",
      ".open-next/**",
      ".wrangler/**",
      "node_modules/**",
      "drizzle/**",
      "drizzle-d1/**",
      "next-env.d.ts",
      "coverage/**",
    ],
  },

  ...compat.extends("next/core-web-vitals", "next/typescript"),

  {
    rules: {
      // Unused code is a review smell, but leading-underscore args are a
      // deliberate "this exists to satisfy a signature" marker.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // `any` defeats the point of the strict tsconfig.
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "smart"],
    },
  },

  {
    /**
     * Server-side entry points are allowed to log directly.
     *
     * These are the CLI-shaped surfaces: a migration runner and the verification
     * scripts print a human-readable transcript to a terminal, which is not what
     * the structured logger is for. Everything else — including `src/lib/logger`
     * itself, which writes to `process.stdout`/`process.stderr` rather than through
     * `console` — stays under the rule.
     */
    files: ["src/lib/db/migrate.ts", "src/worker/**", "src/scheduler/**", "scripts/**"],
    rules: { "no-console": "off" },
  },

  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: { "no-console": "off" },
  },

  /**
   * The client bundle boundary (§34).
   *
   * Everything listed reads `env()`, opens a connection, or holds a credential.
   * A client component that imports one pulls it into the browser bundle, and a
   * provider key or the encryption secret goes with it.
   *
   * `allowTypeImports` is deliberate: `import type` is erased by the compiler, so
   * a view type shared between a server page and the client component it renders
   * carries no runtime code. Several components rely on that today, and forbidding
   * it would push them towards duplicated hand-written interfaces that silently
   * drift from the queries they describe.
   *
   * Scoped to `src/components/**` because that is where client components live,
   * plus the three `src/app` pages that declare `"use client"` themselves. Server
   * components under `src/app` are *supposed* to import these — that is how a page
   * gets its data — so the rule cannot apply to the whole tree.
   */
  {
    files: [
      "src/components/**/*.{ts,tsx}",
      "src/app/forgot-password/page.tsx",
      "src/app/reset-password/page.tsx",
      "src/app/verify-email/page.tsx",
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/lib/env",
                "@/lib/db",
                "@/lib/db/*",
                "@/lib/crypto",
                "@/lib/queue/*",
                "@/lib/providers/*",
                "@/lib/storage",
                "@/lib/storage/*",
                "@/lib/email",
                "@/lib/email/*",
                "@/lib/billing",
                "@/lib/billing/*",
                "@/lib/auth/*",
                "@/lib/api/*",
                "@/lib/health",
                "**/lib/env",
                "**/lib/db",
                "**/lib/crypto",
              ],
              allowTypeImports: true,
              message:
                "Server-side module: reads env()/secrets or opens a connection, " +
                "and a client component would pull it into the browser bundle (§34). " +
                "Fetch through a route in src/app/api, or take the data as a prop " +
                "from a server component. `import type` is allowed.",
            },
            {
              // Service modules run queries. A client importing one either fails
              // at build (no DB in the browser) or, worse, drags the schema and
              // connection string in behind it.
              group: [
                "@/lib/*/service",
                "@/lib/dashboard/overview",
                "@/lib/dashboard/stage",
                "@/lib/dashboard/research",
              ],
              allowTypeImports: true,
              message:
                "Service modules query the database. Call an API route or pass the " +
                "result in as a prop; `import type` is allowed for view types (§34).",
            },
          ],
        },
      ],
    },
  },
];

export default config;

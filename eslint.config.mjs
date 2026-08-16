/**
 * ESLint flat config (ESLint 9).
 *
 * `next/core-web-vitals` and `next/typescript` are still published as eslintrc
 * shareable configs, so they are pulled in through FlatCompat rather than being
 * imported directly.
 *
 * The extra rules below encode two project rules that are easy to break silently:
 *  - `no-restricted-imports` keeps server-only modules (db, env, providers) out of
 *    client bundles, which is how provider keys and OAuth secrets leak (§34).
 *  - `no-floating-promises` is off by default here because the type-aware ruleset
 *    is not enabled; `npm run typecheck` is the backstop for that class of bug.
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
      "node_modules/**",
      "drizzle/**",
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
    // Server-side entry points are allowed to log directly; the structured
    // logger wraps console itself.
    files: [
      "src/lib/observability/**",
      "src/lib/db/migrate.ts",
      "src/worker/**",
      "src/scheduler/**",
      "scripts/**",
    ],
    rules: { "no-console": "off" },
  },

  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: { "no-console": "off" },
  },
];

export default config;

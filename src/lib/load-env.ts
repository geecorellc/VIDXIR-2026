/**
 * Environment file loading for standalone Node entrypoints.
 *
 * Next.js loads `.env.local` / `.env` automatically, but the worker, scheduler
 * and migration scripts run under `tsx` and do not. Importing this module first
 * gives those processes the same configuration the web app sees — otherwise a
 * worker silently runs with mock providers while the web app uses real ones.
 *
 * Precedence matches Next.js: `.env.local` overrides `.env`. `process.loadEnvFile`
 * follows `--env-file` semantics and does not overwrite variables already set in
 * the real environment, so loading `.env.local` first is what makes it win.
 */
const FILES = [".env.local", ".env"] as const;

let loaded = false;

export function loadEnvFiles(): void {
  if (loaded) return;
  loaded = true;

  for (const file of FILES) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Missing file is expected in containerised deployments where the
      // environment is injected directly. Validation in lib/env reports any
      // values that are actually absent.
    }
  }
}

loadEnvFiles();

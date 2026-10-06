/**
 * Whole-run teardown for the integration harness.
 *
 * Vitest calls `teardown()` once after every test file has finished, in the runner
 * process, and it calls it whether the run passed, failed, or was cut short — which is
 * the property this needs and a per-file `afterAll` does not have. A file that throws in
 * its own `beforeAll` never reaches its `afterAll`, and that is precisely the run that
 * leaves the most behind.
 *
 * **Why the sweep is here and not in `useDatabase()`.** A per-file hook would clean the
 * shared `vidxir-test` namespace while other files may still be using it. That is safe
 * today only because `vitest.config.ts` sets `fileParallelism: false` whenever
 * `TEST_DATABASE_URL` is present, and building teardown on top of that would mean
 * enabling parallelism later silently turns cleanup into one file deleting another's live
 * queue keys and uploads mid-test. Sweeping once, after the last file, cannot do that
 * regardless of how the files were scheduled. The cost is that a run holds its own keys
 * and objects until it ends; the leak this fixes was across runs, not within one.
 *
 * Nothing is cleaned on the way *in*. A `setup()` that emptied the namespace would be a
 * second mechanism doing the same deletes at a moment when the previous run's data is the
 * only evidence left of why it failed. The sweep at the end already guarantees the next
 * run starts empty.
 */
import {
  applyTestNamespaceEnv,
  cleanupTestNamespace,
} from "./cleanup";

/**
 * Required by Vitest's globalSetup contract, and deliberately empty.
 *
 * Env for the test workers is applied by `setup.ts` inside each worker; this process
 * only needs it at teardown, where `teardown()` applies it itself.
 */
export function setup(): void {}

export async function teardown(): Promise<void> {
  /**
   * Gated on the same variable the whole integration harness is gated on.
   *
   * `npm test` with no database runs the unit suite alone, touches neither Redis nor
   * storage, and must not have a namespace applied to its environment on the way out —
   * let alone a delete issued against one.
   */
  if (!process.env["TEST_DATABASE_URL"]) return;

  // The runner process never imported `setup.ts`, so it has no namespace of its own yet.
  applyTestNamespaceEnv();

  const result = await cleanupTestNamespace();
  if (result.skipped) {
    // Reported, not thrown: refusing to clean a namespace is the guard working, and it
    // must not turn a green run red. Silence would leave the growth unexplained.
    console.warn(`[integration teardown] skipped cleanup — ${result.skipped}`);
    return;
  }
  if (result.redisKeysDeleted > 0 || result.objectsDeleted > 0) {
    /**
     * Written to stdout directly, as `src/lib/logger` does.
     *
     * A sweep summary is information, not a warning, and `no-console` allows only `warn`
     * and `error` outside the CLI surfaces — so reporting it through `console.warn` would
     * mean dressing a routine line as a problem to satisfy a lint rule.
     */
    process.stdout.write(
      `[integration teardown] removed ${result.redisKeysDeleted} Redis key(s) and ` +
        `${result.objectsDeleted} object(s) from the vidxir-test namespace\n`,
    );
  }
}

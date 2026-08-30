/**
 * Integration-test harness.
 *
 * These tests talk to a real Postgres. §39 asks for coverage of authentication,
 * authorization, database operations and multi-tenant isolation, and none of
 * those can be proven against a mock: tenant isolation is a property of the SQL
 * that actually runs, not of the function that composes it.
 *
 * Opt-in via TEST_DATABASE_URL. When it is absent the suites `describe.skip`
 * themselves loudly rather than passing vacuously.
 *
 * Two things this harness has to work around:
 *
 *  1. `src/lib/auth/session.ts` reads and writes the session cookie through
 *     `next/headers`, which only exists inside a Next request. `cookieJar()`
 *     installs a minimal in-memory cookie store so the real session code path —
 *     token generation, hashing, epoch checks, sliding expiry — is exercised
 *     rather than bypassed.
 *  2. `lib/env` and `lib/db` are singletons keyed off `process.env` at first
 *     touch, so the env has to be set before anything imports them. Hence the
 *     module-scope assignment below and the dynamic imports in the tests.
 */
import { afterAll, beforeAll } from "vitest";
import { applyTestNamespaceEnv } from "./cleanup";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

/** True when a test database was supplied, so suites can gate themselves. */
export const hasDatabase = Boolean(TEST_DATABASE_URL);

if (TEST_DATABASE_URL) {
  // NODE_ENV=test comes from vitest.config.ts — Next's types make it read-only
  // here, and it has to be set before the runner loads anything anyway.
  process.env["DATABASE_URL"] = TEST_DATABASE_URL;
  process.env["APP_URL"] ??= "http://localhost:3000";
  /**
   * Redis, queue prefix and bucket come from the cleanup module (§teardown).
   *
   * Defined there rather than here so that the code which *deletes* the namespace and the
   * code which *creates* it cannot disagree about what it is called. A duplicated
   * `"tally-test"` on both sides would be one careless edit away from a harness that
   * writes to one namespace and a teardown that sweeps another — leaving the leak in
   * place while reporting a clean sweep.
   */
  applyTestNamespaceEnv();
  process.env["ENCRYPTION_KEY"] ??= "a".repeat(64);
  process.env["SESSION_SECRET"] ??= "b".repeat(64);
  // Console email is a real delivery channel in tests: assertions read the
  // token out of the database, not out of an inbox.
  process.env["EMAIL_PROVIDER"] = "console";
  process.env["TALLY_USE_MOCK_PROVIDERS"] = "true";
  process.env["LOG_LEVEL"] ??= "error";
}

// ---------------------------------------------------------------------------
// Cookie store shim
// ---------------------------------------------------------------------------

interface StoredCookie {
  name: string;
  value: string;
}

/**
 * The subset of Next's cookie store that `lib/auth/session` uses.
 *
 * `next/headers` is mocked to return this, so `createSession()` really does set
 * a cookie and `getSession()` really does read one back.
 */
export interface CookieJar {
  get(name: string): StoredCookie | undefined;
  set(name: string, value: string, options?: unknown): void;
  delete(name: string): void;
  /** Drop everything, i.e. a fresh browser. */
  clear(): void;
  /** Hand a raw token to the jar, i.e. paste a stolen cookie in. */
  inject(name: string, value: string): void;
}

function createJar(): CookieJar {
  const store = new Map<string, string>();
  return {
    get(name) {
      const value = store.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set(name, value) {
      store.set(name, value);
    },
    delete(name) {
      store.delete(name);
    },
    clear() {
      store.clear();
    },
    inject(name, value) {
      store.set(name, value);
    },
  };
}

/** The single jar every test shares; `next/headers` is mocked to return it. */
export const jar = createJar();

// ---------------------------------------------------------------------------
// Schema lifecycle
// ---------------------------------------------------------------------------

/**
 * Apply migrations once per test file and truncate between tests.
 *
 * Migrations rather than a schema dump, because the migration files are what
 * production runs — a test schema built any other way could pass against
 * constraints that do not exist in the real database.
 */
export async function prepareDatabase(): Promise<void> {
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgres = (await import("postgres")).default;
  const schema = await import("@/lib/db/schema");
  const { PLAN_CATALOG } = await import("@/lib/plans");

  const sql = postgres(TEST_DATABASE_URL as string, {
    max: 1,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });

  try {
    await migrate(db, { migrationsFolder: "./drizzle" });

    // Plans are reference data the authorization layer reads; without them
    // every entitlement check would fail for reasons unrelated to the test.
    for (const plan of PLAN_CATALOG) {
      await db
        .insert(schema.plans)
        .values({
          tier: plan.tier,
          name: plan.name,
          priceCents: plan.priceCents,
          maxChannels: plan.maxChannels,
          maxVideosPerMonth: plan.maxVideosPerMonth,
          features: plan.features,
        })
        .onConflictDoNothing();
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Tables cleared between tests, in dependency order.
 *
 * `plans` is deliberately absent — it is seeded reference data, not test state.
 * TRUNCATE ... CASCADE covers the rest in one statement so new child tables do
 * not silently start leaking rows between tests.
 *
 * `billing_events` is listed explicitly even though it references `users`,
 * because that FK is `ON DELETE set null`: a webhook event Tally could not match
 * to an account has a null `user_id`, so the cascade from `users` would never
 * reach it and its unique (provider, event id) row would survive into the next
 * test — where a redelivery assertion would then see a "duplicate" that belongs
 * to a different test.
 */
const RESET_ROOTS = [
  "users",
  "research_runs",
  "jobs",
  "api_usage",
  "billing_events",
] as const;

export async function resetDatabase(): Promise<void> {
  const { rawSql } = await import("@/lib/db");
  const sql = rawSql();
  await sql.unsafe(
    `TRUNCATE TABLE ${RESET_ROOTS.map((t) => `"${t}"`).join(", ")} CASCADE`,
  );
  jar.clear();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface TestUser {
  id: string;
  email: string;
  password: string;
  name: string;
}

let userCounter = 0;

/**
 * Create a user through the real signup path, so the row has a real scrypt hash
 * and the free-tier subscription that authorization reads.
 */
export async function createUser(
  overrides: Partial<Pick<TestUser, "email" | "password" | "name">> = {},
): Promise<TestUser> {
  const { signup } = await import("@/lib/auth/service");
  userCounter += 1;
  const user: Omit<TestUser, "id"> = {
    email: overrides.email ?? `user${userCounter}@tally.test`,
    password: overrides.password ?? "Integration-Test-Pass-1",
    name: overrides.name ?? `User ${userCounter}`,
  };
  const { userId } = await signup(user);
  return { id: userId, ...user };
}

/** Sign in as a user, leaving the session cookie in the shared jar. */
export async function signIn(user: TestUser): Promise<string> {
  const { login } = await import("@/lib/auth/service");
  const { createSession } = await import("@/lib/auth/session");
  const result = await login(user.email, user.password);
  return createSession(result.userId, { userAgent: "vitest", ipAddress: null });
}

/** Upgrade a user's tier directly, standing in for a confirmed Stripe webhook. */
export async function setTier(
  userId: string,
  tier: "starter" | "studio" | "scale",
): Promise<void> {
  const { db } = await import("@/lib/db");
  const { subscriptions } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  await db
    .update(subscriptions)
    .set({ tier, status: "active", updatedAt: new Date() })
    .where(eq(subscriptions.userId, userId));
}

/**
 * Insert a connected channel without going through Google.
 *
 * OAuth itself is covered by its own tests; everything downstream of it only
 * needs a channel row that looks the way the callback would leave it.
 */
export async function createChannel(
  userId: string,
  overrides: { youtubeChannelId?: string; title?: string } = {},
): Promise<string> {
  const { db } = await import("@/lib/db");
  const { channels } = await import("@/lib/db/schema");
  const { encryptNullable } = await import("@/lib/crypto");

  const suffix = Math.abs(hashCode(`${userId}:${overrides.youtubeChannelId ?? ""}`));
  const rows = await db
    .insert(channels)
    .values({
      userId,
      youtubeChannelId:
        overrides.youtubeChannelId ?? `UC${String(suffix).padStart(22, "0").slice(0, 22)}`,
      title: overrides.title ?? "Test Channel",
      // Stored encrypted exactly as the OAuth callback would leave them, so a
      // test that reads a token back exercises the real decrypt path (§6).
      accessTokenEnc: encryptNullable("test-access-token"),
      refreshTokenEnc: encryptNullable("test-refresh-token"),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      grantedScopes: "https://www.googleapis.com/auth/youtube.upload",
    })
    .returning({ id: channels.id });

  const created = rows[0];
  if (!created) throw new Error("Failed to insert test channel");
  return created.id;
}

/** Deterministic pseudo-id source; Math.random would make failures unrepeatable. */
function hashCode(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h << 5) - h + input.charCodeAt(i);
    h |= 0;
  }
  return h;
}

// ---------------------------------------------------------------------------
// Shared lifecycle for every integration file
// ---------------------------------------------------------------------------

/** Call at the top of an integration `describe` to get migrations + teardown. */
export function useDatabase(): void {
  beforeAll(async () => {
    await prepareDatabase();
    await resetDatabase();
  }, 60_000);

  afterAll(async () => {
    const { closeDb } = await import("@/lib/db");
    await closeDb();
  });
}

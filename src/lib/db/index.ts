/**
 * Database client.
 *
 * One pool per process. Next.js dev-mode module reloading would otherwise open
 * a new pool on every hot reload until Postgres refuses connections, so the
 * client is cached on `globalThis` outside production.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

type Sql = ReturnType<typeof postgres>;
type Database = ReturnType<typeof drizzle<typeof schema>>;

const globalForDb = globalThis as unknown as {
  __tallySql?: Sql;
  __tallyDb?: Database;
};

function createClient(): { sql: Sql; db: Database } {
  const e = env();
  const sql = postgres(e.DATABASE_URL, {
    max: e.DATABASE_POOL_MAX,
    // Fail fast rather than hanging a request when Postgres is unreachable.
    connect_timeout: 10,
    idle_timeout: 30,
    // Drizzle handles its own type parsing; disable postgres.js transforms.
    transform: { undefined: null },
    onnotice: () => {},
  });
  return { sql, db: drizzle(sql, { schema, logger: false }) };
}

function client() {
  if (env().NODE_ENV === "production") {
    globalForDb.__tallyDb ??= createClient().db;
    return globalForDb.__tallyDb;
  }
  if (!globalForDb.__tallyDb) {
    const created = createClient();
    globalForDb.__tallySql = created.sql;
    globalForDb.__tallyDb = created.db;
  }
  return globalForDb.__tallyDb;
}

/**
 * Drizzle database handle. Accessed through a Proxy so importing this module
 * never opens a connection — a route that only needs types, or a unit test that
 * never touches the DB, must not require Postgres to be running.
 */
export const db = new Proxy({} as Database, {
  get(_target, prop, receiver) {
    return Reflect.get(client(), prop, receiver);
  },
});

/** Raw postgres.js handle for the rare query Drizzle cannot express. */
export function rawSql(): Sql {
  if (!globalForDb.__tallySql) {
    const created = createClient();
    globalForDb.__tallySql = created.sql;
    globalForDb.__tallyDb ??= created.db;
  }
  return globalForDb.__tallySql;
}

/** Close the pool. Used by workers on SIGTERM and by integration tests. */
export async function closeDb(): Promise<void> {
  if (globalForDb.__tallySql) {
    await globalForDb.__tallySql.end({ timeout: 5 });
    globalForDb.__tallySql = undefined;
    globalForDb.__tallyDb = undefined;
  }
}

export { schema };

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
  __vidxirSql?: Sql;
  __vidxirDb?: Database;
};

function createClient(): { sql: Sql; db: Database } {
  const e = env();
  const sql = postgres(e.DATABASE_URL, {
    max: e.DATABASE_POOL_MAX,
    // Fail fast rather than hanging a request when Postgres is unreachable.
    connect_timeout: 10,
    idle_timeout: 30,
    /**
     * Server-side timeouts, applied to every connection in the pool.
     *
     * Without `statement_timeout` a single pathological query holds a pool slot
     * until the client gives up, and with `max` slots taken the whole process
     * stops serving. `idle_in_transaction_session_timeout` covers the worse case:
     * a transaction that opened, took its locks, and then stalled — those locks
     * block unrelated tenants until the connection dies.
     *
     * The values are deliberately far above any legitimate query in this
     * application (the slowest are the analytics rollups, tens of milliseconds)
     * and far below a human-noticeable outage.
     */
    connection: {
      statement_timeout: e.DATABASE_STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: e.DATABASE_IDLE_TX_TIMEOUT_MS,
    },
    // Drizzle handles its own type parsing; disable postgres.js transforms.
    transform: { undefined: null },
    onnotice: () => {},
  });
  return { sql, db: drizzle(sql, { schema, logger: false }) };
}

/**
 * The pool, created once.
 *
 * Both handles are always cached together. An earlier version stored only the
 * Drizzle handle in production, which made `closeDb()` — whose guard is on
 * `__vidxirSql` — a silent no-op there, so the worker and scheduler exited on
 * SIGTERM without draining Postgres connections.
 */
function client() {
  if (!globalForDb.__vidxirDb) {
    const created = createClient();
    globalForDb.__vidxirSql = created.sql;
    globalForDb.__vidxirDb = created.db;
  }
  return globalForDb.__vidxirDb;
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
  if (!globalForDb.__vidxirSql) client();
  // `client()` assigns both handles together, so this is non-null by construction.
  return globalForDb.__vidxirSql as Sql;
}

/**
 * Round-trip to Postgres, for the readiness probe (§16).
 *
 * `select 1` rather than a table read: readiness asks whether this instance can
 * reach its database, and a query that depends on migration state would conflate
 * two different answers.
 */
export async function pingDb(): Promise<void> {
  await rawSql()`select 1`;
}

/** Close the pool. Used by workers on SIGTERM and by integration tests. */
export async function closeDb(): Promise<void> {
  if (globalForDb.__vidxirSql) {
    await globalForDb.__vidxirSql.end({ timeout: 5 });
    globalForDb.__vidxirSql = undefined;
    globalForDb.__vidxirDb = undefined;
  }
}

export { schema };

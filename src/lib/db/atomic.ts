import { SQL, sql } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { nativeBindings } from "@/lib/cloudflare/bindings";

export type AtomicQuery = SQL | { toSQL(): { sql: string; params: unknown[] } };
const dialect = new SQLiteSyncDialect();

/** D1 executes these statements in one real transaction, rolling back on error. */
export async function atomic(queries: AtomicQuery[]) {
  if (!queries.length) return [];
  const binding = nativeBindings().DB;
  return binding.batch(queries.map((query) => {
    const built = query instanceof SQL ? dialect.sqlToQuery(query) : query.toSQL();
    return binding.prepare(built.sql).bind(...built.params);
  }));
}

/** Must follow the conditional write; a failed CHECK rolls back the entire batch. */
export function requireChange() {
  const id = crypto.randomUUID();
  return [
    sql`INSERT INTO _atomic_guards (id, valid) VALUES (${id}, CASE WHEN changes() > 0 THEN 1 ELSE 0 END)`,
    sql`DELETE FROM _atomic_guards WHERE id = ${id}`,
  ];
}

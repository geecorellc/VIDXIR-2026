import { drizzle } from "drizzle-orm/d1";
import { nativeBindings } from "@/lib/cloudflare/bindings";
import * as schema from "./schema";
import type postgres from "postgres";

function client() { return drizzle(nativeBindings().DB, { schema }); }
type Database = ReturnType<typeof client>;
export const db = new Proxy({} as Database, {
  get(_target, property) {
    const current = client();
    const value = Reflect.get(current, property);
    return typeof value === "function" ? value.bind(current) : value;
  },
});
export async function pingDb(): Promise<void> { await nativeBindings().DB.prepare("SELECT 1").first(); }
export async function closeDb(): Promise<void> { /* Bindings have no connection pool. */ }
/** Legacy PostgreSQL verification scripts must not accidentally run against D1. */
export function rawSql(): ReturnType<typeof postgres> {
  throw new Error("This PostgreSQL verification script is obsolete for Cloudflare. Use npm run test:cloudflare.");
}
export { schema };

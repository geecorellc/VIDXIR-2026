/** SQLite column mappings that preserve the application's existing model types. */
import { customType, integer as sqliteInteger, text as sqliteText } from "drizzle-orm/sqlite-core";

export {
  check, index, integer, primaryKey, real, text, uniqueIndex,
  sqliteTable as pgTable, type AnySQLiteColumn as AnyPgColumn,
} from "drizzle-orm/sqlite-core";

export const uuid = (name: string) => sqliteText(name);
export const varchar = (name: string, _options?: { length?: number }) => sqliteText(name);
export const char = varchar;
export const boolean = (name: string) => sqliteInteger(name, { mode: "boolean" });
export const timestamp = (name: string, _options?: { withTimezone?: boolean; mode?: "date" }) =>
  sqliteInteger(name, { mode: "timestamp_ms" });
export const jsonb = (name: string) => sqliteText(name, { mode: "json" });

// Preserve the numeric-string model API while storing SQLite REAL values.
export const numeric = customType<{
  data: string; driverData: number; config: { precision?: number; scale?: number };
}>({
  dataType: () => "real",
  toDriver: (value) => Number(value),
  fromDriver: (value) => String(value),
});

export function pgEnum<const T extends readonly [string, ...string[]]>(_name: string, values: T) {
  return Object.assign((name: string) => sqliteText(name, { enum: [...values] as [T[number], ...T[number][]] }), { enumValues: values });
}

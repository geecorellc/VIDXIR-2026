import { defineConfig } from "drizzle-kit";

/** Kept separate from the existing PostgreSQL migrations during the migration. */
export default defineConfig({
  schema: "./src/lib/db/schema.d1.ts",
  out: "./drizzle-d1",
  dialect: "sqlite",
  strict: true,
});

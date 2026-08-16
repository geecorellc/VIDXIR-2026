import { defineConfig } from "drizzle-kit";

// drizzle-kit runs outside Next.js, which means it does not get Next's automatic
// .env.local loading. Load the same files Next would, in the same precedence
// order (earlier wins, so .env.local overrides .env).
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Absent file is fine; missing values surface as a validation error later.
  }
}

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});

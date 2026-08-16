/**
 * Migration runner. `npm run db:migrate`
 *
 * Applies every pending SQL file in ./drizzle, then seeds the plan catalogue.
 * Plans are reference data the backend authorises against (§23), so they are
 * seeded here rather than being assumed present.
 */
import "@/lib/load-env";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { PLAN_CATALOG } from "@/lib/plans";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  // A dedicated single connection: migrations must run serially.
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(sql, { schema });

  try {
    console.log("Applying migrations…");
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("Migrations applied.");

    console.log("Seeding plan catalogue…");
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
          queuePriority: plan.queuePriority,
          stripePriceId: plan.stripePriceEnvVar
            ? (process.env[plan.stripePriceEnvVar] ?? null)
            : null,
        })
        .onConflictDoUpdate({
          target: schema.plans.tier,
          set: {
            name: plan.name,
            priceCents: plan.priceCents,
            maxChannels: plan.maxChannels,
            maxVideosPerMonth: plan.maxVideosPerMonth,
            features: plan.features,
            queuePriority: plan.queuePriority,
            stripePriceId: plan.stripePriceEnvVar
              ? (process.env[plan.stripePriceEnvVar] ?? null)
              : null,
          },
        });
    }
    console.log(`Seeded ${PLAN_CATALOG.length} plans.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

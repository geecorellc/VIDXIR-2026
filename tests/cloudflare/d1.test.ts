import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../src/lib/db/schema.d1";
import { PLAN_CATALOG } from "../../src/lib/plans";

describe("Cloudflare D1 migration", () => {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    compatibilityDate: "2026-10-07",
    d1Databases: { DB: "vidxir-migration-test" },
  }));
  let binding: Awaited<ReturnType<typeof runtime.getD1Database>>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const userId = "d1-credit-test-user";

  beforeAll(async () => {
    binding = await runtime.getD1Database("DB");
    const directory = resolve("drizzle-d1");
    for (const file of readdirSync(directory).filter((f) => f.endsWith(".sql")).sort()) {
      for (const statement of readFileSync(resolve(directory, file), "utf8").split(";")) {
        if (statement.trim()) await binding.prepare(statement).run();
      }
    }
    db = drizzle(binding, { schema });
    await db.insert(schema.users).values({
      id: userId,
      email: "d1-test@example.invalid",
      emailNormalized: "d1-test@example.invalid",
      passwordHash: "test-only",
      name: "D1 Test",
    });
    await db.insert(schema.creditBalances).values({
      userId, granted: 100, purchased: 0, spent: 0, period: "2026-10",
    });
  });

  afterAll(async () => { await runtime.dispose(); });

  it("creates all application tables and the authoritative plan catalogue", async () => {
    const tables = await binding.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%'").all();
    expect(tables.results).toHaveLength(42);
    const plans = await db.select().from(schema.plans);
    expect(plans.map((p) => p.tier).sort()).toEqual(["scale", "starter", "studio"]);
    for (const expected of PLAN_CATALOG) {
      expect(plans.find((p) => p.tier === expected.tier)).toMatchObject({
        name: expected.name,
        priceCents: expected.priceCents,
        monthlyCredits: expected.monthlyCredits,
        features: expected.features,
      });
    }
  });

  it("round-trips timestamps and JSON through the D1 Drizzle driver", async () => {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user?.createdAt).toBeInstanceOf(Date);
    expect(user!.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    const [plan] = await db.select().from(schema.plans).where(eq(schema.plans.tier, "studio"));
    expect(typeof plan?.features.autoPublish).toBe("boolean");
  });

  it("rejects negative balances and invalid ledger signs", async () => {
    await expect(binding.prepare("UPDATE credit_balances SET spent = 101 WHERE user_id = ?").bind(userId).run()).rejects.toThrow(/credit_balances_non_negative/);
    await expect(binding.prepare("INSERT INTO credit_ledger (id,user_id,reason,amount,balance_after,period) VALUES ('invalid-sign',?,'spend',5,0,'2026-10')").bind(userId).run()).rejects.toThrow(/credit_ledger_sign_matches_reason/);
  });

  it("rolls back the entire D1 batch when a charge would overdraw", async () => {
    await expect(binding.batch([
      binding.prepare("INSERT INTO credit_ledger (id,user_id,reason,amount,balance_after,period,idempotency_key) VALUES ('rollback-test',?,'spend',-101,0,'2026-10','rollback-charge')").bind(userId),
      binding.prepare("UPDATE credit_balances SET spent=spent+101 WHERE user_id=?").bind(userId),
    ])).rejects.toThrow();
    expect(await binding.prepare("SELECT id FROM credit_ledger WHERE id='rollback-test'").first()).toBeNull();
    const balance = await binding.prepare("SELECT spent FROM credit_balances WHERE user_id=?").bind(userId).first();
    expect(balance?.spent).toBe(0);
  });

  it("enforces charge idempotency while permitting separate unkeyed adjustments", async () => {
    const insert = (id: string, key: string | null) => binding.prepare("INSERT INTO credit_ledger (id,user_id,reason,amount,balance_after,period,idempotency_key) VALUES (?,?,'adjustment',1,101,'2026-10',?)").bind(id, userId, key).run();
    await insert("charge-once", "unique-charge");
    await expect(insert("charge-twice", "unique-charge")).rejects.toThrow(/UNIQUE/);
    await insert("adjustment-1", null);
    await insert("adjustment-2", null);
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { eq, sql } from "drizzle-orm";
import { setNativeBindings, type NativeBindings } from "../../src/lib/cloudflare/bindings";
import { db } from "../../src/lib/db";
import { users, subscriptions, creditLedger, usageCounters, projectEvents, emailTokens } from "../../src/lib/db/schema";
import { chargeCredits, refundCredits, ensureMonthlyGrant, creditBalanceFor, addPurchasedCredits } from "../../src/lib/credits/service";
import { createProject, transition, getProject } from "../../src/lib/projects/service";
import { persistScriptVersion } from "../../src/lib/scripts/service";
import { hashToken } from "../../src/lib/crypto";
import { verifyEmail } from "../../src/lib/auth/service";
import { resetEnvCache } from "../../src/lib/env";

vi.mock("../../src/lib/auth/session", () => ({ revokeAllSessions: vi.fn() }));

describe("Application services on real Cloudflare D1", () => {
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    compatibilityDate: "2026-10-07", d1Databases: { DB: "vidxir-services-test" },
  }));
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    process.env.SESSION_SECRET = "1".repeat(64);
    process.env.EMAIL_PROVIDER = "console";
    process.env.RENDER_EXECUTION = "local";
    resetEnvCache();
    const binding = await runtime.getD1Database("DB");
    for (const file of readdirSync("drizzle-d1").filter((f) => f.endsWith(".sql")).sort()) {
      for (const statement of readFileSync(resolve("drizzle-d1", file), "utf8").split(";")) {
        if (statement.trim()) await binding.prepare(statement).run();
      }
    }
    setNativeBindings({ DB: binding } as unknown as NativeBindings);
  });
  afterAll(async () => { await runtime.dispose(); });

  async function account() {
    const id = crypto.randomUUID();
    await db.insert(users).values({ id, email: `${id}@example.invalid`, emailNormalized: `${id}@example.invalid`, passwordHash: "test", name: "Test" });
    await db.insert(subscriptions).values({ userId: id, tier: "starter", status: "active", provider: "none" });
    return id;
  }
  const charge = (userId: string, key: string, durationMs = 5000) => chargeCredits({ userId, operation: "video_scene", modelId: "tal/1.0", quality: "1080p", durationMs, idempotencyKey: key });

  it("grants once and concurrent retries charge exactly once", async () => {
    const userId = await account();
    const grants = await Promise.all(Array.from({ length: 5 }, () => ensureMonthlyGrant(userId)));
    expect(grants.filter((g) => g.granted)).toHaveLength(1);
    const results = await Promise.all(Array.from({ length: 5 }, () => charge(userId, `same:${userId}`)));
    expect(results.filter((r) => !r.alreadyCharged)).toHaveLength(1);
    expect((await creditBalanceFor(userId)).available).toBe(95);
  });

  it("concurrent spends cannot overdraw or leave a refused charge in the ledger", async () => {
    const userId = await account();
    const outcomes = await Promise.allSettled([charge(userId, `a:${userId}`, 60000), charge(userId, `b:${userId}`, 60000)]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect((await creditBalanceFor(userId)).available).toBe(40);
    const spends = await db.select().from(creditLedger).where(sql`${creditLedger.userId}=${userId} AND ${creditLedger.reason}='spend'`);
    expect(spends).toHaveLength(1);
  });

  it("only operator-assigned admins have unlimited credits, without charging on retries or minting refunds", async () => {
    const userId = await account();
    const [ordinary] = await db.select().from(users).where(eq(users.id, userId));
    expect(ordinary?.role).toBe("user");
    expect((await creditBalanceFor(userId)).unlimited).toBeUndefined();
    await db.update(users).set({ role: "admin" }).where(eq(users.id, userId));
    const key = `admin:${userId}`;
    const results = await Promise.all([1, 2, 3].map(() => charge(userId, key, 600000)));
    expect(results.every((r) => r.charged === 0 && r.cost > 100)).toBe(true);
    expect(await creditBalanceFor(userId)).toMatchObject({ unlimited: true, spent: 0 });
    expect(await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))).toHaveLength(0);
    expect((await refundCredits({ userId, chargeIdempotencyKey: key, reason: "Failed test generation" })).refunded).toBe(0);
    await db.update(users).set({ role: "user" }).where(eq(users.id, userId));
    await expect(charge(userId, `revoked:${userId}`, 600000)).rejects.toThrow();
    expect((await creditBalanceFor(userId)).unlimited).toBeUndefined();
  });

  it("refund and purchased-credit replays are idempotent", async () => {
    const userId = await account();
    const key = `refund-test:${userId}`;
    await charge(userId, key);
    const refunds = await Promise.all([1, 2, 3].map(() => refundCredits({ userId, chargeIdempotencyKey: key, reason: "Test" })));
    expect(refunds.reduce((sum, r) => sum + r.refunded, 0)).toBe(5);
    const purchases = await Promise.all([1, 2, 3].map(() => addPurchasedCredits({ userId, credits: 20, idempotencyKey: `purchase:${userId}`, description: "Test purchase" })));
    expect(purchases.reduce((sum, r) => sum + r.credited, 0)).toBe(20);
    expect((await creditBalanceFor(userId)).available).toBe(120);
  });

  it("quota claims are atomic and rejected projects leave no counter or event", async () => {
    const userId = await account();
    const outcomes = await Promise.allSettled([1, 2, 3].map((n) => createProject({ userId, channelId: null, title: `Project ${n}`, maxVideosPerMonth: 1 })));
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const [counter] = await db.select().from(usageCounters).where(eq(usageCounters.userId, userId));
    expect(counter?.videosStarted).toBe(1);
    expect(await db.select().from(projectEvents).where(eq(projectEvents.userId, userId))).toHaveLength(1);
  });

  it("concurrent transitions have one winner and enforce tenant isolation", async () => {
    const userId = await account();
    const other = await account();
    const project = await createProject({ userId, channelId: null, title: "Transition", maxVideosPerMonth: null });
    await expect(getProject(other, project.id)).rejects.toThrow();
    const outcomes = await Promise.allSettled([1, 2].map(() => transition(userId, project.id, "SCRIPT_GENERATING")));
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
  });

  it("script version numbers are assigned atomically inside the batch", async () => {
    const userId = await account();
    const project = await createProject({ userId, channelId: null, title: "Versions", maxVideosPerMonth: null });
    const draft = { title: "Test", titleIdeas: ["Test"], hook: "Hook", introduction: "Intro", sections: [{ heading: "Section", body: "Narration" }], conclusion: "End", cta: "Subscribe", storyStructure: "Test", references: [] };
    const versions = await Promise.all([1, 2].map(() => persistScriptVersion({ userId, projectId: project.id, source: "user_edit", draft })));
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
  });

  it("a verification token can be consumed only once under concurrent requests", async () => {
    const userId = await account();
    const token = crypto.randomUUID();
    await db.insert(emailTokens).values({ userId, tokenHash: hashToken(token), purpose: "verify_email", expiresAt: new Date(Date.now() + 60000) });
    const outcomes = await Promise.allSettled([1, 2].map(() => verifyEmail(token)));
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
  });
});

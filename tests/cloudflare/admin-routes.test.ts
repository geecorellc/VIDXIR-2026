import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { NextRequest } from "next/server";
import {
  setNativeBindings,
  type NativeBindings,
} from "../../src/lib/cloudflare/bindings";
import { resetEnvCache } from "../../src/lib/env";
import { GET, POST } from "../../src/app/api/admin/[[...path]]/route";
const session = vi.hoisted(() => ({
  user: null as null | {
    id: string;
    email: string;
    name: string;
    emailVerifiedAt: Date | null;
    onboardedAt: Date | null;
    role: "user" | "admin";
  },
}));
vi.mock("../../src/lib/auth/session", () => ({
  getSession: async () =>
    session.user ? { sessionId: "test", user: session.user } : null,
  revokeAllSessions: vi.fn(),
}));
vi.mock("../../src/lib/api/rate-limit", () => ({
  enforce: vi.fn(),
  rules: () => ({ read: {}, mutation: {} }),
}));
describe("Admin HTTP authorization", () => {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      compatibilityDate: "2026-10-07",
      d1Databases: { DB: "admin-api" },
    }),
  );
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    process.env.SESSION_SECRET = "1".repeat(64);
    process.env.EMAIL_PROVIDER = "console";
    resetEnvCache();
    const db = await runtime.getD1Database("DB");
    for (const file of readdirSync("drizzle-d1")
      .filter((f) => f.endsWith(".sql"))
      .sort())
      for (const statement of readFileSync(
        resolve("drizzle-d1", file),
        "utf8",
      ).split(";"))
        if (statement.trim()) await db.prepare(statement).run();
    setNativeBindings({ DB: db } as unknown as NativeBindings);
    await db
      .prepare(
        "INSERT INTO users(id,email,email_normalized,password_hash,name,role,email_verified_at) VALUES ('customer','customer@example.invalid','customer@example.invalid','hash','Customer','user',1),('admin','admin@example.invalid','admin@example.invalid','hash','Admin','admin',1)",
      )
      .run();
  });
  afterAll(async () => {
    await runtime.dispose();
  });
  const req = (path: string) => new NextRequest(`http://localhost${path}`);
  it("requires authentication for all four sections", async () => {
    session.user = null;
    for (const section of ["support", "users", "archive", "mail"]) {
      const response = await GET(req(`/api/admin/${section}`));
      expect(response.status).toBe(401);
    }
  });
  it("rejects a customer even if their client/session claims an admin role", async () => {
    session.user = {
      id: "customer",
      email: "customer@example.invalid",
      name: "Customer",
      emailVerifiedAt: new Date(1),
      onboardedAt: null,
      role: "admin",
    };
    for (const section of ["support", "users", "archive", "mail"]) {
      const response = await GET(req(`/api/admin/${section}`));
      expect(response.status).toBe(403);
    }
  });
  it("returns safe account data to real admins", async () => {
    session.user = {
      id: "admin",
      email: "admin@example.invalid",
      name: "Admin",
      emailVerifiedAt: new Date(1),
      onboardedAt: null,
      role: "admin",
    };
    const response = await GET(req("/api/admin/users"));
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("password_hash");
  });
  it("rejects cross-origin admin changes before they execute", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/admin/users", {
        method: "POST",
        headers: {
          Origin: "https://other.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: "new@example.invalid",
          password: "password12345",
          adminPassword: "test",
        }),
      }),
    );
    expect(response.status).toBe(403);
  });
});

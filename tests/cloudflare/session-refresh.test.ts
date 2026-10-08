import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  setNativeBindings,
  type NativeBindings,
} from "../../src/lib/cloudflare/bindings";
import { resetEnvCache } from "../../src/lib/env";
import { hashToken } from "../../src/lib/crypto";
import { getSession } from "../../src/lib/auth/session";

const jar = vi.hoisted(() => ({
  writable: false,
  set: vi.fn(),
  token: "local-session-test-token",
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => ({ value: jar.token }),
    set: (...args: unknown[]) => {
      if (!jar.writable)
        throw new Error(
          "Cookies can only be modified in a Server Action or Route Handler.",
        );
      jar.set(...args);
    },
  }),
}));

describe("Session renewal on Cloudflare D1", () => {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      compatibilityDate: "2026-10-07",
      d1Databases: { DB: "session-renewal" },
    }),
  );
  let db: Awaited<ReturnType<typeof runtime.getD1Database>>;
  let expiry: number;
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    process.env.SESSION_SECRET = "1".repeat(64);
    process.env.EMAIL_PROVIDER = "console";
    resetEnvCache();
    db = await runtime.getD1Database("DB");
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
        "INSERT INTO users(id,email,email_normalized,password_hash,name,email_verified_at,role) VALUES ('u','session@example.invalid','session@example.invalid','test','Session test',1,'admin')",
      )
      .run();
  });
  beforeEach(async () => {
    jar.writable = false;
    jar.set.mockClear();
    expiry = Date.now() + 5 * 60000;
    await db
      .prepare(
        "UPDATE users SET suspended_at=NULL,session_epoch=0 WHERE id='u'",
      )
      .run();
    await db.prepare("DELETE FROM sessions").run();
    await db
      .prepare(
        "INSERT INTO sessions(id,user_id,token_hash,epoch,expires_at) VALUES ('s','u',?,0,?)",
      )
      .bind(hashToken(jar.token), expiry)
      .run();
  });
  afterAll(async () => {
    await runtime.dispose();
  });
  const persistedExpiry = async () =>
    (
      await db
        .prepare("SELECT expires_at FROM sessions WHERE id='s'")
        .first<{ expires_at: number }>()
    )?.expires_at;
  it("renders an older valid session with a read-only cookie store without renewing it", async () => {
    expect(await getSession()).toMatchObject({
      user: { id: "u", role: "admin" },
    });
    expect(await persistedExpiry()).toBe(expiry);
    expect(jar.set).not.toHaveBeenCalled();
  });
  it("renews the session and cookie together when a route handler opts in", async () => {
    jar.writable = true;
    expect(await getSession({ refresh: true })).toMatchObject({
      user: { id: "u" },
    });
    expect(await persistedExpiry()).toBeGreaterThan(Date.now() + 29 * 86400000);
    expect(jar.set).toHaveBeenCalledWith(
      "vidxir_session",
      jar.token,
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        expires: expect.any(Date),
      }),
    );
    await getSession({ refresh: true });
    expect(jar.set).toHaveBeenCalledTimes(1);
  });
  it("does not revive expired, revoked, suspended or superseded sessions", async () => {
    jar.writable = true;
    await db
      .prepare("UPDATE sessions SET expires_at=? WHERE id='s'")
      .bind(Date.now() - 1)
      .run();
    expect(await getSession({ refresh: true })).toBeNull();
    await db
      .prepare("UPDATE sessions SET expires_at=?,revoked_at=1 WHERE id='s'")
      .bind(expiry)
      .run();
    expect(await getSession({ refresh: true })).toBeNull();
    await db.prepare("UPDATE sessions SET revoked_at=NULL WHERE id='s'").run();
    await db.prepare("UPDATE users SET suspended_at=1 WHERE id='u'").run();
    expect(await getSession({ refresh: true })).toBeNull();
    await db
      .prepare(
        "UPDATE users SET suspended_at=NULL,session_epoch=1 WHERE id='u'",
      )
      .run();
    expect(await getSession({ refresh: true })).toBeNull();
    expect(jar.set).not.toHaveBeenCalled();
  });
});

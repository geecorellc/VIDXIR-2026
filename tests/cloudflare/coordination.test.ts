import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

describe("Native Durable Object coordination", () => {
  let runtime: Miniflare;
  beforeAll(async () => {
    const output = await build({ stdin: { contents: `
      export { Coordination } from './cloudflare/coordination.ts';
      export default { async fetch(request, env) {
        const key = new URL(request.url).pathname;
        return env.COORDINATION.get(env.COORDINATION.idFromName(key)).fetch(request);
      } };
    `, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"] });
    runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: output.outputFiles![0]!.text,
      compatibilityDate: "2026-10-07", durableObjects: { COORDINATION: { className: "Coordination", useSQLite: true } },
    }));
  });
  afterAll(async () => { await runtime.dispose(); });
  async function command<T>(key: string, input: Record<string, unknown>): Promise<T> {
    const response = await runtime.dispatchFetch(`http://test/${key}`, { method: "POST", body: JSON.stringify(input) });
    expect(response.ok).toBe(true);
    return response.json() as Promise<T>;
  }
  it("increments a fixed rate-limit window atomically under concurrent calls", async () => {
    const counts = await Promise.all(Array.from({ length: 15 }, () => command<{ count: number; ttlMs: number }>("rate", { operation: "consume", windowMs: 60000 })));
    expect(counts.map((r) => r.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 15 }, (_, index) => index + 1));
    expect(counts.every((r) => r.ttlMs > 0 && r.ttlMs <= 60000)).toBe(true);
  });
  it("has one lock winner and rejects renewal/release by another owner", async () => {
    const claims = await Promise.all(["a", "b", "c"].map((owner) => command<boolean>("lock", { operation: "acquire", owner, ttlMs: 60000 })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const owner = ["a", "b", "c"][claims.findIndex(Boolean)];
    expect(await command("lock", { operation: "renew", owner: "wrong", ttlMs: 60000 })).toBe(false);
    await command("lock", { operation: "release", owner: "wrong" });
    expect((await command<{ held: boolean }>("lock", { operation: "status" })).held).toBe(true);
    await command("lock", { operation: "release", owner });
    expect(await command("lock", { operation: "acquire", owner: "next", ttlMs: 60000 })).toBe(true);
  });
});

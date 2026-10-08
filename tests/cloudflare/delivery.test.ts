import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

describe("Cloudflare durable queue delivery", () => {
  let runtime: Miniflare;
  beforeAll(async () => {
    const output = await build({ stdin: { contents: `
      import backend from './cloudflare/backend.ts';
      import { JobRunner } from './cloudflare/job-runner.ts';
      export { Coordination } from './cloudflare/coordination.ts';
      export class TestRunner extends JobRunner {
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === '/inspect') return Response.json(await this.ctx.storage.get('run'));
          if (path === '/alarm') {
            const state = await this.ctx.storage.get('run');
            await this.ctx.storage.put('run', {...state,message:{...state.message,eligibleAt:Date.now()-1}});
            await this.alarm(); return new Response('ok');
          }
          if (path === '/pending-alarm') return Response.json(await this.ctx.storage.getAlarm());
          return super.fetch(request);
        }
      }
      export default { async fetch(request, env) {
        const url = new URL(request.url);
        const runner = env.RUNNERS.get(env.RUNNERS.idFromName('completed-job'));
        if (url.pathname !== '/deliver') return runner.fetch(request);
        let outcome;
        await backend.queue({messages:[{body:await request.json(),ack(){outcome='ack'},retry(){outcome='retry'}}]}, env);
        return Response.json({outcome});
      } };
    `, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false,
      format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"] });
    runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: output.outputFiles![0]!.text,
      compatibilityDate: "2026-10-07", compatibilityFlags: ["nodejs_compat"], d1Databases: { DB: "delivery-test" },
      bindings: { ENCRYPTION_KEY: "0".repeat(64), SESSION_SECRET: "1".repeat(64) },
      durableObjects: { RUNNERS: { className: "TestRunner", useSQLite: true }, COORDINATION: { className: "Coordination", useSQLite: true } },
    }));
    const db = await runtime.getD1Database("DB");
    await db.prepare("CREATE TABLE jobs(id TEXT PRIMARY KEY,status TEXT)").run();
    await db.prepare("INSERT INTO jobs VALUES('completed-job','succeeded')").run();
  });
  afterAll(async () => { await runtime.dispose(); });

  it("acknowledges concurrent duplicate deliveries only after durable ownership", async () => {
    const message = { jobId: "completed-job", queue: "pipeline", name: "render", attempts: 3, eligibleAt: Date.now() + 86_400_000 };
    const deliveries = await Promise.all(Array.from({ length: 12 }, async () => {
      const response = await runtime.dispatchFetch("http://test/deliver", { method: "POST", body: JSON.stringify(message) });
      return response.json();
    }));
    expect(deliveries.every((result) => (result as { outcome: string }).outcome === "ack")).toBe(true);
    const state = await (await runtime.dispatchFetch("http://test/inspect")).json();
    expect(state).toEqual({ message, attempt: 0 });
  });

  it("retains completed ownership so a late duplicate cannot restart work", async () => {
    const original = await (await runtime.dispatchFetch("http://test/inspect")).json() as { message: { eligibleAt: number } };
    // Exercise the terminal-job recovery path once the delayed delivery is eligible.
    await runtime.dispatchFetch("http://test/alarm");
    const completed = await (await runtime.dispatchFetch("http://test/inspect")).json();
    expect(completed).toMatchObject({ done: true, attempt: 0 });
    await runtime.dispatchFetch("http://test/deliver", { method: "POST", body: JSON.stringify({ ...original.message, eligibleAt: Date.now() - 1 }) });
    expect(await (await runtime.dispatchFetch("http://test/inspect")).json()).toEqual(completed);
    expect(await (await runtime.dispatchFetch("http://test/pending-alarm")).json()).toBeNull();
  });
});

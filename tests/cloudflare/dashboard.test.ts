import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { setNativeBindings, type NativeBindings } from "../../src/lib/cloudflare/bindings";
import { getOverview } from "../../src/lib/dashboard/overview";
import { revenueSummary } from "../../src/lib/analytics/report";

describe("Dashboard analytics on Cloudflare D1", () => {
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules:true,
    script:"export default { fetch() { return new Response('ok'); } };",
    compatibilityDate:"2026-10-07",d1Databases:{DB:"dashboard-regression"},
  }));
  let binding:Awaited<ReturnType<typeof runtime.getD1Database>>;
  beforeAll(async()=>{
    binding=await runtime.getD1Database("DB");
    for(const file of readdirSync("drizzle-d1").filter(f=>f.endsWith(".sql")).sort()){
      for(const statement of readFileSync(resolve("drizzle-d1",file),"utf8").split(";"))if(statement.trim())await binding.prepare(statement).run();
    }
    setNativeBindings({DB:binding} as unknown as NativeBindings);
  });
  afterAll(async()=>{await runtime.dispose();});
  it("loads an empty dashboard after onboarding without PostgreSQL-only aggregates",async()=>{
    const result=await getOverview("new-onboarded-user");
    expect(result.hasChannel).toBe(false);
    expect(result.revenue.value).toBeNull();
    expect(result.inProgress).toEqual([]);
  });
  it("maps SQLite settlement aggregates to booleans and respects unsettled days",async()=>{
    await binding.prepare("INSERT INTO users(id,email,email_normalized,password_hash,name) VALUES ('u','u@example.invalid','u@example.invalid','test','Test')").run();
    await binding.prepare("INSERT INTO channels(id,user_id,youtube_channel_id,title) VALUES ('c','u','youtube-c','Channel')").run();
    const now=Date.now();
    await binding.prepare("INSERT INTO analytics_snapshots(id,user_id,channel_id,date,revenue_state,revenue_currency,estimated_revenue,revenue_final) VALUES ('a','u','c',?,'reported','USD','2.00',1),('b','u','c',?,'reported','USD','3.00',0)").bind(now-1000,now).run();
    const range={start:new Date(now-2000),end:new Date(now+1000)};
    expect((await revenueSummary('u',{range})).final).toBe(false);
    await binding.prepare("UPDATE analytics_snapshots SET revenue_final=1 WHERE id='b'").run();
    expect((await revenueSummary('u',{range})).final).toBe(true);
  });
});

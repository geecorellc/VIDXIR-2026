import { bridge, type BackendEnv } from "./bridge";
import type { JobMessage } from "./job-runner";
export { JobRunner } from "./job-runner";
export { Coordination } from "./coordination";

function configured(env: BackendEnv): boolean {
  return [env.ENCRYPTION_KEY, env.SESSION_SECRET].every((value) => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value));
}

export default {
  async fetch(request: Request, env: BackendEnv): Promise<Response> {
    try {
      if (new URL(request.url).pathname === "/health") {
        await env.DB.prepare("SELECT 1").first();
        if (!configured(env)) return Response.json({ status: "not_configured", missing: ["ENCRYPTION_KEY", "SESSION_SECRET"].filter((key) => !env[key]) }, { status: 503 });
        const probe = env.RUNNERS.get(env.RUNNERS.idFromName("deployment-probe"));
        return probe.fetch("http://runner/probe");
      }
      return await bridge(request, env);
    } catch (error) {
      console.error("Private Cloudflare binding bridge failed", error);
      return new Response(String(error), { status: 500 });
    }
  },
  async queue(batch: MessageBatch<JobMessage>, env: BackendEnv) {
    for (const message of batch.messages) {
      if (!configured(env)) { message.retry({ delaySeconds: 300 }); continue; }
      try {
        const body = message.body;
        if (!body.jobId || !body.name || !body.queue) { message.ack(); continue; }
        const runner = env.RUNNERS.get(env.RUNNERS.idFromName(body.jobId));
        const response = await runner.fetch("https://runner/run", { method: "POST", body: JSON.stringify(body) });
        if (!response.ok) throw new Error("Durable runner did not accept message.");
        message.ack(); // The Durable Object now owns delivery and retries.
      } catch { message.retry({ delaySeconds: 30 }); }
    }
  },
  async scheduled(event: ScheduledController, env: BackendEnv) {
    // Do not start paid Containers until the operator supplies runtime secrets.
    if (!configured(env)) { console.warn("Scheduled work paused: runtime secrets are missing."); return; }
    const tick = Math.floor(event.scheduledTime / 300_000);
    const tasks = ["automation", ...(tick % 6 === 0 ? ["refresh-channel-stats"] : []),
      ...(tick % 12 === 0 ? ["prune-sessions"] : []), ...(tick % 72 === 0 ? ["ingest-analytics"] : [])];
    for (const name of tasks) {
      await env.MAINTENANCE_QUEUE.send({ jobId: `scheduler:${name}:${tick}`, queue: "maintenance", name, attempts: 3, eligibleAt: event.scheduledTime } satisfies JobMessage);
    }
  },
} satisfies ExportedHandler<BackendEnv, JobMessage>;

import { DurableObject } from "cloudflare:workers";
import type { BackendEnv } from "./bridge";

export interface JobMessage { jobId: string; name: string; queue: string; attempts: number; eligibleAt: number }
interface RunState { message: JobMessage; attempt: number; startedAt?: number; retryAt?: number; done?: boolean; slot?: number }

/** Durable delivery ownership and retries survive Worker/Container restarts. */
export class JobRunner extends DurableObject<BackendEnv> {
  constructor(ctx: DurableObjectState, env: BackendEnv) {
    super(ctx, env);
    if (ctx.container?.running) ctx.blockConcurrencyWhile(() => ctx.container!.setInactivityTimeout(120_000));
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/probe") return this.call("/health");
    const message = await request.json() as JobMessage;
    await this.ctx.blockConcurrencyWhile(async () => {
      const existing = await this.ctx.storage.get<RunState>("run");
      if (existing) return; // At-least-once Queue deliveries must not start a second copy.
      await this.ctx.storage.put("run", { message, attempt: 0 } satisfies RunState);
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, message.eligibleAt));
    });
    return new Response(null, { status: 202 });
  }

  private async call(path: string, body?: unknown): Promise<Response> {
    const container = this.ctx.container;
    if (!container) throw new Error("No video worker Container configured.");
    if (!container.running) {
      const variables = Object.fromEntries(Object.entries(this.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      container.start({ image: container.images.base!, instance: "standard-1", enableInternet: true,
        env: { ...variables, NODE_ENV: "production", RENDER_EXECUTION: "local", FFMPEG_PATH: "/usr/bin/ffmpeg", FFMPEG_BIN: "/usr/bin/ffmpeg" } });
    }
    await container.setInactivityTimeout(120_000);
    await container.interceptOutboundHttp("bindings.internal", this.env.SELF);
    const port = container.getTcpPort(8080);
    // The process can be running before its HTTP port is ready.
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        return await port.fetch(`http://container${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
      } catch (error) {
        if (attempt === 29) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    throw new Error("Container port did not become ready.");
  }

  override async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<RunState>("run");
    if (!state || state.done) return;
    // Set recovery alarm before external I/O; a failed invocation cannot strand the job.
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
    const now = Date.now();
    let jobStatus: string | undefined;
    if ((state.retryAt ?? state.message.eligibleAt) > now) {
      await this.ctx.storage.setAlarm(state.retryAt ?? state.message.eligibleAt);
      return;
    }
    if (state.message.queue !== "maintenance") {
      const row = await this.env.DB.prepare("SELECT status FROM jobs WHERE id=?").bind(state.message.jobId).first<{ status: string }>();
      jobStatus = row?.status;
      if (!row || ["succeeded", "failed", "blocked_not_configured", "cancelled"].includes(row.status)) {
        await this.finish(state);
        return;
      }
    }
    if (state.startedAt) {
      if (state.slot !== undefined) {
        const renewed = await this.slot(state.slot, "renew", state.message.jobId);
        if (!renewed) { await this.retry(state, "The execution lease expired.", true); return; }
      }
      // A bounded job lifetime also prevents a hung provider from running up costs.
      if (now - state.startedAt > 60 * 60_000) {
        await this.ctx.container?.destroy();
        await this.retry(state, "The background job exceeded its one-hour limit.", true);
        return;
      }
      try {
        const response = await this.call(`/status?jobId=${encodeURIComponent(state.message.jobId)}`);
        const result = await response.json() as { status: "running" | "succeeded" | "failed" | "missing"; retryable?: boolean };
        if (result.status === "running") return;
        if (result.status === "succeeded") { await this.finish(state); return; }
        await this.retry(state, "The background process stopped before completing this job.", result.retryable ?? true);
      } catch { await this.retry(state, "Could not contact the background process.", true); }
      return;
    }
    // A shared lease caps total active job Containers at five, across all queues.
    // Queued paid-plan jobs are admitted by their durable priority before new work.
    if (jobStatus === "queued") {
      const candidates = await this.env.DB.prepare("SELECT id FROM jobs WHERE status='queued' AND (scheduled_for IS NULL OR scheduled_for<=?) ORDER BY priority ASC,created_at ASC LIMIT 5")
        .bind(now).all<{ id: string }>();
      if (candidates.results.length && !candidates.results.some((job) => job.id === state.message.jobId)) return;
    }
    let acquired = false;
    for (let index = 0; index < 5; index++) {
      if (await this.slot(index, "acquire", state.message.jobId)) { state.slot = index; acquired = true; break; }
    }
    if (!acquired) return;
    state.attempt++;
    state.startedAt = now;
    state.retryAt = undefined;
    await this.ctx.storage.put("run", state);
    try {
      const response = await this.call("/run", { ...state.message, attempt: state.attempt });
      if (!response.ok) throw new Error("Container did not accept the job.");
    } catch { await this.retry(state, "Could not start the background process.", true); }
  }

  private async retry(state: RunState, message: string, retryable: boolean) {
    await this.ctx.container?.destroy(); // Prevent an uncertain old process overlapping the next attempt.
    if (state.slot !== undefined) await this.slot(state.slot, "release", state.message.jobId);
    state.slot = undefined;
    if (retryable && state.attempt < state.message.attempts) {
      state.startedAt = undefined;
      state.retryAt = Date.now() + 15_000 * 2 ** Math.max(0, state.attempt - 1);
      await this.ctx.storage.put("run", state);
      await this.ctx.storage.setAlarm(state.retryAt);
      return;
    }
    if (state.message.queue !== "maintenance") {
      await this.env.DB.prepare("UPDATE jobs SET status='failed',error=?,error_code='internal_error',finished_at=?,updated_at=? WHERE id=? AND status NOT IN ('succeeded','blocked_not_configured','cancelled')")
        .bind(message, Date.now(), Date.now(), state.message.jobId).run();
    }
    await this.finish(state);
  }

  private async finish(state: RunState) {
    state.done = true;
    await this.ctx.storage.put("run", state);
    await this.ctx.storage.deleteAlarm();
    // Sleeping does not erase durable ownership, so a late duplicate stays a no-op.
    await this.ctx.container?.destroy();
    if (state.slot !== undefined) await this.slot(state.slot, "release", state.message.jobId);
  }

  private async slot(index: number, operation: string, owner: string): Promise<boolean> {
    const namespace = this.env.COORDINATION;
    const response = await namespace.get(namespace.idFromName(`execution-slot:${index}`)).fetch("http://coordination/", {
      method: "POST", body: JSON.stringify({ operation, owner, ttlMs: 120_000 }),
    });
    if (!response.ok) throw new Error("Execution slot coordination failed.");
    return response.json() as Promise<boolean>;
  }
}

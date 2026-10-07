import { DurableObject } from "cloudflare:workers";

/** One SQLite-backed object per rate-limit key or lock. No external Redis. */
export class Coordination extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const input = await request.json() as { operation: string; owner?: string; ttlMs?: number; windowMs?: number };
    return Response.json(await this.ctx.storage.transaction(async () => {
      const now = Date.now();
      if (input.operation === "consume") {
        const windowMs = input.windowMs!;
        let state = await this.ctx.storage.get<{ count: number; expires: number }>("window");
        if (!state || state.expires <= now) state = { count: 0, expires: now + windowMs };
        state.count++;
        await this.ctx.storage.put("window", state);
        await this.ctx.storage.setAlarm(state.expires);
        return { count: state.count, ttlMs: Math.max(0, state.expires - now) };
      }
      const lock = await this.ctx.storage.get<{ owner: string; expires: number }>("lock");
      const held = lock !== undefined && lock.expires > now;
      if (input.operation === "acquire") {
        if (held) return false;
        const expires = now + input.ttlMs!;
        await this.ctx.storage.put("lock", { owner: input.owner, expires });
        await this.ctx.storage.setAlarm(expires);
        return true;
      }
      if (input.operation === "renew") {
        if (!held || lock.owner !== input.owner) return false;
        const expires = now + input.ttlMs!;
        await this.ctx.storage.put("lock", { owner: lock.owner, expires });
        await this.ctx.storage.setAlarm(expires);
        return true;
      }
      if (input.operation === "release") {
        if (held && lock.owner === input.owner) await this.ctx.storage.delete("lock");
        return true;
      }
      if (input.operation === "status") return { held, ttlMs: held ? lock.expires - now : null };
      if (input.operation === "ping") return true;
      throw new Error("Unknown coordination operation.");
    }));
  }

  override async alarm(): Promise<void> {
    // Renewed alarms cannot erase a live lock/window, even if a stale alarm runs.
    await this.ctx.storage.transaction(async () => {
      for (const key of ["lock", "window"]) {
        const value = await this.ctx.storage.get<{ expires: number }>(key);
        if (value && value.expires <= Date.now()) await this.ctx.storage.delete(key);
      }
    });
  }
}

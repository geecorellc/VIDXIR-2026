import { createServer } from "node:http";
import { installContainerBindings } from "@/lib/cloudflare/container-bindings";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { HANDLERS } from "./registry";
import { runJob, shouldRetry } from "./runner";
import { withLock } from "@/lib/queue/lock";
import { TASKS } from "@/scheduler/tasks";
import type { QueueName } from "@/lib/queue/queues";
import { execFileSync } from "node:child_process";
import { logger } from "@/lib/logger";

installContainerBindings();
const log = logger.child({ component: "cloudflare-container" });
const outcomes = new Map<string, { status: "running" | "succeeded" | "failed"; retryable?: boolean }>();

interface RunMessage { jobId: string; queue: string; name: string; attempts: number; attempt: number }
async function execute(message: RunMessage) {
  try {
    if (message.queue === "maintenance") {
      const task = TASKS.find((candidate) => candidate.name === message.name);
      if (!task) throw new Error("Unknown scheduled task.");
      await withLock(`scheduler:${task.name}`, task.run, { ttlMs: task.lockTtlMs });
    } else {
      const [row] = await db.select().from(jobs).where(eq(jobs.id, message.jobId)).limit(1);
      if (!row) throw new Error("Durable job not found.");
      if (!["succeeded", "failed", "blocked_not_configured", "cancelled"].includes(row.status)) {
        let discarded = false;
        try {
          await runJob(message.queue as QueueName, HANDLERS[message.queue as QueueName] ?? {}, {
            id: row.id, name: row.name, data: { ...row.payload, jobId: row.id },
            attemptsMade: message.attempt - 1, opts: { attempts: row.maxAttempts }, discard() { discarded = true; },
          });
        } catch (error) {
          outcomes.set(message.jobId, { status: "failed", retryable: !discarded && shouldRetry(error) });
          log.error("background job failed", { jobId: message.jobId, error });
          return;
        }
      }
    }
    outcomes.set(message.jobId, { status: "succeeded" });
  } catch (error) {
    outcomes.set(message.jobId, { status: "failed", retryable: shouldRetry(error) });
    log.error("container execution failed", { jobId: message.jobId, error });
  }
}

createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  try {
    const url = new URL(request.url ?? "/", "http://container");
    if (url.pathname === "/health") {
      await db.select({ id: jobs.id }).from(jobs).limit(1);
      const ffmpeg = execFileSync("/usr/bin/ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0];
      response.end(JSON.stringify({ status: "ok", database: "d1", media: "r2", ffmpeg }));
      return;
    }
    if (url.pathname === "/status") { response.end(JSON.stringify(outcomes.get(url.searchParams.get("jobId") ?? "") ?? { status: "missing" })); return; }
    if (url.pathname !== "/run" || request.method !== "POST") { response.statusCode = 404; response.end("{}"); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString()) as RunMessage;
    if (!outcomes.has(message.jobId)) {
      outcomes.set(message.jobId, { status: "running" });
      void execute(message);
    }
    response.statusCode = 202;
    response.end(JSON.stringify({ accepted: true }));
  } catch (error) {
    log.error("container request failed", { error });
    response.statusCode = 500;
    response.end(JSON.stringify({ error: "Container request failed." }));
  }
}).listen(8080, "0.0.0.0");

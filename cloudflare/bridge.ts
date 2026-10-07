export interface BackendEnv {
  DB: D1Database;
  MEDIA: R2Bucket;
  COORDINATION: DurableObjectNamespace;
  RUNNERS: DurableObjectNamespace;
  SELF: Fetcher;
  RESEARCH_QUEUE: Queue;
  PIPELINE_QUEUE: Queue;
  PUBLISH_QUEUE: Queue;
  ANALYTICS_QUEUE: Queue;
  MAINTENANCE_QUEUE: Queue;
  [key: string]: unknown;
}

/** Only reachable through a service binding or a Container outbound intercept. */
export async function bridge(request: Request, env: BackendEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/storage") {
    const key = url.searchParams.get("key");
    if (!key?.startsWith("u/")) return new Response("Invalid key", { status: 400 });
    if (request.method === "PUT") {
      await env.MEDIA.put(key, request.body, {
        httpMetadata: { contentType: request.headers.get("content-type") ?? "application/octet-stream" },
        customMetadata: JSON.parse(request.headers.get("x-object-metadata") ?? "{}"),
      });
      return Response.json({ success: true });
    }
    if (request.method === "DELETE") { await env.MEDIA.delete(key); return new Response(null, { status: 204 }); }
    if (request.method === "HEAD") return new Response(null, { status: await env.MEDIA.head(key) ? 200 : 404 });
    const object = await env.MEDIA.get(key);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body, { headers: { "content-type": object.httpMetadata?.contentType ?? "application/octet-stream" } });
  }
  const input = await request.json() as {
    operation: string; statements?: { sql: string; params: unknown[] }[];
    key?: string; command?: Record<string, unknown>; queue?: string; message?: unknown; options?: QueueSendOptions;
  };
  if (input.operation === "sql") {
    const statements = input.statements ?? [];
    const prepared = statements.map((q) => env.DB.prepare(q.sql).bind(...q.params));
    return Response.json(await env.DB.batch(prepared));
  }
  if (input.operation === "coordinate") {
    const stub = env.COORDINATION.get(env.COORDINATION.idFromName(input.key!));
    return stub.fetch("https://coordination/", { method: "POST", body: JSON.stringify(input.command) });
  }
  if (input.operation === "queue") {
    const bindings = { research: env.RESEARCH_QUEUE, pipeline: env.PIPELINE_QUEUE, publish: env.PUBLISH_QUEUE,
      analytics: env.ANALYTICS_QUEUE, maintenance: env.MAINTENANCE_QUEUE };
    const queue = bindings[input.queue as keyof typeof bindings];
    if (!queue) return new Response("Unknown queue", { status: 400 });
    await queue.send(input.message, input.options);
    return Response.json({ success: true });
  }
  return new Response("Unknown operation", { status: 400 });
}

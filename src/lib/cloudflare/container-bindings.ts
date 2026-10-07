import { setNativeBindings, type NativeBindings } from "./bindings";

const base = "http://bindings.internal";
async function rpc<T>(input: unknown): Promise<T> {
  const response = await fetch(`${base}/rpc`, { method: "POST", body: JSON.stringify(input) });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

class Statement {
  constructor(readonly sql: string, readonly params: unknown[] = []) {}
  bind(...params: unknown[]) { return new Statement(this.sql, params); }
  async all() { return (await rpc<{ results: Record<string, unknown>[] }[]>({ operation: "sql", statements: [this] }))[0]!; }
  async run() { return this.all(); }
  async raw() { return (await this.all()).results.map((row) => Object.values(row)); }
  async first(column?: string) { const row = (await this.all()).results[0]; return column ? row?.[column] ?? null : row ?? null; }
}

/** Drizzle uses the same D1 contract in Node, transported through the private intercept. */
export function installContainerBindings(): void {
  const bindings = {
    DB: { prepare: (sql: string) => new Statement(sql), batch: (statements: Statement[]) => rpc({ operation: "sql", statements }) },
    MEDIA: {
      async put(key: string, body: Uint8Array, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) {
        const response = await fetch(`${base}/storage?key=${encodeURIComponent(key)}`, { method: "PUT", body: Buffer.from(body),
          headers: { "content-type": options?.httpMetadata?.contentType ?? "application/octet-stream", "x-object-metadata": JSON.stringify(options?.customMetadata ?? {}) } });
        if (!response.ok) throw new Error("R2 upload failed.");
      },
      async get(key: string) {
        const response = await fetch(`${base}/storage?key=${encodeURIComponent(key)}`);
        if (response.status === 404) return null;
        if (!response.ok) throw new Error("R2 read failed.");
        return { arrayBuffer: () => response.arrayBuffer() };
      },
      async head(key: string) {
        const response = await fetch(`${base}/storage?key=${encodeURIComponent(key)}`, { method: "HEAD" });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error("R2 metadata read failed.");
        return {};
      },
      async delete(key: string) {
        const response = await fetch(`${base}/storage?key=${encodeURIComponent(key)}`, { method: "DELETE" });
        if (!response.ok) throw new Error("R2 deletion failed.");
      },
    },
    COORDINATION: { idFromName: (name: string) => name, get: (key: string) => ({
      async fetch(_url: string, init: RequestInit) {
        const result = await rpc({ operation: "coordinate", key, command: JSON.parse(String(init.body)) });
        return Response.json(result);
      },
    }) },
  } as unknown as NativeBindings;
  for (const queue of ["research", "pipeline", "publish", "analytics", "maintenance"]) {
    const binding = `${queue.toUpperCase()}_QUEUE` as "PIPELINE_QUEUE";
    bindings[binding] = { send: (message: unknown, options: unknown) => rpc({ operation: "queue", queue, message, options }) } as unknown as NativeBindings["PIPELINE_QUEUE"];
  }
  setNativeBindings(bindings);
}

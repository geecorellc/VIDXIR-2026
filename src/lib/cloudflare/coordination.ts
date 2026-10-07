import { nativeBindings } from "./bindings";

export async function coordinate<T>(key: string, operation: string, input: Record<string, unknown> = {}): Promise<T> {
  const namespace = nativeBindings().COORDINATION;
  const response = await namespace.get(namespace.idFromName(key)).fetch("https://coordination/", {
    method: "POST", body: JSON.stringify({ operation, ...input }),
  });
  if (!response.ok) throw new Error("Cloudflare coordination request failed.");
  return response.json() as Promise<T>;
}

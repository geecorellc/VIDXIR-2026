import { nativeBindings } from "@/lib/cloudflare/bindings";
import { verifyMedia } from "@/lib/cloudflare/media-token";
import { env } from "@/lib/env";

async function media(request: Request): Promise<Response> {
  const grant = verifyMedia(new URL(request.url).searchParams.get("token") ?? "", env().SESSION_SECRET);
  const method = request.method === "HEAD" ? "GET" : request.method;
  if (!grant || grant.method !== method) return new Response("Invalid or expired media link", { status: 403 });
  const bucket = nativeBindings().MEDIA;
  if (method === "PUT") {
    if (!grant.contentType || request.headers.get("content-type") !== grant.contentType) return new Response("Content type mismatch", { status: 400 });
    const maxBytes = 20 * 1024 * 1024;
    if (Number(request.headers.get("content-length")) > maxBytes) return new Response("Upload too large", { status: 413 });
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > maxBytes) return new Response("Upload too large", { status: 413 });
    await bucket.put(grant.key, bytes, { httpMetadata: { contentType: grant.contentType } });
    return new Response(null, { status: 204 });
  }
  const object = await bucket.get(grant.key, { range: request.headers as unknown as import("@cloudflare/workers-types").Headers });
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers as unknown as import("@cloudflare/workers-types").Headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, max-age=300");
  if (grant.filename) headers.set("content-disposition", `attachment; filename="${grant.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120)}"`);
  const range = object.range as { offset?: number; length?: number } | undefined;
  if (range?.offset !== undefined && range.length !== undefined) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
    headers.set("content-length", String(range.length));
  } else headers.set("content-length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body as unknown as ReadableStream, { headers, status: range ? 206 : 200 });
}
export const GET = media;
export const PUT = media;
export const HEAD = media;

import { createHmac, timingSafeEqual } from "node:crypto";

export interface MediaGrant { key: string; method: "GET" | "PUT"; expires: number; contentType?: string; filename?: string }
export function signMedia(grant: MediaGrant, secret: string): string {
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
export function verifyMedia(token: string, secret: string): MediaGrant | null {
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra || token.length > 4096) return null;
    const expected = createHmac("sha256", secret).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const grant = JSON.parse(Buffer.from(payload, "base64url").toString()) as MediaGrant;
    if (!grant.key.startsWith("u/") || !Number.isFinite(grant.expires) || grant.expires <= Date.now()) return null;
    if (grant.method !== "GET" && grant.method !== "PUT") return null;
    return grant;
  } catch { return null; }
}

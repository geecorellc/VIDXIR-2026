import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { clientIp } from "@/lib/api/guard";
import { enforce } from "@/lib/api/rate-limit";
import { isAppError } from "@/lib/errors";
import { allowedJvOrigin, subscribeJv } from "@/lib/marketing/jv-list";

const schema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z
    .string()
    .trim()
    .email()
    .max(320)
    .transform((value) => value.toLowerCase()),
  list: z.literal("vidxir-jv-launch"),
  company: z.string().max(200).optional(),
});
function cors(request: NextRequest): Headers | null {
  const origin = request.headers.get("origin") ?? "";
  if (!allowedJvOrigin(origin)) return null;
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    Vary: "Origin",
  });
}
export async function OPTIONS(request: NextRequest) {
  const headers = cors(request);
  return new NextResponse(null, {
    status: headers ? 204 : 403,
    headers: headers ?? undefined,
  });
}
export async function POST(request: NextRequest) {
  const headers = cors(request);
  if (!headers)
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403 });
  const reply = (body: unknown, status = 200) =>
    NextResponse.json(body, { status, headers });
  try {
    await enforce(
      { name: "jv-subscribe", limit: 5, windowSeconds: 600 },
      clientIp(request),
    );
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      return reply({ error: "JSON required." }, 415);
    if (Number(request.headers.get("content-length")) > 4096)
      return reply({ error: "Request too large." }, 413);
    const raw = await request.text();
    if (raw.length > 4096) return reply({ error: "Request too large." }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply({ error: "Invalid JSON." }, 400);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      return reply({ error: "Enter a valid name and email." }, 400);
    if (parsed.data.company) return reply({ ok: true });
    const key = env().RESEND_API_KEY;
    if (!key)
      return reply({ error: "Signup is temporarily unavailable." }, 503);
    await subscribeJv(key, parsed.data);
    return reply({ ok: true });
  } catch (error) {
    if (isAppError(error)) return reply({ error: error.message }, error.status);
    console.error("JV subscription could not be saved.");
    return reply(
      { error: "Signup is temporarily unavailable. Please try again." },
      503,
    );
  }
}

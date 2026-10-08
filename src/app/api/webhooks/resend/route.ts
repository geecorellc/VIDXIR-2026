import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { mailRuntime } from "@/lib/admin/service";
import {
  verifyWebhook,
  receiveEmail,
  recordEmailEvent,
} from "@/lib/admin/mail";
const eventSchema = z.object({
  type: z.string().max(100),
  created_at: z.string().optional(),
  data: z.object({ email_id: z.string().min(1).max(100) }),
});
export async function POST(request: NextRequest) {
  const secret = env().RESEND_WEBHOOK_SECRET;
  if (!secret)
    return NextResponse.json(
      { error: "Email webhook is not configured." },
      { status: 503 },
    );
  if (Number(request.headers.get("content-length")) > 256 * 1024)
    return new NextResponse(null, { status: 413 });
  const raw = await request.text();
  if (raw.length > 256 * 1024) return new NextResponse(null, { status: 413 });
  if (!verifyWebhook(raw, request.headers, secret))
    return NextResponse.json(
      { error: "Invalid webhook signature." },
      { status: 403 },
    );
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const parsed = eventSchema.safeParse(value);
  if (!parsed.success) return new NextResponse(null, { status: 400 });
  const event = parsed.data,
    runtime = mailRuntime();
  try {
    if (event.type === "email.received")
      await receiveEmail(runtime, event.data.email_id);
    // Keep events even if their provider ID reaches us before the send response.
    // The mailbox joins on provider_id later; out-of-order events cannot regress status.
    const timestamp = Date.parse(event.created_at ?? "");
    await recordEmailEvent(
      runtime,
      request.headers.get("svix-id")!,
      event.data.email_id,
      event.type,
      Number.isFinite(timestamp) ? timestamp : Date.now(),
    );
    return NextResponse.json({ ok: true });
  } catch {
    console.error("Email webhook could not be processed", {
      type: event.type,
      emailId: event.data.email_id,
    });
    return NextResponse.json(
      { error: "Processing temporarily unavailable." },
      { status: 503 },
    );
  }
}

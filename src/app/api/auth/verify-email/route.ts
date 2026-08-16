/**
 * POST /api/auth/verify-email      — consume a verification token
 * PUT  /api/auth/verify-email      — resend the verification email
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { clientIp, handle, parseJson, requireUser } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { resendVerification, verifyEmail } from "@/lib/auth/service";

const consumeSchema = z.object({
  token: z.string().min(10).max(200),
});

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    await enforce(rules().authIp, clientIp(request));
    const { token } = await parseJson(request, consumeSchema);
    const userId = await verifyEmail(token);
    return { userId, emailVerified: true };
  });
}

export async function PUT(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireUser();
    await enforce(rules().verifyResend, user.id);
    await resendVerification(user.id);
    // Always reports sent, including when already verified, so the response
    // gives away nothing and the UI copy stays simple.
    return { sent: true };
  });
}

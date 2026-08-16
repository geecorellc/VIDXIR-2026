/**
 * POST /api/auth/signup
 *
 * Creates the account, the free-tier subscription row, a session, and sends the
 * verification email. Rate-limited by IP so the endpoint cannot be used to
 * enumerate or to mail-bomb.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { handle, clientIp, parseJson } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { signup } from "@/lib/auth/service";
import { createSession } from "@/lib/auth/session";

const bodySchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  email: z.string().trim().email("Enter a valid email address.").max(320),
  password: z.string().min(1, "Password is required.").max(200),
});

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    await enforce(rules().authIp, clientIp(request));

    const body = await parseJson(request, bodySchema);
    const { userId } = await signup(body);

    await createSession(userId, {
      userAgent: request.headers.get("user-agent"),
      ipAddress: clientIp(request),
    });

    return {
      userId,
      // The prototype showed plan selection immediately after signup, then
      // onboarding. `/plan` only *displays* the catalogue — the account stays on
      // the free tier it was just created with until a payment is confirmed (§24).
      nextStep: "plan" as const,
      emailVerificationSent: true,
    };
  });
}

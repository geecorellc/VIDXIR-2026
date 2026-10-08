/**
 * POST /api/auth/login
 *
 * Rate-limited twice: by IP (broad abuse) and by email (targeted credential
 * stuffing). The account lockout in the auth service is the third layer.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { clientIp, handle, parseJson } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { login, normalizeEmail } from "@/lib/auth/service";
import { createSession } from "@/lib/auth/session";

const bodySchema = z.object({
  email: z.string().trim().email("Enter a valid email address.").max(320),
  password: z.string().min(1, "Password is required.").max(200),
});

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const ip = clientIp(request);
    await enforce(rules().authIp, ip);

    const body = await parseJson(request, bodySchema);
    await enforce(rules().loginEmail, normalizeEmail(body.email));

    const result = await login(body.email, body.password);

    await createSession(result.userId, {
      userAgent: request.headers.get("user-agent"),
      ipAddress: ip,
    });

    return {
      userId: result.userId,
      emailVerified: result.emailVerified,
      // Login skips plan selection and goes straight to the dashboard, matching
      // the prototype's VidxirApp flow — unless onboarding was never finished.
      nextStep: result.role === "admin" ? ("admin" as const) : result.onboarded ? ("dashboard" as const) : ("onboarding" as const),
    };
  });
}

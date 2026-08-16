/**
 * POST /api/auth/forgot-password
 *
 * Always returns success, whether or not the address is registered — the
 * response must not disclose which emails have accounts.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { clientIp, handle, parseJson } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { normalizeEmail, requestPasswordReset } from "@/lib/auth/service";

const bodySchema = z.object({
  email: z.string().trim().email("Enter a valid email address.").max(320),
});

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    await enforce(rules().authIp, clientIp(request));
    const { email } = await parseJson(request, bodySchema);
    await enforce(rules().passwordReset, normalizeEmail(email));

    await requestPasswordReset(email);

    return {
      sent: true,
      message:
        "If an account exists for that address, a reset link is on its way.",
    };
  });
}

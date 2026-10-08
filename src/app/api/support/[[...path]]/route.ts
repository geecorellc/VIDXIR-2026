import type { NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseJson, requireUser, clientIp } from "@/lib/api/guard";
import { enforce } from "@/lib/api/rate-limit";
import { getSession } from "@/lib/auth/session";
import { createTicket, listTickets, ticketThread } from "@/lib/admin/service";
import { NotFoundError, ValidationError } from "@/lib/errors";
export async function GET(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireUser();
    const id = request.nextUrl.pathname.replace(/^\/api\/support\/?/, "");
    return id
      ? ticketThread(decodeURIComponent(id), user.id)
      : listTickets(user.id);
  });
}
export async function POST(request: NextRequest) {
  return handle(request, async () => {
    if (request.nextUrl.pathname !== "/api/support")
      throw new NotFoundError("Support endpoint not found.");
    const session = await getSession();
    await enforce(
      { name: "support-create", limit: 5, windowSeconds: 3600 },
      session?.user.id ?? clientIp(request),
    );
    const body = await parseJson(
      request,
      z.object({
        email: z.string().trim().email().max(320).optional(),
        name: z.string().trim().min(1).max(120).default("Guest"),
        subject: z.string().trim().min(1).max(200),
        category: z.string().trim().min(1).max(100),
        message: z.string().trim().min(1).max(5000),
      }),
    );
    const email = session?.user.email ?? body.email;
    if (!email) throw new ValidationError("Enter an email address.");
    return createTicket({
      userId: session?.user.id,
      email: email.toLowerCase(),
      name: session?.user.name ?? body.name,
      subject: body.subject,
      category: body.category,
      message: body.message,
    });
  });
}

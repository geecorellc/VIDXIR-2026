import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseJson, requireUser } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { nativeBindings } from "@/lib/cloudflare/bindings";
import { env } from "@/lib/env";
import {
  NotFoundError,
  NotConfiguredError,
  ValidationError,
} from "@/lib/errors";
import * as admin from "@/lib/admin/service";
import { renderMail } from "@/lib/admin/mail";
const password = z.string().min(1).max(200);
const emailContent = z.object({
  subject: z.string().trim().min(1).max(200),
  heading: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(10000),
});
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => Number.isFinite(Date.parse(v)));
const draftSchema = emailContent.extend({
  audience: z
    .object({
      tiers: z
        .array(z.enum(["starter", "studio", "scale"]))
        .max(3)
        .default([]),
      verification: z.enum(["any", "verified", "unverified"]).default("any"),
      joinedFrom: date.optional(),
      joinedTo: date.optional(),
      specificEmails: z
        .array(z.string().trim().email().toLowerCase())
        .min(1)
        .max(500)
        .optional(),
    })
    .refine(
      (a) => !a.joinedFrom || !a.joinedTo || a.joinedFrom <= a.joinedTo,
      "Choose a valid joined date range.",
    ),
});
// Explicit address lists use json_each so a 500-address audience stays within
// D1's bound-parameter limit.
function positive(value: string | null, defaultValue: number, max: number) {
  const n = value === null ? defaultValue : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw new ValidationError("Choose a valid page size.");
  return n;
}
async function route(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireUser();
    await admin.adminAccount(user.id);
    await enforce(
      request.method === "GET" ? rules().read : rules().mutation,
      `admin:${user.id}`,
    );
    const path = request.nextUrl.pathname
      .replace(/^\/api\/admin\/?/, "")
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const [area, id, operation] = path;
    const method = request.method;
    if (method === "GET" && area === "overview") {
      const db = nativeBindings().DB;
      const counts = await db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM users) AS users,(SELECT COUNT(*) FROM support_tickets WHERE status<>'Resolved') AS openTickets,
      (SELECT COUNT(*) FROM support_tickets WHERE unread=1) AS unreadTickets,(SELECT COUNT(*) FROM admin_emails WHERE direction='inbound' AND read_at IS NULL) AS unreadMail,
      (SELECT COUNT(*) FROM admin_emails WHERE status='failed') AS failedMail,(SELECT COUNT(*) FROM deleted_accounts) AS archives`,
        )
        .first();
      return counts;
    }
    if (area === "users") {
      if (method === "GET")
        return id
          ? admin.userDetail(id)
          : admin.listUsers(
              (request.nextUrl.searchParams.get("search") ?? "").slice(0, 200),
              positive(request.nextUrl.searchParams.get("page"), 1, 1000000),
              positive(request.nextUrl.searchParams.get("limit"), 20, 100),
            );
      if (!id && method === "POST") {
        await enforce(
          { name: "admin-confirm", limit: 10, windowSeconds: 900 },
          user.id,
        );
        const body = await parseJson(
          request,
          z.object({
            email: z.string().trim().email().max(320),
            password,
            adminPassword: password,
          }),
        );
        return admin.createUser(
          user.id,
          body.adminPassword,
          body.email,
          body.password,
        );
      }
      if (id && method === "DELETE") {
        await enforce(
          { name: "admin-confirm", limit: 10, windowSeconds: 900 },
          user.id,
        );
        const body = await parseJson(
          request,
          z.object({
            password,
            confirmation: z.string().max(320),
            reason: z.string().trim().min(1).max(500),
          }),
        );
        return admin.deleteUser(
          user.id,
          id,
          body.password,
          body.confirmation,
          body.reason,
        );
      }
      if (id && operation === "actions" && method === "POST") {
        await enforce(
          { name: "admin-confirm", limit: 10, windowSeconds: 900 },
          user.id,
        );
        const body = await parseJson(
          request,
          z.object({
            password,
            action: z.enum([
              "promote",
              "suspend",
              "restore",
              "verify",
              "plan:starter",
              "plan:studio",
              "plan:scale",
              "revoke-plan",
              "credits",
            ]),
            credits: z.number().int().min(1).max(1000000).optional(),
            requestId: z.string().uuid().optional(),
          }),
        );
        return admin.userAction(
          user.id,
          id,
          body.password,
          body.action,
          body.credits,
          body.requestId,
        );
      }
      if (id && operation === "email" && method === "POST") {
        const body = await parseJson(
          request,
          emailContent.extend({
            requestId: z.string().uuid(),
            preview: z.boolean().optional(),
          }),
        );
        await admin.userDetail(id);
        if (body.preview)
          return { html: renderMail(body.heading, body.message) };
        return admin.sendUserMail(
          user.id,
          id,
          body.subject,
          body.heading,
          body.message,
          body.requestId,
        );
      }
    }
    if (area === "archive" && method === "GET") return admin.archives(id);
    if (area === "support") {
      if (method === "GET")
        return id
          ? admin.ticketThread(id, undefined, true)
          : admin.listTickets(
              undefined,
              request.nextUrl.searchParams.get("search") ?? "",
              request.nextUrl.searchParams.get("status") ?? "",
            );
      if (id && method === "PATCH") {
        const body = await parseJson(
          request,
          z.object({ status: z.enum(["Open", "In progress", "Resolved"]) }),
        );
        return admin.updateTicket(id, body.status);
      }
      if (id && method === "POST") {
        const body = await parseJson(
          request,
          z.object({
            message: z.string().trim().min(1).max(10000),
            closeTicket: z.boolean(),
            requestId: z.string().uuid(),
          }),
        );
        return admin.replyTicket(
          user.id,
          id,
          body.message,
          body.closeTicket,
          body.requestId,
        );
      }
    }
    if (area === "mail") {
      if (method === "GET" && id === "dispatches" && operation)
        return admin.dispatchProgress(operation);
      if (method === "GET" && id && operation === "attachment") {
        const message = await admin.mailDetail(id),
          attachmentId = request.nextUrl.searchParams.get("id") ?? "";
        const attachments = JSON.parse(message.attachments) as { id: string }[];
        if (
          message.direction !== "inbound" ||
          !attachments.some((a) => a.id === attachmentId)
        )
          throw new NotFoundError("Attachment not found.");
        const key = env().RESEND_API_KEY;
        if (!key) throw new NotConfiguredError("Resend", ["RESEND_API_KEY"]);
        const response = await fetch(
          `https://api.resend.com/emails/receiving/${encodeURIComponent(message.provider_id!)}/attachments/${encodeURIComponent(attachmentId)}`,
          {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(20000),
          },
        );
        if (!response.ok)
          throw new ValidationError(
            "Attachment is unavailable. Try again later.",
          );
        const data = (await response.json()) as { download_url: string };
        if (!data.download_url?.startsWith("https://"))
          throw new ValidationError("Attachment is unavailable.");
        return NextResponse.redirect(data.download_url);
      }
      if (method === "GET")
        return id
          ? admin.mailDetail(id)
          : admin.listMail(
              z
                .enum(["", "inbound", "outbound"])
                .parse(request.nextUrl.searchParams.get("direction") ?? ""),
              (request.nextUrl.searchParams.get("search") ?? "").slice(0, 200),
              positive(request.nextUrl.searchParams.get("page"), 1, 1000000),
            );
      if (method === "POST" && id === "preview") {
        const body = await parseJson(request, draftSchema);
        return admin.previewMail(body);
      }
      if (method === "POST" && id === "send") {
        const body = await parseJson(
          request,
          draftSchema.extend({
            dispatchId: z.string().uuid(),
            fingerprint: z.string().length(64),
          }),
        );
        return admin.dispatchMail(
          user.id,
          body,
          body.dispatchId,
          body.fingerprint,
        );
      }
    }
    throw new NotFoundError("Admin endpoint not found.");
  });
}
async function uncached(request: NextRequest) {
  const response = await route(request);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export const GET = uncached;
export const POST = uncached;
export const PATCH = uncached;
export const DELETE = uncached;

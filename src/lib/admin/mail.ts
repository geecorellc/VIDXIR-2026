/** Durable Resend outbox. No Next.js imports: the backend Worker runs this directly. */
import { renderEmailTemplate, escapeHtml } from "../email/template";
export { escapeHtml } from "../email/template";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { D1Database, Queue, R2Bucket } from "@cloudflare/workers-types";
import type { MailRow, Ticket, TicketMessage } from "./types";
export interface MailRuntime {
  DB: D1Database;
  MEDIA: R2Bucket;
  MAINTENANCE_QUEUE: Queue;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  JV_EMAIL_FROM?: string;
  SUPPORT_EMAIL?: string;
}
export function renderMail(heading: string, message: string): string {
  return renderEmailTemplate(
    heading,
    escapeHtml(message).replace(/\r?\n/g, "<br>"),
  );
}
export function mailbox(value: string): string {
  return (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase();
}
export function supportReplyAddress(
  ticketId: string,
  address = "support@vidxir.com",
): string {
  const [local, domain] = mailbox(address).split("@");
  return `${local}+ticket-${ticketId}@${domain}`;
}
export async function enqueueMail(
  runtime: MailRuntime,
  id: string,
): Promise<void> {
  // The persisted outbox is authoritative; Cron recovers a failed queue send.
  try {
    await runtime.MAINTENANCE_QUEUE.send({ kind: "admin-mail", id });
  } catch {
    console.warn("Mail saved to outbox; scheduling will retry", { id });
  }
}
export async function processMail(
  runtime: MailRuntime,
  id: string,
): Promise<void> {
  if (!runtime.RESEND_API_KEY) throw new Error("RESEND_API_KEY is missing.");
  const now = Date.now();
  const claimed = await runtime.DB.prepare(
    `UPDATE admin_emails SET status='sending', attempted_at=COALESCE(attempted_at,?), lease_until=?
    WHERE id=? AND direction='outbound' AND (status='queued' OR (status='sending' AND lease_until<?)) RETURNING *`,
  )
    .bind(now, now + 120000, id, now)
    .first<MailRow>();
  if (!claimed) return;
  // Resend retains idempotency keys for 24h. An ambiguous request beyond that
  // window needs operator review rather than risking a duplicate delivery.
  if (claimed.attempted_at && now - claimed.attempted_at > 23 * 3600000) {
    await runtime.DB.prepare(
      "UPDATE admin_emails SET status='failed',error='Delivery could not be confirmed within the safe retry window.',lease_until=NULL WHERE id=?",
    )
      .bind(id)
      .run();
    return;
  }
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtime.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `vidxir-mail/${id}`,
      },
      body: JSON.stringify({
        from: claimed.from_address,
        to: [claimed.to_address],
        subject: claimed.subject,
        text: claimed.body,
        html: claimed.html ?? undefined,
        reply_to: claimed.reply_to ?? undefined,
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    await runtime.DB.prepare(
      "UPDATE admin_emails SET lease_until=0 WHERE id=? AND status='sending'",
    )
      .bind(id)
      .run();
    throw new Error("Mail delivery temporarily unavailable.");
  }
  if (!response.ok) {
    const retry = response.status === 429 || response.status >= 500;
    await runtime.DB.prepare(
      "UPDATE admin_emails SET status=?,error=?,lease_until=NULL WHERE id=?",
    )
      .bind(
        retry ? "queued" : "failed",
        `Email provider returned ${response.status}.`,
        id,
      )
      .run();
    if (retry) throw new Error("Email provider requested a retry.");
    return;
  }
  const data = (await response.json()) as { id?: string };
  if (!data.id) throw new Error("Email provider returned no message ID.");
  await runtime.DB.prepare(
    "UPDATE admin_emails SET status='sent',provider_id=?,error=NULL,lease_until=NULL WHERE id=? AND status='sending'",
  )
    .bind(data.id, id)
    .run();
}
export function verifyWebhook(
  raw: string,
  headers: Headers,
  secret: string,
  now = Date.now(),
): boolean {
  const id = headers.get("svix-id"),
    stamp = headers.get("svix-timestamp"),
    signature = headers.get("svix-signature");
  if (
    !id ||
    !stamp ||
    !signature ||
    !secret ||
    !/^\d+$/.test(stamp) ||
    Math.abs(now / 1000 - Number(stamp)) > 300
  )
    return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (!key.length) return false;
  const expected = createHmac("sha256", key)
    .update(`${id}.${stamp}.${raw}`)
    .digest("base64");
  return signature.split(/\s+/).some((candidate) => {
    const [version, value] = candidate.split(",");
    if (version !== "v1" || !value) return false;
    const a = Buffer.from(value),
      b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
interface IncomingEmail {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string | null;
  html?: string | null;
  created_at?: string;
  attachments?: { id: string; filename: string; content_type?: string }[];
}
export async function receiveEmail(
  runtime: MailRuntime,
  emailId: string,
): Promise<void> {
  if (
    await runtime.DB.prepare("SELECT id FROM admin_emails WHERE provider_id=?")
      .bind(emailId)
      .first()
  )
    return;
  const response = await fetch(
    `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`,
    {
      headers: { Authorization: `Bearer ${runtime.RESEND_API_KEY}` },
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok) throw new Error("Could not retrieve received email.");
  const email = (await response.json()) as IncomingEmail;
  if (!email.from || !Array.isArray(email.to))
    throw new Error("Invalid incoming email.");
  const sender = mailbox(email.from);
  const recipients = [
    ...email.to,
    ...(email.cc ?? []),
    ...(email.bcc ?? []),
  ].map(mailbox);
  const support = mailbox(runtime.SUPPORT_EMAIL ?? "support@vidxir.com");
  const [local, domain] = support.split("@");
  const supportRecipients = recipients.filter(
    (a) =>
      a === support ||
      (a.startsWith(`${local}+ticket-`) && a.endsWith(`@${domain}`)),
  );
  const addressedTicket = supportRecipients
    .map((a) => a.match(/\+ticket-([a-z0-9-]+)@/i)?.[1])
    .find(Boolean);
  const subjectTicket = supportRecipients.length
    ? email.subject.match(/support ticket\s+([a-z0-9-]+)/i)?.[1]
    : undefined;
  const requestedTicket = addressedTicket ?? subjectTicket;
  const current = requestedTicket
    ? await runtime.DB.prepare("SELECT * FROM support_tickets WHERE id=?")
        .bind(requestedTicket)
        .first<Ticket>()
    : null;
  // A ticket ID alone is not authority to append to a private support thread.
  const canReply = current && current.requester_email.toLowerCase() === sender;
  const ticketId = canReply
    ? current.id
    : !requestedTicket && supportRecipients.length
      ? `ticket-${emailId}`
      : null;
  const body = (
    email.text ||
    email.html
      ?.replace(
        /<style[^>]*>[\s\S]*?<\/style>|<script[^>]*>[\s\S]*?<\/script>/gi,
        "",
      )
      .replace(/<[^>]*>/g, " ") ||
    "[No text content]"
  ).slice(0, 100000);
  const timestamp = Number.isFinite(Date.parse(email.created_at ?? ""))
    ? Date.parse(email.created_at!)
    : Date.now();
  const statements = [];
  const mailId = `received:${emailId}`;
  statements.push(
    runtime.DB.prepare(
      `INSERT OR IGNORE INTO admin_emails (id,direction,from_address,to_address,subject,body,attachments,provider_id,status,ticket_id,created_at)
    VALUES (?,'inbound',?,?,?,?,?,?,'received',?,?)`,
    ).bind(
      mailId,
      email.from.slice(0, 500),
      email.to.join(", ").slice(0, 2000),
      email.subject.slice(0, 200),
      body,
      JSON.stringify(email.attachments ?? []),
      emailId,
      ticketId,
      timestamp,
    ),
  );
  if (ticketId) {
    const account = await runtime.DB.prepare(
      "SELECT id,name FROM users WHERE email_normalized=?",
    )
      .bind(sender)
      .first<{ id: string; name: string }>();
    if (!current)
      statements.push(
        runtime.DB.prepare(
          `INSERT OR IGNORE INTO support_tickets (id,user_id,requester_email,requester_name,subject,category,status,unread,updated_at,created_at)
      VALUES (?,?,?,?,?,'Email','Open',1,?,?)`,
        ).bind(
          ticketId,
          account?.id ?? null,
          sender,
          account?.name ?? sender,
          email.subject.slice(0, 200),
          timestamp,
          timestamp,
        ),
      );
    const message: TicketMessage = {
      id: mailId,
      ticket_id: ticketId,
      author_type: "user",
      author_name: account?.name ?? sender,
      author_email: sender,
      channel: "email",
      body,
      created_at: timestamp,
    };
    statements.push(
      runtime.DB.prepare(
        `INSERT OR IGNORE INTO support_messages (id,ticket_id,author_type,author_name,author_email,channel,body,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      ).bind(
        message.id,
        ticketId,
        "user",
        message.author_name,
        sender,
        "email",
        body,
        timestamp,
      ),
    );
    statements.push(
      runtime.DB.prepare(
        `UPDATE support_tickets SET unread=1,updated_at=MAX(updated_at,?),status=CASE WHEN status='Resolved' THEN 'In progress' ELSE status END
      WHERE id=? AND changes()>0 AND EXISTS(SELECT 1 FROM support_messages WHERE id=?)`,
      ).bind(timestamp, ticketId, mailId),
    );
  }
  await runtime.DB.batch(statements);
}
export async function recordEmailEvent(
  runtime: MailRuntime,
  id: string,
  providerId: string,
  type: string,
  occurredAt: number,
): Promise<void> {
  await runtime.DB.prepare(
    "INSERT OR IGNORE INTO email_events (id,provider_id,type,occurred_at) VALUES (?,?,?,?)",
  )
    .bind(id, providerId, type, occurredAt)
    .run();
}
export async function recoverMail(runtime: MailRuntime): Promise<void> {
  const { results } = await runtime.DB.prepare(
    "SELECT id FROM admin_emails WHERE direction='outbound' AND (status='queued' OR (status='sending' AND lease_until<?)) ORDER BY created_at LIMIT 100",
  )
    .bind(Date.now())
    .all<{ id: string }>();
  for (const row of results) await enqueueMail(runtime, row.id);
}
export async function purgeArchivedMedia(runtime: MailRuntime): Promise<void> {
  const { results } = await runtime.DB.prepare(
    "SELECT id,original_user_id FROM deleted_accounts WHERE media_delete_after<? AND media_purged_at IS NULL LIMIT 10",
  )
    .bind(Date.now())
    .all<{ id: string; original_user_id: string }>();
  for (const archive of results) {
    if (
      await runtime.DB.prepare("SELECT id FROM users WHERE id=?")
        .bind(archive.original_user_id)
        .first()
    )
      continue;
    const page = await runtime.MEDIA.list({
      prefix: `u/${archive.original_user_id}/`,
      limit: 100,
    });
    if (page.objects.length)
      await runtime.MEDIA.delete(page.objects.map((o) => o.key));
    // A following Cron tick continues large prefixes and confirms they're empty.
    if (!page.objects.length)
      await runtime.DB.prepare(
        "UPDATE deleted_accounts SET media_purged_at=? WHERE id=?",
      )
        .bind(Date.now(), archive.id)
        .run();
  }
}

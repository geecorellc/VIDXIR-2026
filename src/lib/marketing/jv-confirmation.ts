import { createHash } from "node:crypto";
import { enqueueMail, type MailRuntime } from "../admin/mail";
import { escapeHtml, renderEmailTemplate } from "../email/template";

/** Persist before scheduling; repeat submissions get one confirmation per address. */
export async function queueJvConfirmation(
  runtime: MailRuntime,
  fields: { name: string; email: string },
): Promise<void> {
  const email = fields.email.trim().toLowerCase();
  const id = `jv-welcome:${createHash("sha256").update(email).digest("hex")}`;
  const subject = "You’re on the Vidxir AI JV list";
  const heading = "Welcome to the Vidxir AI JV list";
  const body = `Hi ${fields.name.trim()},\n\nThanks for joining the Vidxir AI JV list.\n\nWe’ll send you launch updates, funnel details, promotional swipes, and reminders as the launch approaches.\n\nJoining the list doesn’t approve you as an affiliate. Visit the JV page to request your affiliate links.\n\nIf you have any questions, just reply to this email.\n\nThe Vidxir AI team`;
  const html = renderEmailTemplate(
    heading,
    escapeHtml(body).replace(/\r?\n/g, "<br>"),
    { label: "Visit the JV page", url: "https://vidxir.com/partners/" },
  );
  await runtime.DB.prepare(
    `INSERT OR IGNORE INTO admin_emails(id,direction,from_address,to_address,subject,body,html,reply_to,status)
    VALUES (?,'outbound',?,?,?,?,?,?,'queued')`,
  )
    .bind(
      id,
      runtime.EMAIL_FROM ?? '"Goodluck Efe @Vidxir AI" <support@vidxir.com>',
      email,
      subject,
      body,
      html,
      runtime.SUPPORT_EMAIL ?? "support@vidxir.com",
    )
    .run();
  await enqueueMail(runtime, id);
}

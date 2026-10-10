import { escapeHtml, renderEmailTemplate } from "./template";

export function supportTicketAcknowledgement(input: {
  name: string;
  subject: string;
  message: string;
}) {
  const opening = `Hi ${input.name},\n\nYour support ticket with the title “${input.subject}” is open. Our team will typically reply within one to three working days.`;
  const rest = `\n\nWe’ve received your request and will review it carefully. Thank you for using Vidxir AI — we’re here to help you get back to creating.\n\nYou can follow up or share additional details by replying to this email or any of our replies. Your messages will stay in the same support thread.\n\nYour original message:\n${input.message}\n\nRegards,\nThe Vidxir AI Team`;
  const htmlOpening = `Hi ${escapeHtml(input.name)},<br><br>Your support ticket with the title “<strong style="color:#F5F3F1">${escapeHtml(input.subject)}</strong>” is open. Our team will typically reply within one to three working days.`;
  return {
    text: opening + rest,
    html: renderEmailTemplate(
      "Your support ticket is open",
      htmlOpening + escapeHtml(rest).replace(/\r?\n/g, "<br>"),
    ),
  };
}

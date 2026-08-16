/**
 * Transactional email (§4).
 *
 * Two implementations behind one interface. `console` writes the message to the
 * server log so local signup/reset flows are fully usable without an email
 * account — that is a real delivery channel for development, not a simulation of
 * one: the token in the log genuinely works. Production refuses `console`
 * (enforced in lib/env).
 */
import "server-only";
import { env } from "@/lib/env";
import { NotConfiguredError, ProviderError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";

  async send(message: EmailMessage): Promise<void> {
    // Written as a single block so the link is easy to copy from a dev terminal.
    process.stdout.write(
      [
        "",
        "──────────────── EMAIL (console provider) ────────────────",
        `To:      ${message.to}`,
        `Subject: ${message.subject}`,
        "",
        message.text,
        "──────────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );
  }
}

class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";

  constructor(private readonly apiKey: string) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env().EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ProviderError("resend", `${response.status} ${detail.slice(0, 300)}`, {
        // 4xx other than 429 will not succeed on retry.
        retryable: response.status >= 500 || response.status === 429,
      });
    }
  }
}

let cached: EmailProvider | undefined;

export function emailProvider(): EmailProvider {
  if (cached) return cached;
  const e = env();

  if (e.EMAIL_PROVIDER === "resend") {
    if (!e.RESEND_API_KEY) {
      throw new NotConfiguredError("Resend", ["RESEND_API_KEY"]);
    }
    cached = new ResendEmailProvider(e.RESEND_API_KEY);
  } else {
    cached = new ConsoleEmailProvider();
  }
  return cached;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function appUrl(path: string): string {
  return `${env().APP_URL.replace(/\/$/, "")}${path}`;
}

/** Minimal dark-themed shell matching the Tally palette. */
function wrap(heading: string, body: string, cta?: { label: string; url: string }) {
  return `<!doctype html>
<html><body style="margin:0;background:#0B0A0C;font-family:Inter,system-ui,sans-serif;color:#F5F3F1;padding:32px">
  <div style="max-width:520px;margin:0 auto;background:#141216;border:1px solid #241F22;border-radius:12px;padding:28px">
    <div style="font-family:Oswald,Arial Narrow,sans-serif;text-transform:uppercase;letter-spacing:1.5px;font-size:13px;color:#E8332B;margin-bottom:18px">Tally</div>
    <h1 style="font-family:Oswald,Arial Narrow,sans-serif;text-transform:uppercase;font-size:22px;margin:0 0 14px">${heading}</h1>
    <div style="font-size:14px;line-height:1.6;color:#B5AEB1">${body}</div>
    ${
      cta
        ? `<a href="${cta.url}" style="display:inline-block;margin-top:22px;background:#E8332B;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px;font-weight:600">${cta.label}</a>
    <p style="font-size:12px;color:#6E666A;margin-top:20px;word-break:break-all">Or paste this link into your browser:<br>${cta.url}</p>`
        : ""
    }
  </div>
</body></html>`;
}

export async function sendVerificationEmail(params: {
  to: string;
  name: string;
  token: string;
}): Promise<void> {
  const url = appUrl(`/verify-email?token=${encodeURIComponent(params.token)}`);
  await emailProvider().send({
    to: params.to,
    subject: "Confirm your Tally account",
    text: `Hi ${params.name},\n\nConfirm your email to finish setting up Tally:\n${url}\n\nThis link expires in 24 hours.`,
    html: wrap(
      "Confirm your email",
      `Hi ${params.name}, confirm your email address to finish setting up your Tally studio. This link expires in 24 hours.`,
      { label: "Confirm email", url },
    ),
  });
  logger.info("verification email queued", { component: "email" });
}

export async function sendPasswordResetEmail(params: {
  to: string;
  name: string;
  token: string;
}): Promise<void> {
  const url = appUrl(`/reset-password?token=${encodeURIComponent(params.token)}`);
  await emailProvider().send({
    to: params.to,
    subject: "Reset your Tally password",
    text: `Hi ${params.name},\n\nReset your Tally password:\n${url}\n\nThis link expires in 1 hour. If you did not request it, you can ignore this email.`,
    html: wrap(
      "Reset your password",
      `Hi ${params.name}, use the button below to choose a new password. This link expires in 1 hour. If you did not request a reset, you can safely ignore this email.`,
      { label: "Reset password", url },
    ),
  });
  logger.info("password reset email queued", { component: "email" });
}

/** Notify the user that an automated publish happened while they were away. */
export async function sendPublishNotificationEmail(params: {
  to: string;
  name: string;
  videoTitle: string;
  videoUrl: string;
  channelTitle: string;
}): Promise<void> {
  await emailProvider().send({
    to: params.to,
    subject: `Published: ${params.videoTitle}`,
    text: `Hi ${params.name},\n\nTally published "${params.videoTitle}" to ${params.channelTitle}.\n${params.videoUrl}`,
    html: wrap(
      "Video published",
      `Tally published <strong style="color:#F5F3F1">${params.videoTitle}</strong> to ${params.channelTitle}.`,
      { label: "View on YouTube", url: params.videoUrl },
    ),
  });
}

/** Alert the user that a job failed and needs attention (§30). */
export async function sendJobFailureEmail(params: {
  to: string;
  name: string;
  projectTitle: string;
  stage: string;
  message: string;
  projectUrl: string;
}): Promise<void> {
  await emailProvider().send({
    to: params.to,
    subject: `Action needed: ${params.projectTitle}`,
    text: `Hi ${params.name},\n\n"${params.projectTitle}" failed at the ${params.stage} stage.\n\n${params.message}\n\nRetry or review it here: ${params.projectUrl}`,
    html: wrap(
      "A video needs your attention",
      `<strong style="color:#F5F3F1">${params.projectTitle}</strong> failed at the ${params.stage} stage.<br><br>${params.message}`,
      { label: "Review project", url: params.projectUrl },
    ),
  });
}

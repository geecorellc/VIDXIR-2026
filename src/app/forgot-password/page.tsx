"use client";

/**
 * Password reset request (§4).
 *
 * The endpoint always reports success, so this screen never reveals whether an
 * address has an account. The confirmation copy is deliberately worded to be
 * true in both cases.
 */
import { useState } from "react";
import { Mail, Send } from "lucide-react";
import { AuthNotice, AuthShell } from "@/components/auth/AuthShell";
import { Btn } from "@/components/ui/Btn";
import { Field } from "@/components/ui/Field";
import { color } from "@/lib/design/tokens";
import { api, messageOf } from "@/services/api-client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/api/auth/forgot-password", { email });
      setSent(true);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <AuthShell title="Check your inbox">
        <AuthNotice tone="success">
          If an account exists for <strong>{email}</strong>, a reset link is on
          its way. The link expires in one hour.
        </AuthNotice>
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, color: color.textFaint }}>
          Nothing arrived? Check spam, then try again — repeated requests are
          rate limited.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      intro="Enter the email on your account and we will send you a link to set a new password."
    >
      {error && <AuthNotice tone="error">{error}</AuthNotice>}
      <form
        onSubmit={submit}
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
      >
        <Field
          label="Email"
          icon={Mail}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@studio.com"
          autoComplete="email"
          required
        />
        <Btn type="submit" full loading={submitting} icon={<Send size={15} />}>
          Send reset link
        </Btn>
      </form>
    </AuthShell>
  );
}

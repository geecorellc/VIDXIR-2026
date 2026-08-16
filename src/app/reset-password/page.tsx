"use client";

/**
 * Set a new password from an emailed token (§4).
 *
 * The token arrives in the query string. Successfully resetting revokes every
 * existing session server-side, so the user is sent back to log in rather than
 * straight into the dashboard.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { CheckCircle2, Lock } from "lucide-react";
import { AuthNotice, AuthShell } from "@/components/auth/AuthShell";
import { Btn } from "@/components/ui/Btn";
import { Field } from "@/components/ui/Field";
import { color } from "@/lib/design/tokens";
import { api, messageOf } from "@/services/api-client";

function ResetPasswordForm() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <AuthShell title="Link not valid">
        <AuthNotice tone="error">
          This reset link is missing its token. Request a new one to continue.
        </AuthNotice>
        <Link href="/forgot-password" style={{ textDecoration: "none" }}>
          <Btn full>Request a new link</Btn>
        </Link>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell title="Password updated">
        <AuthNotice tone="success">
          Your password has been changed and all other sessions were signed out.
        </AuthNotice>
        <Btn full onClick={() => router.push("/login")} icon={<CheckCircle2 size={15} />}>
          Log in
        </Btn>
      </AuthShell>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError("Those passwords do not match.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/api/auth/reset-password", { token, password });
      setDone(true);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Choose a new password"
      intro="Pick something at least 10 characters long that you do not use elsewhere."
    >
      {error && <AuthNotice tone="error">{error}</AuthNotice>}
      <form
        onSubmit={submit}
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
      >
        <Field
          label="New password"
          icon={Lock}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••••"
          autoComplete="new-password"
          required
        />
        <Field
          label="Confirm password"
          icon={Lock}
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="••••••••••"
          autoComplete="new-password"
          required
        />
        <Btn type="submit" full loading={submitting}>
          Update password
        </Btn>
      </form>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  // useSearchParams requires a Suspense boundary during static prerender.
  return (
    <Suspense
      fallback={
        <div
          style={{
            minHeight: "100vh",
            display: "grid",
            placeItems: "center",
            color: color.textFaint,
            fontSize: 13,
          }}
        >
          Loading…
        </div>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}

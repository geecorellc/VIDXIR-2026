"use client";

/**
 * Email verification landing (§4).
 *
 * Arriving with `?token=` consumes it immediately. Arriving without one shows
 * the "we sent you a link" state with a resend action (which requires a
 * session, so it only appears for signed-in users).
 */
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { ArrowRight, MailCheck, RefreshCw } from "lucide-react";
import { AuthNotice, AuthShell } from "@/components/auth/AuthShell";
import { Btn } from "@/components/ui/Btn";
import { color } from "@/lib/design/tokens";
import { api, messageOf } from "@/services/api-client";

type Status = "idle" | "verifying" | "verified" | "failed";

function VerifyEmailInner() {
  const router = useRouter();
  const token = useSearchParams().get("token");

  const [status, setStatus] = useState<Status>(token ? "verifying" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  // React runs effects twice in dev StrictMode; a one-shot token must not be
  // consumed twice or the second call reports failure on a successful verify.
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    const controller = new AbortController();
    api
      .post("/api/auth/verify-email", { token }, { signal: controller.signal })
      .then(() => setStatus("verified"))
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(messageOf(caught));
        setStatus("failed");
      });

    return () => controller.abort();
  }, [token]);

  async function resend() {
    setResending(true);
    setError(null);
    try {
      await api.put("/api/auth/verify-email");
      setResent(true);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setResending(false);
    }
  }

  if (status === "verifying") {
    return (
      <AuthShell title="Verifying…" intro="One moment while we confirm your email.">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            color: color.textDim,
            fontSize: 13,
          }}
        >
          <RefreshCw size={15} className="tally-spin" aria-hidden="true" />
          Checking your verification link
        </div>
      </AuthShell>
    );
  }

  if (status === "verified") {
    return (
      <AuthShell title="Email verified">
        <AuthNotice tone="success">
          Your email address is confirmed. You are all set.
        </AuthNotice>
        <Btn
          full
          icon={<ArrowRight size={15} />}
          onClick={() => {
            router.push("/dashboard");
            router.refresh();
          }}
        >
          Go to your studio
        </Btn>
      </AuthShell>
    );
  }

  if (status === "failed") {
    return (
      <AuthShell title="Link not valid">
        <AuthNotice tone="error">{error ?? "That link is no longer valid."}</AuthNotice>
        <p
          style={{
            margin: "0 0 16px",
            fontSize: 12.5,
            lineHeight: 1.6,
            color: color.textFaint,
          }}
        >
          Verification links expire after 24 hours and can only be used once.
        </p>
        <Btn full loading={resending} onClick={resend} icon={<MailCheck size={15} />}>
          {resent ? "Sent — check your inbox" : "Send a new link"}
        </Btn>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Confirm your email"
      intro="We sent a verification link to the address on your account. Open it to confirm your email."
      footerHref="/dashboard"
      footerLabel="Skip for now"
    >
      {error && <AuthNotice tone="error">{error}</AuthNotice>}
      {resent && <AuthNotice tone="success">A new link is on its way.</AuthNotice>}
      <Btn
        full
        variant="ghost"
        loading={resending}
        onClick={resend}
        icon={<MailCheck size={15} />}
      >
        Resend verification email
      </Btn>
    </AuthShell>
  );
}

export default function VerifyEmailPage() {
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
      <VerifyEmailInner />
    </Suspense>
  );
}

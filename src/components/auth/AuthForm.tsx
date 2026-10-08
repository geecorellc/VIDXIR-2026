"use client";

/**
 * Login / signup form — ported from the prototype's `Auth`.
 *
 * Preserved: the segmented login/signup toggle, the Name (signup only) / Email /
 * Password field stack, and the back-to-home link.
 *
 * Fixed: the prototype rendered `<Field>` without `value`/`onChange`, so the
 * inputs were decorative. These are controlled inputs posting to real endpoints,
 * with server-side validation errors mapped back onto the offending field.
 */
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Lock, Mail, User } from "lucide-react";
import { Btn } from "@/components/ui/Btn";
import { Field } from "@/components/ui/Field";
import { VidxirLogo } from "@/components/ui/VidxirLogo";
import { color, display, font, radius } from "@/lib/design/tokens";
import { ApiError, api } from "@/services/api-client";

export type AuthMode = "login" | "signup";

interface AuthResponse {
  userId: string;
  /** Where the server says this account should go next. */
  nextStep: "plan" | "onboarding" | "dashboard" | "admin";
}

/** Server-chosen destinations. The client never picks these itself. */
const NEXT_STEP_PATHS: Record<AuthResponse["nextStep"], string> = {
  admin: "/admin",
  plan: "/plan",
  onboarding: "/onboarding",
  dashboard: "/dashboard",
};

export interface AuthFormProps {
  mode: AuthMode;
  /** Where to go after success, from the ?next= query param. */
  redirectTo?: string;
}

export function AuthForm({ mode, redirectTo }: AuthFormProps) {
  const router = useRouter();
  const isSignup = mode === "signup";

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /**
   * Map a server ValidationError's `fields` array (or a single `field` detail)
   * back onto the inputs, so the message appears where the problem is.
   */
  function applyError(error: unknown) {
    if (error instanceof ApiError) {
      const next: Record<string, string> = {};
      const fields = error.details?.fields;
      if (Array.isArray(fields)) {
        for (const entry of fields) {
          if (
            entry &&
            typeof entry === "object" &&
            "path" in entry &&
            "message" in entry
          ) {
            const path = String((entry as { path: unknown }).path);
            next[path] = String((entry as { message: unknown }).message);
          }
        }
      }
      const single = error.details?.field;
      if (typeof single === "string") next[single] = error.message;

      setFieldErrors(next);
      // Only show the banner when no field owns the message.
      setFormError(Object.keys(next).length === 0 ? error.message : null);
      return;
    }
    setFormError("Something went wrong. Please try again.");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});

    try {
      const result = await api.post<AuthResponse>(
        isSignup ? "/api/auth/signup" : "/api/auth/login",
        isSignup ? { name, email, password } : { email, password },
      );

      const destination =
        redirectTo ?? NEXT_STEP_PATHS[result.nextStep] ?? "/dashboard";
      router.push(destination);
      // Refresh so server components re-read the new session.
      router.refresh();
    } catch (error) {
      applyError(error);
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 20px",
        position: "relative",
      }}
    >
      <div className="grain" aria-hidden="true" />

      <div
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 404,
        }}
      >
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 26 }}>
          <VidxirLogo size={17} />
        </div>

        <div
          style={{
            background: color.card,
            border: `1px solid ${color.border}`,
            borderRadius: radius.lg,
            padding: 26,
          }}
        >
          {/* Segmented toggle, preserved from the prototype */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 4,
              padding: 4,
              background: color.inputBg,
              border: `1px solid ${color.border}`,
              borderRadius: radius.md,
              marginBottom: 24,
            }}
          >
            <Link
              href="/login"
              aria-current={!isSignup ? "page" : undefined}
              style={{
                textAlign: "center",
                padding: "9px 0",
                borderRadius: 6,
                fontSize: 12.5,
                fontWeight: 600,
                textDecoration: "none",
                background: !isSignup ? color.accent : "transparent",
                color: !isSignup ? "#fff" : color.textDim,
              }}
            >
              Log in
            </Link>
            <Link
              href="/signup"
              aria-current={isSignup ? "page" : undefined}
              style={{
                textAlign: "center",
                padding: "9px 0",
                borderRadius: 6,
                fontSize: 12.5,
                fontWeight: 600,
                textDecoration: "none",
                background: isSignup ? color.accent : "transparent",
                color: isSignup ? "#fff" : color.textDim,
              }}
            >
              Sign up
            </Link>
          </div>

          <h1 style={{ ...display(21), marginBottom: 6 }}>
            {isSignup ? "Create your studio" : "Welcome back"}
          </h1>
          <p
            style={{
              margin: "0 0 22px",
              fontSize: 13,
              lineHeight: 1.6,
              color: color.textDim,
            }}
          >
            {isSignup
              ? "Connect a channel, pick a niche, and let Vidxir AI start researching."
              : "Sign in to pick up where your channels left off."}
          </p>

          {formError && (
            <div
              role="alert"
              style={{
                background: color.dangerBg,
                border: `1px solid ${color.dangerBorder}`,
                borderRadius: radius.md,
                padding: "10px 12px",
                fontSize: 12.5,
                lineHeight: 1.55,
                color: color.rose,
                marginBottom: 16,
              }}
            >
              {formError}
            </div>
          )}

          <form
            onSubmit={submit}
            style={{ display: "flex", flexDirection: "column", gap: 14 }}
          >
            {isSignup && (
              <Field
                label="Name"
                icon={User}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Alex Rivera"
                autoComplete="name"
                required
                error={fieldErrors.name}
              />
            )}

            <Field
              label="Email"
              icon={Mail}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@studio.com"
              autoComplete="email"
              required
              error={fieldErrors.email}
            />

            <Field
              label="Password"
              icon={Lock}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••"
              autoComplete={isSignup ? "new-password" : "current-password"}
              required
              error={fieldErrors.password}
              hint={isSignup ? "At least 10 characters." : undefined}
            />

            <Btn
              type="submit"
              full
              loading={submitting}
              icon={<ArrowRight size={15} />}
            >
              {isSignup ? "Create account" : "Log in"}
            </Btn>
          </form>

          {!isSignup && (
            <div style={{ marginTop: 16, textAlign: "center" }}>
              <Link
                href="/forgot-password"
                style={{
                  fontSize: 12.5,
                  color: color.textDim,
                  textDecoration: "none",
                }}
              >
                Forgot your password?
              </Link>
            </div>
          )}
        </div>

        <div style={{ marginTop: 20, textAlign: "center" }}>
          <Link
            href="/"
            style={{
              fontFamily: font.display,
              fontSize: 11,
              letterSpacing: 1.3,
              textTransform: "uppercase",
              color: color.textFaint,
              textDecoration: "none",
            }}
          >
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}

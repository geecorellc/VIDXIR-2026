import type { Metadata } from "next";
import { AuthForm } from "@/components/auth/AuthForm";

export const metadata: Metadata = {
  title: "Log in — Tally",
};

interface Props {
  searchParams: Promise<{ next?: string }>;
}

/**
 * Only same-origin relative paths are accepted from `?next=`, so a crafted link
 * cannot use the login redirect as an open redirect to an external site.
 */
function safeNext(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!value.startsWith("/")) return undefined;
  if (value.startsWith("//")) return undefined;
  return value;
}

export default async function LoginPage({ searchParams }: Props) {
  const params = await searchParams;
  return <AuthForm mode="login" redirectTo={safeNext(params.next)} />;
}

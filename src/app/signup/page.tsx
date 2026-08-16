import type { Metadata } from "next";
import { AuthForm } from "@/components/auth/AuthForm";

export const metadata: Metadata = {
  title: "Create your studio — Tally",
};

export default function SignupPage() {
  // A new account always lands in onboarding (§5), so no ?next= handling here.
  return <AuthForm mode="signup" />;
}

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";
import { getSession } from "@/lib/auth/session";
import { getProfile } from "@/lib/onboarding/service";

export const metadata: Metadata = {
  title: "Set up your studio — Tally",
};

export default async function OnboardingPage() {
  // Server-side session validation. Middleware only checked cookie presence.
  const session = await getSession();
  if (!session) redirect("/login?next=%2Fonboarding");
  if (session.user.onboardedAt) redirect("/dashboard");

  // Answers are loaded from Postgres, so reopening the tab resumes the wizard
  // at the furthest step reached rather than starting over (§45).
  const profile = await getProfile(session.user.id);

  return (
    <OnboardingWizard
      initialName={session.user.name}
      initialProfile={profile}
    />
  );
}

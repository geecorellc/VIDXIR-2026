import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { adminAccount } from "@/lib/admin/service";
import { AdminShell } from "@/components/admin/AdminShell";
export const metadata = {
  title: "Administration — Vidxir AI",
  robots: { index: false, follow: false },
};
export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login?next=%2Fadmin");
  if (session.user.role !== "admin" || !session.user.emailVerifiedAt)
    redirect("/dashboard");
  await adminAccount(session.user.id);
  return (
    <AdminShell
      email={session.user.email}
      onboarded={Boolean(session.user.onboardedAt)}
    >
      {children}
    </AdminShell>
  );
}

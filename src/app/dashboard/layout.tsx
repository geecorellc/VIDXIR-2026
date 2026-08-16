/**
 * Dashboard shell — the prototype's sidebar + scrolling main region.
 *
 * The layout is a server component: it validates the session against the
 * database (middleware only checked that a cookie existed), resolves the
 * authoritative plan and channel count, and redirects to onboarding if the user
 * has not finished it. None of those decisions are left to the client.
 */
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { and, eq, isNull } from "drizzle-orm";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { getSession } from "@/lib/auth/session";
import { currentTier } from "@/lib/api/guard";
import { db } from "@/lib/db";
import { channels } from "@/lib/db/schema";
import { planByTier } from "@/lib/plans";
import { reachOf } from "@/lib/projects/service";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login?next=%2Fdashboard");
  if (!session.user.onboardedAt) redirect("/onboarding");

  const [tier, connected, reach] = await Promise.all([
    currentTier(session.user.id),
    db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.userId, session.user.id),
          isNull(channels.disconnectedAt),
        ),
      ),
    reachOf(session.user.id),
  ]);

  return (
    <DashboardShell
      planName={planByTier(tier).name}
      hasChannel={connected.length > 0}
      projectReach={reach}
      userName={session.user.name}
      emailVerified={session.user.emailVerifiedAt !== null}
    >
      {children}
    </DashboardShell>
  );
}

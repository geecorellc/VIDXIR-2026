/**
 * Script — ported from the prototype's `Script` (STAGE 02, §9).
 *
 * Preserved: the "Write the script" header and copy, and the idle / generating /
 * ready structure.
 *
 * Changed: the prototype's three phases were local `useState`. Here they are read
 * from the project's persisted status and the `scripts` / `script_versions` rows,
 * so a refresh mid-generation shows the same thing the worker is actually doing.
 */
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { ConfigNotice } from "@/components/dashboard/ConfigNotice";
import { ScriptWorkspace } from "@/components/script/ScriptWorkspace";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { ideas } from "@/lib/db/schema";
import { getStageContext } from "@/lib/dashboard/stage";
import { displayTitle } from "@/lib/projects/display-title";
import { capabilityStatus } from "@/lib/providers/config";

export const metadata = { title: "Script — Tally" };

export default async function ScriptPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login?next=%2Fdashboard%2Fscript");
  const userId = session.user.id;

  const params = await searchParams;
  const context = await getStageContext(userId, params.project);
  const ai = capabilityStatus("ai");

  const ideaRows = context.project?.ideaId
    ? await db
        .select({ title: ideas.title })
        .from(ideas)
        .where(
          and(
            eq(ideas.id, context.project.ideaId),
            eq(ideas.userId, userId),
          ),
        )
        .limit(1)
    : [];

  const project = context.project;

  return (
    <div>
      <SectionHeader
        eyebrow="Stage 02"
        title="Write the script"
        sub="Turn an idea into a structured, high-retention script."
      />
      <ConfigNotice status={ai} />
      <ScriptWorkspace
        projectId={project?.id ?? null}
        /*
          `displayTitle` is null for a project still carrying its from-a-link
          placeholder, so the empty state says "this video" rather than quoting the raw
          video id back as though it were the video's name.
        */
        projectTitle={displayTitle(project?.title)}
        status={project?.status ?? null}
        script={context.script}
        ideaTitle={ideaRows[0]?.title ?? null}
        error={
          project?.errorMessage
            ? { message: project.errorMessage, code: project.errorCode }
            : null
        }
        canGenerate={ai.state !== "not_configured"}
      />
    </div>
  );
}

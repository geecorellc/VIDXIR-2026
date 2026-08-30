/**
 * "Describe your idea" — the third entry path's screen (§1C).
 *
 * Type what you want to make, with no channel connected and no video to paste, and
 * this carries it through interpretation, trend research, an original angle, a
 * generation method and a script into the existing video pipeline.
 *
 * It renders the same `LinkStudio` component the link screen does, with `seed`
 * switched. The two paths differ only in how a project is seeded: after that they are
 * the same sequence over the same `research_runs`, `research_results`, `ideas` and
 * `jobs` rows, and a second copy of that flow would be two screens to keep in step
 * rather than one. `latestLinkProjectId` is asked for the `description` origin here, so
 * this screen never opens on a project that a pasted link created and the link screen
 * never opens on a described one.
 *
 * Like the other stage screens, the whole state is server-loaded from persisted rows
 * (§45), so a refresh mid-research resumes exactly where the worker is.
 */
import { redirect } from "next/navigation";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { LinkStudio } from "@/components/youtube/LinkStudio";
import { getSession } from "@/lib/auth/session";
import { getLinkStudioData, latestLinkProjectId } from "@/lib/dashboard/link-studio";
import { loadStudioScript } from "@/lib/dashboard/studio-script";
import { capabilityStatus } from "@/lib/providers/config";

export const metadata = { title: "Describe your idea — Tally" };

export default async function DescribePage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login?next=%2Fdashboard%2Fdescribe");
  const userId = session.user.id;

  const params = await searchParams;
  // `?project=` wins so the flow is linkable; otherwise pick up the most recent
  // unpublished described project, which is what the user was last working on.
  const projectId =
    params.project ?? (await latestLinkProjectId(userId, ["description"]));

  /**
   * `getLinkStudioData` throws `ForbiddenError` for someone else's project id, and the
   * error boundary renders that as a refusal (§34). Nothing here needs to pre-check
   * ownership.
   */
  const data = projectId ? await getLinkStudioData(userId, projectId) : null;
  const script = data ? await loadStudioScript(userId, data.project.id) : null;

  // §48: whether the AI provider is configured is a server fact. The client gets the
  // boolean, never the credential (§21).
  const ai = capabilityStatus("ai");

  return (
    <div>
      <SectionHeader
        eyebrow="Your idea"
        title="Describe the video you want to make"
        sub="Say what you have in mind. Tally researches what is working in that subject right now and writes something original from it — no channel connection needed."
      />
      <LinkStudio
        data={data}
        script={script}
        aiConfigured={ai.state !== "not_configured"}
        seed="description"
        basePath="/dashboard/describe"
      />
    </div>
  );
}

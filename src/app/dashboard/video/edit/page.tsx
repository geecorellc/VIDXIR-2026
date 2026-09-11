/**
 * The video editor route.
 *
 * A thin server shell: it authenticates, resolves which project is being edited, and hands
 * the id to the client editor. The cut itself is fetched by the editor through
 * `GET /api/video/edit`, which seeds it from the project's real scenes on first open —
 * rather than being serialised into the page — because the same document has to be
 * re-readable after a conflict without a full navigation.
 *
 * `getStageContext` resolves `?project=` exactly as the other stage screens do, so
 * arriving here from the studio keeps the user on the same video. It is scoped by
 * `userId`, so a foreign project id resolves to nothing rather than to someone else's cut.
 */
import { redirect } from "next/navigation";
import { VideoEditor } from "@/components/video/editor/VideoEditor";
import { EmptyCTA, SectionHeader } from "@/components/ui/SectionHeader";
import { getSession } from "@/lib/auth/session";
import { getStageContext } from "@/lib/dashboard/stage";
import { displayTitle } from "@/lib/projects/display-title";

export const metadata = { title: "Edit video — Tally" };

export default async function VideoEditPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login?next=%2Fdashboard%2Fvideo%2Fedit");

  const params = await searchParams;
  const context = await getStageContext(session.user.id, params.project);
  const project = context.project;

  if (!project) {
    return (
      <div>
        <SectionHeader
          eyebrow="Stage 03"
          title="Edit the video"
          sub="Cut, trim and re-time the video Tally generated."
        />
        <EmptyCTA
          title="No video to edit"
          body="There is no video here yet. Generate one first — the editor opens the scenes, voiceover, music and captions the pipeline produced."
        />
      </div>
    );
  }

  return (
    <div>
      <SectionHeader
        eyebrow="Stage 03"
        title="Edit the video"
        sub={
          context.script
            ? `Cutting “${context.script.title}.”`
            : "Cut, trim and re-time the generated video."
        }
      />
      <VideoEditor
        projectId={project.id}
        /*
          Null rather than the from-a-link placeholder, so the editor heading falls
          through to its own "Untitled video" instead of showing the raw source video id
          as the name of the user's cut.
        */
        projectTitle={context.script?.title ?? displayTitle(project.title)}
      />
    </div>
  );
}

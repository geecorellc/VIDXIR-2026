/**
 * Research — ported from the prototype's `Research` (STAGE 01, §7).
 *
 * Preserved: the "Find viral ideas" header and copy, and the two-row card layout.
 *
 * Changed: the prototype's `trending`, `searchDemand`, `competitors` and
 * `ideaVault` constants are gone. Everything here comes from `research_runs`,
 * `research_results` and `ideas` for the selected channel, and selecting an idea
 * creates a real project row rather than mutating React state.
 */
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { Youtube } from "lucide-react";
import { ConfigNotice } from "@/components/dashboard/ConfigNotice";
import { ConnectChannelCard } from "@/components/dashboard/ConnectChannelCard";
import { ResearchBoard } from "@/components/research/ResearchBoard";
import { EmptyCTA, SectionHeader } from "@/components/ui/SectionHeader";
import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { ideas } from "@/lib/db/schema";
import { getResearchData } from "@/lib/dashboard/research";
import { getStageContext } from "@/lib/dashboard/stage";
import { capabilityStatus } from "@/lib/providers/config";

export const metadata = { title: "Research — Vidxir AI" };

export default async function ResearchPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string; project?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login?next=%2Fdashboard%2Fresearch");
  const userId = session.user.id;

  const params = await searchParams;
  const context = await getStageContext(userId, params.project);

  const header = (
    <SectionHeader
      eyebrow="Stage 01"
      title="Find viral ideas"
      sub="What people actually watch in your niche, right now."
    />
  );

  if (context.channels.length === 0) {
    return (
      <div>
        {header}
        <EmptyCTA
          icon={<Youtube size={22} />}
          title="Connect a channel first"
          body="Research is per-channel: Vidxir AI reads your niche, your own past performance and your competitors before it proposes anything. Connect a channel to give it something to work from."
          action={<ConnectChannelCard variant="button" />}
        />
      </div>
    );
  }

  // Requested channel if the user owns it, otherwise the project's channel, and
  // finally the first connected one. Never trusts the query string alone.
  const requested = context.channels.find((c) => c.id === params.channel);
  const channel =
    requested ??
    context.channels.find((c) => c.id === context.project?.channelId) ??
    context.channels[0]!;

  const selectedIdeaId = context.project?.ideaId ?? null;

  const [data, ai, selectedIdea] = await Promise.all([
    getResearchData(userId, channel.id, selectedIdeaId),
    Promise.resolve(capabilityStatus("ai")),
    selectedIdeaId
      ? db
          .select({ title: ideas.title })
          .from(ideas)
          .where(and(eq(ideas.id, selectedIdeaId), eq(ideas.userId, userId)))
          .limit(1)
      : Promise.resolve([]),
  ]);

  return (
    <div>
      {header}
      <ConfigNotice status={ai} />
      <ResearchBoard
        channelId={channel.id}
        data={data}
        selectedIdeaTitle={selectedIdea[0]?.title ?? null}
        canGenerateIdeas={ai.state !== "not_configured"}
      />
    </div>
  );
}

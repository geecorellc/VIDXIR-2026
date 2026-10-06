/**
 * Channels — ported from the prototype's `Channels` (STAGE 06, §27).
 *
 * Preserved: the "Scale the channel" header, the "Just published" accent card
 * with its pulsing dot, the auto-fit 220px card grid, and the dashed
 * "Add a channel" tile.
 *
 * Changed: the prototype's six invented channels are gone. This lists the
 * channels actually connected through Google OAuth, with the plan's channel limit
 * enforced server-side (§23) and an explicit configuration state when the Google
 * credentials are absent (§48). Connecting happens by redirecting to Google — Vidxir AI
 * never asks for a YouTube password.
 */
import { redirect } from "next/navigation";
import { desc, eq, sql } from "drizzle-orm";
import { Youtube } from "lucide-react";
import { ChannelCard, type ChannelCardData } from "@/components/dashboard/ChannelCard";
import { ConfigNotice } from "@/components/dashboard/ConfigNotice";
import { ConnectChannelCard } from "@/components/dashboard/ConnectChannelCard";
import {
  ConnectResultBanner,
  isConnectResultCode,
} from "@/components/dashboard/ConnectResultBanner";
import { Card } from "@/components/ui/Card";
import { EmptyCTA, SectionHeader } from "@/components/ui/SectionHeader";
import { currentTier } from "@/lib/api/guard";
import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { analyticsSnapshots, publishedVideos } from "@/lib/db/schema";
import { listChannelSummaries } from "@/lib/dashboard/stage";
import { compact } from "@/lib/dashboard/overview";
import { color, font } from "@/lib/design/tokens";
import { planByTier } from "@/lib/plans";
import { capabilityStatus } from "@/lib/providers/config";

export const metadata = { title: "Channels — Vidxir AI" };

/** A publish is "just published" for an hour, matching the prototype's banner. */
const JUST_PUBLISHED_MS = 60 * 60 * 1000;

interface PageProps {
  /** `?connect=` is set by the OAuth connect/callback redirects (§37). */
  searchParams: Promise<{ connect?: string | string[] }>;
}

export default async function ChannelsPage({ searchParams }: PageProps) {
  const session = await getSession();
  if (!session) redirect("/login?next=%2Fdashboard%2Fchannels");
  const userId = session.user.id;

  const { connect } = await searchParams;
  const connectRaw = Array.isArray(connect) ? connect[0] : connect;
  const connectResult =
    connectRaw && isConnectResultCode(connectRaw) ? connectRaw : null;

  const [connected, tier, youtube] = await Promise.all([
    listChannelSummaries(userId),
    currentTier(userId),
    Promise.resolve(capabilityStatus("youtube")),
  ]);

  // The plan catalogue is the single source of truth for limits, and `tier` came
  // from the subscriptions table — never from the client (§23).
  const plan = planByTier(tier);

  // Latest Vidxir AI-published video per channel, plus lifetime views from real
  // analytics snapshots. Both are left null when nothing has been measured.
  const [recent, viewTotals] = await Promise.all([
    db
      .select({
        channelId: publishedVideos.channelId,
        title: publishedVideos.titleUsed,
        publishedAt: publishedVideos.publishedAt,
        createdAt: publishedVideos.createdAt,
      })
      .from(publishedVideos)
      .where(eq(publishedVideos.userId, userId))
      .orderBy(desc(publishedVideos.createdAt))
      .limit(200),

    db
      .select({
        channelId: analyticsSnapshots.channelId,
        views: sql<string | null>`sum(${analyticsSnapshots.views})`,
      })
      .from(analyticsSnapshots)
      .where(eq(analyticsSnapshots.userId, userId))
      .groupBy(analyticsSnapshots.channelId),
  ]);

  const latestByChannel = new Map<string, (typeof recent)[number]>();
  for (const row of recent) {
    if (!latestByChannel.has(row.channelId)) latestByChannel.set(row.channelId, row);
  }

  const viewsByChannel = new Map<string, number>();
  for (const row of viewTotals) {
    if (row.views !== null) viewsByChannel.set(row.channelId, Number(row.views));
  }

  const newest = recent[0];
  const newestAt = newest?.publishedAt ?? newest?.createdAt ?? null;
  const justPublished =
    newest && newestAt && Date.now() - newestAt.getTime() < JUST_PUBLISHED_MS
      ? newest
      : null;

  const cards: ChannelCardData[] = connected.map((channel) => {
    const views = viewsByChannel.get(channel.id);
    return {
      id: channel.id,
      title: channel.title,
      handle: channel.handle,
      subscriberCount: channel.statsRefreshedAt ? channel.subscriberCount : null,
      viewsLabel: views === undefined ? null : compact(views),
      lastVideoTitle: latestByChannel.get(channel.id)?.title ?? null,
      statsRefreshedAt: channel.statsRefreshedAt,
      needsReauth: channel.reauthRequiredAt !== null,
      highlight: justPublished?.channelId === channel.id,
    };
  });

  const atLimit =
    plan.maxChannels !== null && connected.length >= plan.maxChannels;

  return (
    <div>
      <SectionHeader
        eyebrow="Stage 06"
        title="Scale the channel"
        sub="One studio, running across every channel you own."
      />

      {connectResult && <ConnectResultBanner code={connectResult} />}

      <ConfigNotice status={youtube} />

      {justPublished && (
        <Card
          tone="accent"
          style={{
            marginBottom: 16,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span
            className="vidxir-dot"
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: color.accent,
              flexShrink: 0,
            }}
            aria-hidden="true"
          />
          <span style={{ fontSize: 13.5 }}>
            Just published —{" "}
            <strong style={{ fontWeight: 600 }}>
              {justPublished.title ?? "your latest video"}
            </strong>
          </span>
        </Card>
      )}

      {connected.length === 0 ? (
        <EmptyCTA
          icon={<Youtube size={22} />}
          title="No channel connected"
          body={
            youtube.state === "not_configured"
              ? "Vidxir AI connects to YouTube through Google OAuth. The server is missing its Google credentials, so the connect flow is unavailable until they are configured."
              : "Connect a YouTube channel and Vidxir AI can read your niche, research what is breaking out, and publish on your behalf. You will be sent to Google to approve access — Vidxir AI never asks for your YouTube password."
          }
          action={
            youtube.state === "ready" ? <ConnectChannelCard variant="button" /> : undefined
          }
        />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 14,
            marginBottom: 20,
          }}
        >
          {cards.map((channel) => (
            <ChannelCard key={channel.id} channel={channel} />
          ))}

          <ConnectChannelCard
            variant="card"
            disabled={atLimit || youtube.state !== "ready"}
            reason={
              youtube.state !== "ready"
                ? "Google credentials are not configured on the server."
                : atLimit
                  ? `${plan.name} includes ${plan.maxChannels} channel${
                      plan.maxChannels === 1 ? "" : "s"
                    }. Upgrade to connect more.`
                  : undefined
            }
          />
        </div>
      )}

      {connected.length > 0 && (
        <p
          style={{
            margin: 0,
            fontSize: 12,
            lineHeight: 1.6,
            color: color.textFaint,
            fontFamily: font.body,
          }}
        >
          {plan.maxChannels === null
            ? `${connected.length} connected · ${plan.name} includes unlimited channels.`
            : `${connected.length} of ${plan.maxChannels} channels connected on ${plan.name}.`}
        </p>
      )}
    </div>
  );
}

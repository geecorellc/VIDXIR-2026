/**
 * Analytics — performance, CTR, revenue attribution and thumbnail tests (Phase 9).
 *
 * The prototype had no analytics screen; this one is built from its existing
 * vocabulary — `SectionHeader`, `StatTile`, `Card`, the same tokens — rather than
 * introducing a new visual language (§14).
 *
 * The governing rule is the same one as the rest of Phase 9: **absence is
 * rendered as absence.** Every tile here can show an em dash with a reason, and
 * the revenue tile in particular will normally say the YouTube monetary permission
 * is missing rather than "$0.00", because Tally does not request that scope at
 * consent and a zero would be a claim about earnings rather than about access
 * (§7).
 *
 * A server component: it reads Postgres directly. No YouTube call, so opening this
 * page costs no quota and cannot fail because a provider is down.
 */
import { redirect } from "next/navigation";
import { BarChart3, DollarSign, Eye, MousePointerClick } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { EmptyCTA, SectionHeader } from "@/components/ui/SectionHeader";
import { StatTile } from "@/components/ui/StatTile";
import { ExperimentCard } from "@/components/analytics/ExperimentCard";
import {
  DataSourceNote,
  MetricRow,
  integer,
  percent,
  reasonLabel,
} from "@/components/analytics/MetricRow";
import { getSession } from "@/lib/auth/session";
import { currentTier } from "@/lib/api/guard";
import { hasFeature } from "@/lib/plans/enforce";
import { listChannelSummaries } from "@/lib/dashboard/stage";
import {
  channelPerformance,
  formatMoney,
  lastIngestedAt,
  videoRevenueAttribution,
} from "@/lib/analytics/report";
import { decide, listExperiments } from "@/lib/analytics/experiments";
import { color, font } from "@/lib/design/tokens";

export const metadata = { title: "Analytics — Tally" };

/** The reporting window. Matches the ingest's default retention expectations. */
const WINDOW_DAYS = 28;

interface PageProps {
  searchParams: Promise<{ channel?: string | string[] }>;
}

export default async function AnalyticsPage({ searchParams }: PageProps) {
  const session = await getSession();
  if (!session) redirect("/login?next=%2Fdashboard%2Fanalytics");
  const userId = session.user.id;

  const [channels, tier] = await Promise.all([
    listChannelSummaries(userId),
    currentTier(userId),
  ]);

  if (channels.length === 0) {
    return (
      <div>
        <SectionHeader
          eyebrow="Reporting"
          title="What the numbers say"
          sub="Views, watch time, click-through and earnings, straight from YouTube Analytics."
        />
        <EmptyCTA
          icon={<BarChart3 size={22} />}
          title="No channel connected"
          body="Analytics are read from the YouTube channels you connect. Connect one and Tally starts collecting daily figures for it."
        />
      </div>
    );
  }

  /**
   * The requested channel, re-resolved against the user's own list. A `?channel=`
   * from another tenant simply falls through to the first channel rather than
   * being queried (§12).
   */
  const { channel: requested } = await searchParams;
  const requestedId = Array.isArray(requested) ? requested[0] : requested;
  const selected =
    channels.find((c) => c.id === requestedId) ?? channels[0];
  if (!selected) redirect("/dashboard/channels");

  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_DAYS * 86_400_000);
  const range = { start, end };

  const [performance, videos, ingestedAt, experiments] = await Promise.all([
    channelPerformance(userId, selected.id, range),
    videoRevenueAttribution(userId, selected.id, range, 10),
    lastIngestedAt(userId, selected.id),
    listExperiments(userId, selected.id, 10),
  ]);

  const canAbTest = hasFeature(tier, "thumbnailAbTest");
  const revenue = performance.revenue;

  return (
    <div>
      <SectionHeader
        eyebrow="Reporting"
        title="What the numbers say"
        sub={`${selected.title} — the last ${WINDOW_DAYS} days, from stored YouTube Analytics snapshots.`}
      />

      {channels.length > 1 && <ChannelSwitcher channels={channels} selectedId={selected.id} />}

      <DataSourceNote
        lastIngestedAt={ingestedAt}
        reauthRequired={selected.reauthRequiredAt !== null}
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 14,
          marginBottom: 22,
        }}
      >
        <StatTile
          label="Views"
          icon={<Eye size={15} />}
          value={
            performance.views.state === "available" && performance.views.value !== null
              ? integer(performance.views.value)
              : null
          }
          emptyHint={reasonLabel(performance.views.reason)}
        />
        <StatTile
          label="Watch time"
          value={
            performance.watchTimeMinutes.state === "available" &&
            performance.watchTimeMinutes.value !== null
              ? `${integer(performance.watchTimeMinutes.value)} min`
              : null
          }
          emptyHint={reasonLabel(performance.watchTimeMinutes.reason)}
        />
        <StatTile
          label="Impression CTR"
          icon={<MousePointerClick size={15} />}
          value={
            performance.ctr.state === "available" && performance.ctr.value !== null
              ? percent(performance.ctr.value)
              : null
          }
          // `unsupported` gets its own wording: this metric is not coming later.
          emptyHint={reasonLabel(performance.ctr.reason)}
        />
        <StatTile
          label="Estimated revenue"
          icon={<DollarSign size={15} />}
          value={
            revenue.total.state === "available" && revenue.total.value !== null
              ? formatMoney(revenue.total.value, revenue.currency)
              : null
          }
          emptyHint={reasonLabel(revenue.total.reason ?? revenue.state)}
          delta={
            revenue.total.state === "available"
              ? revenue.final
                ? "Final"
                : "Estimated — YouTube still revising"
              : null
          }
        />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 14,
          marginBottom: 22,
        }}
      >
        <Card>
          <Heading>Engagement</Heading>
          <MetricRow label="Likes" metric={performance.likes} format={integer} />
          <MetricRow label="Comments" metric={performance.comments} format={integer} />
          <MetricRow label="Shares" metric={performance.shares} format={integer} />
          <MetricRow
            label="Net subscribers"
            metric={performance.subscribersNet}
            format={integer}
          />
          <MetricRow
            label="Average view percentage"
            metric={performance.averageViewPercentage}
            // Already a percentage from YouTube, so it is not multiplied again.
            format={(v) => `${Number(v).toFixed(1)}%`}
          />
        </Card>

        <Card>
          <Heading>Revenue attribution</Heading>
          <MetricRow
            label="Total"
            metric={revenue.total}
            format={(v) => formatMoney(String(v), revenue.currency)}
            note={revenue.final ? null : "Estimated"}
          />
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              padding: "9px 0",
              borderBottom: `1px solid ${color.borderFaint}`,
            }}
          >
            <span style={{ fontSize: 12.5, color: color.textDim }}>Days reported</span>
            <span style={{ fontFamily: font.display, fontSize: 15, fontWeight: 600 }}>
              {revenue.measuredDays} / {performance.measuredDays || WINDOW_DAYS}
            </span>
          </div>
          <p
            style={{
              margin: "12px 0 0",
              fontSize: 11.5,
              lineHeight: 1.6,
              color: color.textFaint,
            }}
          >
            {revenue.state === "scope_missing" || revenue.state === "not_requested"
              ? "Earnings need the YouTube Analytics monetary permission, which this connection does not include. Tally shows no figure rather than a zero."
              : "Earnings are YouTube's own estimates and are revised for several weeks after the fact."}
          </p>
        </Card>
      </div>

      <Card style={{ marginBottom: 22 }}>
        <Heading>Per-video attribution</Heading>
        {videos.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: color.textDim }}>
            Nothing published to this channel through Tally yet.
          </p>
        ) : (
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}
          >
            <thead>
              <tr style={{ color: color.textFaint }}>
                <th style={{ ...headStyle, textAlign: "left" }}>Video</th>
                <th style={headStyle}>Views</th>
                <th style={headStyle}>Watch time</th>
                <th style={headStyle}>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {videos.map((video) => (
                <tr key={video.publishedVideoId}>
                  <td
                    style={{
                      ...cellStyle,
                      textAlign: "left",
                      maxWidth: 320,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {video.title ?? video.youtubeVideoId}
                  </td>
                  <td style={cellStyle}>
                    {video.views.state === "available" && video.views.value !== null
                      ? integer(video.views.value)
                      : "—"}
                  </td>
                  <td style={cellStyle}>
                    {video.watchTimeMinutes.state === "available" &&
                    video.watchTimeMinutes.value !== null
                      ? `${integer(video.watchTimeMinutes.value)} min`
                      : "—"}
                  </td>
                  <td style={cellStyle}>
                    {video.revenue.state === "available" &&
                    video.revenue.value !== null
                      ? formatMoney(video.revenue.value, video.revenueCurrency)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <Heading>Thumbnail tests</Heading>
        {!canAbTest ? (
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, color: color.textDim }}>
            Thumbnail A/B testing is included on the Studio and Scale plans.
          </p>
        ) : experiments.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, color: color.textDim }}>
            No thumbnail tests yet. A test compares thumbnails you have already
            generated on a video that is live on YouTube, and reports a winner only
            once each option has been seen enough times to mean something.
          </p>
        ) : (
          <div style={{ marginTop: 4 }}>
            {experiments.map((experiment) => (
              <ExperimentCard
                key={experiment.id}
                experiment={experiment}
                standing={decide(experiment)}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/** Links rather than a select, so a channel's report is a shareable URL. */
function ChannelSwitcher({
  channels,
  selectedId,
}: {
  channels: Array<{ id: string; title: string }>;
  selectedId: string;
}) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
      {channels.map((channel) => {
        const active = channel.id === selectedId;
        return (
          <a
            key={channel.id}
            href={`/dashboard/analytics?channel=${channel.id}`}
            style={{
              fontSize: 12,
              padding: "5px 11px",
              borderRadius: 999,
              textDecoration: "none",
              background: active ? color.accentBgSoft : color.subtle,
              border: `1px solid ${active ? color.accent : color.border}`,
              color: active ? color.text : color.textDim,
            }}
          >
            {channel.title}
          </a>
        );
      })}
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: font.display,
        fontSize: 11,
        letterSpacing: 1.3,
        textTransform: "uppercase",
        color: color.textFaint,
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

const headStyle = {
  fontFamily: font.display,
  fontSize: 10,
  letterSpacing: 1,
  textTransform: "uppercase" as const,
  fontWeight: 500,
  padding: "0 0 7px",
  textAlign: "right" as const,
  borderBottom: `1px solid ${color.borderFaint}`,
};

const cellStyle = {
  padding: "8px 0",
  textAlign: "right" as const,
  borderBottom: `1px solid ${color.borderFaint}`,
  color: color.textBright,
};

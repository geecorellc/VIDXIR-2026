/**
 * Overview — ported from the prototype's `Overview` (§25).
 *
 * Preserved: the "ON AIR / Good to see you back." header, the four stat tiles in
 * order (Channels, Subscribers, Views 7d, Est. revenue), the 1.4fr/1fr split
 * with the niche demand chart beside Quick actions.
 *
 * Changed: every number is a real query result, and anything Tally has not
 * actually measured renders as "—" with the reason, per §42. The prototype's
 * static `searchDemand` array is replaced by the demand series from the user's
 * most recent successful research run; with no run yet, the card says so.
 */
import { redirect } from "next/navigation";
import { DollarSign, Eye, Radio, Users } from "lucide-react";
import { QuickActions } from "@/components/dashboard/QuickActions";
import { DemandChart } from "@/components/dashboard/DemandChart";
import { InProgressList } from "@/components/dashboard/InProgressList";
import { Card } from "@/components/ui/Card";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { StatTile } from "@/components/ui/StatTile";
import { getSession } from "@/lib/auth/session";
import { getOverview } from "@/lib/dashboard/overview";
import { color } from "@/lib/design/tokens";

export const metadata = { title: "Overview — Tally" };

export default async function OverviewPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=%2Fdashboard");

  const data = await getOverview(session.user.id);
  const firstName = session.user.name.split(" ")[0] ?? session.user.name;

  return (
    <div>
      <SectionHeader
        eyebrow="On air"
        title={`Good to see you back, ${firstName}.`}
        sub={
          data.hasChannel
            ? "Here's what your studio did while you were away."
            : // Two of the three entry paths need no channel (Phase 11 §4; §1C), so
              // the empty state points at what already works rather than implying a
              // connection is required to start.
              "Connect a YouTube channel to research your niche — or paste a link or describe an idea and start without one."
        }
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(178px, 1fr))",
          gap: 14,
          marginBottom: 20,
        }}
      >
        <StatTile
          label="Channels"
          value={data.channels.value}
          emptyHint={data.channels.emptyHint}
          delta={data.channels.delta}
          icon={<Radio size={15} color={color.accent} />}
        />
        <StatTile
          label="Subscribers"
          value={data.subscribers.value}
          emptyHint={data.subscribers.emptyHint}
          icon={<Users size={15} color={color.accent} />}
        />
        <StatTile
          label="Views (7d)"
          value={data.views7d.value}
          emptyHint={data.views7d.emptyHint}
          icon={<Eye size={15} color={color.accent} />}
        />
        <StatTile
          label="Est. revenue"
          value={data.revenue.value}
          emptyHint={data.revenue.emptyHint}
          icon={<DollarSign size={15} color={color.accent} />}
        />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.4fr) minmax(260px, 1fr)",
          gap: 16,
          marginBottom: 20,
        }}
        className="tally-overview-grid"
      >
        <Card>
          <h2
            style={{
              fontSize: 14.5,
              fontWeight: 600,
              margin: "0 0 14px",
              color: color.text,
            }}
          >
            Search demand —{" "}
            <span style={{ color: color.textDim }}>
              {data.demandNiche ?? "your niche"}
            </span>
          </h2>
          <DemandChart series={data.demandSeries} />
        </Card>

        <Card>
          <h2
            style={{
              fontSize: 14.5,
              fontWeight: 600,
              margin: "0 0 14px",
              color: color.text,
            }}
          >
            Quick actions
          </h2>
          <QuickActions hasChannel={data.hasChannel} />
        </Card>
      </div>

      <InProgressList
        items={data.inProgress}
        publishedCount={data.publishedCount}
      />

      {/* Single-column below 900px, matching the shell's breakpoint. */}
      <style>{`
        @media (max-width: 900px) {
          .tally-overview-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

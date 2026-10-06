/**
 * Overview — the studio's front door.
 *
 * Restructured after the vidxr-dashboard reference (§3 permits the visual
 * direction to move; the workflow it fronts does not change). The reference
 * opens on a single prompt box, and that ordering is the substance of the
 * change: the first thing on the page is now the thing you came to do, with
 * everything measured sitting underneath it.
 *
 *   prompt box        -> start a video from a description
 *   shortcut row      -> the other two entry paths and the editor
 *   stat tiles        -> real numbers, or "—" with a reason (§42)
 *   demand + progress -> what research found, and what is still running
 *
 * What did *not* change: every number is still a real query result, the four
 * tiles keep their order (Channels, Subscribers, Views 7d, Est. revenue), and
 * the demand series still comes from the user's most recent successful research
 * run rather than a static array. The nine pipeline stages are untouched — this
 * screen is an entry point to them, not a replacement for them.
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { Clapperboard, DollarSign, Eye, PenLine, Radio, Users, Youtube } from "lucide-react";
import { PromptBox } from "@/components/dashboard/PromptBox";
import { DemandChart } from "@/components/dashboard/DemandChart";
import { InProgressList } from "@/components/dashboard/InProgressList";
import { Card } from "@/components/ui/Card";
import { StatTile } from "@/components/ui/StatTile";
import { getSession } from "@/lib/auth/session";
import { getOverview } from "@/lib/dashboard/overview";
import { color, display, font, radius } from "@/lib/design/tokens";
import { capabilityStatus } from "@/lib/providers/config";

export const metadata = { title: "Overview — Vidxir AI" };

/** The entry paths the prompt box does not cover, as the reference's chip row. */
const SHORTCUTS = [
  { href: "/dashboard/youtube", label: "Create from a YouTube link", icon: Youtube },
  { href: "/dashboard/describe", label: "Open the full flow", icon: PenLine },
  { href: "/dashboard/video/edit", label: "Open editor", icon: Clapperboard },
] as const;

export default async function OverviewPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=%2Fdashboard");

  const data = await getOverview(session.user.id);
  const firstName = session.user.name.split(" ")[0] ?? session.user.name;

  // §48: whether a provider is configured is a server fact; the client gets the
  // boolean, never the credential (§21).
  const ai = capabilityStatus("ai");

  return (
    <div>
      {/* Front door. Centred and narrow, so the page opens on one decision. */}
      <section style={{ padding: "22px 0 40px" }}>
        <div style={{ textAlign: "center", marginBottom: 26 }}>
          <h1 style={{ ...display(28), marginBottom: 9 }}>
            What are we making, {firstName}?
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: 14.5,
              lineHeight: 1.6,
              color: color.textDim,
            }}
          >
            Describe it and Vidxir AI researches what is working right now, then
            writes something original from it.
          </p>
        </div>

        <PromptBox aiConfigured={ai.state !== "not_configured"} />

        <div
          style={{
            display: "flex",
            justifyContent: "center",
            flexWrap: "wrap",
            gap: 10,
            marginTop: 20,
          }}
        >
          {SHORTCUTS.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                border: `1px solid ${color.border}`,
                borderRadius: radius.pill,
                padding: "9px 16px",
                color: color.textMuted,
                fontFamily: font.body,
                fontSize: 13,
                fontWeight: 500,
                textDecoration: "none",
              }}
            >
              <Icon size={16} />
              {label}
            </Link>
          ))}
        </div>
      </section>

      {/* Everything measured, beneath the fold of the decision. */}
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

      <Card style={{ marginBottom: 20 }}>
        <h2
          style={{
            fontSize: 14.5,
            fontWeight: 600,
            margin: "0 0 14px",
            color: color.text,
          }}
        >
          Search demand —{" "}
          <span style={{ color: color.textDim, fontWeight: 400 }}>
            {data.demandNiche ?? "your niche"}
          </span>
        </h2>
        <DemandChart series={data.demandSeries} />
      </Card>

      <InProgressList
        items={data.inProgress}
        publishedCount={data.publishedCount}
      />
    </div>
  );
}

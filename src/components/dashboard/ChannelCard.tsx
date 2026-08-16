/**
 * Channel card — ported from the prototype's channel grid tile.
 *
 * Preserved: the 32px #221315 circle with the YouTube glyph, name, "{n}
 * subscribers", the last video line, and the "Views" row.
 *
 * Changed: the prototype hard-coded six channels with invented subscriber counts.
 * Here every figure comes from the `channels` table, populated by a real YouTube
 * Data API read. A channel whose stats have never been fetched shows "—" rather
 * than a plausible-looking number (§42), and a channel whose refresh token was
 * rejected shows a re-authorise prompt instead (§30).
 */
import Link from "next/link";
import { AlertTriangle, Youtube } from "lucide-react";
import { ChannelActions } from "@/components/dashboard/ChannelActions";
import { Card } from "@/components/ui/Card";
import { color, font, radius } from "@/lib/design/tokens";

export interface ChannelCardData {
  id: string;
  title: string;
  handle: string | null;
  subscriberCount: number | null;
  viewsLabel: string | null;
  lastVideoTitle: string | null;
  statsRefreshedAt: Date | null;
  needsReauth: boolean;
  /** Highlight the channel a video was just published to. */
  highlight?: boolean;
}

const nf = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function ChannelCard({ channel }: { channel: ChannelCardData }) {
  return (
    <Card tone={channel.highlight ? "accent" : "default"}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "#221315",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Youtube size={15} color={color.accent} aria-hidden="true" />
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {channel.title}
          </div>
          <div style={{ fontSize: 11.5, color: color.textFaint }}>
            {channel.subscriberCount === null
              ? "Subscriber count not fetched yet"
              : `${nf.format(channel.subscriberCount)} subscribers`}
          </div>
        </div>
      </div>

      {channel.needsReauth ? (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            background: "#221A10",
            border: `1px solid #4A3A20`,
            borderRadius: radius.md,
            padding: "9px 10px",
            fontSize: 12.5,
            lineHeight: 1.5,
            color: color.warning,
          }}
        >
          <AlertTriangle size={13} style={{ marginTop: 2, flexShrink: 0 }} aria-hidden="true" />
          <span>
            Google access expired.{" "}
            <Link
              href={`/api/channels/connect?channel=${channel.id}`}
              prefetch={false}
              style={{ color: color.accent, textDecoration: "underline" }}
            >
              Reconnect this channel
            </Link>
          </span>
        </div>
      ) : (
        <>
          <div
            style={{
              fontSize: 12.5,
              color: color.textMuted,
              marginBottom: 10,
              minHeight: 18,
            }}
          >
            {channel.lastVideoTitle ?? "No videos published by Tally yet"}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: 11.5, color: color.textDim }}>Views</span>
            <span
              style={{
                fontFamily: font.display,
                fontSize: 13,
                fontWeight: 600,
                // Green is reserved for a measured figure. An unmeasured one is
                // dim, so the colour itself never implies data that is absent.
                color: channel.viewsLabel ? color.positive : color.textFaint,
              }}
            >
              {channel.viewsLabel ?? "—"}
            </span>
          </div>
        </>
      )}

      <ChannelActions channelId={channel.id} channelTitle={channel.title} />
    </Card>
  );
}

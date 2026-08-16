/**
 * "In production now" list.
 *
 * A production addition the prototype had no equivalent for: because generation
 * happens in background workers, the user needs to see what is running even
 * after a refresh (§10, §37). Progress values come from the projects table and
 * are derived from completed stages — never animated for effect.
 */
import Link from "next/link";
import { Clapperboard } from "lucide-react";
import { StatusChip } from "@/components/dashboard/StatusChip";
import { Card } from "@/components/ui/Card";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { color, font } from "@/lib/design/tokens";
import type { ProjectStatus } from "@/lib/projects/state-machine";

export interface InProgressItem {
  id: string;
  title: string;
  status: ProjectStatus;
  progress: number;
  channelTitle: string;
  updatedAt: Date;
}

export function InProgressList({
  items,
  publishedCount,
}: {
  items: InProgressItem[];
  publishedCount: number;
}) {
  if (items.length === 0) {
    return (
      <Card>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            fontSize: 13,
            color: color.textDim,
          }}
        >
          <Clapperboard size={15} color={color.textFaint} aria-hidden="true" />
          Nothing in production right now.
          {publishedCount > 0 && (
            <span style={{ color: color.textFaint }}>
              {publishedCount} video{publishedCount === 1 ? "" : "s"} published
              so far.
            </span>
          )}
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <h2
        style={{
          fontSize: 14.5,
          fontWeight: 600,
          margin: "0 0 14px",
          color: color.text,
        }}
      >
        In production now
      </h2>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {items.map((item) => (
          <div key={item.id}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginBottom: 8,
                flexWrap: "wrap",
              }}
            >
              <Link
                href={`/dashboard/video?project=${item.id}`}
                style={{
                  fontSize: 13.5,
                  fontWeight: 500,
                  color: color.text,
                  textDecoration: "none",
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.title}
              </Link>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span
                  style={{
                    fontFamily: font.display,
                    fontSize: 10.5,
                    letterSpacing: 1.1,
                    textTransform: "uppercase",
                    color: color.textFaint,
                  }}
                >
                  {item.channelTitle}
                </span>
                <StatusChip status={item.status} size="sm" />
              </div>
            </div>
            <ProgressBar
              // 0 means "started, no stage finished yet" — shown as an
              // indeterminate stripe rather than a misleading empty bar.
              pct={item.progress}
              indeterminate={item.progress === 0}
              label={`${item.title} progress`}
            />
          </div>
        ))}
      </div>
    </Card>
  );
}

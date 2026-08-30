/**
 * Quick actions — ported from the prototype's four-button list.
 *
 * The prototype's `go(id)` tab switches become links. Without a connected channel the
 * channel-scoped stages are dead ends, so the list collapses to what actually works:
 * connecting a channel, and the two seeded entry paths that need no channel at all
 * (Phase 11 §4; §1C). Offering only "connect a channel" would understate what a new
 * user can do before connecting anything.
 */
import Link from "next/link";
import {
  ChevronRight,
  FileText,
  Image as ImageIcon,
  PenLine,
  Search,
  Send,
  Youtube,
  type LucideIcon,
} from "lucide-react";
import { color, font, radius } from "@/lib/design/tokens";

interface Action {
  href: string;
  label: string;
  icon: LucideIcon;
}

const ACTIONS: Action[] = [
  { href: "/dashboard/research", label: "Find a new idea", icon: Search },
  { href: "/dashboard/describe", label: "Describe an idea", icon: PenLine },
  { href: "/dashboard/script", label: "Write a script", icon: FileText },
  { href: "/dashboard/thumbnail", label: "Design a thumbnail", icon: ImageIcon },
  { href: "/dashboard/publish", label: "Publish a video", icon: Send },
];

const CONNECT_FIRST: Action[] = [
  { href: "/dashboard/channels", label: "Connect a YouTube channel", icon: Youtube },
  { href: "/dashboard/youtube", label: "Create from a YouTube link", icon: Youtube },
  { href: "/dashboard/describe", label: "Describe an idea", icon: PenLine },
];

export function QuickActions({ hasChannel }: { hasChannel: boolean }) {
  const actions = hasChannel ? ACTIONS : CONNECT_FIRST;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {actions.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: color.inputBg,
            border: `1px solid ${color.border}`,
            borderRadius: radius.md,
            padding: "11px 12px",
            color: color.text,
            fontSize: 13.5,
            fontFamily: font.body,
            textDecoration: "none",
          }}
        >
          <Icon size={15} color={color.accent} aria-hidden="true" />
          {label}
          <ChevronRight
            size={14}
            style={{ marginLeft: "auto", color: color.textFaint }}
            aria-hidden="true"
          />
        </Link>
      ))}

      {!hasChannel && (
        <p
          style={{
            margin: "4px 0 0",
            fontSize: 12,
            lineHeight: 1.55,
            color: color.textFaint,
          }}
        >
          The last two work with no channel connected. Tally connects through Google
          — it never asks for your YouTube password.
        </p>
      )}
    </div>
  );
}

"use client";

/**
 * Dashboard sidebar — ported from the prototype's `aside`.
 *
 * Preserved: a fixed-width column with a hairline right border, the nav items in
 * order, an accent left border + soft accent background on the active item, the
 * muted dot for stages that are not yet reachable, and the "PLAN · STUDIO"
 * footer above Log out.
 *
 * Changed: the active item comes from the URL (usePathname) rather than a `tab`
 * state variable, the locked dot is driven by real persisted project status, and
 * the plan label comes from the server (§23 — never a client-held value). Every
 * colour is a `tokens` value, so the rail themes with the rest of the app — the
 * active item uses accent-on-soft-accent rather than white-on-accent, which was
 * unreadable once the soft tint became near-white in the light theme.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  BarChart3,
  LifeBuoy,
  ShieldCheck,
  Clapperboard,
  CreditCard,
  FileText,
  Image as ImageIcon,
  LayoutDashboard,
  LogOut,
  PenLine,
  Radio,
  Search,
  Send,
  Settings,
  Youtube,
  type LucideIcon,
} from "lucide-react";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { VidxirLogo } from "@/components/ui/VidxirLogo";
import { color, font, layout, radius } from "@/lib/design/tokens";
import { NAV_ITEMS, SECONDARY_NAV, type NavItem } from "@/lib/nav";
import { api } from "@/services/api-client";

const ICONS: Record<string, LucideIcon> = {
  BarChart3,
  LifeBuoy,
  ShieldCheck,
  LayoutDashboard,
  Search,
  FileText,
  Clapperboard,
  ImageIcon,
  Send,
  Radio,
  Settings,
  CreditCard,
  Youtube,
  PenLine,
};

export interface SidebarProps {
  isAdmin?: boolean;
  planName: string;
  /** Whether the user has any channel connected — gates every content stage. */
  hasChannel: boolean;
  /** Furthest point the active project has reached, from the database. */
  projectReach: "none" | "idea" | "script" | "video";
  /** Called by the mobile drawer to close itself after navigation. */
  onNavigate?: () => void;
}

const REACH_ORDER = { none: 0, idea: 1, script: 2, video: 3 } as const;

export function Sidebar({
  planName,
  isAdmin,
  hasChannel,
  projectReach,
  onNavigate,
}: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  /**
   * A stage is reachable when the project has progressed far enough. Unlike the
   * prototype, the link still works — it renders its own "do this first" empty
   * state, which is more useful than a dead button.
   */
  function isPending(item: NavItem): boolean {
    // A channel-less stage is never waiting on a channel (Phase 11 §2; §1C): the link
    // and description entries are the content stages that work before anything is
    // connected, so muting them would advertise the opposite of what they do.
    if (!hasChannel && !item.channelless) {
      return item.segment !== "channels" && item.segment !== "";
    }
    if (!item.requires) return false;
    return REACH_ORDER[projectReach] < REACH_ORDER[item.requires];
  }

  function isActive(item: NavItem): boolean {
    if (item.href === "/dashboard") return pathname === "/dashboard";
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
  }

  async function logout() {
    setLoggingOut(true);
    try {
      await api.post("/api/auth/logout");
    } finally {
      // Navigate regardless: the cookie is cleared server-side, and a failed
      // request should not trap the user in a session they asked to leave.
      router.push("/");
      router.refresh();
    }
  }

  return (
    <aside
      style={{
        width: layout.sidebarWidth,
        borderRight: `1px solid ${color.border}`,
        padding: "22px 14px",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        background: color.bg,
        height: "100%",
      }}
    >
      <div style={{ padding: "0 8px", marginBottom: 30 }}>
        <Link href="/dashboard" aria-label="Vidxir AI — dashboard">
          <VidxirLogo size={20} />
        </Link>
      </div>

      <nav
        aria-label="Studio stages"
        style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1 }}
      >
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={isActive(item)}
            pending={isPending(item)}
            onNavigate={onNavigate}
          />
        ))}

        <div
          style={{
            borderTop: `1px solid ${color.borderFaint}`,
            margin: "12px 0",
          }}
        />

        {isAdmin && <NavLink item={{segment:"admin",href:"/admin",label:"Administration",icon:"ShieldCheck"}} active={false} pending={false} onNavigate={onNavigate}/>}
        {SECONDARY_NAV.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={isActive(item)}
            pending={false}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      <div
        style={{
          borderTop: `1px solid ${color.borderFaint}`,
          paddingTop: 14,
          marginTop: 14,
        }}
      >
        <div
          style={{
            fontFamily: font.display,
            fontSize: 10.5,
            letterSpacing: 1.3,
            fontWeight: 600,
            color: color.textFaint,
            padding: "0 12px 10px",
          }}
        >
          PLAN · {planName.toUpperCase()}
        </div>

        <div style={{ padding: "0 4px 8px" }}>
          <ThemeToggle />
        </div>

        <button
          type="button"
          onClick={logout}
          disabled={loggingOut}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "10px 12px",
            borderRadius: radius.md,
            border: "none",
            background: "transparent",
            color: color.textDim,
            cursor: loggingOut ? "wait" : "pointer",
            fontSize: 13.5,
            width: "100%",
            fontFamily: font.body,
            textAlign: "left",
          }}
        >
          <LogOut size={16} aria-hidden="true" />
          {loggingOut ? "Logging out…" : "Log out"}
        </button>
      </div>
    </aside>
  );
}

function NavLink({
  item,
  active,
  pending,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  pending: boolean;
  onNavigate?: () => void;
}) {
  const Icon = ICONS[item.icon] ?? LayoutDashboard;

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        padding: "10px 12px",
        borderRadius: radius.md,
        textDecoration: "none",
        background: active ? color.accentBgSoft : "transparent",
        /**
         * The accent, not `onAccent`. `accentBgSoft` is a *tint* of the accent,
         * not a fill of it — near-white on the light theme — so white label text
         * would be invisible there. The accent reads against both tints.
         */
        color: active ? color.accent : color.textDim,
        fontSize: 13.5,
        fontWeight: active ? 600 : 500,
        borderLeft: `2px solid ${active ? color.accent : "transparent"}`,
      }}
    >
      <Icon size={16} color={active ? color.accent : color.textFaint} aria-hidden="true" />
      {item.label}
      {pending && (
        <span
          title="Earlier stages first"
          style={{
            marginLeft: "auto",
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: color.textFaint,
          }}
        />
      )}
    </Link>
  );
}

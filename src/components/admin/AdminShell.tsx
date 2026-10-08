"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  Archive,
  LifeBuoy,
  Mail,
  Users,
  ArrowUpRight,
  LogOut,
  ShieldCheck,
  KeyRound,
} from "lucide-react";
import { VidxirLogo } from "@/components/ui/VidxirLogo";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { api } from "@/services/api-client";
import { Badge, Button } from "./ui";
import { PasswordDialog } from "./PasswordDialog";
import "./admin.css";
const tabs = [
  {
    name: "Support",
    href: "/admin/support",
    icon: LifeBuoy,
    key: "unreadTickets",
  },
  { name: "Users", href: "/admin/users", icon: Users, key: "users" },
  { name: "Archive", href: "/admin/archive", icon: Archive, key: "archives" },
  { name: "Mail", href: "/admin/mail", icon: Mail, key: "unreadMail" },
];
export function AdminShell({
  children,
  email,
  onboarded,
}: {
  children: ReactNode;
  email: string;
  onboarded: boolean;
}) {
  const pathname = usePathname(),
    [counts, setCounts] = useState<Record<string, number>>({}),
    [changingPassword, setChangingPassword] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void api
        .get<Record<string, number>>("/api/admin/overview")
        .then((data) => {
          if (!cancelled) setCounts(data);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 20000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pathname]);
  return (
    <div className="vx-admin">
      <header className="vx-admin-top">
        <Link href="/admin" aria-label="Vidxir admin">
          <VidxirLogo size={20} />
        </Link>
        <div className="vx-admin-row">
          <span className="dim">{email}</span>
          <ThemeToggle />
          <Button onClick={() => setChangingPassword(true)}>
            <KeyRound size={14} />
            Password
          </Button>
          <Button
            onClick={() => {
              void api
                .post("/api/auth/logout")
                .finally(() => window.location.assign("/login"));
            }}
          >
            <LogOut size={14} />
            Sign out
          </Button>
        </div>
      </header>
      <div className="vx-admin-heading">
        <div>
          <div className="eyebrow">Vidxir workspace</div>
          <h1>Administration</h1>
          <p className="dim" style={{ margin: 0 }}>
            Keep customers supported, accounts organized, and conversations
            moving.
          </p>
        </div>
        <div className="vx-admin-row">
          <Badge tone="accent">
            <ShieldCheck size={11} /> Administrator
          </Badge>
          <Link
            className="vx-admin-button"
            href={onboarded ? "/dashboard" : "/onboarding"}
          >
            Open studio <ArrowUpRight size={14} />
          </Link>
        </div>
      </div>
      <nav className="vx-admin-nav" aria-label="Admin sections">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={pathname.startsWith(tab.href) ? "page" : undefined}
          >
            <tab.icon size={15} />
            {tab.name}
            {(counts[tab.key] ?? 0) > 0 && <Badge>{counts[tab.key]}</Badge>}
          </Link>
        ))}
      </nav>
      {children}
      {changingPassword && (
        <PasswordDialog onClose={() => setChangingPassword(false)} />
      )}
    </div>
  );
}

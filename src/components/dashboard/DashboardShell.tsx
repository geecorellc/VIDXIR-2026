"use client";

/**
 * Client half of the dashboard shell: the responsive sidebar behaviour.
 *
 * The prototype had a fixed 220px sidebar that simply overflowed on a phone.
 * §3 permits responsiveness improvements, so below 900px the same sidebar
 * becomes a drawer behind a header button — identical visual language, no
 * redesign.
 */
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { VerifyEmailBanner } from "@/components/dashboard/VerifyEmailBanner";
import { VidxirLogo } from "@/components/ui/VidxirLogo";
import { color, font } from "@/lib/design/tokens";

export interface DashboardShellProps {
  planName: string;
  hasChannel: boolean;
  projectReach: "none" | "idea" | "script" | "video";
  userName: string;
  emailVerified: boolean;
  children: React.ReactNode;
}

export function DashboardShell({
  planName,
  hasChannel,
  projectReach,
  userName,
  emailVerified,
  children,
}: DashboardShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const apply = () => {
      setNarrow(query.matches);
      if (!query.matches) setDrawerOpen(false);
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  // Escape closes the drawer, as a dialog should.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const sidebar = (
    <Sidebar
      planName={planName}
      hasChannel={hasChannel}
      projectReach={projectReach}
      onNavigate={narrow ? () => setDrawerOpen(false) : undefined}
    />
  );

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      {!narrow && sidebar}

      {narrow && drawerOpen && (
        <>
          <div
            onClick={() => setDrawerOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.6)",
              zIndex: 40,
            }}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Studio navigation"
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              bottom: 0,
              zIndex: 41,
              boxShadow: "0 18px 48px rgba(0,0,0,0.55)",
            }}
          >
            {sidebar}
          </div>
        </>
      )}

      <main
        className="vidxir-scroll"
        style={{
          flex: 1,
          minWidth: 0,
          overflowY: "auto",
          maxHeight: "100vh",
        }}
      >
        {narrow && (
          <header
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "14px 18px",
              borderBottom: `1px solid ${color.borderFaint}`,
              position: "sticky",
              top: 0,
              background: color.bg,
              zIndex: 20,
            }}
          >
            <VidxirLogo size={16} />
            <button
              type="button"
              onClick={() => setDrawerOpen((open) => !open)}
              aria-label={drawerOpen ? "Close navigation" : "Open navigation"}
              aria-expanded={drawerOpen}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                background: "transparent",
                border: `1px solid ${color.border}`,
                borderRadius: 8,
                padding: "8px 11px",
                color: color.textMuted,
                fontFamily: font.body,
                fontSize: 12.5,
                cursor: "pointer",
              }}
            >
              {drawerOpen ? <X size={15} /> : <Menu size={15} />}
              Menu
            </button>
          </header>
        )}

        <div style={{ padding: narrow ? "20px 18px 60px" : "26px 32px 60px" }}>
          {!emailVerified && <VerifyEmailBanner name={userName} />}
          {children}
        </div>
      </main>
    </div>
  );
}

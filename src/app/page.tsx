/**
 * Landing page — ported from the prototype's `Landing`.
 *
 * Preserved verbatim: the "ON AIR — YOUR CHANNEL, RUNNING ITSELF" pill, the
 * two-line h1, both CTAs, and the six numbered stage cards. The prototype's
 * `onStart("signup"|"login")` callbacks become real links, since routing is now
 * URL-based rather than a `stage` state variable.
 */
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Clapperboard,
  FileText,
  Image as ImageIcon,
  Radio,
  Rocket,
  TrendingUp,
} from "lucide-react";
import type { ComponentType } from "react";
import { VidxirLogo } from "@/components/ui/VidxirLogo";
import { color, display, font, radius } from "@/lib/design/tokens";
import { MARKETING_STAGES } from "@/lib/stages";

const ICONS: Record<string, ComponentType<{ size?: number; color?: string }>> = {
  TrendingUp,
  FileText,
  Clapperboard,
  ImageIcon,
  Rocket,
  BarChart3,
};

export default function LandingPage() {
  return (
    <div style={{ minHeight: "100vh", position: "relative", overflow: "hidden" }}>
      <div className="grain" aria-hidden="true" />

      <header
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "22px clamp(20px, 5vw, 56px)",
        }}
      >
        <VidxirLogo size={15} />
        <nav style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Link
            href="/login"
            style={{
              fontSize: 13.5,
              fontWeight: 500,
              color: color.textMuted,
              textDecoration: "none",
              padding: "9px 14px",
            }}
          >
            Log in
          </Link>
          <Link
            href="/signup"
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              color: color.onAccent,
              background: color.accent,
              textDecoration: "none",
              padding: "10px 16px",
              borderRadius: radius.md,
            }}
          >
            Start free
          </Link>
        </nav>
      </header>

      <main
        style={{
          position: "relative",
          padding: "clamp(40px, 8vh, 90px) clamp(20px, 5vw, 56px) 90px",
          maxWidth: 1180,
          margin: "0 auto",
        }}
      >
        {/* ON AIR pill */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 9,
            padding: "7px 14px",
            border: `1px solid ${color.border}`,
            borderRadius: radius.pill,
            background: color.card,
            marginBottom: 28,
          }}
        >
          <Radio size={13} color={color.accent} />
          <span
            style={{
              fontFamily: font.display,
              fontSize: 10.5,
              letterSpacing: 1.5,
              textTransform: "uppercase",
              color: color.textMuted,
            }}
          >
            On air — your channel, running itself
          </span>
        </div>

        <h1
          style={{
            ...display(0),
            fontSize: "clamp(38px, 7.5vw, 74px)",
            lineHeight: 1.03,
            maxWidth: 900,
            marginBottom: 22,
          }}
        >
          One studio.
          <br />
          <span style={{ color: color.accent }}>Every stage</span> of the video.
        </h1>

        <p
          style={{
            fontSize: "clamp(15px, 2vw, 17.5px)",
            lineHeight: 1.65,
            color: color.textDim,
            maxWidth: 620,
            margin: "0 0 34px",
          }}
        >
          Vidxir AI studies your niche, finds the opportunity your competitors
          missed, writes an original script, produces the video, and publishes it
          to YouTube on your schedule.
        </p>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 76 }}>
          <Link
            href="/signup"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 9,
              padding: "13px 22px",
              background: color.accent,
              color: color.onAccent,
              fontSize: 14.5,
              fontWeight: 600,
              borderRadius: radius.md,
              textDecoration: "none",
            }}
          >
            Start free <ArrowRight size={16} />
          </Link>
          <Link
            href="/login"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 9,
              padding: "13px 22px",
              background: "transparent",
              border: `1px solid ${color.borderLight}`,
              color: color.textBright,
              fontSize: 14.5,
              fontWeight: 600,
              borderRadius: radius.md,
              textDecoration: "none",
            }}
          >
            Log in
          </Link>
        </div>

        {/* Six numbered stage cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(268px, 1fr))",
            gap: 14,
          }}
        >
          {MARKETING_STAGES.map((stage) => {
            const Icon = ICONS[stage.icon] ?? TrendingUp;
            return (
              <div
                key={stage.n}
                style={{
                  background: color.card,
                  border: `1px solid ${color.border}`,
                  borderRadius: radius.lg,
                  padding: 20,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 14,
                  }}
                >
                  <span
                    style={{
                      fontFamily: font.display,
                      fontSize: 12,
                      letterSpacing: 1.6,
                      color: color.accent,
                      fontWeight: 600,
                    }}
                  >
                    {stage.n}
                  </span>
                  <Icon size={16} color={color.textFaint} />
                </div>
                <h2
                  style={{
                    ...display(16),
                    marginBottom: 9,
                  }}
                >
                  {stage.title}
                </h2>
                <p
                  style={{
                    margin: 0,
                    fontSize: 13,
                    lineHeight: 1.6,
                    color: color.textDim,
                  }}
                >
                  {stage.body}
                </p>
              </div>
            );
          })}
        </div>
      </main>

      <footer
        style={{
          position: "relative",
          borderTop: `1px solid ${color.borderFaint}`,
          padding: "24px clamp(20px, 5vw, 56px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <VidxirLogo size={12} still />
        <span style={{ fontSize: 12, color: color.textFaint }}>
          Vidxir AI creates original content. It does not repost other creators&apos;
          videos.
        </span>
      </footer>
    </div>
  );
}

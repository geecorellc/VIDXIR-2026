/**
 * Project status chip (§18, §37).
 *
 * One component owns the mapping from persisted status to label and colour, so
 * the sidebar, overview and publish screen can never disagree about whether a
 * project is "Rendering" or "Ready for review".
 */
import { color, font, radius } from "@/lib/design/tokens";
import {
  STATUS_LABEL,
  statusTone,
  type ProjectStatus,
} from "@/lib/projects/state-machine";

const TONE: Record<
  ReturnType<typeof statusTone>,
  { bg: string; border: string; fg: string }
> = {
  neutral: { bg: color.subtle, border: color.border, fg: color.textDim },
  working: { bg: color.infoBg, border: color.infoBorder, fg: color.info },
  action: { bg: color.warningBg, border: color.warningBorder, fg: color.warning },
  success: { bg: color.positiveBg, border: color.positiveBorder, fg: color.positive },
  danger: { bg: color.dangerBg, border: color.dangerBorder, fg: color.rose },
};

export function StatusChip({
  status,
  size = "md",
}: {
  status: ProjectStatus;
  size?: "sm" | "md";
}) {
  const palette = TONE[statusTone(status)];

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: radius.pill,
        padding: size === "sm" ? "3px 9px" : "4px 11px",
        fontFamily: font.display,
        fontSize: size === "sm" ? 10 : 10.5,
        letterSpacing: 1.1,
        textTransform: "uppercase",
        fontWeight: 500,
        color: palette.fg,
        whiteSpace: "nowrap",
      }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

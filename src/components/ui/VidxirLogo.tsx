/**
 * Vidxir wordmark — the pulsing radial-gradient dot plus "Vidxir".
 * Ported from the prototype's VidxirLogo (props: size, label).
 */
import { accentGradient, color, font } from "@/lib/design/tokens";

export interface VidxirLogoProps {
  /** Diameter of the dot in px; the wordmark scales from it. */
  size?: number;
  /** Show the "Vidxir" wordmark beside the dot. */
  label?: boolean;
  /** Disable the pulse — used in emails and static contexts. */
  still?: boolean;
}

export function VidxirLogo({ size = 14, label = true, still = false }: VidxirLogoProps) {
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: size * 0.62 }}
    >
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: accentGradient,
          boxShadow: `0 0 ${size}px ${color.accent}66`,
          animation: still ? undefined : "vidxir-pulse 2.4s ease-in-out infinite",
          flexShrink: 0,
        }}
      />
      {label && (
        <span
          style={{
            fontFamily: font.display,
            fontSize: size * 1.35,
            fontWeight: 600,
            letterSpacing: 1.2,
            textTransform: "uppercase",
            color: color.text,
          }}
        >
          Vidxir
        </span>
      )}
    </span>
  );
}

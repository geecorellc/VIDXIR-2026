"use client";

/**
 * Light/dark switch.
 *
 * Writes the choice to localStorage and toggles `.vx-dark` on <html>; the token
 * indirection in `GlobalStyle` does the rest, so nothing here knows a single
 * colour. `ThemeScript` reads the same key before paint on the next load.
 *
 * The initial state is read in an effect rather than during render, because the
 * class is applied by a pre-paint script that the server render knows nothing
 * about. Reading it during render would mismatch and hydrate wrong; until the
 * effect runs the button renders its icon-neutral state.
 */
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { color, font, radius } from "@/lib/design/tokens";
import { DARK_CLASS, THEME_STORAGE_KEY } from "./ThemeScript";

export interface ThemeToggleProps {
  /** Hide the text label, leaving only the icon — used in the collapsed rail. */
  compact?: boolean;
}

export function ThemeToggle({ compact = false }: ThemeToggleProps) {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    setDark(document.documentElement.classList.contains(DARK_CLASS));
  }, []);

  function toggle() {
    const next = !document.documentElement.classList.contains(DARK_CLASS);
    document.documentElement.classList.toggle(DARK_CLASS, next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next ? "dark" : "light");
    } catch {
      // Storage unavailable: the class still applied, it just will not persist.
    }
    setDark(next);
  }

  // `null` until the effect resolves the real theme — see the note above.
  const isDark = dark ?? false;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Light theme" : "Dark theme"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: compact ? "center" : "flex-start",
        gap: 10,
        width: "100%",
        background: "transparent",
        border: `1px solid ${color.border}`,
        borderRadius: radius.md,
        padding: compact ? "8px" : "8px 11px",
        color: color.textMuted,
        fontFamily: font.body,
        fontSize: 13,
        fontWeight: 500,
        cursor: "pointer",
      }}
    >
      {isDark ? <Sun size={17} /> : <Moon size={17} />}
      {!compact && (isDark ? "Light mode" : "Dark mode")}
    </button>
  );
}

"use client";

/**
 * Selectable card grid, used by onboarding and the plan picker.
 *
 * Visual language is the prototype's selected-card treatment: red border plus a
 * soft red glow, and a radio dot in the corner. Implemented as real radio inputs
 * inside a fieldset so keyboard and screen-reader users get grouped
 * arrow-key navigation instead of a pile of clickable divs.
 */
import { Check } from "lucide-react";
import { useId } from "react";
import { accentRing, color, font, radius } from "@/lib/design/tokens";

export interface ChoiceOption {
  value: string;
  label: string;
  hint?: string;
}

export interface ChoiceGridProps {
  legend: string;
  options: readonly ChoiceOption[];
  value: string;
  onChange: (value: string) => void;
  /** Minimum card width; drives how many fit per row. */
  minWidth?: number;
  /** Hide the legend visually while keeping it for assistive tech. */
  hideLegend?: boolean;
  error?: string;
}

export function ChoiceGrid({
  legend,
  options,
  value,
  onChange,
  minWidth = 210,
  hideLegend = false,
  error,
}: ChoiceGridProps) {
  const name = useId();

  return (
    <fieldset style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
      <legend
        style={
          hideLegend
            ? {
                position: "absolute",
                width: 1,
                height: 1,
                overflow: "hidden",
                clip: "rect(0 0 0 0)",
                whiteSpace: "nowrap",
              }
            : {
                fontFamily: font.display,
                fontSize: 10.5,
                letterSpacing: 1.3,
                textTransform: "uppercase",
                color: color.textFaint,
                fontWeight: 500,
                marginBottom: 10,
                padding: 0,
              }
        }
      >
        {legend}
      </legend>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(auto-fit, minmax(${minWidth}px, 1fr))`,
          gap: 10,
        }}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <label
              key={option.value}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                cursor: "pointer",
                background: selected ? color.accentBgSoft : color.card,
                border: `1px solid ${selected ? color.accent : color.border}`,
                boxShadow: selected
                  ? accentRing
                  : "none",
                borderRadius: radius.md,
                padding: "13px 14px",
                transition: "border-color 140ms ease, background 140ms ease",
              }}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
                style={{
                  appearance: "none",
                  width: 15,
                  height: 15,
                  flexShrink: 0,
                  marginTop: 1,
                  borderRadius: "50%",
                  border: `2px solid ${selected ? color.accent : color.controlBorder}`,
                  background: selected ? color.accent : "transparent",
                  cursor: "pointer",
                }}
              />
              <span style={{ minWidth: 0 }}>
                <span
                  style={{
                    display: "block",
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: selected ? color.text : color.textBright,
                    lineHeight: 1.35,
                  }}
                >
                  {option.label}
                </span>
                {option.hint && (
                  <span
                    style={{
                      display: "block",
                      marginTop: 4,
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: color.textDim,
                    }}
                  >
                    {option.hint}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>

      {error && (
        <span
          role="alert"
          style={{ display: "block", marginTop: 8, fontSize: 12, color: color.rose }}
        >
          {error}
        </span>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Multi-select variant — publish days
// ---------------------------------------------------------------------------

export interface TogglePillsProps {
  legend: string;
  options: readonly ChoiceOption[];
  values: string[];
  onChange: (values: string[]) => void;
  error?: string;
}

/** Checkbox pills, used for "which days do you publish". */
export function TogglePills({
  legend,
  options,
  values,
  onChange,
  error,
}: TogglePillsProps) {
  function toggle(value: string) {
    onChange(
      values.includes(value)
        ? values.filter((v) => v !== value)
        : [...values, value],
    );
  }

  return (
    <fieldset style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
      <legend
        style={{
          fontFamily: font.display,
          fontSize: 10.5,
          letterSpacing: 1.3,
          textTransform: "uppercase",
          color: color.textFaint,
          fontWeight: 500,
          marginBottom: 10,
          padding: 0,
        }}
      >
        {legend}
      </legend>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {options.map((option) => {
          const selected = values.includes(option.value);
          return (
            <label
              key={option.value}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                cursor: "pointer",
                padding: "8px 13px",
                borderRadius: radius.pill,
                background: selected ? color.accentBgSoft : color.inputBg,
                border: `1px solid ${selected ? color.accent : color.border}`,
                fontSize: 12.5,
                fontWeight: 600,
                color: selected ? color.text : color.textDim,
              }}
            >
              <input
                type="checkbox"
                checked={selected}
                onChange={() => toggle(option.value)}
                style={{
                  position: "absolute",
                  width: 1,
                  height: 1,
                  opacity: 0,
                  pointerEvents: "none",
                }}
              />
              {selected && <Check size={12} color={color.accent} aria-hidden="true" />}
              {option.label}
            </label>
          );
        })}
      </div>

      {error && (
        <span
          role="alert"
          style={{ display: "block", marginTop: 8, fontSize: 12, color: color.rose }}
        >
          {error}
        </span>
      )}
    </fieldset>
  );
}

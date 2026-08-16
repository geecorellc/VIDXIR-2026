"use client";

/**
 * Form field — uppercase label + optional leading icon + input.
 *
 * Ported from the prototype's `Field`, which accepted `value`/`onChange` but
 * whose callers in `Auth` never passed them, leaving the inputs unusable. This
 * version is a genuine controlled input, associates the label with the input via
 * htmlFor/id, and renders validation errors with aria-invalid + aria-describedby
 * so screen readers announce them.
 */
import type { ComponentType, InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";
import { color, font, radius } from "@/lib/design/tokens";

export interface FieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "style" | "id"> {
  label: string;
  /** A lucide icon component, e.g. Mail. */
  icon?: ComponentType<{ size?: number; color?: string }>;
  /** Validation message; renders in rose and marks the input invalid. */
  error?: string;
  /** Helper text shown under the input when there is no error. */
  hint?: ReactNode;
}

export function Field({
  label,
  icon: Icon,
  error,
  hint,
  ...inputProps
}: FieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <label
        htmlFor={id}
        style={{
          fontFamily: font.display,
          fontSize: 10.5,
          letterSpacing: 1.3,
          textTransform: "uppercase",
          color: color.textFaint,
          fontWeight: 500,
        }}
      >
        {label}
      </label>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          background: color.inputBg,
          border: `1px solid ${error ? "#5A2A28" : color.border}`,
          borderRadius: radius.md,
          padding: "0 12px",
        }}
      >
        {Icon && <Icon size={15} color={color.textFaint} />}
        <input
          {...inputProps}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            padding: "11px 0",
            color: color.text,
            fontFamily: font.body,
            fontSize: 14,
            minWidth: 0,
          }}
        />
      </div>

      {error ? (
        <span
          id={`${id}-error`}
          role="alert"
          style={{ fontSize: 12, color: color.rose }}
        >
          {error}
        </span>
      ) : hint ? (
        <span id={`${id}-hint`} style={{ fontSize: 12, color: color.textFaint }}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** Multi-line variant used by onboarding (target audience) and metadata editing. */
export interface TextAreaFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  error?: string;
  hint?: ReactNode;
  maxLength?: number;
}

export function TextAreaField({
  label,
  value,
  onChange,
  rows = 3,
  placeholder,
  error,
  hint,
  maxLength,
}: TextAreaFieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <label
        htmlFor={id}
        style={{
          fontFamily: font.display,
          fontSize: 10.5,
          letterSpacing: 1.3,
          textTransform: "uppercase",
          color: color.textFaint,
          fontWeight: 500,
        }}
      >
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        rows={rows}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        style={{
          background: color.inputBg,
          border: `1px solid ${error ? "#5A2A28" : color.border}`,
          borderRadius: radius.md,
          padding: "11px 12px",
          color: color.text,
          fontFamily: font.body,
          fontSize: 14,
          lineHeight: 1.55,
          outline: "none",
          resize: "vertical",
        }}
      />
      {error ? (
        <span id={`${id}-error`} role="alert" style={{ fontSize: 12, color: color.rose }}>
          {error}
        </span>
      ) : hint ? (
        <span id={`${id}-hint`} style={{ fontSize: 12, color: color.textFaint }}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** Select field, styled to match. Used heavily by §5 onboarding. */
export interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  error?: string;
  hint?: ReactNode;
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  error,
  hint,
}: SelectFieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <label
        htmlFor={id}
        style={{
          fontFamily: font.display,
          fontSize: 10.5,
          letterSpacing: 1.3,
          textTransform: "uppercase",
          color: color.textFaint,
          fontWeight: 500,
        }}
      >
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        style={{
          background: color.inputBg,
          border: `1px solid ${error ? "#5A2A28" : color.border}`,
          borderRadius: radius.md,
          padding: "11px 12px",
          color: color.text,
          fontFamily: font.body,
          fontSize: 14,
          outline: "none",
          appearance: "none",
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? (
        <span id={`${id}-error`} role="alert" style={{ fontSize: 12, color: color.rose }}>
          {error}
        </span>
      ) : hint ? (
        <span id={`${id}-hint`} style={{ fontSize: 12, color: color.textFaint }}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

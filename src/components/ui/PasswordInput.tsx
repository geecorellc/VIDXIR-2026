"use client";

import { useId, useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";
import { color } from "@/lib/design/tokens";

/** A password input with an independent, accessible visibility control. */
export function PasswordInput({
  id: providedId,
  style,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;

  return (
    <span
      style={{
        position: "relative",
        display: "flex",
        flex: 1,
        minWidth: 0,
        width: "100%",
      }}
    >
      <input
        {...props}
        id={id}
        type={visible ? "text" : "password"}
        style={{ ...style, width: "100%", paddingRight: 44 }}
      />
      <button
        type="button"
        aria-label={visible ? "Hide password" : "Show password"}
        aria-controls={id}
        aria-pressed={visible}
        disabled={props.disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setVisible((value) => !value)}
        style={{
          position: "absolute",
          right: 2,
          top: "50%",
          transform: "translateY(-50%)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 36,
          height: 36,
          padding: 0,
          border: "none",
          borderRadius: 5,
          background: "transparent",
          color: color.textMuted,
          cursor: props.disabled ? "default" : "pointer",
        }}
      >
        <Icon size={18} aria-hidden="true" />
      </button>
    </span>
  );
}

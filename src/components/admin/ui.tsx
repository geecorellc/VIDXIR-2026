"use client";
import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type ButtonHTMLAttributes,
} from "react";
import { X } from "lucide-react";
export const dateTime = (timestamp: number | null | undefined) =>
  timestamp ? new Date(timestamp).toLocaleString() : "—";
export function Button({
  children,
  tone = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: string }) {
  return (
    <button type="button" className={`vx-admin-button ${tone}`} {...props}>
      {children}
    </button>
  );
}
export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`vx-admin-badge ${tone}`}>{children}</span>;
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="vx-admin-empty">{children}</div>;
}
export function Alert({
  message,
  success = false,
}: {
  message: string;
  success?: boolean;
}) {
  return message ? (
    <div
      role={success ? "status" : "alert"}
      className={success ? "vx-admin-success" : "vx-admin-error"}
    >
      {message}
    </div>
  ) : null;
}
export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} aria-labelledby={id} onCancel={onClose}>
      <div className="vx-admin-row between" style={{ marginBottom: 20 }}>
        <h2 id={id}>{title}</h2>
        <Button onClick={onClose} aria-label="Close dialog">
          <X size={16} />
        </Button>
      </div>
      {children}
    </dialog>
  );
}
export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="vx-admin-panel vx-admin-stat">
      <span className="dim">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

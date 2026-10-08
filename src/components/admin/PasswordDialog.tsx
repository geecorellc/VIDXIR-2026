"use client";
import { useState } from "react";
import { api, messageOf } from "@/services/api-client";
import { Alert, Button, Dialog } from "./ui";
export function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState(""),
    [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Dialog
      title="Change your password"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (password !== confirmation) {
            setError("New passwords do not match.");
            return;
          }
          setBusy(true);
          setError("");
          try {
            await api.post("/api/account/password", {
              currentPassword: current,
              newPassword: password,
            });
            window.location.assign("/login");
          } catch (cause) {
            setError(messageOf(cause));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="dim">
          Changing your password signs you out of every session. Sign in again
          using your new password.
        </p>
        <label>
          Current password
          <input
            required
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label>
          New password
          <input
            required
            type="password"
            minLength={10}
            maxLength={200}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          Confirm new password
          <input
            required
            type="password"
            minLength={10}
            maxLength={200}
            autoComplete="new-password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </label>
        <Alert message={error} />
        <Button type="submit" tone="primary" disabled={busy}>
          {busy ? "Updating…" : "Change password"}
        </Button>
      </form>
    </Dialog>
  );
}

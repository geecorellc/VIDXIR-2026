"use client";
import { useMemo, useState } from "react";
import { api, messageOf } from "@/services/api-client";
import type { AdminUser } from "@/lib/admin/types";
import { Alert, Button, Dialog } from "./ui";
export function UserMailDialog({
  user,
  onClose,
}: {
  user: AdminUser;
  onClose: () => void;
}) {
  const [subject, setSubject] = useState(""),
    [heading, setHeading] = useState(""),
    [message, setMessage] = useState(""),
    [preview, setPreview] = useState<{ html: string; key: string } | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [sent, setSent] = useState(false);
  const key = JSON.stringify([subject, heading, message]);
  const requestId = useMemo(() => ({ key, id: crypto.randomUUID() }), [key]).id;
  const body = { subject, heading, message, requestId };
  async function loadPreview() {
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{ html: string }>(
        `/api/admin/users/${user.id}/email`,
        { ...body, preview: true },
      );
      setPreview({ ...result, key });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    setBusy(true);
    setError("");
    try {
      await api.post(`/api/admin/users/${user.id}/email`, body);
      setSent(true);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={`Email ${user.name}`} onClose={onClose}>
      <p className="dim">To {user.email}</p>
      {sent ? (
        <Alert success message="Email queued. Follow its delivery in Mail." />
      ) : (
        <>
          <label>
            Subject
            <input
              value={subject}
              maxLength={200}
              onChange={(e) => setSubject(e.target.value)}
            />
          </label>
          <label>
            Heading
            <input
              value={heading}
              maxLength={200}
              onChange={(e) => setHeading(e.target.value)}
            />
          </label>
          <label>
            Message
            <textarea
              value={message}
              maxLength={10000}
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>
          <Alert message={error} />
          <div className="vx-admin-row">
            <Button
              disabled={
                busy || !subject.trim() || !heading.trim() || !message.trim()
              }
              onClick={() => void loadPreview()}
            >
              Preview email
            </Button>
            <Button
              tone="primary"
              disabled={busy || preview?.key !== key}
              onClick={() => void send()}
            >
              {busy ? "Working…" : "Send email"}
            </Button>
          </div>
          {preview?.key === key && (
            <iframe
              title="Email preview"
              sandbox=""
              srcDoc={preview.html}
              className="vx-admin-preview"
              style={{ marginTop: 20 }}
            />
          )}
        </>
      )}
    </Dialog>
  );
}

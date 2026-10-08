"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Mail,
  Send,
  RefreshCw,
  Paperclip,
  ArrowLeft,
  ArrowRight,
  Eye,
} from "lucide-react";
import { api, messageOf } from "@/services/api-client";
import type {
  MailRow,
  MailDraft,
  Audience,
  DispatchProgress,
} from "@/lib/admin/types";
import { Alert, Badge, Button, Dialog, Empty, dateTime } from "./ui";
import { CampaignHistory } from "./CampaignHistory";
export function MailPanel() {
  const [reusedDraft, setReusedDraft] = useState<MailDraft | undefined>();
  const [mode, setMode] = useState("inbound"),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(1),
    [data, setData] = useState<{
      items: (MailRow & { latest_event?: string })[];
      total: number;
    }>({ items: [], total: 0 }),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [selected, setSelected] = useState<
    | (MailRow & {
        events: { id: string; type: string; occurred_at: number }[];
      })
    | null
  >(null);
  const load = useCallback(async () => {
    try {
      setData(
        await api.get(
          `/api/admin/mail?direction=${mode === "compose" ? "" : mode}&search=${encodeURIComponent(search)}&page=${page}`,
        ),
      );
      setError("");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, [mode, search, page]);
  useEffect(() => {
    if (mode === "compose" || mode === "campaigns") return;
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [mode, load]);
  useEffect(() => {
    if (mode === "compose" || mode === "campaigns") return;
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  }, [mode, load]);
  async function inspect(id: string) {
    try {
      setSelected(await api.get(`/api/admin/mail/${encodeURIComponent(id)}`));
      await load();
    } catch (e) {
      setError(messageOf(e));
    }
  }
  return (
    <section>
      <div className="vx-admin-heading" style={{ marginTop: 0 }}>
        <div>
          <h2>Mail</h2>
          <p className="dim" style={{ margin: 0 }}>
            Incoming messages, customer updates, and delivery activity.
          </p>
        </div>
        {(mode === "inbound" || mode === "outbound") && (
          <Button onClick={() => void load()}>
            <RefreshCw size={14} />
            Refresh
          </Button>
        )}
      </div>
      <div className="vx-admin-toolbar">
        {[
          { key: "inbound", name: "Inbox", icon: Mail },
          { key: "outbound", name: "Sent & queued", icon: Send },
          { key: "compose", name: "Compose", icon: Mail },
          { key: "campaigns", name: "Campaigns", icon: Send },
        ].map((tab) => (
          <Button
            key={tab.key}
            tone={mode === tab.key ? "primary" : ""}
            onClick={() => {
              setMode(tab.key);
              setPage(1);
            }}
          >
            <tab.icon size={14} />
            {tab.name}
          </Button>
        ))}
      </div>
      {mode === "compose" ? (
        <MailComposer initialDraft={reusedDraft} />
      ) : mode === "campaigns" ? (
        <CampaignHistory
          onCompose={(draft) => {
            setReusedDraft(draft);
            setMode("compose");
          }}
        />
      ) : (
        <>
          <div className="vx-admin-toolbar">
            <input
              aria-label="Search mail"
              placeholder="Search subject, sender, or recipient…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <Alert message={error} />
          <div className="vx-admin-panel">
            {loading ? (
              <Empty>Loading mail…</Empty>
            ) : !data.items.length ? (
              <Empty>
                <Mail size={28} />
                <p>
                  {mode === "inbound"
                    ? "Incoming emails will appear here when the Resend webhook is connected."
                    : "No outgoing mail yet."}
                </p>
              </Empty>
            ) : (
              <div className="vx-admin-table-wrap">
                <table className="vx-admin-table">
                  <thead>
                    <tr>
                      <th>{mode === "inbound" ? "From" : "To"}</th>
                      <th>Subject</th>
                      <th>Status</th>
                      <th>Date</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((row) => (
                      <tr key={row.id}>
                        <td style={{ maxWidth: 240, overflowWrap: "anywhere" }}>
                          {mode === "inbound"
                            ? row.from_address
                            : row.to_address}
                          {mode === "inbound" && !row.read_at && (
                            <div style={{ marginTop: 6 }}>
                              <Badge tone="accent">Unread</Badge>
                            </div>
                          )}
                        </td>
                        <td style={{ minWidth: 180 }}>
                          {row.subject}
                          {row.error && (
                            <p
                              style={{
                                color: "var(--vx-danger)",
                                fontSize: 11,
                              }}
                            >
                              {row.error}
                            </p>
                          )}
                        </td>
                        <td>
                          <Badge
                            tone={
                              row.status === "failed"
                                ? "warning"
                                : row.status === "sent"
                                  ? "positive"
                                  : ""
                            }
                          >
                            {row.latest_event?.replace("email.", "") ??
                              row.status}
                          </Badge>
                        </td>
                        <td className="dim">{dateTime(row.created_at)}</td>
                        <td>
                          <Button onClick={() => void inspect(row.id)}>
                            <Eye size={13} />
                            Read
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="vx-admin-pagination">
            <span className="dim">
              {data.total} messages · Page {page}
            </span>
            <div className="vx-admin-row">
              <Button
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
              >
                <ArrowLeft size={13} />
                Previous
              </Button>
              <Button
                disabled={page * 30 >= data.total}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
                <ArrowRight size={13} />
              </Button>
            </div>
          </div>
        </>
      )}
      {selected && (
        <Dialog title={selected.subject} onClose={() => setSelected(null)}>
          <div className="vx-admin-row">
            <Badge>{selected.direction}</Badge>
            <Badge tone="accent">{selected.status}</Badge>
          </div>
          <p className="dim">
            From: {selected.from_address}
            <br />
            To: {selected.to_address}
            <br />
            {dateTime(selected.created_at)}
          </p>
          <div className="vx-admin-message">
            <p style={{ margin: 0 }}>{selected.body}</p>
          </div>
          {selected.error && <Alert message={selected.error} />}
          {(
            JSON.parse(selected.attachments) as {
              id: string;
              filename: string;
            }[]
          ).length > 0 && (
            <div className="vx-admin-section">
              <h3>Attachments</h3>
              <div className="vx-admin-row">
                {(
                  JSON.parse(selected.attachments) as {
                    id: string;
                    filename: string;
                  }[]
                ).map((a) => (
                  <a
                    key={a.id}
                    className="vx-admin-button"
                    href={`/api/admin/mail/${encodeURIComponent(selected.id)}/attachment?id=${encodeURIComponent(a.id)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Paperclip size={13} />
                    {a.filename}
                  </a>
                ))}
              </div>
            </div>
          )}
          {selected.ticket_id && (
            <div className="vx-admin-section">
              <Link
                className="vx-admin-button"
                href={`/admin/support?ticket=${encodeURIComponent(selected.ticket_id)}`}
                onClick={() => setSelected(null)}
              >
                Open support conversation
              </Link>
            </div>
          )}
          {selected.events.length > 0 && (
            <div className="vx-admin-section">
              <h3>Delivery activity</h3>
              {selected.events.map((event) => (
                <p className="dim" key={event.id}>
                  {event.type.replace("email.", "")} ·{" "}
                  {dateTime(event.occurred_at)}
                </p>
              ))}
            </div>
          )}
        </Dialog>
      )}
    </section>
  );
}
function MailComposer({ initialDraft }: { initialDraft?: MailDraft }) {
  const [subject, setSubject] = useState(initialDraft?.subject ?? ""),
    [heading, setHeading] = useState(initialDraft?.heading ?? ""),
    [message, setMessage] = useState(initialDraft?.message ?? ""),
    [mode, setMode] = useState(
      initialDraft?.audience.specificEmails ? "emails" : "filters",
    ),
    [emails, setEmails] = useState(
      initialDraft?.audience.specificEmails?.join(", ") ?? "",
    );
  const [audience, setAudience] = useState<Audience>({
    ...initialDraft?.audience,
    specificEmails: undefined,
    tiers: initialDraft?.audience.tiers ?? [],
    verification: initialDraft?.audience.verification ?? "any",
  });

  const [preview, setPreview] = useState<{
      html: string;
      fingerprint: string;
      recipientCount: number;
      key: string;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false),
    [delivery, setDelivery] = useState<DispatchProgress | null>(null);
  const [dispatchId, setDispatchId] = useState(() => crypto.randomUUID());
  const key = JSON.stringify([
    subject,
    heading,
    message,
    audience,
    mode,
    emails,
  ]);
  const draft = useMemo<MailDraft>(
    () => ({
      subject,
      heading,
      message,
      audience:
        mode === "emails"
          ? {
              ...audience,
              specificEmails: [
                ...new Set(
                  emails
                    .split(/[,\n]/)
                    .map((e) => e.trim().toLowerCase())
                    .filter(Boolean),
                ),
              ],
            }
          : audience,
    }),
    [subject, heading, message, audience, mode, emails],
  );
  const active = delivery && delivery.status !== "completed";
  useEffect(() => {
    if (!delivery || delivery.status === "completed") return;
    let cancelled = false;
    const timer = setInterval(() => {
      void api
        .get<DispatchProgress>(`/api/admin/mail/dispatches/${delivery.id}`)
        .then((p) => {
          if (!cancelled) setDelivery(p);
        })
        .catch((e) => {
          if (!cancelled) setError(messageOf(e));
        });
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [delivery]);
  async function loadPreview() {
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{
        html: string;
        fingerprint: string;
        recipientCount: number;
      }>("/api/admin/mail/preview", draft);
      setPreview({ ...result, key });
      setDispatchId(crypto.randomUUID());
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if (!preview || preview.key !== key) return;
    setBusy(true);
    setError("");
    try {
      setDelivery(
        await api.post<DispatchProgress>("/api/admin/mail/send", {
          ...draft,
          dispatchId,
          fingerprint: preview.fingerprint,
        }),
      );
      setConfirm(false);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <Alert message={error} />
      <div
        className="vx-admin-split"
        style={{
          gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,340px),1fr))",
        }}
      >
        <div className="vx-admin-panel">
          <h3>Email content</h3>
          <p className="dim">
            A branded email, sent individually to each selected account.
          </p>
          <fieldset
            disabled={busy || Boolean(active)}
            style={{ border: 0, padding: 0, margin: 0 }}
          >
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
                style={{ minHeight: 200 }}
              />
            </label>
            <h3>Audience</h3>
            <label>
              Choose recipients
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="filters">Filter customer accounts</option>
                <option value="emails">Specific customer emails</option>
              </select>
            </label>
            {mode === "emails" ? (
              <label>
                Email addresses
                <textarea
                  value={emails}
                  onChange={(e) => setEmails(e.target.value)}
                  placeholder="customer@example.com, another@example.com"
                />
                <span className="dim">
                  Up to 500 addresses. Only existing, active customer accounts
                  are included.
                </span>
              </label>
            ) : (
              <>
                <label>
                  Plan
                  <select
                    value={audience.tiers[0] ?? ""}
                    onChange={(e) =>
                      setAudience((a) => ({
                        ...a,
                        tiers: e.target.value ? [e.target.value] : [],
                      }))
                    }
                  >
                    <option value="">All plans</option>
                    {["starter", "studio", "scale"].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Email verification
                  <select
                    value={audience.verification}
                    onChange={(e) =>
                      setAudience((a) => ({
                        ...a,
                        verification: e.target
                          .value as Audience["verification"],
                      }))
                    }
                  >
                    <option value="any">Any</option>
                    <option value="verified">Verified</option>
                    <option value="unverified">Unverified</option>
                  </select>
                </label>
                <div className="vx-admin-grid">
                  <label>
                    Joined from
                    <input
                      type="date"
                      value={audience.joinedFrom ?? ""}
                      onChange={(e) =>
                        setAudience((a) => ({
                          ...a,
                          joinedFrom: e.target.value || undefined,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Joined through
                    <input
                      type="date"
                      value={audience.joinedTo ?? ""}
                      onChange={(e) =>
                        setAudience((a) => ({
                          ...a,
                          joinedTo: e.target.value || undefined,
                        }))
                      }
                    />
                  </label>
                </div>
              </>
            )}
          </fieldset>
          <p className="dim">
            Administrators and suspended accounts are excluded.
          </p>
          <div className="vx-admin-row">
            <Button
              disabled={
                busy ||
                Boolean(active) ||
                !subject.trim() ||
                !heading.trim() ||
                !message.trim()
              }
              onClick={() => void loadPreview()}
            >
              <Eye size={14} />
              Preview
            </Button>
            <Button
              tone="primary"
              disabled={
                busy ||
                Boolean(active) ||
                preview?.key !== key ||
                !preview.recipientCount
              }
              onClick={() => setConfirm(true)}
            >
              <Send size={14} />
              Send email
            </Button>
          </div>
        </div>
        <div className="vx-admin-panel">
          <h3>Preview & delivery</h3>
          {preview?.key === key ? (
            <>
              <p className="dim">
                {preview.recipientCount} matching customer accounts
              </p>
              <iframe
                title="Campaign preview"
                sandbox=""
                className="vx-admin-preview"
                srcDoc={preview.html}
              />
            </>
          ) : (
            <Empty>
              <Mail size={28} />
              <p>Preview the current content and audience before sending.</p>
            </Empty>
          )}
          {delivery && (
            <div className="vx-admin-section">
              <div className="vx-admin-row between">
                <h3>Delivery progress</h3>
                <Badge
                  tone={delivery.status === "completed" ? "positive" : "accent"}
                >
                  {delivery.status}
                </Badge>
              </div>
              <progress
                style={{ width: "100%", accentColor: "var(--vx-accent)" }}
                max={Math.max(1, delivery.recipientCount)}
                value={delivery.processedCount}
              />
              <p className="dim">
                {delivery.processedCount} / {delivery.recipientCount} processed
                · {delivery.sentCount} sent · {delivery.failedCount} failed
              </p>
              {delivery.failedEmails.length > 0 && (
                <>
                  <p className="dim" style={{ overflowWrap: "anywhere" }}>
                    {delivery.failedEmails.join(", ")}
                  </p>
                  <Button
                    onClick={() => {
                      setMode("emails");
                      setEmails(delivery.failedEmails.join(", "));
                      setDelivery(null);
                      setPreview(null);
                    }}
                  >
                    Target failed recipients
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {confirm && preview && (
        <Dialog
          title="Send this email?"
          onClose={() => {
            if (!busy) setConfirm(false);
          }}
        >
          <p>
            This will send <strong>{subject}</strong> to{" "}
            <strong>{preview.recipientCount}</strong> customer accounts.
          </p>
          <p className="dim">
            Delivery runs in the background. You can follow progress here or
            inspect individual messages in Sent & queued.
          </p>
          <div className="vx-admin-row">
            <Button disabled={busy} onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button disabled={busy} tone="primary" onClick={() => void send()}>
              {busy ? "Queueing…" : "Confirm send"}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LifeBuoy,
  RefreshCw,
  Send,
  Plus,
  Mail,
  CheckCheck,
} from "lucide-react";
import { api, messageOf } from "@/services/api-client";
import type { Ticket, TicketThread, TicketStatus } from "@/lib/admin/types";
import { Alert, Badge, Button, Dialog, Empty, dateTime } from "./ui";
import "./admin.css";
export function SupportInbox({
  admin = false,
  guest = false,
}: {
  admin?: boolean;
  guest?: boolean;
}) {
  const [items, setItems] = useState<Ticket[]>([]),
    [thread, setThread] = useState<TicketThread | null>(null);
  const [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [message, setMessage] = useState(""),
    [closeTicket, setClose] = useState(false),
    [busy, setBusy] = useState(false),
    [creating, setCreating] = useState(false);
  const replyKey = JSON.stringify([message, closeTicket, thread?.id]);
  const replyId = useMemo(
    () => ({ key: replyKey, id: crypto.randomUUID() }),
    [replyKey],
  ).id;
  const endpoint = admin ? "/api/admin/support" : "/api/support";
  const refresh = useCallback(async () => {
    if (guest) {
      setLoading(false);
      return;
    }
    try {
      const result = await api.get<{ items: Ticket[] }>(
        `${endpoint}?search=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}`,
      );
      setItems(result.items);
      setError("");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, [endpoint, guest, search, status]);
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 250);
    return () => clearTimeout(timer);
  }, [refresh]);
  useEffect(() => {
    if (admin) {
      const selected = new URLSearchParams(window.location.search).get(
        "ticket",
      );
      if (selected)
        void api
          .get<TicketThread>(`${endpoint}/${encodeURIComponent(selected)}`)
          .then(setThread)
          .catch((e) => setError(messageOf(e)));
    }
  }, [admin, endpoint]);
  useEffect(() => {
    if (guest) return;
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, [guest, refresh]);
  async function inspect(id: string) {
    setBusy(true);
    setError("");
    try {
      setThread(
        await api.get<TicketThread>(`${endpoint}/${encodeURIComponent(id)}`),
      );
      setItems((current) =>
        current.map((t) => (t.id === id ? { ...t, unread: 0 } : t)),
      );
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  async function changeStatus(value: TicketStatus) {
    if (!thread) return;
    setBusy(true);
    try {
      setThread(
        await api.patch<TicketThread>(
          `${endpoint}/${encodeURIComponent(thread.id)}`,
          { status: value },
        ),
      );
      await refresh();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  async function reply() {
    if (!thread || !message.trim()) return;
    setBusy(true);
    setError("");
    try {
      setThread(
        await api.post<TicketThread>(
          `${endpoint}/${encodeURIComponent(thread.id)}`,
          { message, closeTicket, requestId: replyId },
        ),
      );
      setMessage("");
      setClose(false);
      await refresh();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <div className="vx-admin-heading" style={{ marginTop: 0 }}>
        <div>
          <h2>{admin ? "Support inbox" : "How can we help?"}</h2>
          <p className="dim" style={{ margin: 0 }}>
            {admin
              ? "Web requests and email replies, together in one conversation."
              : "Open a request and follow the conversation here or by email."}
          </p>
        </div>
        <div className="vx-admin-row">
          {!admin && (
            <Button tone="primary" onClick={() => setCreating(true)}>
              <Plus size={14} />
              New request
            </Button>
          )}
          {!guest && (
            <Button onClick={() => void refresh()}>
              <RefreshCw size={14} />
              Refresh
            </Button>
          )}
        </div>
      </div>
      <Alert message={error} />
      {guest ? (
        <div className="vx-admin-panel">
          <Empty>
            <LifeBuoy size={28} />
            <p>Tell us what you need help with. We’ll reply to your email.</p>
            <Button tone="primary" onClick={() => setCreating(true)}>
              Contact support
            </Button>
          </Empty>
        </div>
      ) : (
        <>
          {admin && (
            <div className="vx-admin-toolbar">
              <input
                aria-label="Search support tickets"
                placeholder="Search subject or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select
                aria-label="Filter ticket status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">All statuses</option>
                {["Open", "In progress", "Resolved"].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
          )}
          <div className="vx-admin-split">
            <div className="vx-admin-list" aria-label="Support tickets">
              {loading ? (
                <Empty>Loading tickets…</Empty>
              ) : items.length === 0 ? (
                <div className="vx-admin-panel">
                  <Empty>No support requests yet.</Empty>
                </div>
              ) : (
                items.map((ticket) => (
                  <button
                    key={ticket.id}
                    className={`vx-admin-ticket ${thread?.id === ticket.id ? "selected" : ""}`}
                    onClick={() => void inspect(ticket.id)}
                    disabled={busy}
                  >
                    <div
                      className="vx-admin-row between"
                      style={{ marginBottom: 12 }}
                    >
                      <Badge
                        tone={
                          ticket.status === "Resolved" ? "positive" : "accent"
                        }
                      >
                        {ticket.status}
                      </Badge>
                      {admin && ticket.unread === 1 && (
                        <Badge tone="warning">Unread</Badge>
                      )}
                    </div>
                    <span className="subject">{ticket.subject}</span>
                    <div className="dim">
                      {admin ? ticket.requester_email : ticket.category}
                    </div>
                    <div
                      className="dim"
                      style={{ fontSize: 11, marginTop: 10 }}
                    >
                      {dateTime(ticket.updated_at)}
                    </div>
                  </button>
                ))
              )}
            </div>
            <div className="vx-admin-panel">
              {!thread ? (
                <Empty>
                  <Mail size={28} />
                  <p>Select a request to read its conversation.</p>
                </Empty>
              ) : (
                <>
                  <div className="vx-admin-row between">
                    <h3>{thread.subject}</h3>
                    <Badge
                      tone={
                        thread.status === "Resolved" ? "positive" : "accent"
                      }
                    >
                      {thread.status}
                    </Badge>
                  </div>
                  <p className="dim" style={{ margin: "4px 0" }}>
                    {thread.requester_name} · {thread.requester_email}
                  </p>
                  <div className="vx-admin-row">
                    <Badge>{thread.category}</Badge>
                    {thread.tier && <Badge>{thread.tier} plan</Badge>}
                    <span className="dim" style={{ fontSize: 10 }}>
                      #{thread.id}
                    </span>
                  </div>
                  <div className="vx-admin-thread">
                    {thread.messages.map((m) => (
                      <article
                        key={m.id}
                        className={`vx-admin-message ${m.author_type === "admin" ? "admin" : ""}`}
                      >
                        <div className="vx-admin-row between">
                          <strong style={{ fontSize: 12 }}>
                            {m.author_name}
                          </strong>
                          <span className="dim" style={{ fontSize: 10 }}>
                            {m.channel} · {dateTime(m.created_at)}
                          </span>
                        </div>
                        <p>{m.body}</p>
                      </article>
                    ))}
                  </div>
                  {admin ? (
                    <div className="vx-admin-section">
                      <label>
                        Reply to {thread.requester_email}
                        <textarea
                          value={message}
                          onChange={(e) => setMessage(e.target.value)}
                          maxLength={10000}
                          placeholder="Write a helpful reply…"
                        />
                      </label>
                      <div className="vx-admin-row between">
                        <label
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            margin: 0,
                          }}
                        >
                          <input
                            type="checkbox"
                            style={{ width: "auto" }}
                            checked={closeTicket}
                            onChange={(e) => setClose(e.target.checked)}
                          />
                          Resolve after replying
                        </label>
                        <Button
                          tone="primary"
                          disabled={busy || !message.trim()}
                          onClick={() => void reply()}
                        >
                          <Send size={14} />
                          {busy ? "Saving…" : "Send reply"}
                        </Button>
                      </div>
                      <div className="vx-admin-row" style={{ marginTop: 14 }}>
                        <span className="dim">Status</span>
                        <select
                          aria-label="Ticket status"
                          disabled={busy}
                          value={thread.status}
                          onChange={(e) =>
                            void changeStatus(e.target.value as TicketStatus)
                          }
                        >
                          {["Open", "In progress", "Resolved"].map((s) => (
                            <option key={s}>{s}</option>
                          ))}
                        </select>
                        <CheckCheck size={14} />
                      </div>
                    </div>
                  ) : (
                    <p className="dim">
                      Reply to the ticket email to add a message to this
                      conversation.{" "}
                      <Button onClick={() => void inspect(thread.id)}>
                        Refresh conversation
                      </Button>
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
      {creating && (
        <NewTicket
          guest={guest}
          onClose={() => setCreating(false)}
          onCreated={async (ticket) => {
            setCreating(false);
            setThread(ticket);
            await refresh();
          }}
        />
      )}
    </section>
  );
}
function NewTicket({
  guest,
  onClose,
  onCreated,
}: {
  guest: boolean;
  onClose: () => void;
  onCreated: (ticket: TicketThread) => void;
}) {
  const [email, setEmail] = useState(""),
    [name, setName] = useState(""),
    [subject, setSubject] = useState(""),
    [category, setCategory] = useState("General"),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Dialog title="New support request" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            onCreated(
              await api.post<TicketThread>("/api/support", {
                email: guest ? email : undefined,
                name: guest ? name : undefined,
                subject,
                category,
                message,
              }),
            );
          } catch (cause) {
            setError(messageOf(cause));
          } finally {
            setBusy(false);
          }
        }}
      >
        {guest && (
          <>
            <label>
              Your name
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
              />
            </label>
            <label>
              Email
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
          </>
        )}
        <label>
          Subject
          <input
            required
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={200}
          />
        </label>
        <label>
          Category
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {[
              "General",
              "Video generation",
              "YouTube & publishing",
              "Billing",
              "Account access",
            ].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          How can we help?
          <textarea
            required
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={5000}
          />
        </label>
        <Alert message={error} />
        <Button type="submit" tone="primary" disabled={busy}>
          {busy ? "Opening request…" : "Open request"}
        </Button>
      </form>
    </Dialog>
  );
}

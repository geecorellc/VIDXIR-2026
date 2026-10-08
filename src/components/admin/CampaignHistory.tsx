"use client";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Eye, RefreshCw } from "lucide-react";
import { api, messageOf } from "@/services/api-client";
import type {
  DispatchDetail,
  DispatchSummary,
  MailDraft,
} from "@/lib/admin/types";
import { Alert, Badge, Button, Dialog, Empty, dateTime } from "./ui";

export function CampaignHistory({
  onCompose,
}: {
  onCompose: (draft: MailDraft) => void;
}) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: DispatchSummary[]; total: number }>(
    { items: [], total: 0 },
  );
  const [selected, setSelected] = useState<DispatchDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      setData(await api.get(`/api/admin/mail/dispatches?page=${page}`));
      setError("");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, [page]);
  useEffect(() => {
    setLoading(true);
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  }, [load]);
  const selectedId = selected?.id;
  const active = selected && selected.status !== "completed";
  useEffect(() => {
    if (!selectedId || !active) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void api
        .get<DispatchDetail>(`/api/admin/mail/dispatches/${selectedId}`)
        .then((detail) => {
          if (!cancelled) setSelected(detail);
        })
        .catch((e) => {
          if (!cancelled) setError(messageOf(e));
        });
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selectedId, active]);
  async function inspect(id: string) {
    try {
      setSelected(await api.get(`/api/admin/mail/dispatches/${id}`));
      setError("");
    } catch (e) {
      setError(messageOf(e));
    }
  }
  return (
    <>
      <div className="vx-admin-heading">
        <div>
          <h3>Campaign history</h3>
          <p className="dim">
            Delivery keeps running when you leave this page. Open a campaign to
            follow its progress.
          </p>
        </div>
        <Button onClick={() => void load()}>
          <RefreshCw size={14} />
          Refresh
        </Button>
      </div>
      <Alert message={error} />
      <div className="vx-admin-panel">
        {loading ? (
          <Empty>Loading campaigns…</Empty>
        ) : !data.items.length ? (
          <Empty>No campaigns have been sent yet.</Empty>
        ) : (
          <div className="vx-admin-table-wrap">
            <table className="vx-admin-table">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Delivery</th>
                  <th>Sent</th>
                  <th>Failed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.subject}</strong>
                      <p className="dim">
                        {dateTime(item.created_at)} · {item.actor_name}
                      </p>
                    </td>
                    <td>
                      <Badge
                        tone={
                          item.status === "completed" ? "positive" : "accent"
                        }
                      >
                        {item.status}
                      </Badge>
                      <p className="dim">
                        {item.processedCount} / {item.recipientCount} processed
                      </p>
                    </td>
                    <td>{item.sentCount}</td>
                    <td>{item.failedCount}</td>
                    <td>
                      <Button
                        onClick={() => void inspect(item.id)}
                        aria-label={`Inspect campaign ${item.subject}`}
                      >
                        <Eye size={14} />
                        Inspect
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="vx-admin-row between" style={{ marginTop: 16 }}>
        <span className="dim">
          {data.total} campaigns · Page {page} of{" "}
          {Math.max(1, Math.ceil(data.total / 20))}
        </span>
        <div className="vx-admin-row">
          <Button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            <ArrowLeft size={14} />
            Previous
          </Button>
          <Button
            disabled={page * 20 >= data.total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
            <ArrowRight size={14} />
          </Button>
        </div>
      </div>
      {selected && (
        <Dialog
          title={selected.draft.subject}
          onClose={() => setSelected(null)}
        >
          <p className="dim">
            {dateTime(selected.created_at)} · {selected.actor_name}
          </p>
          <Badge tone={selected.status === "completed" ? "positive" : "accent"}>
            {selected.status}
          </Badge>
          <progress
            aria-label="Campaign delivery progress"
            style={{
              width: "100%",
              marginTop: 16,
              accentColor: "var(--vx-accent)",
            }}
            max={Math.max(1, selected.recipientCount)}
            value={selected.processedCount}
          />
          <p className="dim">
            {selected.processedCount} / {selected.recipientCount} processed ·{" "}
            {selected.sentCount} sent · {selected.failedCount} failed
          </p>
          <h3>Original email</h3>
          <h4>{selected.draft.heading}</h4>
          <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {selected.draft.message}
          </p>
          <Button onClick={() => onCompose(selected.draft)}>
            Reuse content
          </Button>
          {selected.failedEmails.length > 0 && (
            <div className="vx-admin-section">
              <h3>Failed recipients</h3>
              <p className="dim" style={{ overflowWrap: "anywhere" }}>
                {selected.failedEmails.join(", ")}
              </p>
              <Button
                onClick={() =>
                  onCompose({
                    ...selected.draft,
                    audience: {
                      tiers: [],
                      verification: "any",
                      specificEmails: selected.failedEmails,
                    },
                  })
                }
              >
                Target failed recipients
              </Button>
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}

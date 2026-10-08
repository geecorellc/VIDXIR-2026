"use client";
import { useEffect, useState } from "react";
import { Archive as ArchiveIcon, Eye, RefreshCw } from "lucide-react";
import { api, messageOf } from "@/services/api-client";
import type { Archive } from "@/lib/admin/types";
import { Alert, Badge, Button, Dialog, Empty, dateTime } from "./ui";
export function ArchivePanel() {
  const [items, setItems] = useState<Archive[]>([]),
    [selected, setSelected] = useState<Archive | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true);
    try {
      setItems(
        (await api.get<{ items: Archive[] }>("/api/admin/archive")).items,
      );
      setError("");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function inspect(id: string) {
    try {
      setSelected(await api.get<Archive>(`/api/admin/archive/${id}`));
    } catch (e) {
      setError(messageOf(e));
    }
  }
  return (
    <section>
      <div className="vx-admin-heading" style={{ marginTop: 0 }}>
        <div>
          <h2>Deleted account archive</h2>
          <p className="dim" style={{ margin: 0 }}>
            Read-only records for inspection. Deleted accounts cannot be
            restored.
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
          <Empty>Loading archive…</Empty>
        ) : items.length === 0 ? (
          <Empty>
            <ArchiveIcon size={28} />
            <p>No deleted accounts have been archived.</p>
          </Empty>
        ) : (
          <div className="vx-admin-table-wrap">
            <table className="vx-admin-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Deleted</th>
                  <th>Source</th>
                  <th>Media retention</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.name}</strong>
                      <p className="dim">{item.email}</p>
                    </td>
                    <td>{dateTime(item.created_at)}</td>
                    <td>
                      <Badge>{item.source}</Badge>
                    </td>
                    <td>
                      {item.media_purged_at ? (
                        <Badge tone="positive">Purged</Badge>
                      ) : (
                        <span className="dim">
                          Until{" "}
                          {new Date(
                            item.media_delete_after,
                          ).toLocaleDateString()}
                        </span>
                      )}
                    </td>
                    <td>
                      <Button onClick={() => void inspect(item.id)}>
                        <Eye size={13} />
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
      {selected && (
        <Dialog title="Archived account" onClose={() => setSelected(null)}>
          <h3>{selected.name}</h3>
          <p className="dim">{selected.email}</p>
          <div className="vx-admin-row">
            <Badge>{selected.source}</Badge>
            <Badge>Deleted {dateTime(selected.created_at)}</Badge>
          </div>
          <p className="dim">
            Reason: {selected.reason}
            <br />
            Deleted by: {selected.actor_id}
            <br />
            Media purge:{" "}
            {dateTime(selected.media_purged_at ?? selected.media_delete_after)}
          </p>
          <h3>Sanitized account snapshot</h3>
          <p className="dim">
            Passwords, sessions, recovery tokens, and provider credentials are
            excluded.
          </p>
          <pre>{JSON.stringify(selected.snapshot, null, 2)}</pre>
        </Dialog>
      )}
    </section>
  );
}

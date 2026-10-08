"use client";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Plus,
  RefreshCw,
  Mail,
  ShieldCheck,
  Trash2,
  CheckCircle2,
  UserRound,
  Coins,
} from "lucide-react";
import { api, messageOf } from "@/services/api-client";
import type { AdminUser, UserDetail } from "@/lib/admin/types";
import { Alert, Badge, Button, Dialog, Empty, dateTime } from "./ui";
import { UserMailDialog } from "./UserMailDialog";
export function UsersPanel() {
  const [data, setData] = useState<{ items: AdminUser[]; total: number }>({
      items: [],
      total: 0,
    }),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(1),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [selected, setSelected] = useState<UserDetail | null>(null),
    [creating, setCreating] = useState(false),
    [action, setAction] = useState<string | null>(null),
    [mail, setMail] = useState(false),
    [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await api.get(
          `/api/admin/users?search=${encodeURIComponent(search)}&page=${page}&limit=20`,
        ),
      );
      setError("");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, [search, page]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);
  async function inspect(id: string) {
    setError("");
    try {
      setSelected(await api.get<UserDetail>(`/api/admin/users/${id}`));
    } catch (e) {
      setError(messageOf(e));
    }
  }
  async function changed(detail?: UserDetail) {
    setAction(null);
    if (detail) setSelected(detail);
    else setSelected(null);
    setNotice("Account updated.");
    await load();
  }
  return (
    <section>
      <div className="vx-admin-heading" style={{ marginTop: 0 }}>
        <div>
          <h2>Users</h2>
          <p className="dim" style={{ margin: 0 }}>
            Manage access, account status, and creation credits.
          </p>
        </div>
        <Button tone="primary" onClick={() => setCreating(true)}>
          <Plus size={14} />
          Create user
        </Button>
      </div>
      <div className="vx-admin-toolbar">
        <input
          aria-label="Search users"
          placeholder="Search users by name or email…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <Button onClick={() => void load()}>
          <RefreshCw size={14} />
          Refresh
        </Button>
      </div>
      <Alert message={error} />
      <Alert message={notice} success />
      {loading ? (
        <Empty>Loading accounts…</Empty>
      ) : data.items.length === 0 ? (
        <div className="vx-admin-panel">
          <Empty>
            <UserRound size={26} />
            <p>No accounts match your search.</p>
          </Empty>
        </div>
      ) : (
        <div className="vx-admin-grid">
          {data.items.map((user) => (
            <button
              className="vx-admin-person"
              key={user.id}
              onClick={() => void inspect(user.id)}
            >
              <div className="vx-admin-row between">
                <div className="vx-admin-initial">
                  {user.name.slice(0, 2).toUpperCase()}
                </div>
                <Badge
                  tone={
                    user.role === "admin"
                      ? "accent"
                      : user.suspended_at
                        ? "warning"
                        : ""
                  }
                >
                  {user.role === "admin"
                    ? "Administrator"
                    : user.suspended_at
                      ? "Suspended"
                      : user.tier}
                </Badge>
              </div>
              <div>
                <strong style={{ fontSize: 14 }}>{user.name}</strong>
                <div
                  className="dim"
                  style={{ marginTop: 5, overflowWrap: "anywhere" }}
                >
                  {user.email}
                </div>
              </div>
              <div className="vx-admin-row between">
                <span className="dim" style={{ fontSize: 11 }}>
                  Joined {new Date(user.created_at).toLocaleDateString()}
                </span>
                <Badge tone={user.email_verified_at ? "positive" : "warning"}>
                  {user.email_verified_at ? "Verified" : "Unverified"}
                </Badge>
              </div>
            </button>
          ))}
        </div>
      )}
      <div className="vx-admin-pagination">
        <span className="dim">
          {data.total} accounts · Page {page} of{" "}
          {Math.max(1, Math.ceil(data.total / 20))}
        </span>
        <div className="vx-admin-row">
          <Button
            disabled={page === 1 || loading}
            onClick={() => setPage((p) => p - 1)}
          >
            <ArrowLeft size={13} />
            Previous
          </Button>
          <Button
            disabled={page * 20 >= data.total || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
            <ArrowRight size={13} />
          </Button>
        </div>
      </div>
      {selected && (
        <Dialog
          title={selected.name}
          onClose={() => {
            setSelected(null);
            setNotice("");
          }}
        >
          <p className="dim">{selected.email}</p>
          <div className="vx-admin-row">
            <Badge tone="accent">{selected.role}</Badge>
            <Badge tone={selected.email_verified_at ? "positive" : "warning"}>
              {selected.email_verified_at
                ? "Email verified"
                : "Email unverified"}
            </Badge>
            {selected.suspended_at && (
              <Badge tone="warning">Access suspended</Badge>
            )}
          </div>
          <div className="vx-admin-grid" style={{ marginTop: 20 }}>
            <div className="vx-admin-panel">
              <span className="dim">Available credits</span>
              <h2 style={{ marginTop: 8 }}>
                {selected.credits.unlimited
                  ? "Unlimited"
                  : selected.credits.available.toLocaleString()}
              </h2>
              <span className="dim">
                {selected.credits.spent} spent · {selected.credits.purchased}{" "}
                non-expiring
              </span>
            </div>
            <div className="vx-admin-panel">
              <span className="dim">Effective plan</span>
              <h2 style={{ marginTop: 8, textTransform: "capitalize" }}>
                {selected.tier}
              </h2>
              <span className="dim">
                {selected.plan_override
                  ? "Administrator grant"
                  : "Subscription"}{" "}
                · {selected.subscription_status}
              </span>
            </div>
          </div>
          <div className="vx-admin-section">
            <h3>Account actions</h3>
            <p className="dim">
              Access changes require your current administrator password.
            </p>
            <div className="vx-admin-row">
              <Button onClick={() => setMail(true)}>
                <Mail size={14} />
                Email user
              </Button>
              {!selected.email_verified_at && (
                <Button onClick={() => setAction("verify")}>
                  <CheckCircle2 size={14} />
                  Verify email
                </Button>
              )}
              {selected.role !== "admin" && (
                <>
                  <Button onClick={() => setAction("promote")}>
                    <ShieldCheck size={14} />
                    Promote to admin
                  </Button>
                  <Button
                    onClick={() =>
                      setAction(selected.suspended_at ? "restore" : "suspend")
                    }
                  >
                    {selected.suspended_at
                      ? "Restore access"
                      : "Suspend access"}
                  </Button>
                  <Button onClick={() => setAction("credits")}>
                    <Coins size={14} />
                    Grant credits
                  </Button>
                </>
              )}
            </div>
          </div>
          <div className="vx-admin-section">
            <h3>Plan access</h3>
            <p className="dim">
              Manual access grants take effect immediately and preserve
              subscription records.
            </p>
            <div className="vx-admin-row">
              {["starter", "studio", "scale"].map((tier) => (
                <Button key={tier} onClick={() => setAction(`plan:${tier}`)}>
                  Grant {tier}
                </Button>
              ))}
              {selected.plan_override && (
                <Button onClick={() => setAction("revoke-plan")}>
                  Revoke manual plan
                </Button>
              )}
            </div>
          </div>
          <div className="vx-admin-section">
            <h3>YouTube channels</h3>
            {selected.channels.length ? (
              selected.channels.map((c) => (
                <p className="dim" key={c.id}>
                  {c.title} · {c.youtube_channel_id}{" "}
                  {c.disconnected_at ? "· Disconnected" : ""}
                </p>
              ))
            ) : (
              <p className="dim">No connected channels.</p>
            )}
            <h3 style={{ marginTop: 20 }}>Projects & publishing</h3>
            {selected.projects.length ? (
              <div className="vx-admin-table-wrap">
                <table className="vx-admin-table">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Status</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.projects.map((p) => (
                      <tr key={p.id}>
                        <td>{p.title}</td>
                        <td>
                          <Badge>{p.status}</Badge>
                        </td>
                        <td className="dim">{dateTime(p.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="dim">No projects yet.</p>
            )}
            <h3 style={{ marginTop: 20 }}>Latest YouTube publications</h3>
            {selected.publications.length ? (
              <div className="vx-admin-table-wrap">
                <table className="vx-admin-table">
                  <thead>
                    <tr>
                      <th>Video</th>
                      <th>Channel</th>
                      <th>Status</th>
                      <th>Published / scheduled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.publications.map((video) => (
                      <tr key={video.id}>
                        <td>
                          <a
                            href={`https://www.youtube.com/watch?v=${encodeURIComponent(video.youtube_video_id)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {video.title}
                          </a>
                        </td>
                        <td>{video.channel_title}</td>
                        <td>
                          <Badge>{video.upload_status ?? "Unknown"}</Badge>
                          <p className="dim">
                            {video.privacy_status ?? "Privacy not reported"}
                          </p>
                        </td>
                        <td className="dim">
                          {dateTime(
                            video.published_at ?? video.scheduled_publish_at,
                          )}
                          {!video.published_at && video.scheduled_publish_at
                            ? " · Scheduled"
                            : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="dim">No YouTube publications yet.</p>
            )}
          </div>
          <div className="vx-admin-section">
            <h3>Action history</h3>
            {selected.actions.length ? (
              selected.actions.map((a) => (
                <p className="dim" key={a.id}>
                  {a.action} {a.detail ? `· ${a.detail}` : ""} ·{" "}
                  {dateTime(a.created_at)}
                  <br />
                  <span style={{ fontSize: 10 }}>Actor {a.actor_id}</span>
                </p>
              ))
            ) : (
              <p className="dim">No administrator actions yet.</p>
            )}
          </div>
          {selected.role !== "admin" && (
            <div className="vx-admin-section">
              <Button tone="danger" onClick={() => setAction("delete")}>
                <Trash2 size={14} />
                Delete account
              </Button>
              <p className="dim">
                A read-only archive is retained. This action cannot be undone.
              </p>
            </div>
          )}
          {action && (
            <ActionDialog
              user={selected}
              action={action}
              onClose={() => setAction(null)}
              onDone={(detail) => void changed(detail)}
            />
          )}
          {mail && (
            <UserMailDialog user={selected} onClose={() => setMail(false)} />
          )}
        </Dialog>
      )}
      {creating && (
        <CreateUser
          onClose={() => setCreating(false)}
          onCreated={(detail) => {
            setCreating(false);
            setSelected(detail);
            void load();
          }}
        />
      )}
    </section>
  );
}
function ActionDialog({
  user,
  action,
  onClose,
  onDone,
}: {
  user: UserDetail;
  action: string;
  onClose: () => void;
  onDone: (detail?: UserDetail) => void;
}) {
  const [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [reason, setReason] = useState(""),
    [credits, setCredits] = useState(1000),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [requestId] = useState(() => crypto.randomUUID());
  const title =
    action === "delete"
      ? "Delete account"
      : action === "credits"
        ? "Grant creation credits"
        : action === "promote"
          ? "Promote to administrator"
          : action === "suspend"
            ? "Suspend account"
            : action === "restore"
              ? "Restore account access"
              : action === "verify"
                ? "Verify email address"
                : action === "revoke-plan"
                  ? "Revoke manual plan"
                  : `Grant ${action.slice(5)} access`;
  return (
    <Dialog
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            if (action === "delete") {
              await api.delete(`/api/admin/users/${user.id}`, {
                body: { password, confirmation, reason },
              });
              onDone();
            } else
              onDone(
                await api.post<UserDetail>(
                  `/api/admin/users/${user.id}/actions`,
                  {
                    password,
                    action,
                    credits: action === "credits" ? credits : undefined,
                    requestId,
                  },
                ),
              );
            setPassword("");
          } catch (cause) {
            setError(messageOf(cause));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="dim">
          {action === "delete"
            ? "This permanently removes the account and its active data. A sanitized archive is retained; media is purged after 60 days."
            : action === "promote"
              ? "This user will have administrator access and unlimited generation credits. Their existing sessions will be revoked."
              : action === "suspend"
                ? "The user will be signed out. Their purchases and content remain recorded, but account access is blocked until restored."
                : "This action is recorded in the account’s administrator history."}
        </p>
        <p>
          <strong>{user.email}</strong>
        </p>
        {action === "credits" && (
          <label>
            Non-expiring credits
            <input
              type="number"
              required
              min={1}
              max={1000000}
              value={credits}
              onChange={(e) => setCredits(Number(e.target.value))}
            />
          </label>
        )}
        {action === "delete" && (
          <>
            <label>
              Type {user.email} to confirm
              <input
                required
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label>
              Deletion reason
              <input
                required
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </>
        )}
        <label>
          Your current administrator password
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={200}
          />
        </label>
        <Alert message={error} />
        <div className="vx-admin-row">
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              busy ||
              (action === "delete" &&
                confirmation.toLowerCase() !== user.email.toLowerCase())
            }
            tone={action === "delete" ? "danger" : "primary"}
          >
            {busy ? "Applying…" : "Confirm"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function CreateUser({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (detail: UserDetail) => void;
}) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [adminPassword, setAdminPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Dialog
      title="Create a verified account"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            onCreated(
              await api.post<UserDetail>("/api/admin/users", {
                email,
                password,
                adminPassword,
              }),
            );
            setPassword("");
            setAdminPassword("");
          } catch (cause) {
            setError(messageOf(cause));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="dim">
          Creates a verified standard account with the starter plan and its
          normal credit allowance.
        </p>
        <label>
          User email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Initial password
          <input
            type="password"
            required
            minLength={10}
            maxLength={200}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          Your administrator password
          <input
            type="password"
            required
            autoComplete="current-password"
            value={adminPassword}
            onChange={(e) => setAdminPassword(e.target.value)}
          />
        </label>
        <Alert message={error} />
        <Button type="submit" tone="primary" disabled={busy}>
          {busy ? "Creating…" : "Create user"}
        </Button>
      </form>
    </Dialog>
  );
}

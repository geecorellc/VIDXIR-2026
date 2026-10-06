"use client";

/**
 * Publish panel — the prototype's Publish tab (STAGE 05, §17, §18).
 *
 * Preserved: the 1.4fr/1fr split, the Title / Description / Tags / Chapters
 * fields in their inset panels, the thumbnail preview, the Visibility and Checks
 * rows, and the Publish → Published → "View on channels" progression.
 *
 * Changed, and this is the one that matters most: the prototype published with
 * `update({ published: true })`. Here the button creates a `publish_jobs` row and
 * the screen shows "Published" only when a `published_videos` row exists — which
 * is written only after YouTube confirms the upload (§42). Every state between the
 * two is named honestly: Queued, Uploading, Scheduled, Failed.
 *
 * Title, description, tags and chapters are editable, and an edit sets
 * `editedByUser` server-side so regeneration cannot silently overwrite the user's
 * wording (§17).
 */
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ExternalLink,
  ImageIcon,
  Loader2,
  Pencil,
  Rocket,
  X,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Btn } from "@/components/ui/Btn";
import { EmptyCTA } from "@/components/ui/SectionHeader";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { color, font, radius } from "@/lib/design/tokens";
import { formatMs } from "@/lib/dashboard/format";
import type {
  MetadataView,
  PublishView,
  PublishedView,
  QualityCheckView,
} from "@/lib/dashboard/stage";
import type { ProjectStatus } from "@/lib/projects/state-machine";
import { api, messageOf } from "@/services/api-client";

const POLL_MS = 4000;

export type Visibility = "public" | "unlisted" | "private";

export interface PublishPanelProps {
  projectId: string | null;
  status: ProjectStatus | null;
  /** Whether a rendered video file actually exists. */
  hasVideo: boolean;
  metadata: MetadataView | null;
  thumbnailUrl: string | null;
  qualityCheck: QualityCheckView | null;
  publishJob: PublishView | null;
  published: PublishedView | null;
  /** Plan gate for scheduling a future publish time (§23). */
  schedulingAvailable: boolean;
  /** YouTube OAuth credentials present. */
  youtubeReady: boolean;
  /** §40 — VIDXIR_BLOCK_REAL_PUBLISH is on, so uploads are refused. */
  publishBlockedByDevMode: boolean;
  error: { message: string; code: string | null } | null;
}

export function PublishPanel({
  projectId,
  status,
  hasVideo,
  metadata,
  thumbnailUrl,
  qualityCheck,
  publishJob,
  published,
  schedulingAvailable,
  youtubeReady,
  publishBlockedByDevMode,
  error,
}: PublishPanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [visibility, setVisibility] = useState<Visibility>(
    publishJob?.visibility ?? "public",
  );

  const [draft, setDraft] = useState({
    title: metadata?.title ?? "",
    description: metadata?.description ?? "",
    tags: (metadata?.tags ?? []).join(", "),
  });

  const uploading =
    publishJob?.status === "publishing" || status === "PUBLISHING";

  useEffect(() => {
    if (!uploading) return;
    const id = setInterval(() => startTransition(() => router.refresh()), POLL_MS);
    return () => clearInterval(id);
  }, [uploading, router, startTransition]);

  async function saveMetadata() {
    setActionError(null);
    setBusy(true);
    try {
      await api.patch("/api/metadata", {
        projectId,
        title: draft.title,
        description: draft.description,
        tags: draft.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setEditing(false);
      startTransition(() => router.refresh());
    } catch (e) {
      setActionError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setActionError(null);
    setBusy(true);
    try {
      await api.post("/api/publish", { projectId, visibility });
      startTransition(() => router.refresh());
    } catch (e) {
      setActionError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (!projectId) {
    return (
      <EmptyCTA
        icon={<Rocket size={22} />}
        title="No video started"
        body="Start a video in Research — publishing is the last step of a pipeline, and there is nothing in it yet."
        action={
          <Btn onClick={() => router.push("/dashboard/research")}>
            Find an idea <ChevronRight size={15} />
          </Btn>
        }
      />
    );
  }

  if (!hasVideo) {
    return (
      <EmptyCTA
        icon={<ImageIcon size={22} />}
        title="No rendered video"
        body="There's nothing to publish yet — the video has to finish rendering before it can be uploaded to YouTube."
        action={
          <Btn onClick={() => router.push("/dashboard/video")}>
            Go to the video builder <ChevronRight size={15} />
          </Btn>
        }
      />
    );
  }

  const notice = actionError ?? error?.message ?? publishJob?.error ?? null;
  const failures = qualityCheck?.findings.filter((f) => f.severity === "fail") ?? [];
  const warnings = qualityCheck?.findings.filter((f) => f.severity === "warn") ?? [];

  const blockedReason = publishBlockedByDevMode
    ? "Publishing is blocked because development mode has VIDXIR_BLOCK_REAL_PUBLISH enabled."
    : !youtubeReady
      ? "YouTube is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to publish."
      : !metadata
        ? "Metadata has not been generated yet."
        : failures.length > 0
          ? "Pre-publish checks found issues that must be resolved first."
          : null;

  return (
    <div>
      {notice && (
        <Card tone="warning" pad={14} style={{ marginBottom: 16 }}>
          <p style={{ margin: 0, fontSize: 13, color: color.warning, lineHeight: 1.6 }}>
            {notice}
          </p>
        </Card>
      )}

      <Card>
        <div
          className="vidxir-publish-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.4fr) minmax(240px, 1fr)",
            gap: 20,
          }}
        >
          <div>
            <FieldLabel
              text="Title"
              action={
                !editing && metadata ? (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      fontSize: 11.5,
                      color: color.textDim,
                    }}
                  >
                    <Pencil size={11} /> Edit
                  </button>
                ) : null
              }
            />
            {editing ? (
              <input
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                maxLength={100}
                style={inputStyle}
              />
            ) : (
              <Inset style={{ fontSize: 14 }}>
                {metadata?.title ?? "Not generated yet"}
              </Inset>
            )}

            <FieldLabel text="Description" />
            {editing ? (
              <textarea
                value={draft.description}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, description: e.target.value }))
                }
                rows={6}
                maxLength={5000}
                style={{ ...inputStyle, resize: "vertical", lineHeight: 1.55 }}
              />
            ) : (
              <Inset
                style={{ fontSize: 13.5, color: color.textMuted, lineHeight: 1.5 }}
              >
                {metadata?.description || "Not generated yet"}
              </Inset>
            )}

            <FieldLabel text="Tags" />
            {editing ? (
              <input
                value={draft.tags}
                onChange={(e) => setDraft((d) => ({ ...d, tags: e.target.value }))}
                placeholder="automation, future of work, ai tools"
                style={inputStyle}
              />
            ) : (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  marginBottom: 16,
                }}
              >
                {(metadata?.tags ?? []).length === 0 ? (
                  <span style={{ fontSize: 12.5, color: color.textFaint }}>
                    No tags generated yet
                  </span>
                ) : (
                  metadata?.tags.map((tag) => (
                    <span
                      key={tag}
                      style={{
                        background: color.subtle,
                        border: `1px solid ${color.borderLight}`,
                        borderRadius: radius.pill,
                        padding: "5px 12px",
                        fontSize: 12,
                      }}
                    >
                      #{tag}
                    </span>
                  ))
                )}
              </div>
            )}

            <FieldLabel text="Chapters" />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {(metadata?.chapters ?? []).length === 0 ? (
                <span style={{ fontSize: 12.5, color: color.textFaint }}>
                  No chapters generated yet
                </span>
              ) : (
                metadata?.chapters.map((chapter) => (
                  <div
                    key={`${chapter.startMs}-${chapter.label}`}
                    style={{
                      background: color.inputBg,
                      border: `1px solid ${color.border}`,
                      borderRadius: radius.sm,
                      padding: "6px 10px",
                      fontSize: 12,
                    }}
                  >
                    <span style={{ color: color.accent, fontWeight: 700 }}>
                      {formatMs(chapter.startMs)}
                    </span>{" "}
                    {chapter.label}
                  </div>
                ))
              )}
            </div>

            {editing && (
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <Btn size="sm" onClick={saveMetadata} loading={busy}>
                  Save changes
                </Btn>
                <Btn
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(false);
                    setDraft({
                      title: metadata?.title ?? "",
                      description: metadata?.description ?? "",
                      tags: (metadata?.tags ?? []).join(", "),
                    });
                  }}
                >
                  Cancel
                </Btn>
              </div>
            )}

            {metadata?.editedByUser && !editing && (
              <p
                style={{
                  margin: "14px 0 0",
                  fontSize: 11.5,
                  color: color.textFaint,
                }}
              >
                Edited by you — regenerating metadata will not overwrite this.
              </p>
            )}
          </div>

          <div>
            <div
              style={{
                background: thumbnailUrl
                  ? "#000"
                  : color.inputBg,
                border: `1px solid ${color.border}`,
                borderRadius: radius.md,
                aspectRatio: "16/9",
                marginBottom: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
                padding: thumbnailUrl ? 0 : 10,
              }}
            >
              {thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived storage URL
                <img
                  src={thumbnailUrl}
                  alt="Selected thumbnail"
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              ) : (
                <ImageIcon size={22} color="#3A3336" aria-hidden="true" />
              )}
            </div>

            <Row label="Visibility">
              {published ? (
                <span>{labelForVisibility(published.privacyStatus)}</span>
              ) : (
                <select
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value as Visibility)}
                  style={{
                    background: color.inputBg,
                    color: color.text,
                    border: `1px solid ${color.border}`,
                    borderRadius: radius.sm,
                    padding: "4px 8px",
                    fontSize: 12.5,
                    fontFamily: font.body,
                  }}
                >
                  <option value="public">Public</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="private">Private</option>
                </select>
              )}
            </Row>

            <Row label="Checks">
              {!qualityCheck ? (
                <span style={{ color: color.textDim }}>Not run yet</span>
              ) : failures.length > 0 ? (
                <span
                  style={{
                    color: color.danger,
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <X size={13} /> {failures.length}{" "}
                  {failures.length === 1 ? "issue" : "issues"}
                </span>
              ) : warnings.length > 0 ? (
                <span
                  style={{
                    color: color.warning,
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <AlertTriangle size={13} /> {warnings.length}{" "}
                  {warnings.length === 1 ? "warning" : "warnings"}
                </span>
              ) : (
                <span
                  style={{
                    color: color.positive,
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <Check size={13} /> No issues found
                </span>
              )}
            </Row>

            {qualityCheck && qualityCheck.findings.length > 0 && (
              <ul
                style={{
                  margin: "0 0 16px",
                  padding: "0 0 0 16px",
                  fontSize: 12,
                  lineHeight: 1.6,
                  color: color.textDim,
                }}
              >
                {qualityCheck.findings.slice(0, 5).map((finding) => (
                  <li key={finding.code}>
                    <span
                      style={{
                        color:
                          finding.severity === "fail"
                            ? color.danger
                            : finding.severity === "warn"
                              ? color.warning
                              : color.textDim,
                      }}
                    >
                      {finding.message}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {/* Published only when YouTube confirmed it (§42). */}
            {published ? (
              <>
                <Btn full disabled icon={<Check size={15} />}>
                  Published
                </Btn>
                <a
                  href={published.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    marginTop: 8,
                    fontSize: 12.5,
                    color: color.textDim,
                    textDecoration: "none",
                  }}
                >
                  Watch on YouTube <ExternalLink size={12} />
                </a>
                <Btn
                  full
                  variant="ghost"
                  onClick={() => router.push("/dashboard/channels")}
                  size="sm"
                >
                  View on channels <ChevronRight size={15} />
                </Btn>
              </>
            ) : uploading ? (
              <>
                <Btn full disabled icon={<Loader2 size={15} className="vidxir-spin" />}>
                  Uploading…
                </Btn>
                <div style={{ marginTop: 10 }}>
                  <ProgressBar
                    label="Upload progress"
                    pct={publishJob?.uploadProgress ?? 0}
                    indeterminate={(publishJob?.uploadProgress ?? 0) === 0}
                  />
                </div>
                <p
                  style={{
                    margin: "10px 0 0",
                    fontSize: 11.5,
                    color: color.textFaint,
                    lineHeight: 1.5,
                  }}
                >
                  Vidxir AI will mark this Published only once YouTube confirms the
                  upload.
                </p>
              </>
            ) : publishJob?.status === "scheduled" ? (
              <>
                <Btn full disabled>
                  Scheduled
                </Btn>
                <p
                  style={{
                    margin: "10px 0 0",
                    fontSize: 11.5,
                    color: color.textFaint,
                  }}
                >
                  {publishJob.scheduledFor
                    ? `Goes live ${publishJob.scheduledFor.toLocaleString()}`
                    : "Waiting for its scheduled slot"}
                </p>
              </>
            ) : publishJob?.status === "queued" ? (
              <Btn full disabled>
                Queued for upload
              </Btn>
            ) : (
              <>
                <Btn
                  full
                  onClick={publish}
                  loading={busy || pending}
                  disabled={blockedReason !== null}
                >
                  Publish <Rocket size={15} />
                </Btn>
                {blockedReason && (
                  <p
                    style={{
                      margin: "10px 0 0",
                      fontSize: 11.5,
                      color: color.warning,
                      lineHeight: 1.5,
                    }}
                  >
                    {blockedReason}
                  </p>
                )}
                {publishJob?.status === "failed" && (
                  <p
                    style={{
                      margin: "10px 0 0",
                      fontSize: 11.5,
                      color: color.warning,
                      lineHeight: 1.5,
                    }}
                  >
                    The last attempt failed. Publishing again starts a fresh
                    upload.
                  </p>
                )}
              </>
            )}

            {!schedulingAvailable && !published && (
              <p
                style={{
                  margin: "14px 0 0",
                  fontSize: 11.5,
                  color: color.textFaint,
                  lineHeight: 1.5,
                }}
              >
                Scheduling a publish time is part of the Studio plan.
              </p>
            )}
          </div>
        </div>
      </Card>

      <style>{`
        @media (max-width: 900px) {
          .vidxir-publish-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: color.inputBg,
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  padding: 12,
  fontSize: 14,
  color: color.text,
  fontFamily: font.body,
  marginBottom: 16,
};

function FieldLabel({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        fontSize: 12,
        color: color.textDim,
        marginBottom: 6,
      }}
    >
      <span>{text}</span>
      {action}
    </div>
  );
}

function Inset({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        background: color.inputBg,
        border: `1px solid ${color.border}`,
        borderRadius: radius.md,
        padding: 12,
        marginBottom: 16,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 10,
        fontSize: 13,
        marginBottom: 12,
      }}
    >
      <span style={{ color: color.textDim }}>{label}</span>
      {children}
    </div>
  );
}

function labelForVisibility(value: string | null): string {
  if (value === "public") return "Public";
  if (value === "unlisted") return "Unlisted";
  if (value === "private") return "Private";
  return "Not reported";
}

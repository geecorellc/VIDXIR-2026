"use client";

/**
 * Export.
 *
 * Queues the existing `RENDER_JOB` through `POST /api/video/export` and then polls
 * `GET /api/video/export/status` for real rows. Every figure shown comes from the
 * `renders` row: a render that has reported no percentage draws an indeterminate stripe
 * rather than an invented number, which is the same rule the studio screen follows.
 *
 * The one thing this does beyond starting and reporting is flush the autosave first. The
 * server renders the *stored* cut, so exporting with a debounce still pending would render
 * the previous version — the failure that looks like the editor silently ignoring an edit.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Film, Loader2 } from "lucide-react";
import { Btn } from "@/components/ui/Btn";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { color, font, radius } from "@/lib/design/tokens";
import { formatMs } from "@/lib/dashboard/format";
import { api, messageOf } from "@/services/api-client";
import type { SaveState } from "@/lib/video/edit-history";

/** Matches `GET /api/video/export/status`. */
interface ExportStatus {
  render: {
    id: string;
    status: string;
    progress: number | null;
    provider: string | null;
    durationMs: number | null;
    error: string | null;
    createdAt: string;
    completedAt: string | null;
    url: string | null;
  } | null;
  edit: {
    version: number;
    updatedAt: string;
    lastRenderedAt: string | null;
    upToDate: boolean;
  } | null;
}

/** Poll cadence while a render is running. Matches the studio screen's. */
const POLL_MS = 4_000;

export interface ExportPanelProps {
  projectId: string;
  saveState: SaveState;
  /** Save any pending edit before queueing, so the export renders what is on screen. */
  flush: () => Promise<void>;
}

export function ExportPanel({ projectId, saveState, flush }: ExportPanelProps) {
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await api.get<ExportStatus>(
          `/api/video/export/status?projectId=${encodeURIComponent(projectId)}`,
          { signal },
        );
        if (mountedRef.current) setStatus(next);
      } catch (e) {
        // A failed poll is not worth a banner — the previous status stays on screen and
        // the next tick usually succeeds. An abort is the effect cleaning up.
        if (e instanceof DOMException && e.name === "AbortError") return;
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const running = status?.render?.status === "running" || status?.render?.status === "queued";

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [running, refresh]);

  async function start() {
    setError(null);
    setBusy(true);
    try {
      // Order matters: the cut must be on the server before the job reads it.
      await flush();
      await api.post("/api/video/export", { projectId });
      await refresh();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const render = status?.render ?? null;
  const succeeded = render?.status === "succeeded";
  const failed = render?.status === "failed";
  const upToDate = status?.edit?.upToDate ?? false;
  // A conflict means the local document is not the stored one; exporting would render a
  // cut the user is not looking at.
  const blocked = saveState === "conflict";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12.5 }}>
        <span style={{ color: color.textBright }}>{statusLabel(render, upToDate)}</span>
        {render?.provider && (
          <span style={{ color: color.textFaint, fontFamily: font.mono, fontSize: 11 }}>
            {render.provider}
          </span>
        )}
      </div>

      {render && (
        <ProgressBar
          label="Export progress"
          pct={succeeded ? 100 : (render.progress ?? 0)}
          indeterminate={running && (render.progress ?? 0) === 0}
          color={failed ? color.danger : color.accent}
        />
      )}

      {render?.durationMs != null && (
        <div style={{ fontSize: 11.5, color: color.textFaint }}>
          Output length {formatMs(render.durationMs)}
        </div>
      )}

      {failed && render.error && (
        <p style={{ margin: 0, fontSize: 12, color: color.rose, lineHeight: 1.5 }}>
          {render.error}
        </p>
      )}

      {error && (
        <p style={{ margin: 0, fontSize: 12, color: color.warning, lineHeight: 1.5 }}>
          {error}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn
          size="sm"
          onClick={start}
          loading={busy}
          disabled={running || blocked}
          icon={running ? <Loader2 size={13} className="tally-spin" /> : <Film size={13} />}
        >
          {running ? "Exporting…" : succeeded ? "Export again" : "Export video"}
        </Btn>

        {succeeded && render.url && (
          <Btn
            size="sm"
            variant="ghost"
            icon={<Download size={13} />}
            onClick={() => window.open(render.url ?? "", "_blank", "noopener,noreferrer")}
          >
            Open file
          </Btn>
        )}
      </div>

      {succeeded && !upToDate && (
        <p
          style={{
            margin: 0,
            fontSize: 11.5,
            color: color.warning,
            lineHeight: 1.5,
            background: "#1E1710",
            border: `1px solid #4A3A20`,
            borderRadius: radius.sm,
            padding: "7px 9px",
          }}
        >
          The last export was made before your latest changes. Export again to render the
          cut you are looking at.
        </p>
      )}

      {blocked && (
        <p style={{ margin: 0, fontSize: 11.5, color: color.rose, lineHeight: 1.5 }}>
          Exporting is unavailable until you resolve the conflict above — the saved cut is
          not the one on screen, so this would render the wrong video.
        </p>
      )}
    </div>
  );
}

/**
 * Honest status copy.
 *
 * "Queued" and "Rendering" are distinct because the wait feels different, and a succeeded
 * render that predates the current cut says so rather than reading as finished work.
 */
function statusLabel(
  render: ExportStatus["render"],
  upToDate: boolean,
): string {
  if (!render) return "Not exported yet";
  switch (render.status) {
    case "queued":
      return "Queued — waiting for a render worker";
    case "running":
      return "Rendering";
    case "succeeded":
      return upToDate ? "Exported — up to date" : "Exported — out of date";
    case "failed":
      return "Export failed";
    case "blocked_not_configured":
      return "Blocked — render provider not configured";
    default:
      return render.status;
  }
}

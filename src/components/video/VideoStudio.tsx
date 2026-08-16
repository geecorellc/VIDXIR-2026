"use client";

/**
 * Video studio — the prototype's Video tab (STAGE 03).
 *
 * Preserved: the 16:9 preview panel, the six-cell filmstrip, the four asset cards
 * (Voiceover / B-roll / Music & SFX / Captions) with their provider sublines, the
 * "Render engine · Remotion / Shotstack" bar, and the Generate / Rebuild +
 * "Continue to thumbnail" button row.
 *
 * Changed: the prototype simulated four asset bars with `Math.random()` and a
 * render bar on a 350 ms interval. Every bar here reads a real `jobs` row for that
 * pipeline stage, and the render bar reads provider-reported progress from the
 * `renders` row. A stage the provider reports no percentage for renders as an
 * indeterminate stripe rather than an invented number (§37, §42).
 *
 * The preview is a real `<video>` element pointed at the rendered file. Before a
 * render exists there is no player and no placeholder frame that could be mistaken
 * for output.
 */
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  Captions as CaptionsIcon,
  Check,
  ChevronRight,
  Clapperboard,
  FileText,
  Loader2,
  Mic,
  Music2,
  RefreshCw,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Btn } from "@/components/ui/Btn";
import { EmptyCTA } from "@/components/ui/SectionHeader";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { ConfigNotice } from "@/components/dashboard/ConfigNotice";
import { color, radius } from "@/lib/design/tokens";
import { blockedReasonLabel } from "@/lib/errors";
import { formatMs } from "@/lib/dashboard/format";
import type { RenderView, StageJobView } from "@/lib/dashboard/stage";
import type { CapabilityStatus } from "@/lib/providers/config";
import type { PipelineStage } from "@/lib/stages";
import type { ProjectStatus } from "@/lib/projects/state-machine";
import { api, messageOf } from "@/services/api-client";

/** The prototype's four asset cards, mapped to real pipeline stages. */
const ASSET_CARDS: Array<{
  stage: PipelineStage;
  label: string;
  sub: string;
  capability: CapabilityStatus["capability"];
  icon: typeof Mic;
}> = [
  { stage: "VOICEOVER", label: "Voiceover", sub: "ElevenLabs", capability: "voice", icon: Mic },
  { stage: "VISUALS", label: "B-roll", sub: "Pexels, Runway", capability: "visuals", icon: Clapperboard },
  { stage: "MUSIC", label: "Music & SFX", sub: "Library API", capability: "music", icon: Music2 },
  { stage: "CAPTIONS", label: "Captions", sub: "Whisper API", capability: "transcription", icon: CaptionsIcon },
];

const POLL_MS = 4000;

export interface VideoStudioProps {
  projectId: string | null;
  status: ProjectStatus | null;
  scriptTitle: string | null;
  scriptApproved: boolean;
  sceneCount: number;
  stageJobs: StageJobView[];
  render: RenderView | null;
  /** Streaming URL for the finished file, or null before a render exists. */
  videoUrl: string | null;
  /** Provider states for the four asset capabilities plus render. */
  capabilities: CapabilityStatus[];
  error: { message: string; code: string | null } | null;
}

export function VideoStudio({
  projectId,
  status,
  scriptTitle,
  scriptApproved,
  sceneCount,
  stageJobs,
  render,
  videoUrl,
  capabilities,
  error,
}: VideoStudioProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Scene planning is not its own project status — it is the first stage inside
  // ASSETS_GENERATING, so it is read from that stage's job rather than invented.
  const planningScenes =
    stageJobs.find((j) => j.stage === "SCENE_PLAN")?.status === "running";

  const building = status === "ASSETS_GENERATING" || status === "RENDERING";

  const done = render?.status === "succeeded" && videoUrl !== null;

  useEffect(() => {
    if (!building) return;
    const id = setInterval(() => startTransition(() => router.refresh()), POLL_MS);
    return () => clearInterval(id);
  }, [building, router, startTransition]);

  async function build() {
    setActionError(null);
    setBusy(true);
    try {
      await api.post("/api/video/build", { projectId });
      startTransition(() => router.refresh());
    } catch (e) {
      setActionError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (!projectId || !scriptTitle) {
    return (
      <EmptyCTA
        icon={<FileText size={22} />}
        title="No script yet"
        body="There's no script yet — the video builder needs one to generate voiceover, b-roll, and captions from."
        action={
          <Btn onClick={() => router.push("/dashboard/script")}>
            Write a script <ChevronRight size={15} />
          </Btn>
        }
      />
    );
  }

  const notice = actionError ?? error?.message ?? null;
  const blocked = capabilities.filter((c) => c.state === "not_configured");
  const canBuild = blocked.length === 0 && scriptApproved;

  return (
    <div>
      {notice && (
        <Card tone="warning" pad={14} style={{ marginBottom: 16 }}>
          <p style={{ margin: 0, fontSize: 13, color: color.warning, lineHeight: 1.6 }}>
            {notice}
          </p>
        </Card>
      )}

      {blocked.map((status_) => (
        <ConfigNotice key={status_.capability} status={status_} />
      ))}

      <Card style={{ marginBottom: 16 }}>
        <div
          style={{
            background: "#000",
            borderRadius: radius.md,
            aspectRatio: "16/9",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            overflow: "hidden",
            marginBottom: 16,
          }}
        >
          {done ? (
            // The real file, with the browser's own controls. No simulated
            // playhead — the timecode comes from the media element. Captions are
            // burned into the render itself, so there is no separate track.
            <video
              src={videoUrl ?? undefined}
              controls
              preload="metadata"
              style={{ width: "100%", height: "100%", objectFit: "contain" }}
            />
          ) : (
            <>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: "linear-gradient(135deg, #1a0d0d, #000)",
                }}
              />
              <div
                style={{
                  position: "relative",
                  textAlign: "center",
                  padding: "0 20px",
                }}
              >
                <p
                  style={{
                    color: previewTone(status, planningScenes),
                    fontSize: 13.5,
                    margin: 0,
                  }}
                >
                  {previewLabel(status, render, planningScenes)}
                </p>
                {render?.status === "failed" && render.error && (
                  <p
                    style={{
                      color: color.textFaint,
                      fontSize: 12,
                      margin: "8px 0 0",
                      lineHeight: 1.5,
                    }}
                  >
                    {render.error}
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        {/* Filmstrip. Cells map to real scenes; before a scene plan exists the
            strip is empty rather than showing six invented frames. */}
        <div style={{ display: "flex", gap: 8, overflowX: "auto" }} className="tally-scroll">
          {sceneCount === 0 ? (
            <span style={{ fontSize: 12, color: color.textFaint }}>
              Scenes appear here once the scene planner has run.
            </span>
          ) : (
            Array.from({ length: sceneCount }, (_, i) => (
              <div
                key={i}
                title={`Scene ${i + 1}`}
                style={{
                  minWidth: 90,
                  height: 52,
                  borderRadius: radius.sm,
                  background: color.subtle,
                  border: `1px solid ${color.border}`,
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  color: color.textFaint,
                }}
              >
                {String(i + 1).padStart(2, "0")}
              </div>
            ))
          )}
        </div>
      </Card>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        {ASSET_CARDS.map((card) => {
          const job = stageJobs.find((j) => j.stage === card.stage) ?? null;
          const capability = capabilities.find((c) => c.capability === card.capability);
          const complete = job?.status === "succeeded";
          const Icon = card.icon;

          return (
            <Card key={card.stage}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 10,
                }}
              >
                <Icon size={17} color={color.accent} aria-hidden="true" />
                {complete && <Check size={15} color={color.positive} aria-hidden="true" />}
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>
                {card.label}
              </div>
              <div style={{ fontSize: 12, color: color.textFaint, marginBottom: 10 }}>
                {capability?.state === "mock"
                  ? `${card.sub} · mock`
                  : capability?.state === "not_configured"
                    ? "Not configured"
                    : card.sub}
              </div>
              <ProgressBar
                label={`${card.label} progress`}
                pct={job?.progress ?? 0}
                indeterminate={job?.status === "running" && (job.progress ?? 0) === 0}
                color={
                  job?.status === "failed" || job?.status === "blocked_not_configured"
                    ? color.danger
                    : color.accent
                }
              />
              <div
                style={{
                  marginTop: 8,
                  fontSize: 11.5,
                  color:
                    job?.status === "failed" || job?.status === "blocked_not_configured"
                      ? color.warning
                      : color.textFaint,
                  lineHeight: 1.5,
                }}
              >
                {stageLabelFor(job)}
              </div>
            </Card>
          );
        })}
      </div>

      <Card style={{ marginBottom: 16 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 8,
            fontSize: 13,
          }}
        >
          <span>Render engine · {renderEngineLabel(render, capabilities)}</span>
          <span style={{ color: color.textDim }}>{renderStatusLabel(render)}</span>
        </div>
        <ProgressBar
          label="Render progress"
          pct={render?.status === "succeeded" ? 100 : (render?.progress ?? 0)}
          indeterminate={render?.status === "running" && (render.progress ?? 0) === 0}
          color={render?.status === "failed" ? color.danger : color.accent}
        />
        {render?.durationMs !== null && render?.durationMs !== undefined && (
          <div style={{ marginTop: 8, fontSize: 11.5, color: color.textFaint }}>
            Output length {formatMs(render.durationMs)}
          </div>
        )}
      </Card>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Btn
          onClick={build}
          disabled={building || !canBuild}
          loading={busy || pending}
          icon={
            building ? (
              <Loader2 size={15} className="tally-spin" />
            ) : done ? (
              <RefreshCw size={15} />
            ) : undefined
          }
        >
          {building ? "Building…" : done ? "Rebuild video" : "Generate video"}
          {!building && !done && <ChevronRight size={15} />}
        </Btn>
        {done && (
          <Btn variant="ghost" onClick={() => router.push("/dashboard/thumbnail")}>
            Continue to thumbnail <ChevronRight size={15} />
          </Btn>
        )}
      </div>

      {!scriptApproved && (
        <p
          style={{
            margin: "12px 0 0",
            fontSize: 12,
            color: color.textFaint,
            lineHeight: 1.55,
          }}
        >
          Approve the script first — the video builder generates voiceover and
          visuals from the approved version, so it needs one to work from.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Honest status copy
// ---------------------------------------------------------------------------

function previewLabel(
  status: ProjectStatus | null,
  render: RenderView | null,
  planningScenes: boolean,
): string {
  if (render?.status === "failed") return "Render failed";
  if (render?.status === "blocked_not_configured") {
    return "Render blocked — provider not configured";
  }
  if (planningScenes) return "Planning scenes…";
  if (status === "ASSETS_GENERATING") return "Generating assets…";
  if (status === "RENDERING") {
    return render && render.progress > 0
      ? `Rendering timeline… ${Math.floor(render.progress)}%`
      : "Rendering timeline…";
  }
  if (render?.status === "queued") return "Queued…";
  return "Nothing rendered yet";
}

function previewTone(status: ProjectStatus | null, planningScenes: boolean): string {
  return planningScenes || status === "ASSETS_GENERATING" || status === "RENDERING"
    ? color.rose
    : color.textDim;
}

function stageLabelFor(job: StageJobView | null): string {
  if (!job) return "Not started";
  if (job.status === "blocked_not_configured") {
    // `errorCode` separates a missing credential from an exhausted balance; both
    // land on this status, and only one is fixed by setting an env var.
    return blockedReasonLabel(job.errorCode, job.notConfiguredProvider);
  }
  if (job.status === "failed") return job.error ?? "Failed";
  if (job.status === "cancelled") return "Cancelled";
  if (job.status === "queued") return "Queued";
  if (job.status === "running") return job.statusMessage ?? "Working…";
  return job.statusMessage ?? "Done";
}

function renderEngineLabel(
  render: RenderView | null,
  capabilities: CapabilityStatus[],
): string {
  if (render?.provider) return render.provider;
  const configured = capabilities.find((c) => c.capability === "render");
  return configured?.state === "not_configured"
    ? "not configured"
    : (configured?.provider ?? "Remotion / Shotstack");
}

function renderStatusLabel(render: RenderView | null): string {
  if (!render) return "Waiting on assets";
  switch (render.status) {
    case "queued":
      return "Queued";
    case "running":
      return render.progress > 0 ? `${Math.floor(render.progress)}%` : "Rendering";
    case "succeeded":
      return "Complete";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "blocked_not_configured":
      return "Provider not configured";
  }
}

"use client";

/**
 * The channel-less creation flow, end to end (§18; §1C).
 *
 * Seed → research → choose an angle → choose a generation method → script → video.
 * One screen, because the steps are a sequence over a single project and splitting
 * them across routes would lose the thing that makes the flow legible: you can see
 * what the last step decided while you make the next one.
 *
 * Two entry paths share it, chosen by `seed`:
 *
 *  - `"link"` — paste any public YouTube URL, analyse it, research its topic (§4).
 *  - `"description"` — type what you want to make, and Vidxir AI interprets it into a
 *    research brief instead (§1C).
 *
 * They differ only in step 1 and in what step 2 has to show. Everything after that —
 * the run status, the measured trends, the angle cards, the generation picker, the
 * script and the build — is the same sequence over the same rows, so it is
 * parameterised here rather than copied into a second 900-line screen. Named for link
 * mode because that is what it was written for, following `getLinkStudioData` and
 * `/api/projects/link-status`, which serve both paths for the same reason.
 *
 * What this component does *not* do is as important as what it does.
 *
 * §18: "show job progress using Vidxir AI's existing job/worker system. Do not create
 * fake progress." Every status line here is a `jobs` row or a `research_runs` row.
 * While something is running it polls `/api/projects/link-status`, prints the
 * worker's own `statusMessage`, and stops the moment the run reaches a terminal
 * state. There is no client-side timer, no interpolated percentage, and no
 * optimistic "done".
 *
 * §19, §21: no decision is made here. Selecting an angle, saving a generation
 * method, generating a script and building a video are each a request whose
 * authorisation is re-derived server-side from the caller's subscription. The
 * disabled buttons below are a courtesy, not a gate.
 *
 * §22: the pasted video is a research source. Nothing on this screen offers to
 * download it, copy its script, or reuse its title — the angle cards are Vidxir AI's
 * own proposals, and the source panel is metadata and a thumbnail URL.
 *
 * §1C, on the description path: the text the user types is a subject to research, and
 * this screen never sends it anywhere but `/api/projects/from-description`. It is not
 * a prompt, not a script, and not passed to any generation stage.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  ArrowRight,
  Clapperboard,
  FileText,
  Lightbulb,
  Link2,
  RefreshCw,
  Search,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { GenerationPicker } from "@/components/youtube/GenerationPicker";
import { SourceCard } from "@/components/youtube/SourceCard";
import { Btn } from "@/components/ui/Btn";
import { Card } from "@/components/ui/Card";
import { color, font, radius } from "@/lib/design/tokens";
import { compact } from "@/lib/dashboard/format";
import type { LinkStudioData } from "@/lib/dashboard/link-studio";
import { blockedReasonLabel } from "@/lib/errors";
import { api, messageOf } from "@/services/api-client";

/** What `POST /api/youtube/analyze` answers — an analysis, or a named non-answer. */
interface AnalyzeResponse {
  state:
    | "ok"
    | "not_found"
    | "not_configured"
    | "quota_exceeded"
    | "forbidden"
    | "unavailable";
  videoId: string;
  canonicalUrl: string;
  analysis: {
    videoId: string;
    url: string | null;
    title: string | null;
    channelTitle: string | null;
    durationSeconds: number | null;
    viewCount: number | null;
    likeCount: number | null;
    commentCount: number | null;
    viewsPerHour: number | null;
    thumbnailUrl: string | null;
    categoryTitle: string | null;
    topics: string[];
    niche: string | null;
    transcript: string | null;
    missingFields: string[];
  } | null;
  message?: string;
  missingEnvVars?: string[];
}

/** What `GET /api/projects/link-status` answers while a stage is in flight. */
interface LinkStatusResponse {
  project: {
    status: string;
    ideaId: string | null;
    generationMode: string | null;
    generationModel: string | null;
    videoFormat: string | null;
  } | null;
  run: {
    status: string;
    resultCount: number;
    angleCount: number;
  } | null;
  activeJob: { statusMessage: string | null; name: string } | null;
}

/** The active project's script, when one has been written. */
export interface LinkScriptView {
  title: string;
  version: number;
  approved: boolean;
  wordCount: number | null;
  estimatedDurationSeconds: number | null;
}

/** Which entry path this screen is rendering (§4, §1C). */
export type StudioSeed = "link" | "description";

export interface LinkStudioProps {
  /** Null until the user has seeded a project. */
  data: LinkStudioData | null;
  script: LinkScriptView | null;
  /** Whether the AI capability is configured — gates angles and scripts (§48). */
  aiConfigured: boolean;
  /**
   * The entry path. Defaults to link mode so the existing screen is unchanged.
   *
   * Only step 1 and step 2 read it; every later step is identical, which is the
   * reason one component serves both.
   */
  seed?: StudioSeed;
  /**
   * The route this screen lives at, for the push after a project is created.
   *
   * Passed in rather than derived, because the screen is not always at the path its
   * component name suggests and a wrong guess would navigate the user off the flow.
   */
  basePath?: string;
}

/**
 * Bounds on the typed description, mirroring `MIN/MAX_DESCRIPTION_CHARS`.
 *
 * Duplicated rather than imported: `@/lib/research/description` pulls in the AI
 * provider and the capability registry, which read `env()` — none of which can be in a
 * client bundle (§21). The server re-validates against the real constants, so this is a
 * courtesy that cannot disagree in a way that matters: too short is refused with a 400
 * either way.
 */
const MIN_DESCRIPTION = 12;
const MAX_DESCRIPTION = 2_000;

/**
 * Run outcomes after which no source analysis is coming.
 *
 * `blocked_not_configured` belongs here with the other two: the run never reached the
 * worker, so nothing read the video, and it will not start reading on its own — the
 * operator has to configure the provider first. `succeeded` is deliberately absent,
 * because a succeeded run always wrote its analysis, and if one ever did not, the
 * waiting copy is the safer thing to show than a claim about why.
 */
const SETTLED_WITHOUT_SOURCE = new Set([
  "failed",
  "cancelled",
  "blocked_not_configured",
]);

export function LinkStudio({
  data,
  script,
  aiConfigured,
  seed = "link",
  basePath = "/dashboard/youtube",
}: LinkStudioProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [busy, setBusy] = useState<
    "start" | "angle" | "script" | "video" | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const project = data?.project ?? null;
  const run = data?.run ?? null;
  // Empty rather than absent: a queued run legitimately has no results yet, and the
  // difference between "none yet" and "no project" is already carried by `project`.
  const trends = data?.trends ?? [];
  const angles = data?.angles ?? [];

  const researching = run?.status === "queued" || run?.status === "running";
  const building =
    project?.status === "SCRIPT_GENERATING" ||
    project?.status === "ASSETS_GENERATING" ||
    project?.status === "RENDERING";
  const live = researching || building;

  /** The worker's own note. Null until a poll answers — never a guess (§42). */
  const [stage, setStage] = useState<string | null>(null);

  // A ref so the interval callback reads the current value without being
  // re-created on every tick.
  const liveRef = useRef(live);
  liveRef.current = live;

  useEffect(() => {
    if (!live || !project) {
      setStage(null);
      return;
    }

    let cancelled = false;
    const projectId = project.id;

    async function poll() {
      try {
        const result = await api.get<LinkStatusResponse>(
          `/api/projects/link-status?projectId=${encodeURIComponent(projectId)}`,
        );
        if (cancelled) return;

        setStage(result.activeJob?.statusMessage ?? null);

        // Terminal: refresh so the server re-renders the board from the rows the
        // worker wrote. This component polls status only — it never assembles the
        // screen from the poll response.
        const runDone =
          result.run !== null &&
          result.run.status !== "queued" &&
          result.run.status !== "running";
        const projectSettled =
          result.project !== null &&
          result.project.status !== "SCRIPT_GENERATING" &&
          result.project.status !== "ASSETS_GENERATING" &&
          result.project.status !== "RENDERING";

        if ((researching && runDone) || (building && projectSettled)) {
          startTransition(() => router.refresh());
        }
      } catch {
        // A failed poll is not a failed job. Trying again beats showing an error
        // about our own status request.
      }
    }

    void poll();
    const timer = setInterval(() => {
      if (liveRef.current) void poll();
    }, 4_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [live, researching, building, project, router, startTransition]);

  async function analyze() {
    setError(null);
    setAnalysis(null);
    setAnalyzing(true);
    try {
      // The URL is parsed and validated on the server (§4). Nothing is checked
      // here first: a client-side regex would only disagree with the real one.
      const result = await api.post<AnalyzeResponse>("/api/youtube/analyze", {
        url,
      });
      setAnalysis(result);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setAnalyzing(false);
    }
  }

  async function start() {
    setError(null);
    setBusy("start");
    try {
      // Two routes, because the two seeds are validated and charged differently on
      // the server. Both create a channel-less project and enqueue one research run.
      const result =
        seed === "description"
          ? await api.post<{ project: { id: string } }>(
              "/api/projects/from-description",
              { description },
            )
          : await api.post<{ project: { id: string } }>(
              "/api/projects/from-youtube",
              { url },
            );
      // Navigate to the new project rather than refreshing: the screen is
      // project-scoped, and the URL should say which one.
      startTransition(() => {
        router.push(`${basePath}?project=${result.project.id}`);
        router.refresh();
      });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  async function chooseAngle(ideaId: string) {
    if (!project) return;
    setError(null);
    setBusy("angle");
    try {
      await api.patch("/api/projects/configure", {
        projectId: project.id,
        ideaId,
      });
      startTransition(() => router.refresh());
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  async function generateScript() {
    if (!project) return;
    setError(null);
    setBusy("script");
    try {
      await api.post("/api/scripts/generate", { projectId: project.id });
      startTransition(() => router.refresh());
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  async function buildVideo() {
    if (!project) return;
    setError(null);
    setBusy("video");
    try {
      await api.post("/api/video/build", { projectId: project.id });
      startTransition(() => router.push(`/dashboard/video?project=${project.id}`));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  const working = busy !== null || pending || live;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {error && (
        <Card tone="warning" pad={14}>
          <p style={{ margin: 0, fontSize: 13, color: color.warning }}>{error}</p>
        </Card>
      )}

      {/* ---------------------------------------------------------------
          Step 1 — describe an idea (§1C).
          The description path's seed. No analysis step: there is nothing to read
          metadata from, and interpreting the sentence is the worker's first job
          rather than a request the user waits on.
      ---------------------------------------------------------------- */}
      {seed === "description" && (
        <Card>
          <Step number={1} title="Describe the video you want to make" />
          <p
            style={{
              margin: "0 0 14px",
              fontSize: 13,
              lineHeight: 1.6,
              color: color.textDim,
            }}
          >
            A sentence or two, in your own words. Vidxir AI works out the subject,
            researches what is working in it right now, and proposes original angles
            from what it measures. No channel connection needed.
          </p>

          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={MAX_DESCRIPTION}
            rows={3}
            placeholder="I want to make a video about why sourdough starters die and how to revive them"
            aria-label="Describe your video idea"
            style={{
              boxSizing: "border-box",
              width: "100%",
              background: color.inputBg,
              border: `1px solid ${color.border}`,
              borderRadius: radius.md,
              padding: "11px 12px",
              color: color.text,
              fontFamily: font.body,
              fontSize: 14,
              lineHeight: 1.6,
              resize: "vertical",
              outline: "none",
            }}
          />

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
              marginTop: 12,
            }}
          >
            <Btn
              onClick={start}
              loading={busy === "start"}
              disabled={working || description.trim().length < MIN_DESCRIPTION}
              icon={<Search size={14} />}
            >
              Research this idea
            </Btn>
            <span style={{ fontSize: 11.5, color: color.textFaint }}>
              {description.trim().length < MIN_DESCRIPTION
                ? `At least ${MIN_DESCRIPTION} characters.`
                : "Starts a new video and counts against your monthly allowance."}
            </span>
          </div>

          {!aiConfigured && (
            <p
              style={{
                margin: "12px 0 0",
                fontSize: 11.5,
                lineHeight: 1.55,
                color: color.textFaint,
              }}
            >
              The AI provider is not configured, so Vidxir AI will fall back to reading
              search terms out of your own words, and cannot propose angles or write a
              script until it is.
            </p>
          )}
        </Card>
      )}

      {/* ---------------------------------------------------------------
          Step 1 — paste a link.
          Shown alongside an existing project too: starting another video from a
          different link is the normal next action, not a hidden one.
      ---------------------------------------------------------------- */}
      {seed === "link" && (
      <Card>
        <Step number={1} title="Paste a YouTube link" />
        <p
          style={{
            margin: "0 0 14px",
            fontSize: 13,
            lineHeight: 1.6,
            color: color.textDim,
          }}
        >
          Any public video — yours or someone else&apos;s, in any niche. Vidxir AI
          reads what it is about, researches what is working in that topic right
          now, and proposes original angles of its own. No channel connection
          needed to research or generate.
        </p>

        <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
          <input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setAnalysis(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && url.trim() && !analyzing) void analyze();
            }}
            placeholder="https://www.youtube.com/watch?v=…"
            aria-label="YouTube video URL"
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 240,
              background: color.inputBg,
              border: `1px solid ${color.border}`,
              borderRadius: radius.md,
              padding: "11px 12px",
              color: color.text,
              fontFamily: font.body,
              fontSize: 14,
              outline: "none",
            }}
          />
          <Btn
            variant="ghost"
            onClick={analyze}
            loading={analyzing}
            disabled={!url.trim() || analyzing}
            icon={<Link2 size={14} />}
          >
            Analyze
          </Btn>
        </div>

        {/* A named non-answer, rendered as itself: private, deleted, quota spent
            and no API key are four different problems with four different fixes. */}
        {analysis && analysis.state !== "ok" && (
          <Card tone="warning" pad={14} style={{ marginTop: 14 }}>
            <p style={{ margin: 0, fontSize: 13, color: color.warning }}>
              {analysis.message ?? "That video could not be read."}
            </p>
            {analysis.missingEnvVars && analysis.missingEnvVars.length > 0 && (
              <p
                style={{
                  margin: "8px 0 0",
                  fontSize: 12,
                  color: color.textFaint,
                  fontFamily: font.mono,
                }}
              >
                {analysis.missingEnvVars.join(", ")}
              </p>
            )}
          </Card>
        )}

        {analysis?.state === "ok" && analysis.analysis && (
          <div style={{ marginTop: 14 }}>
            <SourceCard source={analysis.analysis} />
            <div style={{ marginTop: 14 }}>
              <Btn
                onClick={start}
                loading={busy === "start"}
                disabled={working}
                icon={<Search size={14} />}
              >
                Research this topic
              </Btn>
              <p
                style={{
                  margin: "10px 0 0",
                  fontSize: 11.5,
                  lineHeight: 1.55,
                  color: color.textFaint,
                }}
              >
                Starts a new video and counts against your monthly allowance.
              </p>
            </div>
          </div>
        )}
      </Card>
      )}

      {!project ? null : (
        <>
          {/* -------------------------------------------------------------
              Step 2 — source analysis + research status.
          -------------------------------------------------------------- */}
          <Card>
            <Step
              number={2}
              title={seed === "description" ? "Your idea" : "Source analysis"}
            />
            {seed === "description" ? (
              /**
               * The description as stored, and what Vidxir AI understood it to be about.
               *
               * Read back from the run row rather than from local state, so a refresh
               * or a link to `?project=` shows it and it is visibly the same text the
               * research used. `niche` is null until the worker interprets it — and
               * says so, rather than guessing (§42).
               */
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <p
                  style={{
                    margin: 0,
                    fontSize: 13.5,
                    lineHeight: 1.6,
                    color: color.textBright,
                  }}
                >
                  “{run?.description ?? project.title}”
                </p>
                <p style={{ margin: 0, fontSize: 12.5, color: color.textDim }}>
                  <Label>Subject</Label>
                  {run?.niche ??
                    "not read yet — Vidxir AI works this out when the run starts"}
                </p>
              </div>
            ) : data?.source ? (
              <SourceCard source={data.source} />
            ) : (
              /**
               * No analysis. Which is phrased by whether one is still coming.
               *
               * "when the run starts" is a promise, and a run that already failed or
               * was cancelled is not going to keep it — leaving the screen waiting on
               * something that will never arrive. The run's own outcome is right below
               * this in `RunStatus`, so this line says only whether a read is still
               * expected and does not restate the error.
               */
              <p style={{ margin: 0, fontSize: 13, color: color.textDim }}>
                {run && SETTLED_WITHOUT_SOURCE.has(run.status)
                  ? "This run stopped before Vidxir AI read the source video, so there is nothing to show. Paste the link again to start a fresh one."
                  : "The worker reads the source video when the run starts. Nothing is shown here until it has."}
              </p>
            )}
          </Card>

          {run && (
            <RunStatus
              status={run.status}
              errorCode={run.errorCode}
              error={run.error}
              niche={run.niche}
              stage={stage}
              seed={seed}
              trendCount={trends.length}
              angleCount={angles.length}
            />
          )}

          {/* -------------------------------------------------------------
              Step 3 — trending research. Evidence, not templates.
          -------------------------------------------------------------- */}
          {trends.length > 0 && (
            <Card>
              <Step number={3} title="Trending research" />
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {trends.map((row) => (
                  <div
                    key={row.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 12,
                      paddingBottom: 10,
                      borderBottom: `1px solid ${color.borderFaint}`,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13.5,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {row.url ? (
                          <a
                            href={row.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: color.text, textDecoration: "none" }}
                          >
                            {row.title}
                          </a>
                        ) : (
                          row.title
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: color.textFaint }}>
                        {row.viewCount === null
                          ? "views not reported"
                          : `${compact(row.viewCount)} views`}
                        {row.channelTitle ? ` · ${row.channelTitle}` : ""}
                      </div>
                    </div>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        color:
                          row.viewsPerHour === null
                            ? color.textFaint
                            : color.positive,
                      }}
                    >
                      {row.viewsPerHour === null
                        ? "—"
                        : `${compact(Math.round(row.viewsPerHour))}/hr`}
                    </span>
                  </div>
                ))}
              </div>
              <p
                style={{
                  margin: "14px 0 0",
                  fontSize: 11.5,
                  lineHeight: 1.55,
                  color: color.textFaint,
                }}
              >
                These are signals Vidxir AI measured, shown so you can judge the
                angles below. Nothing here is copied into your video.
              </p>
            </Card>
          )}

          {/* -------------------------------------------------------------
              Step 4 — choose your content angle (§7).
          -------------------------------------------------------------- */}
          <Card>
            <Step number={4} title="Choose your content angle" />
            {angles.length === 0 ? (
              <p
                style={{
                  margin: 0,
                  fontSize: 13,
                  lineHeight: 1.6,
                  color: color.textDim,
                }}
              >
                {!aiConfigured
                  ? "Proposing angles needs the AI provider to be configured. " +
                    "Research signals above will still be collected."
                  : researching
                    ? seed === "description"
                      ? "Vidxir AI is researching your idea and will propose original " +
                        "angles here when it finishes."
                      : "Vidxir AI is researching the topic and will propose original " +
                        "angles here when it finishes."
                    : "No angles yet. Re-run research to propose some."}
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {angles.map((angle) => {
                  const selected = angle.id === data?.selectedAngleId;
                  return (
                    <button
                      key={angle.id}
                      type="button"
                      onClick={() => chooseAngle(angle.id)}
                      disabled={working}
                      aria-pressed={selected}
                      style={{
                        all: "unset",
                        boxSizing: "border-box",
                        display: "block",
                        width: "100%",
                        padding: "13px 14px",
                        borderRadius: radius.md,
                        cursor: working ? "wait" : "pointer",
                        background: selected ? color.accentBgSoft : color.inputBg,
                        border: `1px solid ${selected ? color.accent : color.border}`,
                      }}
                    >
                      <span
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          fontSize: 14,
                          fontWeight: 600,
                          color: selected ? color.text : color.textBright,
                        }}
                      >
                        <Lightbulb
                          size={13}
                          color={selected ? color.accent : color.textFaint}
                          aria-hidden="true"
                        />
                        <span style={{ flex: 1, minWidth: 0 }}>{angle.title}</span>
                        <span
                          title="Vidxir AI's own score — not a YouTube metric"
                          style={{
                            fontFamily: font.display,
                            fontSize: 12,
                            flexShrink: 0,
                            color:
                              angle.vidxirScore === null
                                ? color.textFaint
                                : color.accent,
                          }}
                        >
                          {angle.vidxirScore === null
                            ? "—"
                            : Math.round(angle.vidxirScore)}
                        </span>
                      </span>

                      {angle.hook && (
                        <span
                          style={{
                            display: "block",
                            marginTop: 8,
                            fontSize: 13,
                            lineHeight: 1.55,
                            color: color.textBright,
                          }}
                        >
                          “{angle.hook}”
                        </span>
                      )}

                      {angle.rationale && (
                        <span
                          style={{
                            display: "block",
                            marginTop: 8,
                            fontSize: 12.5,
                            lineHeight: 1.55,
                            color: color.textDim,
                          }}
                        >
                          <Label>Why this angle</Label> {angle.rationale}
                        </span>
                      )}

                      {angle.trendSignal && (
                        <span
                          style={{
                            display: "block",
                            marginTop: 6,
                            fontSize: 12.5,
                            lineHeight: 1.55,
                            color: color.textDim,
                          }}
                        >
                          <Label>Trend signal</Label> {angle.trendSignal}
                        </span>
                      )}
                    </button>
                  );
                })}
                <p
                  style={{
                    margin: "4px 0 0",
                    fontSize: 11.5,
                    lineHeight: 1.55,
                    color: color.textFaint,
                  }}
                >
                  Each of these is Vidxir AI&apos;s own proposal, written from the
                  research above.
                  {seed === "description"
                    ? " Each one delivers on what you described."
                    : " None reuses the source video’s title."}
                </p>
              </div>
            )}
          </Card>

          {/* -------------------------------------------------------------
              Step 5 — video generation method (§9, §10, §16).
          -------------------------------------------------------------- */}
          <Card>
            <Step number={5} title="Video generation" />
            <p
              style={{
                margin: "0 0 14px",
                fontSize: 13,
                lineHeight: 1.6,
                color: color.textDim,
              }}
            >
              How each scene gets its footage, and what shape the finished video
              is. Both are saved on this video and used by the build.
            </p>
            <GenerationPicker
              projectId={project.id}
              mode={project.generationMode}
              model={project.generationModel}
              format={project.videoFormat}
              quality={project.videoQuality}
              disabled={building || pending}
              onSaved={() => startTransition(() => router.refresh())}
            />
          </Card>

          {/* -------------------------------------------------------------
              Step 6 — script (§8), then the existing video pipeline (§17).
          -------------------------------------------------------------- */}
          <Card>
            <Step number={6} title="Script and video" />

            {!data?.selectedAngleId ? (
              <p style={{ margin: 0, fontSize: 13, color: color.textDim }}>
                Choose an angle first — the script is written from it.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {script ? (
                  <div>
                    <div style={{ fontSize: 14, marginBottom: 4 }}>
                      {script.title}
                    </div>
                    <div style={{ fontSize: 12.5, color: color.textFaint }}>
                      v{script.version}
                      {script.wordCount === null
                        ? ""
                        : ` · ${script.wordCount} words`}
                      {script.estimatedDurationSeconds === null
                        ? ""
                        : ` · about ${Math.round(script.estimatedDurationSeconds / 60)} min`}
                      {script.approved ? " · approved" : " · not yet approved"}
                    </div>
                  </div>
                ) : (
                  <p
                    style={{
                      margin: 0,
                      fontSize: 13,
                      lineHeight: 1.6,
                      color: color.textDim,
                    }}
                  >
                    {aiConfigured
                      ? "Vidxir AI will write an original script from the angle you " +
                        "chose and the research above — structured into scenes the " +
                        "video pipeline can build."
                      : "Writing a script needs the AI provider to be configured."}
                  </p>
                )}

                <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                  <Btn
                    onClick={generateScript}
                    loading={busy === "script"}
                    disabled={working || !aiConfigured}
                    icon={<Sparkles size={14} />}
                  >
                    {script ? "Regenerate script" : "Generate script"}
                  </Btn>
                  {script && (
                    <Btn
                      variant="ghost"
                      onClick={() =>
                        router.push(`/dashboard/script?project=${project.id}`)
                      }
                      icon={<FileText size={14} />}
                    >
                      Edit and approve
                    </Btn>
                  )}
                  {script?.approved && (
                    <Btn
                      onClick={buildVideo}
                      loading={busy === "video"}
                      disabled={working}
                      icon={<Clapperboard size={14} />}
                    >
                      Generate video
                    </Btn>
                  )}
                </div>

                {script && !script.approved && (
                  <p
                    style={{
                      margin: 0,
                      fontSize: 11.5,
                      lineHeight: 1.55,
                      color: color.textFaint,
                    }}
                  >
                    Approve the script before building — nothing is generated from
                    an unapproved draft.
                  </p>
                )}

                {/* Progress for the stages after research comes from the same
                    `jobs` rows the Video screen reads (§17, §18). */}
                {building && (
                  <p style={{ margin: 0, fontSize: 12.5, color: color.textDim }}>
                    {stage ?? "Working…"}{" "}
                    <a
                      href={`/dashboard/video?project=${project.id}`}
                      style={{ color: color.accent }}
                    >
                      Follow it in the video studio
                    </a>
                  </p>
                )}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

/**
 * Real run status (§18, §42).
 *
 * A queued or running run says so and offers no percentage; a failed run shows the
 * error the worker recorded, and a blocked one names the reason it was blocked —
 * a missing credential and an exhausted provider balance are different things and
 * send the operator to different places.
 */
function RunStatus({
  status,
  errorCode,
  error,
  niche,
  stage,
  seed,
  trendCount,
  angleCount,
}: {
  status: string;
  errorCode: string | null;
  error: string | null;
  niche: string | null;
  stage: string | null;
  seed: StudioSeed;
  trendCount: number;
  angleCount: number;
}) {
  const LABELS: Record<string, string> = {
    queued: "Queued — waiting for a worker",
    running: "Researching this topic…",
    succeeded: "Research complete",
    failed: "Research failed",
    cancelled: "Research cancelled",
    blocked_not_configured: `Blocked — ${blockedReasonLabel(errorCode)}`,
  };

  const warn = status === "failed" || status === "blocked_not_configured";

  return (
    <Card
      tone={warn ? "warning" : "default"}
      pad={14}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: font.display,
            fontSize: 11,
            letterSpacing: 1.3,
            textTransform: "uppercase",
            color: warn ? color.warning : color.textFaint,
            marginBottom: 4,
            display: "flex",
            alignItems: "center",
            gap: 7,
          }}
        >
          {status === "running" ? (
            <RefreshCw size={12} aria-hidden="true" />
          ) : (
            <TrendingUp size={12} aria-hidden="true" />
          )}
          {LABELS[status] ?? status}
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.5, color: color.textDim }}>
          {error
            ? error
            : // The worker's own note wins while it is working: it is the most
              // specific true thing known about the run right now.
              (stage ??
              (status === "succeeded"
                ? `${trendCount} trending videos measured · ${angleCount} original angles proposed`
                : niche
                  ? `Topic: ${niche}`
                  : seed === "description"
                    ? "Working out what your idea is about"
                    : "Reading the source video"))}
        </div>
      </div>
    </Card>
  );
}

function Step({ number, title }: { number: number; title: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 12,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          flexShrink: 0,
          borderRadius: "50%",
          background: color.subtle,
          border: `1px solid ${color.border}`,
          fontFamily: font.display,
          fontSize: 11,
          color: color.textDim,
        }}
      >
        {number}
      </span>
      <h3
        style={{
          margin: 0,
          fontSize: 15,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {title}
      </h3>
      <ArrowRight
        size={13}
        color={color.borderLight}
        style={{ marginLeft: "auto" }}
        aria-hidden="true"
      />
    </div>
  );
}

function Label({ children }: { children: string }) {
  return (
    <span
      style={{
        fontFamily: font.display,
        fontSize: 10,
        letterSpacing: 1.1,
        textTransform: "uppercase",
        color: color.textFaint,
        marginRight: 6,
      }}
    >
      {children}
    </span>
  );
}

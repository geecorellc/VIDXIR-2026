"use client";

/**
 * Research board — the prototype's Research tab, driven by persisted data.
 *
 * Preserved exactly: the selected-idea accent card with "Write the script", the
 * 1.2fr/1fr "Trending now" + "Search demand" row, and the 1fr/1fr "Competitor top
 * videos" + "Idea vault" row.
 *
 * Changed: clicking an idea is a request to the server, not a `setState`. The
 * selection lives on the project row, so it survives a refresh (§45). "Run
 * research" enqueues a background job; the button reflects the real run status and
 * never animates a pretend result (§42).
 *
 * While a run is active the board polls `/api/research/runs` for the worker's
 * recorded stage (§38). Polling rather than a socket because a research run
 * reports four or five milestones over about a minute — a persistent connection
 * per viewer would cost more than it tells anyone. It stops the moment the run
 * reaches a terminal state, so an idle tab is not a permanent request loop.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  BarChart3,
  Bookmark,
  ChevronRight,
  Lightbulb,
  RefreshCw,
  Search,
  Target,
  TrendingUp,
} from "lucide-react";
import { DemandChart } from "@/components/dashboard/DemandChart";
import { Card } from "@/components/ui/Card";
import { Btn } from "@/components/ui/Btn";
import { EmptyCTA } from "@/components/ui/SectionHeader";
import { color, font, radius } from "@/lib/design/tokens";
import { blockedReasonLabel } from "@/lib/errors";
import { compact } from "@/lib/dashboard/format";
import type { ResearchData } from "@/lib/dashboard/research";
import { api, messageOf } from "@/services/api-client";

export interface ResearchBoardProps {
  channelId: string;
  data: ResearchData;
  /** Title of the idea currently attached to the active project. */
  selectedIdeaTitle: string | null;
  /** Whether the AI capability is configured — gates idea generation. */
  canGenerateIdeas: boolean;
}

export function ResearchBoard({
  channelId,
  data,
  selectedIdeaTitle,
  canGenerateIdeas,
}: ResearchBoardProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<"run" | "select" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const running =
    data.run?.status === "queued" || data.run?.status === "running";

  /**
   * The worker's own progress note ("Reading YouTube signals", "Scoring
   * opportunities"). Null until the first poll answers — an unknown stage shows
   * as unknown rather than as a guess.
   */
  const [stage, setStage] = useState<string | null>(null);

  // A ref, not state: the interval callback needs the current value without
  // re-creating the interval on every tick.
  const runningRef = useRef(running);
  runningRef.current = running;

  useEffect(() => {
    if (!running) {
      setStage(null);
      return;
    }

    let cancelled = false;

    async function poll() {
      try {
        const result = await api.get<{
          runs: Array<{ id: string; status: string }>;
          activeJob: { statusMessage: string | null; progress: number } | null;
        }>(`/api/research/runs?channelId=${encodeURIComponent(channelId)}&limit=1`);

        if (cancelled) return;

        setStage(result.activeJob?.statusMessage ?? null);

        // The run finished while we were watching. Refresh to pull the results
        // themselves — this component only polls status, it does not assemble
        // the board from the poll response.
        const latest = result.runs[0];
        if (latest && latest.status !== "queued" && latest.status !== "running") {
          startTransition(() => router.refresh());
        }
      } catch {
        // A failed poll is not a failed run. Staying quiet and trying again beats
        // showing the user an error about our own status request.
      }
    }

    void poll();
    const timer = setInterval(() => {
      if (runningRef.current) void poll();
    }, 4_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [running, channelId, router, startTransition]);

  async function runResearch() {
    setError(null);
    setBusy("run");
    try {
      await api.post("/api/research/run", { channelId });
      // The job is queued server-side; refreshing shows its real status. No
      // client-side timer pretends to be progress.
      startTransition(() => router.refresh());
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  async function selectIdea(ideaId: string) {
    setError(null);
    setBusy("select");
    try {
      await api.post("/api/projects", { channelId, ideaId });
      startTransition(() => router.refresh());
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  const working = busy !== null || pending || running;

  return (
    <div>
      {error && (
        <Card tone="warning" pad={14} style={{ marginBottom: 16 }}>
          <p style={{ margin: 0, fontSize: 13, color: color.warning }}>{error}</p>
        </Card>
      )}

      {selectedIdeaTitle && (
        <Card
          tone="accent"
          style={{
            marginBottom: 16,
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
                fontSize: 11,
                color: color.accent,
                fontWeight: 700,
                marginBottom: 4,
                letterSpacing: 0.6,
              }}
            >
              SELECTED IDEA
            </div>
            <div style={{ fontSize: 15 }}>{selectedIdeaTitle}</div>
          </div>
          <Btn onClick={() => router.push("/dashboard/script")}>
            Write the script <ChevronRight size={15} />
          </Btn>
        </Card>
      )}

      {!data.run && (
        <div style={{ marginBottom: 16 }}>
          <EmptyCTA
            icon={<Search size={22} />}
            title="No research yet"
            body="Vidxir AI will read your niche on YouTube, score what is breaking out, and propose original angles you can actually make. Nothing here is pre-filled — the numbers come from a real run."
            action={
              <Btn onClick={runResearch} loading={busy === "run"} icon={<Search size={15} />}>
                Run research
              </Btn>
            }
          />
        </div>
      )}

      {data.run && (
        <RunStatus
          run={data.run}
          stage={stage}
          onRerun={runResearch}
          busy={working}
        />
      )}

      <div
        className="vidxir-research-top"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.2fr) minmax(260px, 1fr)",
          gap: 16,
          marginBottom: 16,
        }}
      >
        <Card>
          <h3
            style={{
              fontSize: 15,
              margin: "0 0 14px",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <TrendingUp size={16} color={color.accent} aria-hidden="true" /> Trending now
          </h3>

          {data.trending.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: color.textDim, lineHeight: 1.6 }}>
              Nothing yet. A completed research run lists the videos actually
              breaking out in your niche here, with the views per hour Vidxir AI
              measured.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {data.trending.map((row) => (
                <div
                  key={row.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 12,
                    padding: 10,
                    margin: "0 -10px",
                    borderRadius: radius.md,
                    border: "1px solid transparent",
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
                      color: row.viewsPerHour === null ? color.textFaint : color.positive,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.viewsPerHour === null
                      ? "—"
                      : `${compact(Math.round(row.viewsPerHour))}/hr`}
                  </span>
                </div>
              ))}
            </div>
          )}

          <p
            style={{
              margin: "14px 0 0",
              fontSize: 11.5,
              lineHeight: 1.55,
              color: color.textFaint,
            }}
          >
            These are source signals, not templates. Vidxir AI builds an original
            angle from the underlying opportunity rather than reproducing someone
            else&apos;s video.
          </p>
        </Card>

        <Card>
          <h3
            style={{
              fontSize: 15,
              margin: "0 0 14px",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <BarChart3 size={16} color={color.accent} aria-hidden="true" /> Search demand
          </h3>
          <DemandChart series={data.run?.demandSeries ?? null} />
        </Card>
      </div>

      <div
        className="vidxir-research-bottom"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          gap: 16,
        }}
      >
        <Card>
          <h3
            style={{
              fontSize: 15,
              margin: "0 0 14px",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Target size={16} color={color.accent} aria-hidden="true" /> Competitor top videos
          </h3>
          {data.competitors.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: color.textDim, lineHeight: 1.6 }}>
              Competitors appear once research has run and Vidxir AI can see who is
              winning the topics you are targeting.
            </p>
          ) : (
            data.competitors.map((c) => (
              <div
                key={c.channelTitle}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "9px 0",
                  fontSize: 13.5,
                  borderBottom: `1px solid ${color.borderFaint}`,
                }}
              >
                <span
                  style={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {c.channelTitle}
                </span>
                <span style={{ color: color.textDim, whiteSpace: "nowrap" }}>
                  {compact(c.totalViews)}
                </span>
              </div>
            ))
          )}
        </Card>

        <Card>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              marginBottom: 14,
            }}
          >
            <h3
              style={{
                fontSize: 15,
                margin: 0,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Bookmark size={16} color={color.accent} aria-hidden="true" /> Idea vault
            </h3>
            {data.ideas.length > 0 && (
              <span style={{ fontSize: 11.5, color: color.textFaint }}>
                Vidxir AI Opportunity Score
              </span>
            )}
          </div>

          {data.ideas.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: color.textDim, lineHeight: 1.6 }}>
              {canGenerateIdeas
                ? "Run research and Vidxir AI will propose original angles here, each with its own opportunity score."
                : "Idea generation needs the AI provider to be configured before it can propose angles."}
            </p>
          ) : (
            data.ideas.map((idea) => {
              const selected = idea.id === data.selectedIdeaId;
              return (
                <button
                  key={idea.id}
                  type="button"
                  onClick={() => selectIdea(idea.id)}
                  disabled={working}
                  style={{
                    all: "unset",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "9px 10px",
                    margin: "0 -10px",
                    borderRadius: radius.md,
                    fontSize: 13.5,
                    cursor: working ? "wait" : "pointer",
                    background: selected ? color.accentBgSoft : "transparent",
                    border: `1px solid ${selected ? color.accent : "transparent"}`,
                  }}
                >
                  <Lightbulb
                    size={13}
                    color={selected ? color.accent : color.textDim}
                    aria-hidden="true"
                  />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {idea.title}
                  </span>
                  <span
                    title="Vidxir AI's own score — not a YouTube metric"
                    style={{
                      fontFamily: font.display,
                      fontSize: 12,
                      color:
                        idea.vidxirScore === null ? color.textFaint : color.accent,
                      flexShrink: 0,
                    }}
                  >
                    {idea.vidxirScore === null ? "—" : Math.round(idea.vidxirScore)}
                  </span>
                </button>
              );
            })
          )}

          {data.ideas.length > 0 && (
            <p
              style={{
                margin: "14px 0 0",
                fontSize: 11.5,
                lineHeight: 1.55,
                color: color.textFaint,
              }}
            >
              The Vidxir AI Opportunity Score is calculated by Vidxir AI from trend,
              competition, velocity and fit. It is not a YouTube metric.
            </p>
          )}
        </Card>
      </div>

      <style>{`
        @media (max-width: 900px) {
          .vidxir-research-top,
          .vidxir-research-bottom { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

/**
 * Real run status. A queued or running job says so and offers no fake percentage;
 * a failed run shows its error and a retry (§30, §37).
 */
function RunStatus({
  run,
  stage,
  onRerun,
  busy,
}: {
  run: NonNullable<ResearchData["run"]>;
  /** The worker's recorded stage, when a job is active. */
  stage: string | null;
  onRerun: () => void;
  busy: boolean;
}) {
  const label: Record<typeof run.status, string> = {
    queued: "Queued — waiting for a worker",
    running: "Researching your niche…",
    succeeded: "Research complete",
    failed: "Research failed",
    cancelled: "Research cancelled",
    // Two different causes share this status. A run stopped by an empty Claude
    // balance must not tell someone their credentials are missing — the key is
    // fine, and they would go and check the wrong thing.
    blocked_not_configured: `Blocked — ${blockedReasonLabel(run.errorCode)}`,
  };

  const tone =
    run.status === "failed" || run.status === "blocked_not_configured"
      ? "warning"
      : "default";

  return (
    <Card
      tone={tone}
      pad={14}
      style={{
        marginBottom: 16,
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
            color: tone === "warning" ? color.warning : color.textFaint,
            marginBottom: 4,
          }}
        >
          {label[run.status]}
        </div>
        <div style={{ fontSize: 12.5, color: color.textDim, lineHeight: 1.5 }}>
          {run.error
            ? run.error
            : // The worker's own note takes precedence while it is working: it is
              // the most specific true thing we know about the run right now.
              (stage ??
              (run.sources.length > 0
                ? `Sources: ${run.sources.join(", ")}`
                : run.niche
                  ? `Niche: ${run.niche}`
                  : "Waiting for signal sources"))}
        </div>
      </div>
      <Btn
        variant="ghost"
        size="sm"
        onClick={onRerun}
        loading={busy}
        icon={<RefreshCw size={13} />}
      >
        Run research
      </Btn>
    </Card>
  );
}

"use client";

/**
 * Script workspace — the prototype's Script tab (STAGE 02).
 *
 * Preserved: the idle → loading → ready progression, the 1.3fr/1fr split, the
 * "SCRIPT v1.0" eyebrow with the Wand2 glyph, the accent TITLE / HOOK / STORY /
 * CTA labels with timecodes, the numbered storyboard rows, and the full-width
 * "Send to video builder" + "Regenerate" buttons.
 *
 * Changed fundamentally: the prototype's `setTimeout(..., 1000)` is replaced by a
 * queued background job. "Writing hook, story beats, and a CTA…" now appears only
 * while the project's *persisted* status is SCRIPT_GENERATING, so the state is
 * identical after a refresh and cannot get stuck client-side (§9, §42).
 */
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  ChevronRight,
  Loader2,
  RefreshCw,
  Sparkles,
  Wand2,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Btn } from "@/components/ui/Btn";
import { EmptyCTA } from "@/components/ui/SectionHeader";
import { StatusChip } from "@/components/dashboard/StatusChip";
import { color, font, radius } from "@/lib/design/tokens";
import { formatTime } from "@/lib/dashboard/format";
import type { ScriptView } from "@/lib/dashboard/stage";
import type { ProjectStatus } from "@/lib/projects/state-machine";
import { api, messageOf } from "@/services/api-client";

export interface ScriptWorkspaceProps {
  projectId: string | null;
  projectTitle: string | null;
  status: ProjectStatus | null;
  script: ScriptView | null;
  ideaTitle: string | null;
  /** Failure recorded on the project, shown instead of a spinner (§30). */
  error: { message: string; code: string | null } | null;
  canGenerate: boolean;
}

/** How often to re-check a running job. Cheap, and never fakes progress. */
const POLL_MS = 4000;

export function ScriptWorkspace({
  projectId,
  projectTitle,
  status,
  script,
  ideaTitle,
  error,
  canGenerate,
}: ScriptWorkspaceProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const generating = status === "SCRIPT_GENERATING";

  // While the worker is writing, re-read the server. The UI shows what the
  // database says; it never advances on a timer of its own.
  useEffect(() => {
    if (!generating) return;
    const id = setInterval(() => startTransition(() => router.refresh()), POLL_MS);
    return () => clearInterval(id);
  }, [generating, router, startTransition]);

  async function generate() {
    setActionError(null);
    setBusy(true);
    try {
      await api.post("/api/scripts/generate", { projectId });
      startTransition(() => router.refresh());
    } catch (e) {
      setActionError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setActionError(null);
    setBusy(true);
    try {
      await api.post("/api/scripts/approve", { projectId });
      router.push("/dashboard/video");
    } catch (e) {
      setActionError(messageOf(e));
      setBusy(false);
    }
  }

  const notice = actionError ?? error?.message ?? null;

  if (!projectId) {
    return (
      <EmptyCTA
        icon={<Sparkles size={22} />}
        title="No video started"
        body="Pick an idea in Research first — a script is written for a specific opportunity, not from a blank page."
        action={
          <Btn onClick={() => router.push("/dashboard/research")}>
            Find an idea <ChevronRight size={15} />
          </Btn>
        }
      />
    );
  }

  return (
    <div>
      {notice && (
        <Card tone="warning" pad={14} style={{ marginBottom: 16 }}>
          <p style={{ margin: 0, fontSize: 13, color: color.warning, lineHeight: 1.6 }}>
            {notice}
          </p>
        </Card>
      )}

      {generating && (
        <Card style={{ textAlign: "center", padding: 40 }}>
          <Loader2
            size={20}
            color={color.accent}
            className="tally-spin"
            style={{ marginBottom: 12 }}
            aria-hidden="true"
          />
          <p style={{ color: color.textDim, fontSize: 14, margin: 0 }}>
            Writing hook, story beats, and a CTA…
          </p>
          <p
            style={{
              color: color.textFaint,
              fontSize: 12,
              margin: "10px 0 0",
              lineHeight: 1.55,
            }}
          >
            This runs on the server. You can close this tab — the script will be
            here when you come back.
          </p>
        </Card>
      )}

      {!generating && !script && (
        <EmptyCTA
          icon={<Wand2 size={22} />}
          title="No script yet"
          body={
            canGenerate
              ? ideaTitle
                ? `Ready to write a script for “${ideaTitle}.”`
                : `Ready to write a script for “${projectTitle ?? "this video"}.”`
              : "Script generation needs the AI provider to be configured before it can run."
          }
          action={
            <Btn onClick={generate} loading={busy} disabled={!canGenerate}>
              Generate script <ChevronRight size={15} />
            </Btn>
          }
        />
      )}

      {!generating && script && (
        <>
          <div
            className="tally-script-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1.3fr) minmax(260px, 1fr)",
              gap: 16,
            }}
          >
            <Card>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 16,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    color: color.textFaint,
                    fontWeight: 700,
                    letterSpacing: "0.05em",
                  }}
                >
                  SCRIPT v{script.version}.0
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  {status && <StatusChip status={status} size="sm" />}
                  <Wand2 size={15} color={color.accent} aria-hidden="true" />
                </div>
              </div>

              <Label>TITLE</Label>
              <p style={{ fontSize: 15, margin: "0 0 18px" }}>{script.title}</p>

              <Label>
                HOOK · {formatTime(0)}–{formatTime(hookEnd(script))}
              </Label>
              <p style={{ fontSize: 14, color: color.textBright, margin: "0 0 18px" }}>
                {script.hook}
              </p>

              {script.introduction && (
                <>
                  <Label>INTRO</Label>
                  <p style={{ fontSize: 14, color: color.textBright, margin: "0 0 18px" }}>
                    {script.introduction}
                  </p>
                </>
              )}

              <Label>
                STORY · {formatTime(hookEnd(script))}–{formatTime(storyEnd(script))}
              </Label>
              {script.sections.map((section, i) => (
                <div key={`${section.heading}-${i}`} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 13.5, color: color.textMuted, padding: "6px 0" }}>
                    • {section.heading}
                  </div>
                  {section.body && (
                    <p
                      style={{
                        margin: "0 0 0 14px",
                        fontSize: 13,
                        lineHeight: 1.65,
                        color: color.textDim,
                      }}
                    >
                      {section.body}
                    </p>
                  )}
                </div>
              ))}

              {script.conclusion && (
                <>
                  <Label style={{ marginTop: 14 }}>CONCLUSION</Label>
                  <p style={{ fontSize: 14, color: color.textBright, margin: "0 0 18px" }}>
                    {script.conclusion}
                  </p>
                </>
              )}

              {script.cta && (
                <>
                  <Label style={{ marginTop: 14 }}>
                    CTA · {formatTime(storyEnd(script))}–{formatTime(totalSeconds(script))}
                  </Label>
                  <p style={{ fontSize: 14, color: color.textBright, margin: 0 }}>
                    {script.cta}
                  </p>
                </>
              )}

              <div
                style={{
                  marginTop: 20,
                  paddingTop: 14,
                  borderTop: `1px solid ${color.borderFaint}`,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 14,
                  fontSize: 11.5,
                  color: color.textFaint,
                }}
              >
                <span>
                  {script.wordCount === null
                    ? "Word count not recorded"
                    : `${script.wordCount} words`}
                </span>
                <span>
                  {script.estimatedDurationSeconds === null
                    ? "Duration not estimated"
                    : `≈ ${formatTime(script.estimatedDurationSeconds)} spoken`}
                </span>
                <span>
                  {script.source === "ai"
                    ? `${script.provider ?? "provider"} · ${script.model ?? "model"}`
                    : "Edited by you"}
                </span>
              </div>
            </Card>

            <Card>
              <h3 style={{ fontSize: 15, margin: "0 0 14px" }}>Storyboard</h3>
              {beats(script).map((beat, i, all) => (
                <div
                  key={`${beat.label}-${i}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 0",
                    borderBottom:
                      i < all.length - 1 ? `1px solid ${color.borderFaint}` : "none",
                  }}
                >
                  <div
                    style={{
                      width: 44,
                      height: 30,
                      borderRadius: radius.sm,
                      background: color.subtle,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                      color: color.textFaint,
                      flexShrink: 0,
                    }}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13.5,
                        fontWeight: 600,
                        color: color.accent,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {beat.label}
                    </div>
                    <div style={{ fontSize: 11.5, color: color.textFaint }}>
                      {beat.time}
                    </div>
                  </div>
                </div>
              ))}

              <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                <Btn full onClick={approve} loading={busy || pending}>
                  Send to video builder <ChevronRight size={15} />
                </Btn>
                <Btn full variant="ghost" onClick={generate} loading={busy}>
                  <RefreshCw size={14} /> Regenerate
                </Btn>
              </div>

              {script.titleIdeas.length > 0 && (
                <div style={{ marginTop: 18 }}>
                  <div
                    style={{
                      fontFamily: font.display,
                      fontSize: 10.5,
                      letterSpacing: 1.3,
                      textTransform: "uppercase",
                      color: color.textFaint,
                      marginBottom: 8,
                    }}
                  >
                    Other title options
                  </div>
                  {script.titleIdeas.map((idea) => (
                    <div
                      key={idea}
                      style={{
                        fontSize: 12.5,
                        color: color.textDim,
                        padding: "5px 0",
                        lineHeight: 1.5,
                      }}
                    >
                      {idea}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <style>{`
            @media (max-width: 900px) {
              .tally-script-grid { grid-template-columns: 1fr !important; }
            }
          `}</style>
        </>
      )}
    </div>
  );
}

function Label({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        fontSize: 11,
        color: color.accent,
        fontWeight: 700,
        marginBottom: 6,
        letterSpacing: 0.5,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timecodes
//
// The prototype hard-coded "0:00–0:05", "0:05–3:30", "3:30–3:45". Real scripts
// vary, so the boundaries are derived from the estimated duration the generator
// recorded. With no estimate the labels omit times rather than invent them.
// ---------------------------------------------------------------------------

function totalSeconds(script: ScriptView): number {
  return script.estimatedDurationSeconds ?? 0;
}

function hookEnd(script: ScriptView): number {
  const total = totalSeconds(script);
  // A hook is short and roughly proportional: 5s on a 5-minute video.
  return total > 0 ? Math.max(3, Math.round(total * 0.017)) : 0;
}

function storyEnd(script: ScriptView): number {
  const total = totalSeconds(script);
  return total > 0 ? Math.round(total * 0.93) : 0;
}

function beats(script: ScriptView): Array<{ label: string; time: string }> {
  const total = totalSeconds(script);
  const labels = [
    "Hook",
    ...script.sections.map((s) => s.heading),
    ...(script.cta ? ["CTA"] : []),
  ];

  if (total <= 0) {
    return labels.map((label) => ({ label, time: "timing not estimated" }));
  }

  // Weight the hook lightly and split the remainder across the sections.
  const hookLength = hookEnd(script);
  const rest = Math.max(0, total - hookLength);
  const bodyCount = Math.max(1, labels.length - 1);
  const each = rest / bodyCount;

  let cursor = 0;
  return labels.map((label, i) => {
    const length = i === 0 ? hookLength : each;
    const from = cursor;
    cursor += length;
    return {
      label,
      time: `${formatTime(from)}–${formatTime(Math.min(total, cursor))}`,
    };
  });
}

"use client";

/**
 * The overview's front door: describe a video, press Generate.
 *
 * Borrowed from the vidxr-dashboard reference, which opens on a single prompt
 * box rather than a stat grid. The reference is a static prototype, so what it
 * models is the *shape* of the entry point; the behaviour here is the real
 * `/api/projects/from-description` flow that `/dashboard/describe` already uses.
 *
 * This is deliberately an entry point and not a replacement for that screen. It
 * creates the project and hands off:
 *
 *   PromptBox  ->  POST /api/projects/from-description  ->  /dashboard/describe?project=<id>
 *
 * The pipeline past that point — research, angle, generation method, script,
 * video — is unchanged and still lives in `LinkStudio`. Nothing is duplicated:
 * this component owns one textarea, one optional refinement, and one request.
 *
 * §19/§21 hold as they do everywhere else: the plan check, the allowance charge
 * and the model validation are all re-derived server-side. The disabled state on
 * the button is a courtesy, and the character counter is a courtesy; the route's
 * zod schema is the real bound.
 */
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { color, font, radius, shadow } from "@/lib/design/tokens";
import {
  MAX_DESCRIPTION_CHARS,
  MIN_DESCRIPTION_CHARS,
  // The limits module, not `description.ts`: that one reaches googleapis.
} from "@/lib/research/description-limits";
import { api, messageOf } from "@/services/api-client";

/**
 * The duration choices, mirroring the reference's drawer.
 *
 * `null` is a real option and the default: the route treats an omitted target as
 * "decide later" and the worker's interpretation step derives one from the
 * description. Forcing a choice here would make the user answer questions
 * before seeing anything, which is what the pipeline screens are for.
 *
 * The reference offers 15s/30s/50s as well. They are not here because
 * `from-description` clamps `targetDurationSeconds` to a 60–1,200s band — the
 * range the pipeline can actually render — so a 15-second chip would either be
 * rejected by the schema or silently become a minute. Offering a choice the
 * backend cannot honour is worse than not offering it.
 */
const DURATIONS = [
  { label: "1 minute", seconds: 60 },
  { label: "1.5 minutes", seconds: 90 },
  { label: "2 minutes", seconds: 120 },
  { label: "5 minutes", seconds: 300 },
  { label: "10 minutes", seconds: 600 },
] as const;

const AUDIENCES = ["Kids", "Teens", "Families", "Professionals"] as const;

export interface PromptBoxProps {
  /**
   * Whether an AI provider is configured. False disables the button and says
   * why, rather than letting the request fail at the worker (§48).
   */
  aiConfigured: boolean;
}

export function PromptBox({ aiConfigured }: PromptBoxProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [description, setDescription] = useState("");
  const [showRefine, setShowRefine] = useState(false);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [audience, setAudience] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Measured the way the route measures it, so the counter and the server's
  // length check cannot disagree about a paste full of newlines.
  const normalised = description.trim().replace(/\s+/g, " ");
  const tooShort = normalised.length < MIN_DESCRIPTION_CHARS;
  const tooLong = normalised.length > MAX_DESCRIPTION_CHARS;
  const canSubmit = aiConfigured && !tooShort && !tooLong && !busy;

  async function generate() {
    if (!canSubmit) return;
    setError(null);
    setBusy(true);
    try {
      /**
       * Only fields `BodySchema` declares are sent.
       *
       * `audience` is not one of them, so it is folded into the description —
       * the string the interpretation step actually reads — rather than sent as
       * a parameter nothing would consume. `format` is omitted for the same
       * reason in reverse: the route only reads it through `validateSelection`,
       * which runs when `mode` is present, and choosing a generation mode is a
       * plan-gated decision that belongs on the pipeline screen, not here.
       */
      const body: Record<string, unknown> = {
        description: audience ? `${normalised} (for ${audience})` : normalised,
      };
      if (seconds !== null) body.targetDurationSeconds = seconds;

      const result = await api.post<{ project: { id: string } }>(
        "/api/projects/from-description",
        body,
      );

      // Hand off to the full flow, project-scoped so the URL says which one.
      startTransition(() => {
        router.push(`/dashboard/describe?project=${result.project.id}`);
        router.refresh();
      });
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
    // No `finally`: on success the route change unmounts this, and clearing
    // `busy` first would flash the idle button during the transition.
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl+Enter submits, the convention for a multiline composer.
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void generate();
    }
  }

  return (
    <div style={{ width: "100%", maxWidth: 740, margin: "0 auto" }}>
      <div style={{ position: "relative" }}>
        <textarea
          ref={textareaRef}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
          rows={6}
          aria-label="Describe the video you want to generate"
          placeholder="Describe the type of video you want to generate…"
          style={{
            width: "100%",
            minHeight: 190,
            // Room for the footer row, which is absolutely positioned so the
            // counter and button sit inside the box as they do in the reference.
            padding: "20px 20px 64px",
            background: color.card,
            border: `1px solid ${tooLong ? color.fieldErrorBorder : color.border}`,
            borderRadius: radius.xxl,
            color: color.text,
            fontFamily: font.body,
            fontSize: 15,
            lineHeight: 1.6,
            resize: "vertical",
            outline: "none",
          }}
        />

        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "0 20px 18px",
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              fontSize: 12.5,
              color: tooLong ? color.danger : color.textDim,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {normalised.length}/{MAX_DESCRIPTION_CHARS}
          </span>

          <div
            style={{ display: "flex", gap: 9, pointerEvents: "auto" }}
          >
            <button
              type="button"
              onClick={() => setShowRefine((open) => !open)}
              aria-expanded={showRefine}
              style={{
                background: "transparent",
                border: `1px solid ${color.border}`,
                borderRadius: radius.pill,
                padding: "8px 14px",
                color: color.textMuted,
                fontFamily: font.body,
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              {showRefine ? "Hide options" : "Options"}
            </button>

            <button
              type="button"
              onClick={generate}
              disabled={!canSubmit}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                background: canSubmit ? color.accent : color.subtle,
                border: "none",
                borderRadius: radius.pill,
                padding: "9px 18px",
                color: canSubmit ? color.onAccent : color.textFaint,
                fontFamily: font.body,
                fontSize: 13.5,
                fontWeight: 600,
                cursor: canSubmit ? "pointer" : "not-allowed",
                boxShadow: canSubmit ? shadow.panel : undefined,
              }}
            >
              {busy ? (
                <>
                  <Loader2 size={15} className="vidxir-spin" />
                  Starting…
                </>
              ) : (
                <>
                  Generate
                  <Sparkles size={15} />
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {showRefine && (
        <div
          className="vidxir-fade-up"
          style={{
            marginTop: 14,
            padding: 18,
            background: color.card,
            border: `1px solid ${color.border}`,
            borderRadius: radius.xl,
            display: "grid",
            gap: 16,
          }}
        >
          <ChipRow
            label="Duration"
            options={DURATIONS.map((d) => d.label)}
            selected={
              seconds === null
                ? null
                : (DURATIONS.find((d) => d.seconds === seconds)?.label ?? null)
            }
            onSelect={(label) => {
              const hit = DURATIONS.find((d) => d.label === label);
              // Re-clicking the active chip clears it, back to "decide later".
              setSeconds(
                hit && hit.seconds !== seconds ? hit.seconds : null,
              );
            }}
          />
          <ChipRow
            label="Audience"
            options={[...AUDIENCES]}
            selected={audience}
            onSelect={(value) =>
              setAudience((prev) => (prev === value ? null : value))
            }
          />
          <p style={{ margin: 0, fontSize: 12, color: color.textFaint, lineHeight: 1.6 }}>
            Anything you leave unset, Vidxir AI decides from your description.
            You pick the generation method and format on the next screen.
          </p>
        </div>
      )}

      {!aiConfigured && (
        <p
          style={{
            margin: "12px 0 0",
            fontSize: 12.5,
            color: color.warning,
            textAlign: "center",
          }}
        >
          Video generation is not configured on this deployment yet.
        </p>
      )}

      {error && (
        <div
          role="alert"
          style={{
            marginTop: 12,
            padding: "11px 14px",
            background: color.dangerBg,
            border: `1px solid ${color.dangerBorder}`,
            borderRadius: radius.md,
            color: color.rose,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

interface ChipRowProps {
  label: string;
  options: string[];
  selected: string | null;
  onSelect: (value: string) => void;
}

/** A labelled row of pill toggles — the reference's drawer sections. */
function ChipRow({ label, options, selected, onSelect }: ChipRowProps) {
  return (
    <div>
      <div
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          color: color.textDim,
          marginBottom: 9,
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {options.map((option) => {
          const active = selected === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(option)}
              style={{
                background: active ? color.accent : "transparent",
                border: `1px solid ${active ? color.accent : color.border}`,
                borderRadius: radius.pill,
                padding: "7px 14px",
                color: active ? color.onAccent : color.textMuted,
                fontFamily: font.body,
                fontSize: 12.5,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

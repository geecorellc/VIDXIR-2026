"use client";

/**
 * Generation method picker (Phase 11 §9, §10, §16, §19, §21).
 *
 * The "VIDEO GENERATION" step of §18: stock footage, or AI video and which model,
 * and into what frame. Three things about it are load-bearing.
 *
 * **The catalogue is not in this file.** It is fetched from
 * `/api/video/providers`, which computes it from `VIDEO_GEN_PROVIDERS` and the
 * caller's subscription. §10 requires available models to come from server-side
 * provider configuration, and this component has no list of models in it to fall
 * out of date — a deployment that configures nothing renders a picker offering
 * stock footage only, without a code change.
 *
 * **No key ever reaches here.** The response carries labels, states and env var
 * *names*; `videoGenStatuses()` has no code path that reads a credential's value
 * (§21). So the unconfigured notice below can name `FAL_KEY` without naming its
 * contents.
 *
 * **Nothing here is an authorisation.** A `locked` model is a display hint about
 * an upgrade and a disabled Save is a convenience. `/api/projects/configure`
 * re-runs `validateSelection` against the tier read from the database, so a client
 * that flips a flag in the console gets 402 or 503 from the server and stores
 * nothing (§19, "do not allow the frontend to grant itself access").
 */
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Check, Film, Lock, Sparkles } from "lucide-react";
import { ConfigNotice } from "@/components/dashboard/ConfigNotice";
import { Btn } from "@/components/ui/Btn";
import { Card } from "@/components/ui/Card";
import { ChoiceGrid } from "@/components/ui/ChoiceGrid";
import { color, font, radius } from "@/lib/design/tokens";
import type { CapabilityStatus } from "@/lib/providers/config";
import type { FormatSpec } from "@/lib/video/format";
import type {
  GenerationModeOption,
  GenerationModelOption,
} from "@/lib/video/generation-plan";
import { api, messageOf } from "@/services/api-client";

/** One provider's configuration state. Names only — never a value (§20). */
interface ProviderRow {
  provider: string;
  label: string;
  state: "ready" | "mock" | "not_configured" | "disabled";
  missingEnvVars: string[];
  hint: string;
  serviceNote: string | null;
}

/** The shape `/api/video/providers` returns. */
interface ProvidersResponse {
  modes: GenerationModeOption[];
  models: GenerationModelOption[];
  aiAvailable: boolean;
  formats: FormatSpec[];
  providers: ProviderRow[];
  stock: CapabilityStatus;
}

export interface GenerationPickerProps {
  projectId: string;
  /** The project's stored choice, or null on a project that has not chosen. */
  mode: string | null;
  model: string | null;
  format: string | null;
  /** True while another stage is running, or once the choice is no longer editable. */
  disabled: boolean;
  /** Called after the server accepted and persisted the selection. */
  onSaved: () => void;
}

export function GenerationPicker({
  projectId,
  mode,
  model,
  format,
  disabled,
  onSaved,
}: GenerationPickerProps) {
  const [options, setOptions] = useState<ProvidersResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState(mode ?? "STOCK");
  const [selectedModel, setSelectedModel] = useState(model);
  const [selectedFormat, setSelectedFormat] = useState(format ?? "landscape");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    api
      .get<ProvidersResponse>("/api/video/providers")
      .then((result) => {
        if (!cancelled) setOptions(result);
      })
      .catch((e: unknown) => {
        // The picker cannot be rendered honestly without the server's catalogue,
        // so the failure is shown rather than replaced with a guessed list.
        if (!cancelled) setLoadError(messageOf(e));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) {
    return (
      <Card tone="warning" pad={16}>
        <p style={{ margin: 0, fontSize: 13, color: color.warning }}>
          Could not load the available generation methods: {loadError}
        </p>
      </Card>
    );
  }

  if (!options) {
    return (
      <Card pad={16}>
        <p style={{ margin: 0, fontSize: 13, color: color.textDim }}>
          Reading which generation methods this deployment offers…
        </p>
      </Card>
    );
  }

  /**
   * Models that can actually produce the chosen frame (§16).
   *
   * Veo generates 16:9 and 9:16 only, so a square project must not be able to
   * select it — the render would either fail or crop the subject out. Shown as
   * unavailable-for-this-format rather than hidden, so switching the format back
   * explains where the model went.
   */
  // Bound once, above the handlers: a hoisted function declaration cannot see the
  // `!options` guard above it, since TypeScript has to assume it might be called
  // before the narrowing ran.
  const models = options.models;

  const compatible = models.filter((m) =>
    (m.formats as readonly string[]).includes(selectedFormat),
  );

  const aiMode = options.modes.find((m) => m.mode === "AI_VIDEO");
  const aiLocked = aiMode?.locked ?? true;
  const unconfigured = options.providers.filter(
    (p) => p.state === "not_configured",
  );

  function chooseMode(next: string) {
    setSelectedMode(next);
    setError(null);
    if (next === "STOCK") {
      // A model cannot be stored alongside stock mode — `validateSelection`
      // refuses the pair rather than ignoring the model, so clear it here too.
      setSelectedModel(null);
      return;
    }
    if (!selectedModel) {
      const first = compatible.find((m) => !m.locked) ?? compatible[0];
      setSelectedModel(first?.id ?? null);
    }
  }

  function chooseFormat(next: string) {
    setSelectedFormat(next);
    setError(null);
    // The stored model may not generate the new frame. Dropping it here means the
    // Save button asks for a model again instead of submitting a pair the server
    // will refuse.
    if (
      selectedModel &&
      !models.some(
        (m) =>
          m.id === selectedModel &&
          (m.formats as readonly string[]).includes(next),
      )
    ) {
      setSelectedModel(null);
    }
  }

  const dirty =
    selectedMode !== (mode ?? "STOCK") ||
    selectedModel !== model ||
    selectedFormat !== (format ?? "landscape");

  const needsModel = selectedMode === "AI_VIDEO" && !selectedModel;

  async function save() {
    setError(null);
    setSaving(true);
    try {
      // Mode and format always travel together: the route refuses a bare format
      // change because the frame is not independent of the model (§16).
      await api.patch("/api/projects/configure", {
        projectId,
        mode: selectedMode,
        model: selectedMode === "AI_VIDEO" ? selectedModel : null,
        format: selectedFormat,
      });
      onSaved();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {selectedMode === "STOCK" && <ConfigNotice status={options.stock} />}

      <div>
        <Legend>How the footage is made</Legend>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 10,
          }}
        >
          {options.modes.map((option) => (
            <OptionButton
              key={option.mode}
              selected={option.mode === selectedMode}
              disabled={disabled}
              onClick={() => chooseMode(option.mode)}
              icon={
                option.mode === "STOCK" ? (
                  <Film size={14} aria-hidden="true" />
                ) : (
                  <Sparkles size={14} aria-hidden="true" />
                )
              }
              label={option.label}
              hint={option.description}
              badge={option.locked ? "Upgrade" : null}
            />
          ))}
        </div>
      </div>

      {selectedMode === "AI_VIDEO" && (
        <div>
          <Legend>Video model</Legend>

          {compatible.length === 0 ? (
            <Card tone="warning" pad={14}>
              <p style={{ margin: 0, fontSize: 13, color: color.warning }}>
                {options.models.length === 0
                  ? "No AI video provider is configured on this deployment, so " +
                    "there is no model to choose. Stock footage still works."
                  : `No configured model generates ${labelFor(options.formats, selectedFormat)} video. Choose a different format, or use stock footage.`}
              </p>
            </Card>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
                gap: 10,
              }}
            >
              {compatible.map((option) => (
                <OptionButton
                  key={option.id}
                  selected={option.id === selectedModel}
                  disabled={disabled}
                  onClick={() => {
                    setSelectedModel(option.id);
                    setError(null);
                  }}
                  icon={<Sparkles size={14} aria-hidden="true" />}
                  label={option.label}
                  hint={`${option.description} Clips up to ${option.maxClipSeconds}s.`}
                  badge={option.locked ? "Upgrade" : null}
                />
              ))}
            </div>
          )}

          {/*
            §20, §48: a provider that is enabled but has no credential is named,
            with the variables an operator has to set. This is why the response
            carries per-provider state and not just a filtered model list — an
            empty picker otherwise reads as "this feature does not exist".
          */}
          {unconfigured.length > 0 && (
            <div style={{ marginTop: 12 }}>
              {unconfigured.map((provider) => (
                <p
                  key={provider.provider}
                  style={{
                    margin: "0 0 6px",
                    fontSize: 12,
                    lineHeight: 1.55,
                    color: color.textFaint,
                  }}
                >
                  {provider.label} is enabled but not configured —{" "}
                  {provider.missingEnvVars.join(", ")} is unset.
                  {provider.serviceNote ? ` ${provider.serviceNote}` : ""}
                </p>
              ))}
            </div>
          )}

          {aiLocked && (
            <p
              style={{
                margin: "10px 0 0",
                fontSize: 12,
                lineHeight: 1.55,
                color: color.textFaint,
              }}
            >
              AI video generation is not included in your plan. Selecting it here
              will be refused when you save — your plan is checked on the server.
            </p>
          )}
        </div>
      )}

      <ChoiceGrid
        legend="Video format"
        options={options.formats.map((spec) => ({
          value: spec.format,
          label: spec.label,
          hint: spec.description,
        }))}
        value={selectedFormat}
        onChange={chooseFormat}
        minWidth={200}
      />

      {error && (
        <Card tone="warning" pad={14}>
          <p style={{ margin: 0, fontSize: 13, color: color.warning }}>{error}</p>
        </Card>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Btn
          onClick={save}
          loading={saving}
          disabled={disabled || saving || !dirty || needsModel}
          icon={<Check size={14} />}
        >
          Save generation method
        </Btn>
        {!dirty && mode && (
          <span style={{ fontSize: 12.5, color: color.textFaint }}>
            Saved. This video will be built with {describe(mode, model, options)}.
          </span>
        )}
        {needsModel && (
          <span style={{ fontSize: 12.5, color: color.textFaint }}>
            Choose a model to continue.
          </span>
        )}
      </div>
    </div>
  );
}

/** The stored choice in one sentence, for the "saved" confirmation. */
function describe(
  mode: string,
  model: string | null,
  options: ProvidersResponse,
): string {
  if (mode !== "AI_VIDEO") return "stock footage";
  const label = options.models.find((m) => m.id === model)?.label;
  return label ? `${label}` : "an AI video model";
}

function labelFor(formats: FormatSpec[], format: string): string {
  return formats.find((spec) => spec.format === format)?.label ?? format;
}

function Legend({ children }: { children: string }) {
  return (
    <div
      style={{
        fontFamily: font.display,
        fontSize: 10.5,
        letterSpacing: 1.3,
        textTransform: "uppercase",
        color: color.textFaint,
        fontWeight: 500,
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

/**
 * One selectable card.
 *
 * `ChoiceGrid` covers the format row, but modes and models need a lock badge and
 * an icon, and a locked option must stay *clickable* so the server is the thing
 * that refuses it — a silently un-selectable card teaches the user nothing.
 */
function OptionButton({
  selected,
  disabled,
  onClick,
  icon,
  label,
  hint,
  badge,
}: {
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  hint: string;
  badge: string | null;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      style={{
        all: "unset",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        width: "100%",
        padding: "13px 14px",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        background: selected ? color.accentBgSoft : color.card,
        border: `1px solid ${selected ? color.accent : color.border}`,
        borderRadius: radius.md,
        boxShadow: selected
          ? "0 0 0 1px #E8332B, 0 0 22px rgba(232,51,43,0.14)"
          : "none",
      }}
    >
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13.5,
          fontWeight: 600,
          color: selected ? color.text : color.textBright,
        }}
      >
        <span style={{ color: selected ? color.accent : color.textFaint }}>
          {icon}
        </span>
        {label}
        {badge && (
          <span
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 10.5,
              fontFamily: font.display,
              letterSpacing: 1,
              textTransform: "uppercase",
              color: color.warning,
            }}
          >
            <Lock size={10} aria-hidden="true" />
            {badge}
          </span>
        )}
      </span>
      <span style={{ fontSize: 12, lineHeight: 1.5, color: color.textDim }}>
        {hint}
      </span>
    </button>
  );
}

"use client";

/**
 * Generation method picker (Phase 11 §9, §10, §16, §19, §21; Phase 12 §3, §4).
 *
 * The "VIDEO GENERATION" step of §18: stock footage, or AI video and which Vidxir AI
 * model, and into what frame. Four things about it are load-bearing.
 *
 * **The catalogue is not in this file.** It is fetched from
 * `/api/video/providers`, which computes it from `VIDEO_GEN_PROVIDERS` and the
 * caller's subscription. §10 requires available models to come from server-side
 * provider configuration, and this component has no list of models in it to fall
 * out of date — a deployment that configures nothing renders a picker offering
 * stock footage only, without a code change.
 *
 * **No key ever reaches here.** The response carries labels, capabilities and
 * counts, and `publicModel()` strips the vendor before serialising (§21).
 *
 * **No vendor name is renderable here** (Phase 12 §3). Until Phase 12 this
 * component displayed each provider's own label and hint, which is how "fal.ai",
 * "Seedance", "MiniMax" and "Veo" reached the screen. The response now carries
 * `readiness` — the same "enabled but unconfigured" distinction as counts — so the
 * notice below says what the user can act on ("contact support") without naming a
 * company. The variable an operator must set lives in the operator surfaces, which
 * is where an operator looks.
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
import type { QualitySpec } from "@/lib/video/quality";
import { api, messageOf } from "@/services/api-client";

/**
 * Aggregate configuration state, with no vendor names (§3).
 *
 * Counts rather than rows, because the only thing this screen ever did with the
 * per-provider list was tell "this deployment offers no AI video" apart from "AI
 * video is enabled but not finished being set up" — and that distinction survives
 * as two numbers.
 */
interface ProviderReadiness {
  ready: number;
  awaitingConfiguration: number;
  placeholder: boolean;
}

/**
 * What the caller has to spend (§20).
 *
 * Server-supplied, like everything else here: a balance computed in the browser could
 * be edited in the browser, and the number this screen quotes has to be the number the
 * charge path will use.
 */
interface CreditSummary {
  available: number;
  period: string;
  /** Whether this deployment can actually open a top-up checkout. */
  canTopUp: boolean;
}

/** The shape `/api/video/providers` returns. */
interface ProvidersResponse {
  modes: GenerationModeOption[];
  models: GenerationModelOption[];
  aiAvailable: boolean;
  formats: FormatSpec[];
  qualities: QualitySpec[];
  readiness: ProviderReadiness;
  stock: CapabilityStatus;
  credits: CreditSummary;
}

export interface GenerationPickerProps {
  projectId: string;
  /** The project's stored choice, or null on a project that has not chosen. */
  mode: string | null;
  model: string | null;
  format: string | null;
  /** Null on any project created before §4 made the resolution a choice. */
  quality?: string | null;
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
  quality = null,
  disabled,
  onSaved,
}: GenerationPickerProps) {
  const [options, setOptions] = useState<ProvidersResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState(mode ?? "STOCK");
  const [selectedModel, setSelectedModel] = useState(model);
  const [selectedFormat, setSelectedFormat] = useState(format ?? "landscape");
  /**
   * Null means "the model's own default", which is what the server resolves an
   * absent quality to. Held as null rather than pre-filled with a guess, so a
   * project that has never chosen does not look like one that chose 1080p.
   */
  const [selectedQuality, setSelectedQuality] = useState(quality);
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

  /** The chosen model, for the resolution row it declares (§4). */
  const activeModel = models.find((m) => m.id === selectedModel) ?? null;

  /**
   * The priced resolution the cost line quotes (§20).
   *
   * `selectedQuality ?? defaultQuality` mirrors what the picker has selected in the row
   * *and* what the server resolves an absent quality to, so the figure shown for a
   * project that has never chosen is the figure that project would actually be charged.
   * Undefined only if the stored quality is one this model no longer offers, which
   * `chooseModel` clears — the fallback exists so the cost line degrades to the default
   * rather than to a crash.
   */
  const activeQuality = activeModel
    ? (activeModel.qualities.find(
        (q) => q.quality === (selectedQuality ?? activeModel.defaultQuality),
      ) ?? null)
    : null;
  const activePrice = activeQuality?.sceneCredits ?? activeModel?.sceneCredits ?? 0;
  const activeImagePrice = activeQuality?.imageCredits ?? null;

  function chooseMode(next: string) {
    setSelectedMode(next);
    setError(null);
    if (next === "STOCK") {
      // Neither a model nor a quality can be stored alongside stock mode —
      // `validateSelection` refuses both pairs rather than ignoring the field, so
      // clear them here too.
      setSelectedModel(null);
      setSelectedQuality(null);
      return;
    }
    if (!selectedModel) {
      const first = compatible.find((m) => !m.locked) ?? compatible[0];
      setSelectedModel(first?.id ?? null);
    }
  }

  function chooseModel(next: GenerationModelOption) {
    setSelectedModel(next.id);
    setError(null);
    /**
     * A resolution the previous model offered may not exist on this one — the
     * creators tier has no draft, the fast tier no 2K. Reset to null rather than to
     * the nearest, so the server resolves it to this model's own default instead of
     * this screen guessing a tier the user did not pick (§4, §12).
     */
    if (
      selectedQuality &&
      !next.qualities.some((q) => q.quality === selectedQuality)
    ) {
      setSelectedQuality(null);
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
      setSelectedQuality(null);
    }
  }

  const dirty =
    selectedMode !== (mode ?? "STOCK") ||
    selectedModel !== model ||
    selectedFormat !== (format ?? "landscape") ||
    selectedQuality !== quality;

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
        // Omitted rather than sent as null in stock mode, where the route refuses a
        // quality outright. Omitted in AI mode too when nothing was picked, so the
        // server resolves the model's default and the stored value is one it could
        // actually have quoted a price for.
        quality: selectedMode === "AI_VIDEO" ? selectedQuality : null,
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
          <Legend>Vidxir AI video models</Legend>

          {compatible.length === 0 ? (
            <Card tone="warning" pad={14}>
              <p style={{ margin: 0, fontSize: 13, color: color.warning }}>
                {options.models.length === 0
                  ? /*
                     * §3: the two cases differ in what the *user* can do, which is
                     * the only distinction worth drawing on this screen. "Not
                     * offered here" is final; "being set up" is worth asking about.
                     * Neither names a vendor.
                     */
                    options.readiness.awaitingConfiguration > 0
                    ? "AI video generation is being set up on this workspace and " +
                      "has no models available yet. Stock footage still works — " +
                      "contact support if you need AI video now."
                    : "This workspace offers stock footage only, so there is no " +
                      "AI video model to choose."
                  : `No available model generates ${labelFor(options.formats, selectedFormat)} video. Choose a different format, or use stock footage.`}
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
                  onClick={() => chooseModel(option)}
                  icon={<Sparkles size={14} aria-hidden="true" />}
                  label={option.label}
                  hint={option.description}
                  /*
                   * §3 and §4's per-model detail: what it is for, and what it can
                   * actually do. Read off `capabilities` rather than written here,
                   * so a model that gains or loses a tier changes this text
                   * without a component edit — and so nothing can be claimed that
                   * the resolver would refuse.
                   */
                  meta={[
                    `Best for: ${option.bestFor}`,
                    `Up to ${option.maxClipSeconds}s per scene`,
                    `${option.qualities.map((q) => q.label).join(" · ")}`,
                    /*
                     * §20's headline price. One comparable figure per model, at that
                     * model's own default resolution — the per-resolution figures are
                     * in the quality row below, and repeating all of them here would
                     * bury the comparison the customer is making at this step.
                     *
                     * `sceneSeconds` is printed rather than assumed, because the price
                     * is per 5s unit and a model whose clips run to 10s costs two units
                     * for one scene. Saying "per scene" without the duration would
                     * understate that by half.
                     */
                    `${creditWord(option.sceneCredits)} per ${option.sceneSeconds}s scene at ${qualityLabel(option, option.defaultQuality)}`,
                    ...(option.capabilities.audio ? ["Generates audio"] : []),
                    ...(option.capabilities.imageGeneration
                      ? [`Reference images from ${imagePriceRange(option)}`]
                      : []),
                  ]}
                  badge={option.locked ? "Upgrade" : null}
                />
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

      {/*
        §4: resolution, from the chosen model's own declared list.

        Rendered from `activeModel.qualities` rather than from the full vocabulary,
        so an option the model does not support is not merely disabled but absent —
        "do not show an option that the underlying provider/model does not actually
        support", enforced by having nothing to render. The full list still arrives
        in `options.qualities`; a tier missing from this row is one this model does
        not offer, which the note underneath says out loud.
      */}
      {selectedMode === "AI_VIDEO" && activeModel && (
        <div>
          <ChoiceGrid
            legend="Generation quality"
            options={activeModel.qualities.map((spec) => ({
              value: spec.quality,
              label: spec.recommended ? `${spec.label} ⭐ Recommended` : spec.label,
              /*
               * The price joined onto the description rather than replacing it (§20).
               *
               * The resolution row is the one place the multiplier is visible — draft is
               * half of 1080p and 2K is 1.75× it on the same model — so a customer
               * choosing here is choosing a cost, and the tier's own description is
               * what tells them whether the saving is one they want.
               */
              hint: `${spec.description} · ${creditWord(spec.sceneCredits)} per ${activeModel.sceneSeconds}s scene`,
            }))}
            value={selectedQuality ?? activeModel.defaultQuality}
            onChange={(next) => {
              setSelectedQuality(next);
              setError(null);
            }}
            minWidth={200}
          />

          {/*
            What this choice will cost against what the account has (§20).

            Placed under the resolution row rather than next to Save, because this is
            the last input that changes the figure: by the time the eye reaches it both
            halves of the price — model and resolution — have been chosen.
          */}
          <CostLine
            credits={activePrice}
            seconds={activeModel.sceneSeconds}
            balance={options.credits}
            imageCredits={activeImagePrice}
          />
          {activeModel.qualities.length < options.qualities.length && (
            <p
              style={{
                margin: "8px 0 0",
                fontSize: 12,
                lineHeight: 1.55,
                color: color.textFaint,
              }}
            >
              {activeModel.label} generates{" "}
              {activeModel.qualities.map((q) => q.label).join(", ")}. Other
              resolutions are not offered by this model — switch models to use them.
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
            Saved. This video will be built with{" "}
            {describe(mode, model, quality, options)}.
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

/**
 * "1 credit" / "20 credits" (§20).
 *
 * A shared helper rather than a template at each site, because the singular case is
 * real: `scenePriceFor` floors at 1, so the mock model and draft-quality Tal 1.0 both
 * price at exactly one credit and "1 credits" is the kind of detail that makes a
 * billing figure look untrustworthy.
 */
function creditWord(credits: number): string {
  return `${credits} ${credits === 1 ? "credit" : "credits"}`;
}

/** A quality's own label, for naming the resolution a headline price refers to. */
function qualityLabel(model: GenerationModelOption, quality: string): string {
  return model.qualities.find((q) => q.quality === quality)?.label ?? quality;
}

/**
 * The still-image price as a range across the model's resolutions (§5, §20).
 *
 * A range rather than one figure because images are priced per resolution too, and the
 * customer has not chosen one yet at the point this line is read — the model card is
 * above the resolution row. Collapses to a single figure when the ends coincide, which
 * is the common case on a model with one tier.
 */
function imagePriceRange(model: GenerationModelOption): string {
  const prices = model.qualities
    .map((q) => q.imageCredits)
    .filter((price): price is number => price !== null);

  // Reachable: `imageCredits` is null on every tier of a model whose `imageGeneration`
  // capability is false, and this is only called when that capability is true — but a
  // model declaring the capability with no priced tier should not render "from NaN".
  if (prices.length === 0) return "reference images";

  const low = Math.min(...prices);
  const high = Math.max(...prices);
  return low === high
    ? `${creditWord(low)} each`
    : `${low}–${high} credits each`;
}

/**
 * What the chosen combination costs, against what the account holds (§20).
 *
 * Deliberately *not* a total for the whole video. The scene count is not known at this
 * step — it comes out of the script stage, which has not run — so a total here would be
 * a guess presented as a price. The per-scene figure is exact and multiplies in the
 * reader's head; a wrong total does not.
 *
 * The balance is shown beside it rather than gating anything. This screen saves a
 * *choice*, and a choice costs nothing: `chargeCredits` runs when a generation starts,
 * and refusing to save a selection because the balance is low today would strand a user
 * who intends to top up before generating.
 */
function CostLine({
  credits,
  seconds,
  balance,
  imageCredits,
}: {
  credits: number;
  seconds: number;
  balance: CreditSummary;
  imageCredits: number | null;
}) {
  const short = balance.available < credits;

  return (
    <p
      style={{
        margin: "10px 0 0",
        fontSize: 12,
        lineHeight: 1.6,
        color: short ? color.warning : color.textDim,
      }}
    >
      <strong style={{ fontWeight: 600 }}>
        {creditWord(credits)} per {seconds}s scene
      </strong>
      {imageCredits !== null && ` · ${creditWord(imageCredits)} per reference image`}
      {" · "}
      {/*
        "Charged when generation starts" is the part that makes the balance
        comparison honest: the number below can change between now and then, in
        either direction, and the charge is what settles it.
      */}
      {creditWord(balance.available)} available. Credits are charged when generation
      starts, per scene.
      {short && (
        <>
          {" "}
          Your balance will not cover a scene at this setting.{" "}
          {balance.canTopUp ? (
            <a
              href="/dashboard/billing"
              style={{ color: color.warning, textDecoration: "underline" }}
            >
              Top up or upgrade
            </a>
          ) : (
            "Your plan allowance renews at the start of next month."
          )}
        </>
      )}
    </p>
  );
}

/** The stored choice in one sentence, for the "saved" confirmation. */
function describe(
  mode: string,
  model: string | null,
  quality: string | null,
  options: ProvidersResponse,
): string {
  if (mode !== "AI_VIDEO") return "stock footage";
  const chosen = options.models.find((m) => m.id === model);
  if (!chosen) return "an AI video model";
  // The stored quality by its own label, so the sentence says what was saved rather
  // than what the picker currently shows.
  const tier = chosen.qualities.find((q) => q.quality === quality);
  return tier ? `${chosen.label} at ${tier.label}` : chosen.label;
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
  meta = [],
  badge,
}: {
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  hint: string;
  /** Capability lines under the description. Empty for a mode card (§4). */
  meta?: string[];
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
      {meta.length > 0 && (
        <span
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            fontSize: 11.5,
            lineHeight: 1.45,
            color: color.textFaint,
          }}
        >
          {meta.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      )}
    </button>
  );
}

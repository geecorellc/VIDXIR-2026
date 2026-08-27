/**
 * How a project's visuals get made (Phase 11 §9, §10, §16, §17).
 *
 * One function, `generationPlanFor`, answers three questions the visuals stage and
 * the timeline stage both need:
 *
 *   1. Stock footage or an AI model? (`mode`)
 *   2. Which model? (`modelId`)
 *   3. Into what frame? (`format`)
 *
 * It exists as its own module because those three values are stored on the project
 * row and read by two stages running in different jobs, and because resolving them
 * involves a decision that must not be duplicated: **a stored choice is re-checked,
 * never trusted.**
 *
 * That is §10's requirement applied to time rather than to a request. A model id is
 * validated when the user selects it, but minutes or days pass before the visuals
 * stage runs, and in between an operator can remove a provider from
 * `VIDEO_GEN_PROVIDERS` or a credential can be rotated away. So the plan is
 * resolved at the moment of use, and when the stored model is no longer available
 * the stage does not quietly render stock footage and call it AI video — it fails
 * with a message naming what happened (§42).
 *
 * The one thing that *is* silent is the absence of a choice: a project with
 * `generationMode` null is a pre-Phase-11 project, and it resolves to stock in
 * landscape, which is exactly what it would have rendered before.
 */
import { ProviderError, ValidationError } from "@/lib/errors";
import { requireFeature, hasFeature } from "@/lib/plans/enforce";
import type { PlanTier } from "@/lib/plans";
import {
  availableModels,
  isGenerationMode,
  resolveModel,
  type GenerationMode,
  type VideoGenModel,
} from "@/lib/providers/video-gen";
import { formatSpec, type FormatSpec, type VideoFormat } from "@/lib/video/format";

export interface GenerationPlan {
  mode: GenerationMode;
  /** The frame every stage targets. Landscape when the project chose none. */
  format: VideoFormat;
  spec: FormatSpec;
  /** Null in STOCK mode. */
  model: VideoGenModel | null;
}

/** The project columns this reads. Kept narrow so a caller can pass a partial row. */
export interface GenerationChoice {
  generationMode: string | null;
  generationModel: string | null;
  videoFormat: string | null;
}

/**
 * Resolve a project's stored choice into a usable plan.
 *
 * Throws when the project asked for AI video and that is no longer possible.
 * Deliberately: the alternatives are to render stock and mislabel it, or to render
 * nothing and say nothing, and both are worse than a stage failure the user can
 * read and act on.
 */
export function generationPlanFor(choice: GenerationChoice): GenerationPlan {
  const spec = formatSpec(choice.videoFormat);
  const mode: GenerationMode = isGenerationMode(choice.generationMode)
    ? choice.generationMode
    : "STOCK";

  if (mode === "STOCK") {
    return { mode, format: spec.format, spec, model: null };
  }

  if (!choice.generationModel) {
    throw new ValidationError(
      "This video is set to use AI video generation but no model was chosen. " +
        "Pick a model, or switch it to stock footage.",
      { field: "generationModel" },
    );
  }

  // Re-validation. `resolveModel` throws `ProviderError` for an unknown or disabled
  // model and `NotConfiguredError` for one whose credential has gone, which the
  // worker maps to `blocked_not_configured` rather than to a retry — correct, since
  // retrying a missing API key just fails again.
  const { model } = resolveModel(choice.generationModel);

  if (!model.formats.includes(spec.format)) {
    throw new ProviderError(
      model.label,
      `does not generate ${spec.format} video. Choose a different model or ` +
        `change the video format.`,
      { retryable: false, status: 400 },
    );
  }

  return { mode, format: spec.format, spec, model };
}

/**
 * Validate a mode/model/format triple a client just sent (§10, §19, §21).
 *
 * The route-time counterpart of the above. Same shape checks, but it returns the
 * values to store rather than a plan to execute, and it refuses a model in STOCK
 * mode instead of ignoring it — silently dropping a field the user set is how a UI
 * ends up showing a selection that was never saved.
 *
 * It also answers §19's authorisation question, which is why `tier` is a required
 * argument and not an option: the tier comes from the caller's `subscriptions` row,
 * and making it mandatory means a new route cannot accidentally accept a paid
 * selection by forgetting to pass it. Three separate refusals live here, in
 * increasing specificity — AI video at all, then the premium models, then whether
 * this deployment configured the provider behind the model (`resolveModel`, via
 * `generationPlanFor`). A client that posts a model id it saw in someone else's
 * plan gets 402 from the first two and 503 from the third; in no case does the
 * selection get stored.
 */
export interface ValidatedSelection {
  generationMode: GenerationMode;
  generationModel: string | null;
  videoFormat: VideoFormat;
}

export function validateSelection(input: {
  mode: string;
  model?: string | null;
  format?: string | null;
  /** The caller's plan, read server-side from their subscription. Never from the body. */
  tier: PlanTier;
}): ValidatedSelection {
  if (!isGenerationMode(input.mode)) {
    throw new ValidationError(
      "Choose either stock footage or AI video generation.",
      { field: "mode" },
    );
  }

  const spec = formatSpec(input.format);

  if (input.mode === "STOCK") {
    if (input.model) {
      throw new ValidationError(
        "A video model cannot be used with stock footage. Choose AI video " +
          "generation to use a model.",
        { field: "model" },
      );
    }
    return {
      generationMode: "STOCK",
      generationModel: null,
      videoFormat: spec.format,
    };
  }

  // Checked before the model is even looked at, so a starter-plan request is
  // refused for the reason that is actually true of it rather than for whichever
  // model it happened to name.
  requireFeature(input.tier, "aiVideoGeneration");

  if (!input.model) {
    throw new ValidationError("Choose a video model.", { field: "model" });
  }

  const plan = generationPlanFor({
    generationMode: "AI_VIDEO",
    generationModel: input.model,
    videoFormat: spec.format,
  });

  if (plan.model?.premium) {
    requireFeature(input.tier, "premiumVideoModels");
  }

  return {
    generationMode: "AI_VIDEO",
    generationModel: plan.model?.id ?? null,
    videoFormat: spec.format,
  };
}

/**
 * The catalogue a picker renders (§10, §19).
 *
 * Server-computed, credentials never included. An empty `models` array with
 * `aiAvailable: false` is a complete and honest answer: this deployment offers
 * stock footage only.
 *
 * Two distinct reasons a model can be unusable, and the UI needs to tell them
 * apart because the remedies differ. A model missing from `models` altogether is
 * one this deployment has not configured — nothing the user can do. A model
 * present with `locked: true` is configured but above the user's plan, and that is
 * an upgrade. Neither flag is an authorisation: `validateSelection` re-checks the
 * same entitlement server-side on submit, so a client that strips `locked` before
 * rendering has changed nothing but its own display.
 */
export interface GenerationModeOption {
  mode: GenerationMode;
  label: string;
  description: string;
  /** True when the plan does not include this mode. */
  locked: boolean;
}

export interface GenerationModelOption extends VideoGenModel {
  /** True when the model is configured but the plan does not include it. */
  locked: boolean;
}

export interface GenerationOptions {
  modes: GenerationModeOption[];
  models: GenerationModelOption[];
  /** Configured *and* included in the plan — i.e. the AI mode is actually usable. */
  aiAvailable: boolean;
}

export function generationOptions(tier: PlanTier): GenerationOptions {
  const aiAllowed = hasFeature(tier, "aiVideoGeneration");
  const premiumAllowed = hasFeature(tier, "premiumVideoModels");

  const models: GenerationModelOption[] = availableModels().map((model) => ({
    ...model,
    locked: !aiAllowed || (model.premium && !premiumAllowed),
  }));

  return {
    modes: [
      {
        mode: "STOCK",
        label: "Stock footage",
        description:
          "Real footage matched to each scene from a licensed stock library. " +
          "Fast and included on every plan.",
        locked: false,
      },
      {
        mode: "AI_VIDEO",
        label: "AI video",
        description:
          "Each scene generated from its description by a video model. Slower, " +
          "and costs more per video.",
        locked: !aiAllowed,
      },
    ],
    models,
    aiAvailable: aiAllowed && models.some((model) => !model.locked),
  };
}

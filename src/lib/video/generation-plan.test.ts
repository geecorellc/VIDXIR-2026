/**
 * Generation mode/model selection (Phase 11 §9, §10, §19, §21, §23).
 *
 * This module is the single place where "which provider makes this video" is
 * decided, on both the request path (`validateSelection`) and the worker path
 * (`generationPlanFor`), so the cases below are authorisation cases rather than
 * formatting ones. Four claims the spec makes explicitly, each of which would be
 * invisibly false if only the UI enforced it:
 *
 *  - **The server decides what exists** (§10). A model name in a request body is a
 *    string, not a capability. An id that no provider declares, or one whose
 *    provider the operator has not enabled, is refused — and a request cannot reach
 *    an unconfigured provider by naming it.
 *  - **The plan decides what is allowed** (§19). AI video and the premium models are
 *    entitlements read from the caller's tier, and the tier is a required argument
 *    precisely so a future route cannot omit it and accept a paid selection.
 *  - **A stored choice is re-checked, never trusted** (§10 applied to time). Days can
 *    pass between selecting a model and rendering with it, and a credential can be
 *    rotated away in between.
 *  - **No silent downgrade** (§42). When AI video is no longer possible the stage
 *    fails; it never renders stock footage and calls it AI video.
 *
 * Nothing here makes a network call. `VIDEO_GEN_PROVIDERS` and the provider keys are
 * set as strings, and every assertion is about a decision made before any provider
 * is invoked — §23's "use mocks/fakes, do not spend real quota" is satisfied by
 * never reaching a `generate()` at all.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/env";
import {
  FeatureNotInPlanError,
  NotConfiguredError,
  ProviderError,
  ValidationError,
} from "@/lib/errors";
import {
  generationOptions,
  generationPlanFor,
  validateSelection,
} from "@/lib/video/generation-plan";

/** The variables `lib/env` requires before it will parse. Local placeholders only. */
const BASE = {
  DATABASE_URL: "postgresql://tally:tally@localhost:5432/tally_unit",
  REDIS_URL: "redis://127.0.0.1:6379",
  S3_BUCKET: "tally-unit",
  S3_ACCESS_KEY_ID: "unit",
  S3_SECRET_ACCESS_KEY: "unit",
  ENCRYPTION_KEY: "a".repeat(64),
  SESSION_SECRET: "b".repeat(64),
} as const;

const MANAGED = [
  "NODE_ENV",
  "TALLY_USE_MOCK_PROVIDERS",
  "VIDEO_GEN_PROVIDERS",
  "FAL_KEY",
  "GEMINI_API_KEY",
  "RUNWAY_API_KEY",
  ...Object.keys(BASE),
] as const;

const original = new Map<string, string | undefined>(
  MANAGED.map((key) => [key, process.env[key]]),
);

function setEnv(key: string, value: string): void {
  // Next declares NODE_ENV readonly in its ambient types; written through the
  // index signature, confined to this helper.
  (process.env as Record<string, string>)[key] = value;
}

/**
 * Apply a provider configuration.
 *
 * `TALLY_USE_MOCK_PROVIDERS` is forced off by default: left on, it replaces the
 * enabled provider list with `["mock"]` entirely, which would make every case below
 * assert against the placeholder provider instead of the one it names.
 */
function configure(vars: Record<string, string | undefined>): void {
  setEnv("NODE_ENV", "test");
  resetEnvCache();
  for (const key of MANAGED) delete process.env[key];
  const merged = { ...BASE, TALLY_USE_MOCK_PROVIDERS: "false", ...vars };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete process.env[key];
    else setEnv(key, value);
  }
  resetEnvCache();
}

/**
 * fal.ai enabled and configured — the whole catalogue on one key.
 *
 * Its models are a mix of premium and standard, so a case that needs one or the
 * other names it explicitly rather than relying on "the model this provider has".
 */
function falReady(): void {
  configure({ VIDEO_GEN_PROVIDERS: "fal", FAL_KEY: "unit-placeholder" });
}

/** Veo enabled and configured. Offers one premium model and one standard. */
function veoReady(): void {
  configure({ VIDEO_GEN_PROVIDERS: "veo", GEMINI_API_KEY: "unit-placeholder" });
}

afterEach(() => {
  setEnv("NODE_ENV", "test");
  resetEnvCache();
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else setEnv(key, value);
  }
  resetEnvCache();
});

describe("validateSelection — stock mode", () => {
  it("is available on every plan, including the free one", () => {
    configure({ VIDEO_GEN_PROVIDERS: "" });

    expect(validateSelection({ mode: "STOCK", tier: "starter" })).toEqual({
      generationMode: "STOCK",
      generationModel: null,
      videoFormat: "landscape",
    });
  });

  it("keeps the requested format", () => {
    configure({ VIDEO_GEN_PROVIDERS: "" });

    expect(
      validateSelection({ mode: "STOCK", format: "portrait", tier: "starter" })
        .videoFormat,
    ).toBe("portrait");
  });

  it("refuses a model in stock mode rather than dropping it", () => {
    falReady();

    // Silently ignoring the field is how a UI ends up showing a selection that
    // was never saved, and the user believing they paid for AI video.
    expect(() =>
      validateSelection({
        mode: "STOCK",
        model: "fal/seedance-1-pro",
        tier: "scale",
      }),
    ).toThrowError(ValidationError);
  });

  it("rejects a mode that is neither STOCK nor AI_VIDEO", () => {
    configure({ VIDEO_GEN_PROVIDERS: "" });

    expect(() =>
      validateSelection({ mode: "ai_video", tier: "scale" }),
    ).toThrowError(ValidationError);
    expect(() =>
      validateSelection({ mode: "MAGIC", tier: "scale" }),
    ).toThrowError(ValidationError);
  });
});

describe("validateSelection — AI mode, provider checks (§10)", () => {
  it("accepts a configured model and returns its canonical id", () => {
    falReady();

    expect(
      validateSelection({
        mode: "AI_VIDEO",
        model: "fal/seedance-1-pro",
        format: "portrait",
        tier: "scale",
      }),
    ).toEqual({
      generationMode: "AI_VIDEO",
      generationModel: "fal/seedance-1-pro",
      videoFormat: "portrait",
    });
  });

  it("accepts every model the fal.ai catalogue offers, on the plan that allows it", () => {
    falReady();

    // The catalogue is what the picker lists, so anything in it must be storable.
    // A model listed but rejected on submit is the failure this asserts against.
    for (const model of generationOptions("scale").models) {
      const format = model.formats[0];
      expect(format).toBeDefined();
      expect(
        validateSelection({
          mode: "AI_VIDEO",
          model: model.id,
          format,
          tier: "scale",
        }).generationModel,
      ).toBe(model.id);
    }
  });

  it("rewrites a model id stored before the catalogue existed", () => {
    falReady();

    // A project saved when fal.ai carried one model holds `seedance/v1-pro`. The
    // choice still resolves, and it is normalised on the way through so the row
    // stops carrying a dead id the next time it is saved.
    expect(
      validateSelection({
        mode: "AI_VIDEO",
        model: "seedance/v1-pro",
        tier: "scale",
      }).generationModel,
    ).toBe("fal/seedance-1-pro");
  });

  it("rejects a model name no provider declares", () => {
    falReady();

    expect(() =>
      validateSelection({
        mode: "AI_VIDEO",
        model: "sora/turbo",
        tier: "scale",
      }),
    ).toThrowError(ProviderError);
  });

  it("rejects a real model whose provider the operator has not enabled", () => {
    // Google's own Veo endpoint exists in the registry, but this deployment offers
    // fal.ai only. The refusal is the same shape as for an invented name —
    // deliberately, so a client cannot enumerate which providers exist but are
    // switched off. Note `fal/veo3` *is* selectable here: same model, different
    // provider, and it is the provider the operator enabled.
    falReady();

    expect(() =>
      validateSelection({ mode: "AI_VIDEO", model: "veo/3.1", tier: "scale" }),
    ).toThrowError(ProviderError);

    expect(
      validateSelection({ mode: "AI_VIDEO", model: "fal/veo3", tier: "scale" })
        .generationModel,
    ).toBe("fal/veo3");
  });

  it("reports an enabled provider with no credential as not configured, not as invalid", () => {
    configure({ VIDEO_GEN_PROVIDERS: "fal", FAL_KEY: undefined });

    // §10's exact requirement: a client cannot request an unconfigured provider by
    // manipulating the request. This is the operator's problem rather than the
    // caller's, so it is a 503 naming the variable — never a fallback to stock.
    try {
      validateSelection({
        mode: "AI_VIDEO",
        model: "fal/seedance-1-pro",
        tier: "scale",
      });
      expect.unreachable("an unconfigured provider must not be selectable");
    } catch (error) {
      expect(error).toBeInstanceOf(NotConfiguredError);
      expect((error as NotConfiguredError).status).toBe(503);
      expect((error as NotConfiguredError).details).toMatchObject({
        missingEnvVars: ["FAL_KEY"],
      });
      // The variable is named; its value is not read anywhere on this path.
      expect(JSON.stringify((error as NotConfiguredError).details)).not.toContain(
        "unit-placeholder",
      );
    }
  });

  it("requires a model when AI video is chosen", () => {
    falReady();

    expect(() =>
      validateSelection({ mode: "AI_VIDEO", tier: "scale" }),
    ).toThrowError(ValidationError);
  });

  it("rejects a format the chosen model cannot generate", () => {
    veoReady();

    // Veo generates landscape and portrait only. Accepting square here would mean
    // paying for a generation that then has to be cropped out of shape.
    expect(() =>
      validateSelection({
        mode: "AI_VIDEO",
        model: "veo/3.1",
        format: "square",
        tier: "scale",
      }),
    ).toThrowError(ProviderError);
  });
});

describe("validateSelection — entitlements (§19)", () => {
  it("refuses AI video on the free tier before looking at the model", () => {
    falReady();

    try {
      validateSelection({
        mode: "AI_VIDEO",
        model: "fal/seedance-1-pro",
        tier: "starter",
      });
      expect.unreachable("starter must not reach AI video");
    } catch (error) {
      // The reason reported is the one that is actually true of the request. A
      // model-shaped error would send the user hunting for a different model when
      // no model would have worked.
      expect(error).toBeInstanceOf(FeatureNotInPlanError);
      expect((error as FeatureNotInPlanError).message).toContain("Starter");
    }
  });

  it("refuses AI video on the free tier even when the model name is nonsense", () => {
    falReady();

    // Ordering matters: the entitlement is checked first, so a free-tier client
    // cannot probe which model ids exist by reading back different errors.
    expect(() =>
      validateSelection({
        mode: "AI_VIDEO",
        model: "does-not-exist",
        tier: "starter",
      }),
    ).toThrowError(FeatureNotInPlanError);
  });

  it("lets Studio use a standard model", () => {
    veoReady();

    expect(
      validateSelection({
        mode: "AI_VIDEO",
        model: "veo/3.1-fast",
        tier: "studio",
      }).generationModel,
    ).toBe("veo/3.1-fast");
  });

  it("refuses a premium model on Studio", () => {
    veoReady();

    // Veo 3.1 is premium, Veo 3.1 Fast is not, and both are configured — so the
    // only thing separating them here is the plan.
    expect(() =>
      validateSelection({ mode: "AI_VIDEO", model: "veo/3.1", tier: "studio" }),
    ).toThrowError(FeatureNotInPlanError);
  });

  it("lets Scale use a premium model", () => {
    veoReady();

    expect(
      validateSelection({ mode: "AI_VIDEO", model: "veo/3.1", tier: "scale" })
        .generationModel,
    ).toBe("veo/3.1");
  });
});

describe("generationPlanFor — the stored choice (§10 over time)", () => {
  it("resolves a pre-Phase-11 project to landscape stock, exactly as it rendered before", () => {
    configure({ VIDEO_GEN_PROVIDERS: "" });

    const plan = generationPlanFor({
      generationMode: null,
      generationModel: null,
      videoFormat: null,
    });

    expect(plan.mode).toBe("STOCK");
    expect(plan.model).toBeNull();
    expect(plan.format).toBe("landscape");
    expect(plan.spec.width).toBe(1920);
    expect(plan.spec.height).toBe(1080);
  });

  it("carries the frame the AI provider will be asked for", () => {
    falReady();

    const plan = generationPlanFor({
      generationMode: "AI_VIDEO",
      generationModel: "fal/seedance-1-pro",
      videoFormat: "portrait",
    });

    expect(plan.model?.id).toBe("fal/seedance-1-pro");
    expect(plan.spec.ratio).toBe("9:16");
    expect(plan.spec.width).toBe(1080);
  });

  it("fails rather than rendering stock when the credential has since been removed", () => {
    // The project was created while FAL_KEY was set; the key is gone by the time
    // the visuals stage runs. §42: a stage failure the user can read beats a video
    // that quietly is not what they paid for.
    configure({ VIDEO_GEN_PROVIDERS: "fal", FAL_KEY: undefined });

    expect(() =>
      generationPlanFor({
        generationMode: "AI_VIDEO",
        generationModel: "fal/seedance-1-pro",
        videoFormat: "landscape",
      }),
    ).toThrowError(NotConfiguredError);
  });

  it("fails when the stored model's provider has since been disabled", () => {
    configure({ VIDEO_GEN_PROVIDERS: "veo", GEMINI_API_KEY: "unit-placeholder" });

    expect(() =>
      generationPlanFor({
        generationMode: "AI_VIDEO",
        generationModel: "fal/seedance-1-pro",
        videoFormat: "landscape",
      }),
    ).toThrowError(ProviderError);
  });

  it("fails when the stored model was removed from the catalogue entirely", () => {
    // Not the same case as a disabled provider: fal.ai is enabled and keyed, but
    // the project holds a model id the catalogue no longer carries. §42 again —
    // the nearest surviving fal model is not what the user chose.
    falReady();

    expect(() =>
      generationPlanFor({
        generationMode: "AI_VIDEO",
        generationModel: "fal/seedance-0-alpha",
        videoFormat: "landscape",
      }),
    ).toThrowError(ProviderError);
  });

  it("fails when AI video was chosen but no model was stored", () => {
    falReady();

    expect(() =>
      generationPlanFor({
        generationMode: "AI_VIDEO",
        generationModel: null,
        videoFormat: "landscape",
      }),
    ).toThrowError(ValidationError);
  });

  it("treats an unrecognised stored mode as stock rather than throwing", () => {
    // A mode column can only hold what a route wrote, and the tolerance here is for
    // a legacy or corrupted row — degrading to the pre-Phase-11 behaviour, which is
    // the one thing that is certainly safe.
    configure({ VIDEO_GEN_PROVIDERS: "" });

    expect(
      generationPlanFor({
        generationMode: "LIVE_ACTION",
        generationModel: null,
        videoFormat: "landscape",
      }).mode,
    ).toBe("STOCK");
  });
});

describe("generationOptions — what the picker is told (§10, §19)", () => {
  it("offers stock only, unlocked, when no provider is configured", () => {
    configure({ VIDEO_GEN_PROVIDERS: "" });

    const options = generationOptions("scale");

    expect(options.models).toEqual([]);
    expect(options.aiAvailable).toBe(false);
    // An honest complete answer for a deployment that offers stock footage: the AI
    // mode is still listed, so the operator sees it exists and is unconfigured.
    expect(options.modes.find((m) => m.mode === "STOCK")?.locked).toBe(false);
  });

  it("omits models whose provider has no credential", () => {
    configure({ VIDEO_GEN_PROVIDERS: "fal,veo", GEMINI_API_KEY: "unit-placeholder" });

    const ids = generationOptions("scale").models.map((m) => m.id);

    // Absent rather than present-and-flagged: a flagged model is one careless
    // render away from being selected. One missing key removes the whole fal.ai
    // catalogue, since the catalogue is exactly what that one key buys.
    expect(ids.some((id) => id.startsWith("fal/"))).toBe(false);
    expect(ids).toContain("veo/3.1");
  });

  it("lists the whole fal.ai catalogue under one provider, unlocked on Scale", () => {
    falReady();

    const models = generationOptions("scale").models;

    // The picker's job is to show the choice, so this is the assertion that the
    // choice exists: several distinct models, from more than one vendor, all of
    // them selectable, and all reached through the single fal provider.
    expect(models.length).toBeGreaterThan(5);
    expect(new Set(models.map((m) => m.provider))).toEqual(new Set(["fal"]));
    expect(new Set(models.map((m) => m.id)).size).toBe(models.length);
    expect(models.some((m) => m.locked)).toBe(false);
    // A mix of tiers, or `premiumVideoModels` would be an entitlement over nothing.
    expect(models.some((m) => m.premium)).toBe(true);
    expect(models.some((m) => !m.premium)).toBe(true);
  });

  it("locks the premium half of the fal.ai catalogue on Studio", () => {
    falReady();

    const models = generationOptions("studio").models;

    for (const model of models) expect(model.locked).toBe(model.premium);
    // Studio can still generate: a plan that lists models and locks all of them
    // would report `aiAvailable` false, which is the regression this guards.
    expect(generationOptions("studio").aiAvailable).toBe(true);
  });

  it("locks every model and the AI mode itself on the free tier", () => {
    veoReady();

    const options = generationOptions("starter");

    expect(options.modes.find((m) => m.mode === "AI_VIDEO")?.locked).toBe(true);
    expect(options.models.every((m) => m.locked)).toBe(true);
    // Configured, but not usable by this caller — which is what aiAvailable means.
    expect(options.aiAvailable).toBe(false);
  });

  it("locks only the premium models on Studio", () => {
    veoReady();

    const options = generationOptions("studio");

    expect(options.modes.find((m) => m.mode === "AI_VIDEO")?.locked).toBe(false);
    expect(options.models.find((m) => m.id === "veo/3.1")?.locked).toBe(true);
    expect(options.models.find((m) => m.id === "veo/3.1-fast")?.locked).toBe(false);
    expect(options.aiAvailable).toBe(true);
  });

  it("unlocks everything configured on Scale", () => {
    veoReady();

    const options = generationOptions("scale");

    expect(options.models.length).toBeGreaterThan(0);
    expect(options.models.some((m) => m.locked)).toBe(false);
    expect(options.aiAvailable).toBe(true);
  });

  it("never includes a credential in what the picker receives (§21)", () => {
    configure({
      VIDEO_GEN_PROVIDERS: "fal,veo",
      FAL_KEY: "fal-unit-placeholder-value",
      GEMINI_API_KEY: "gemini-unit-placeholder-value",
    });

    // The whole payload, serialised — the assertion has to cover fields nobody
    // thought to check, because this object is returned to the browser.
    const serialised = JSON.stringify(generationOptions("scale"));

    expect(serialised).not.toContain("fal-unit-placeholder-value");
    expect(serialised).not.toContain("gemini-unit-placeholder-value");
    expect(serialised).not.toMatch(/FAL_KEY|GEMINI_API_KEY/);
  });
});

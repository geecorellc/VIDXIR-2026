/**
 * Generation mode/model/quality selection (Phase 11 §9, §10, §19, §21, §23;
 * Phase 12 §3, §4, §17).
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
 * Phase 12 adds three more, for the same reason — each would be invisibly false if
 * only the UI enforced it:
 *
 *  - **Resolution is a checked choice, not a hint** (§4). A quality the chosen model
 *    does not declare is refused on submit and again at render time, because §12
 *    quotes a credit price from it.
 *  - **The vendor is absent from the picker payload** (§3). `generationOptions` is
 *    serialised and searched for every backend name.
 *  - **A pre-Phase-12 project still resolves** (§17). Rows holding a retired model id
 *    and no quality at all must produce a usable plan.
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
  "DASHSCOPE_API_KEY",
  "MINIMAX_API_KEY",
  "SEEDANCE_API_KEY",
  "GEMINI_API_KEY",
  "RUNWAY_API_KEY",
  // Retained in `env.ts` as deprecated (§14). Managed so a developer's own shell
  // cannot influence a case.
  "FAL_KEY",
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
 * All four branded models enabled and configured.
 *
 * Three standard tiers and one premium, so a case that needs one or the other names
 * it explicitly rather than relying on "the model this provider has".
 */
function allReady(): void {
  configure({
    VIDEO_GEN_PROVIDERS: "qwen,minimax,seedance,veo",
    DASHSCOPE_API_KEY: "unit-placeholder",
    MINIMAX_API_KEY: "unit-placeholder",
    SEEDANCE_API_KEY: "unit-placeholder",
    GEMINI_API_KEY: "unit-placeholder",
  });
}

/** Only the cinematic tier's vendor. Used for the "not enabled" refusals. */
function cinematicOnly(): void {
  configure({
    VIDEO_GEN_PROVIDERS: "seedance",
    SEEDANCE_API_KEY: "unit-placeholder",
  });
}

/** Only the ultra tier's vendor — the one premium model in the catalogue. */
function ultraOnly(): void {
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
      // Resolution is not a choice in stock mode: the library holds one rendition
      // per clip and the renderer scales it. Null rather than the default, so a
      // cost preview cannot quote a resolution nobody selected (§12).
      videoQuality: null,
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
    allReady();

    // Silently ignoring the field is how a UI ends up showing a selection that
    // was never saved, and the user believing they paid for AI video.
    expect(() =>
      validateSelection({ mode: "STOCK", model: "tal/3.0", tier: "scale" }),
    ).toThrowError(ValidationError);
  });

  it("refuses a generation quality in stock mode rather than dropping it (§4)", () => {
    allReady();

    // Same reasoning as the model. A quality accepted here would be stored and
    // then priced, and stock footage is not priced by resolution.
    expect(() =>
      validateSelection({ mode: "STOCK", quality: "1080p", tier: "scale" }),
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
    allReady();

    expect(
      validateSelection({
        mode: "AI_VIDEO",
        model: "tal/3.0",
        format: "portrait",
        quality: "1080p",
        tier: "scale",
      }),
    ).toEqual({
      generationMode: "AI_VIDEO",
      generationModel: "tal/3.0",
      videoFormat: "portrait",
      videoQuality: "1080p",
    });
  });

  it("accepts every model the catalogue offers, on the plan that allows it", () => {
    allReady();

    // The catalogue is what the picker lists, so anything in it must be storable —
    // at its own default quality and in its own first format. A model listed but
    // rejected on submit is the failure this asserts against.
    for (const model of generationOptions("scale").models) {
      const format = model.formats[0];
      expect(format).toBeDefined();
      expect(
        validateSelection({
          mode: "AI_VIDEO",
          model: model.id,
          format,
          quality: model.defaultQuality,
          tier: "scale",
        }).generationModel,
      ).toBe(model.id);
    }
  });

  it("resolves an id stored before the branded models existed (§14, §17)", () => {
    allReady();

    // A project saved in Phase 11 holds an aggregator id. §14 removes that route,
    // §17 requires the project to keep working, so the id maps forward to the
    // branded tier backed by the same vendor — and is normalised on the way
    // through, so the row stops carrying a dead id the next time it is saved.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["fal/wan-v2-2-a14b", "tal/1.0"],
      ["fal/minimax-hailuo-02-pro", "tal/2.0"],
      ["fal/seedance-1-pro", "tal/3.0"],
      ["seedance/v1-pro", "tal/3.0"],
      ["fal/veo3", "tal/3.1"],
      ["veo/3.1", "tal/3.1"],
    ];

    for (const [stored, expected] of cases) {
      expect(
        validateSelection({ mode: "AI_VIDEO", model: stored, tier: "scale" })
          .generationModel,
      ).toBe(expected);
    }
  });

  it("rejects a model name no provider declares", () => {
    allReady();

    expect(() =>
      validateSelection({ mode: "AI_VIDEO", model: "sora/turbo", tier: "scale" }),
    ).toThrowError(ProviderError);
  });

  it("rejects a real model whose provider the operator has not enabled", () => {
    // The ultra tier exists in the registry, but this deployment enabled the
    // cinematic tier's vendor only. The refusal is the same shape as for an
    // invented name — deliberately, so a client cannot enumerate which providers
    // exist but are switched off.
    cinematicOnly();

    expect(() =>
      validateSelection({ mode: "AI_VIDEO", model: "tal/3.1", tier: "scale" }),
    ).toThrowError(ProviderError);

    expect(
      validateSelection({ mode: "AI_VIDEO", model: "tal/3.0", tier: "scale" })
        .generationModel,
    ).toBe("tal/3.0");
  });

  it("reports an enabled provider with no credential as not configured, not as invalid", () => {
    configure({ VIDEO_GEN_PROVIDERS: "seedance", SEEDANCE_API_KEY: undefined });

    // §10's exact requirement: a client cannot request an unconfigured provider by
    // manipulating the request. This is the operator's problem rather than the
    // caller's, so it is a 503 — never a fallback to stock.
    try {
      validateSelection({ mode: "AI_VIDEO", model: "tal/3.0", tier: "scale" });
      expect.unreachable("an unconfigured provider must not be selectable");
    } catch (error) {
      expect(error).toBeInstanceOf(NotConfiguredError);
      expect((error as NotConfiguredError).status).toBe(503);
      expect((error as NotConfiguredError).details).toMatchObject({
        missingEnvVars: ["SEEDANCE_API_KEY"],
      });
      // The variable is named; its value is not read anywhere on this path.
      expect(JSON.stringify((error as NotConfiguredError).details)).not.toContain(
        "unit-placeholder",
      );
    }
  });

  it("names the branded model rather than the vendor in that refusal (§3)", () => {
    configure({ VIDEO_GEN_PROVIDERS: "seedance", SEEDANCE_API_KEY: undefined });

    try {
      validateSelection({ mode: "AI_VIDEO", model: "tal/3.0", tier: "scale" });
      expect.unreachable("an unconfigured provider must not be selectable");
    } catch (error) {
      // This message reaches a user, so §3 applies to it. The missing variable is
      // still reported in `details` for the operator reading a log.
      const message = (error as NotConfiguredError).message;
      expect(message).toContain("Tal 3.0");
      expect(message).not.toMatch(/\bseedance\b|\bark\b|\bbytedance\b|\bvolcengine\b/i);
    }
  });

  it("requires a model when AI video is chosen", () => {
    allReady();

    expect(() =>
      validateSelection({ mode: "AI_VIDEO", tier: "scale" }),
    ).toThrowError(ValidationError);
  });

  it("rejects a format the chosen model cannot generate", () => {
    ultraOnly();

    // The ultra model generates landscape and portrait only. Accepting square here
    // would mean paying for a generation that then has to be cropped out of shape.
    expect(() =>
      validateSelection({
        mode: "AI_VIDEO",
        model: "tal/3.1",
        format: "square",
        tier: "scale",
      }),
    ).toThrowError(ProviderError);
  });
});

describe("validateSelection — quality (§4, §12)", () => {
  it("resolves the model's own default when no quality is sent", () => {
    allReady();

    // Not a fixed constant: a model with no 1080p tier needs a default it can
    // actually generate, and the stored value has to be one the cost preview
    // could have quoted.
    for (const model of generationOptions("scale").models) {
      const resolved = validateSelection({
        mode: "AI_VIDEO",
        model: model.id,
        format: model.formats[0],
        tier: "scale",
      }).videoQuality;

      expect(resolved).toBe(model.defaultQuality);
      expect(model.qualities.map((q) => q.quality)).toContain(resolved);
    }
  });

  it("rejects a quality string that is not a quality at all", () => {
    allReady();

    // Rejected rather than coerced: §12 quotes a credit cost from the resolution,
    // so accepting "best" and silently charging 1080p prices for it is a billing
    // error dressed as leniency.
    expect(() =>
      validateSelection({
        mode: "AI_VIDEO",
        model: "tal/3.0",
        quality: "best",
        tier: "scale",
      }),
    ).toThrowError(ValidationError);
  });

  it("rejects a real quality the chosen model does not declare (§4, §18.7)", () => {
    allReady();

    // 2K is a quality Tally knows and no video model offers. §4 forbids showing an
    // option the model does not support, and this is the same rule enforced where
    // the UI cannot be trusted.
    for (const model of generationOptions("scale").models) {
      expect(() =>
        validateSelection({
          mode: "AI_VIDEO",
          model: model.id,
          format: model.formats[0],
          quality: "2k",
          tier: "scale",
        }),
      ).toThrowError(ProviderError);
    }
  });

  it("accepts a lower tier than the default when the model declares it", () => {
    allReady();

    // Draft exists so a user can check a scene cheaply before committing (§4), so
    // choosing down from the recommended tier has to work, not just choosing up.
    expect(
      validateSelection({
        mode: "AI_VIDEO",
        model: "tal/1.0",
        quality: "draft",
        tier: "scale",
      }).videoQuality,
    ).toBe("draft");
  });

  it("refuses a tier the model skips even when a lower and higher one exist", () => {
    allReady();

    // The creators model starts at 720p — it has no draft tier. Snapping down to
    // 720p would charge more than the user asked for, snapping is only correct for
    // an *absent* choice, so an explicit unsupported value is refused.
    expect(() =>
      validateSelection({
        mode: "AI_VIDEO",
        model: "tal/2.0",
        quality: "draft",
        tier: "scale",
      }),
    ).toThrowError(ProviderError);
  });
});

describe("validateSelection — entitlements (§19)", () => {
  it("refuses AI video on the free tier before looking at the model", () => {
    allReady();

    try {
      validateSelection({ mode: "AI_VIDEO", model: "tal/3.0", tier: "starter" });
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
    allReady();

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
    allReady();

    expect(
      validateSelection({ mode: "AI_VIDEO", model: "tal/2.0", tier: "studio" })
        .generationModel,
    ).toBe("tal/2.0");
  });

  it("refuses the premium model on Studio", () => {
    allReady();

    // Only the ultra tier is premium (§2, §3), and every model here is configured —
    // so the only thing separating them is the plan.
    expect(() =>
      validateSelection({ mode: "AI_VIDEO", model: "tal/3.1", tier: "studio" }),
    ).toThrowError(FeatureNotInPlanError);
  });

  it("lets Scale use the premium model", () => {
    allReady();

    expect(
      validateSelection({ mode: "AI_VIDEO", model: "tal/3.1", tier: "scale" })
        .generationModel,
    ).toBe("tal/3.1");
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
    allReady();

    const plan = generationPlanFor({
      generationMode: "AI_VIDEO",
      generationModel: "tal/3.0",
      videoFormat: "portrait",
    });

    expect(plan.model?.id).toBe("tal/3.0");
    expect(plan.spec.ratio).toBe("9:16");
    expect(plan.spec.width).toBe(1080);
  });

  it("resolves a project stored before quality was a column (§17)", () => {
    allReady();

    // `videoQuality` is absent, not null — a row read before migration 0008 adds
    // the column. The plan still has to name a resolution, because the adapter
    // needs one to submit.
    const plan = generationPlanFor({
      generationMode: "AI_VIDEO",
      generationModel: "tal/3.0",
      videoFormat: "landscape",
    });

    expect(plan.quality).toBe("1080p");
  });

  it("re-checks the stored quality against the model, not just its spelling (§4)", () => {
    allReady();

    // The row holds a quality that was valid for the model it was chosen on and is
    // not valid for the model it now names. Same argument as the model itself: the
    // check happens at the moment of use, because the row outlives the choice.
    expect(() =>
      generationPlanFor({
        generationMode: "AI_VIDEO",
        generationModel: "tal/2.0",
        videoFormat: "landscape",
        videoQuality: "draft",
      }),
    ).toThrowError(ProviderError);
  });

  it("resolves a retired model id to its branded successor (§14, §17)", () => {
    allReady();

    // The stored row is never rewritten by the worker, so the mapping has to hold
    // on the read path too — otherwise a project saved in Phase 11 renders nothing.
    const plan = generationPlanFor({
      generationMode: "AI_VIDEO",
      generationModel: "fal/seedance-1-pro",
      videoFormat: "landscape",
    });

    expect(plan.model?.id).toBe("tal/3.0");
    expect(plan.model?.label).toBe("Tal 3.0 — Cinematic Model");
  });

  it("fails rather than rendering stock when the credential has since been removed", () => {
    // The project was created while the key was set; it is gone by the time the
    // visuals stage runs. §42: a stage failure the user can read beats a video that
    // quietly is not what they paid for.
    configure({ VIDEO_GEN_PROVIDERS: "seedance", SEEDANCE_API_KEY: undefined });

    expect(() =>
      generationPlanFor({
        generationMode: "AI_VIDEO",
        generationModel: "tal/3.0",
        videoFormat: "landscape",
      }),
    ).toThrowError(NotConfiguredError);
  });

  it("fails when the stored model's provider has since been disabled", () => {
    ultraOnly();

    expect(() =>
      generationPlanFor({
        generationMode: "AI_VIDEO",
        generationModel: "tal/3.0",
        videoFormat: "landscape",
      }),
    ).toThrowError(ProviderError);
  });

  it("fails when the stored model was removed from the catalogue entirely", () => {
    // Not the same case as a disabled provider: the vendor is enabled and keyed,
    // but the project holds an id the catalogue has never carried and no alias
    // maps. §42 again — the nearest surviving model is not what the user chose.
    allReady();

    expect(() =>
      generationPlanFor({
        generationMode: "AI_VIDEO",
        generationModel: "tal/9.0",
        videoFormat: "landscape",
      }),
    ).toThrowError(ProviderError);
  });

  it("fails when AI video was chosen but no model was stored", () => {
    allReady();

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

describe("generationOptions — what the picker is told (§3, §4, §10, §19)", () => {
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
    configure({
      VIDEO_GEN_PROVIDERS: "seedance,veo",
      GEMINI_API_KEY: "unit-placeholder",
    });

    const ids = generationOptions("scale").models.map((m) => m.id);

    // Absent rather than present-and-flagged: a flagged model is one careless
    // render away from being selected.
    expect(ids).not.toContain("tal/3.0");
    expect(ids).toContain("tal/3.1");
  });

  it("lists the four branded models, unlocked on Scale (§2)", () => {
    allReady();

    const models = generationOptions("scale").models;

    // The picker's job is to show the choice, so this is the assertion that the
    // choice exists: the four tiers §2 names, in order, all selectable.
    expect(models.map((m) => m.id)).toEqual([
      "tal/1.0",
      "tal/2.0",
      "tal/3.0",
      "tal/3.1",
    ]);
    expect(models.map((m) => m.label)).toEqual([
      "Tal 1.0 — Fast Model",
      "Tal 2.0 — Creators Model",
      "Tal 3.0 — Cinematic Model",
      "Tal 3.1 — Ultra Model",
    ]);
    expect(models.some((m) => m.locked)).toBe(false);
    // A mix of tiers, or `premiumVideoModels` would be an entitlement over nothing.
    expect(models.filter((m) => m.premium).map((m) => m.id)).toEqual(["tal/3.1"]);
  });

  it("never names the vendor behind a model (§3, §14)", () => {
    allReady();

    // The whole payload, serialised, because this object is returned to the browser
    // and the assertion has to cover fields nobody thought to check. Word-anchored:
    // "fal" is a substring of ordinary English, so a bare `includes` would either
    // fail on innocent copy or get relaxed until it tested nothing.
    const serialised = JSON.stringify(generationOptions("scale"));

    for (const vendor of [
      /\bfal\b/i,
      /fal\.ai/i,
      /\bseedance\b/i,
      /\bminimax\b/i,
      /\bhailuo\b/i,
      /\bkling\b/i,
      /\bwan\b/i,
      /\bveo\b/i,
      /\bgemini\b/i,
      /\bimagen\b/i,
      /\bdashscope\b/i,
      /\balibaba\b/i,
      /\bbytedance\b/i,
      /\bvolcengine\b/i,
      /\bark\b/i,
      /\brunway\b/i,
      /\bqwen\b/i,
    ]) {
      expect(serialised).not.toMatch(vendor);
    }
  });

  it("does not carry a provider field at all, rather than a renamed one (§3)", () => {
    allReady();

    // Absence, not obfuscation: a UI cannot render what it was never sent, and a
    // future contributor cannot re-expose a field the type does not hold.
    for (const model of generationOptions("scale").models) {
      expect(model).not.toHaveProperty("provider");
      expect(Object.keys(model)).not.toContain("provider");
    }
  });

  it("gives each model only the resolutions it declares (§4)", () => {
    allReady();

    const byId = new Map(generationOptions("scale").models.map((m) => [m.id, m]));

    // §4's "do not show an option the underlying model does not support", read off
    // the payload the picker iterates. The lists differ per model, which is the
    // point — a single shared list would be the fabrication §19 forbids.
    expect(byId.get("tal/1.0")?.qualities.map((q) => q.quality)).toEqual([
      "draft",
      "720p",
      "1080p",
    ]);
    expect(byId.get("tal/2.0")?.qualities.map((q) => q.quality)).toEqual([
      "720p",
      "1080p",
    ]);
    expect(byId.get("tal/3.1")?.qualities.map((q) => q.quality)).toEqual([
      "720p",
      "1080p",
    ]);

    for (const model of byId.values()) {
      expect(model.qualities.length).toBeGreaterThan(0);
      // No video model generates 2K. Listing it would be a capability invented for
      // the sake of a fuller-looking picker.
      expect(model.qualities.map((q) => q.quality)).not.toContain("2k");
      // The default has to be one of the options, or the picker opens on a value
      // it cannot show as selected.
      expect(model.qualities.map((q) => q.quality)).toContain(model.defaultQuality);
    }
  });

  it("describes each model in the words §3 specifies", () => {
    allReady();

    const byId = new Map(generationOptions("scale").models.map((m) => [m.id, m]));

    expect(byId.get("tal/1.0")?.description).toBe(
      "Fast generation • Great for high-volume content",
    );
    expect(byId.get("tal/1.0")?.bestFor).toBe(
      "Shorts, simple scenes, rapid production",
    );
    expect(byId.get("tal/3.1")?.description).toBe("Premium generation quality");
    expect(byId.get("tal/3.1")?.bestFor).toBe(
      "Hero scenes, premium productions and highest visual quality",
    );
  });

  it("carries the whole quality vocabulary alongside the per-model lists (§4)", () => {
    allReady();

    const options = generationOptions("scale");

    // So the control can show an unsupported tier as unavailable rather than making
    // options appear and disappear as the user compares models.
    expect(options.qualities.map((q) => q.quality)).toEqual([
      "draft",
      "720p",
      "1080p",
      "2k",
    ]);
    expect(options.qualities.filter((q) => q.recommended).map((q) => q.quality)).toEqual(
      ["1080p"],
    );
  });

  it("locks only the premium model on Studio", () => {
    allReady();

    const options = generationOptions("studio");

    expect(options.modes.find((m) => m.mode === "AI_VIDEO")?.locked).toBe(false);
    for (const model of options.models) expect(model.locked).toBe(model.premium);
    // Studio can still generate: a plan that lists models and locks all of them
    // would report `aiAvailable` false, which is the regression this guards.
    expect(options.aiAvailable).toBe(true);
  });

  it("locks every model and the AI mode itself on the free tier", () => {
    allReady();

    const options = generationOptions("starter");

    expect(options.modes.find((m) => m.mode === "AI_VIDEO")?.locked).toBe(true);
    expect(options.models.every((m) => m.locked)).toBe(true);
    // Configured, but not usable by this caller — which is what aiAvailable means.
    expect(options.aiAvailable).toBe(false);
  });

  it("unlocks everything configured on Scale", () => {
    ultraOnly();

    const options = generationOptions("scale");

    expect(options.models.length).toBeGreaterThan(0);
    expect(options.models.some((m) => m.locked)).toBe(false);
    expect(options.aiAvailable).toBe(true);
  });

  it("never includes a credential in what the picker receives (§21)", () => {
    configure({
      VIDEO_GEN_PROVIDERS: "qwen,minimax,seedance,veo",
      DASHSCOPE_API_KEY: "dashscope-unit-placeholder-value",
      MINIMAX_API_KEY: "minimax-unit-placeholder-value",
      SEEDANCE_API_KEY: "seedance-unit-placeholder-value",
      GEMINI_API_KEY: "gemini-unit-placeholder-value",
    });

    const serialised = JSON.stringify(generationOptions("scale"));

    for (const value of [
      "dashscope-unit-placeholder-value",
      "minimax-unit-placeholder-value",
      "seedance-unit-placeholder-value",
      "gemini-unit-placeholder-value",
    ]) {
      expect(serialised).not.toContain(value);
    }
    // Not even the variable names, which would tell a reader which vendors are
    // behind the models (§3) as surely as the labels would.
    expect(serialised).not.toMatch(
      /DASHSCOPE_API_KEY|MINIMAX_API_KEY|SEEDANCE_API_KEY|GEMINI_API_KEY|FAL_KEY/,
    );
  });
});

/**
 * The prices the picker quotes (§20).
 *
 * §20 requires the customer to see the cost before generating, and §9 requires the
 * quote, the charge and the refund to be the same number. `generationOptions` is where
 * the quote is produced, so these cases are about one property above all others: the
 * figure in the payload is the figure `creditCostFor` will bill. Asserting it by
 * calling `scenePriceFor` back would be circular — it would pass if both were wrong
 * together — so the cases below fix the actual numbers and the relationships between
 * them instead.
 */
describe("generationOptions — the cost preview (§20)", () => {
  it("prices every resolution on every model, never at zero", () => {
    allReady();

    for (const model of generationOptions("scale").models) {
      for (const quality of model.qualities) {
        // §9's floor. A zero-credit option would be free provider spend, and it is the
        // draft tier on the cheapest model where a rounding change would first produce
        // one.
        expect(quality.sceneCredits, `${model.id}/${quality.quality}`).toBeGreaterThan(
          0,
        );
        expect(Number.isInteger(quality.sceneCredits)).toBe(true);
      }
    }
  });

  it("never prices a higher resolution below a lower one on the same model (§9)", () => {
    allReady();

    for (const model of generationOptions("scale").models) {
      const prices = model.qualities.map((q) => q.sceneCredits);
      // The per-model list is ascending by `qualityRank`, so the prices must be
      // non-decreasing in the order the picker renders them. A row where 1080p sat
      // below 720p would let a customer buy the better resolution for less by reading
      // down the list.
      for (let i = 1; i < prices.length; i += 1) {
        expect(prices[i], `${model.id} ${i}`).toBeGreaterThanOrEqual(
          prices[i - 1] as number,
        );
      }
    }
  });

  it("quotes the four branded tiers at ascending prices (§4, §9)", () => {
    allReady();

    const byId = new Map(generationOptions("scale").models.map((m) => [m.id, m]));

    /*
     * The literal figures, at 1080p, which is every model's recommended tier.
     *
     * Fixed rather than derived: this is the customer-visible price list, and a change
     * to it is a pricing decision that should have to be made deliberately in two
     * places. Tal 1.0 → 3.1 is 5 → 10 → 20 → 40, the rates in `credits/pricing`
     * multiplied by 1080p's 1.0.
     */
    expect(byId.get("tal/1.0")?.qualities.find((q) => q.quality === "1080p")?.sceneCredits).toBe(5);
    expect(byId.get("tal/2.0")?.qualities.find((q) => q.quality === "1080p")?.sceneCredits).toBe(10);
    expect(byId.get("tal/3.0")?.qualities.find((q) => q.quality === "1080p")?.sceneCredits).toBe(20);
    expect(byId.get("tal/3.1")?.qualities.find((q) => q.quality === "1080p")?.sceneCredits).toBe(40);

    // The multiplier, which is the whole reason the resolution row shows a price: draft
    // is half of 1080p on the one model that offers it.
    expect(byId.get("tal/1.0")?.qualities.find((q) => q.quality === "draft")?.sceneCredits).toBe(3);
    expect(byId.get("tal/1.0")?.qualities.find((q) => q.quality === "720p")?.sceneCredits).toBe(4);
  });

  it("headlines each model at its own default resolution", () => {
    allReady();

    for (const model of generationOptions("scale").models) {
      const atDefault = model.qualities.find((q) => q.quality === model.defaultQuality);
      /*
       * The headline figure and the row the picker opens on have to agree, or the model
       * card quotes one number and the resolution beneath it quotes another the instant
       * the screen renders — with nothing the user did in between to explain it.
       */
      expect(atDefault, model.id).toBeDefined();
      expect(model.sceneCredits, model.id).toBe(atDefault?.sceneCredits);
      // Quoted per five seconds, which is the unit `credits/pricing` rates are in. A UI
      // that printed "per scene" against a per-second figure would understate a 10s
      // clip by half.
      expect(model.sceneSeconds).toBe(5);
    }
  });

  it("prices reference images only on models that draw them (§5, §16)", () => {
    allReady();

    const models = generationOptions("scale").models;
    // Both cases have to be present or the assertion is vacuous: a run where every
    // model drew images would pass the null branch without testing it.
    expect(models.some((m) => m.capabilities.imageGeneration)).toBe(true);

    for (const model of models) {
      for (const quality of model.qualities) {
        if (model.capabilities.imageGeneration) {
          expect(quality.imageCredits, `${model.id}/${quality.quality}`).toBeGreaterThan(
            0,
          );
        } else {
          /*
           * Null, not a number. `imagePriceFor` returns a price for any id, so quoting
           * one here would advertise a capability `resolveImageModel` refuses — the
           * customer would be shown a price for something they cannot buy.
           */
          expect(quality.imageCredits, `${model.id}/${quality.quality}`).toBeNull();
        }
      }
    }
  });

  it("prices a locked model too, so an upgrade can be compared (§19, §20)", () => {
    allReady();

    const premium = generationOptions("studio").models.find((m) => m.premium);

    // A locked card without a price is an upgrade prompt with no argument behind it.
    // The price is not an authorisation: `validateSelection` still refuses the
    // selection with 402, which the surrounding cases assert.
    expect(premium?.locked).toBe(true);
    expect(premium?.sceneCredits).toBe(40);
  });

  it("carries no price anywhere in the payload that names a vendor rate (§3)", () => {
    allReady();

    // The pricing table is keyed by model id, including `runway/gen4-turbo` for the
    // legacy path. A payload that leaked the key set would name a vendor through the
    // price list, which the vendor-name case above would not catch on its own.
    const serialised = JSON.stringify(generationOptions("scale"));
    expect(serialised).not.toMatch(/runway|gen4/i);
  });
});

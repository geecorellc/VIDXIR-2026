/**
 * Credit pricing (§9).
 *
 * `creditCostFor` is pure, so everything worth knowing about it is testable here — and
 * a great deal is worth knowing, because this one function decides what a customer is
 * quoted, what they are charged and what they are refunded. The properties below are
 * ordered by what they cost to get wrong:
 *
 *  - **Never free.** A zero price is unmetered provider spend. No combination of
 *    model, quality and duration may produce one.
 *  - **Never fractional.** Credits are integers in the database, so a fractional
 *    price would be rounded somewhere unspecified — and the quote and the charge would
 *    round in different places.
 *  - **Monotonic in quality and duration.** A non-monotonic table lets a customer buy
 *    2K for the price of 720p, or a 20-second clip for the price of a 5-second one.
 *  - **Covers the catalogue.** A model with no explicit rate silently falls back to
 *    the most expensive one, which is safe but mis-quotes.
 *  - **The quote equals the charge.** `scenePriceFor` is what the picker shows;
 *    it has to be the same number `creditCostFor` produces at generation time.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/env";
import {
  BASE_SECONDS,
  creditCostFor,
  hasExplicitRate,
  imagePriceFor,
  pricedModelIds,
  qualitiesByPrice,
  qualityMultiplier,
  scenePriceFor,
} from "@/lib/credits/pricing";
import { VIDEO_QUALITIES, type VideoQuality } from "@/lib/video/quality";
import { allVideoGenStatuses } from "@/lib/providers/video-gen";

/**
 * Every model the registry can resolve, configured or not, legacy included.
 *
 * `allVideoGenStatuses` rather than `availableModels` on purpose: `availableModels`
 * filters out unconfigured providers and legacy models, and both of those still need
 * prices. A legacy model is resolvable so a saved project can still render (§17), and
 * an unconfigured one becomes configured the moment an operator sets a key — a price
 * that only appeared then would be a price nobody had checked.
 */
function catalogueModelIds(): string[] {
  return allVideoGenStatuses().flatMap((status) =>
    status.models.map((model) => model.id),
  );
}

/**
 * The minimum `lib/env` needs before it will parse.
 *
 * Required only by the two catalogue-coverage cases: reaching the registry means
 * reaching `videoGenProviderIds()`, which reads the environment. Placeholders only,
 * and no credential of any kind — the registry is being enumerated, never called. The
 * pricing cases themselves need none of this, which is the point of `pricing.ts`
 * having no imports beyond `quality`.
 */
const BASE_ENV = {
  DATABASE_URL: "postgresql://vidxir:vidxir@localhost:5432/vidxir_unit",
  REDIS_URL: "redis://127.0.0.1:6379",
  S3_BUCKET: "vidxir-unit",
  S3_ACCESS_KEY_ID: "unit",
  S3_SECRET_ACCESS_KEY: "unit",
  ENCRYPTION_KEY: "a".repeat(64),
  SESSION_SECRET: "b".repeat(64),
  NODE_ENV: "test",
} as const;

const originalEnv = new Map<string, string | undefined>(
  Object.keys(BASE_ENV).map((key) => [key, process.env[key]]),
);

beforeAll(() => {
  resetEnvCache();
  for (const [key, value] of Object.entries(BASE_ENV)) {
    // Next declares NODE_ENV readonly in its ambient types; written through the
    // index signature, confined to this block.
    (process.env as Record<string, string>)[key] = value;
  }
  resetEnvCache();
});

afterAll(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else (process.env as Record<string, string>)[key] = value;
  }
  resetEnvCache();
});

/** Every (model, quality) pair the pricing table can be asked about. */
const MODELS = pricedModelIds();
const PAIRS = MODELS.flatMap((modelId) =>
  VIDEO_QUALITIES.map((quality) => ({ modelId, quality })),
);

describe("creditCostFor", () => {
  it("never prices a generation at zero", () => {
    /**
     * The whole matrix, both operations, and durations down to a single millisecond.
     * A free generation is unmetered provider spend, so this is asserted
     * exhaustively rather than on a sample.
     */
    for (const { modelId, quality } of PAIRS) {
      for (const durationMs of [1, 100, 1_000, 5_000, 60_000]) {
        const video = creditCostFor({
          operation: "video_scene",
          modelId,
          quality,
          durationMs,
        });
        expect(video, `${modelId} ${quality} ${durationMs}ms`).toBeGreaterThan(0);
      }
      expect(
        creditCostFor({ operation: "image", modelId, quality }),
        `${modelId} ${quality} image`,
      ).toBeGreaterThan(0);
    }
  });

  it("always prices in whole credits", () => {
    for (const { modelId, quality } of PAIRS) {
      // 3,333ms is chosen to make the division come out fractional before ceil.
      for (const durationMs of [3_333, 4_500, 7_777]) {
        const cost = creditCostFor({
          operation: "video_scene",
          modelId,
          quality,
          durationMs,
        });
        expect(Number.isInteger(cost), `${modelId} ${quality}`).toBe(true);
      }
      expect(
        Number.isInteger(creditCostFor({ operation: "image", modelId, quality })),
      ).toBe(true);
    }
  });

  it("never charges less for a higher quality", () => {
    /**
     * Monotonicity, checked pairwise across the ascending order rather than by
     * eyeballing the multipliers. Equal is allowed — two tiers may round to the same
     * integer on a cheap model — but a decrease is not.
     */
    const ascending = qualitiesByPrice();

    for (const modelId of MODELS) {
      for (let i = 1; i < ascending.length; i += 1) {
        const lower = ascending[i - 1] as VideoQuality;
        const higher = ascending[i] as VideoQuality;

        expect(
          scenePriceFor(modelId, higher),
          `${modelId}: ${higher} must not undercut ${lower}`,
        ).toBeGreaterThanOrEqual(scenePriceFor(modelId, lower));

        expect(
          imagePriceFor(modelId, higher),
          `${modelId} image: ${higher} must not undercut ${lower}`,
        ).toBeGreaterThanOrEqual(imagePriceFor(modelId, lower));
      }
    }
  });

  it("never charges less for a longer clip", () => {
    for (const { modelId, quality } of PAIRS) {
      let previous = 0;
      for (const seconds of [1, 5, 10, 20, 60]) {
        const cost = creditCostFor({
          operation: "video_scene",
          modelId,
          quality,
          durationMs: seconds * 1000,
        });
        expect(cost, `${modelId} ${quality} at ${seconds}s`).toBeGreaterThanOrEqual(
          previous,
        );
        previous = cost;
      }
    }
  });

  it("scales linearly with duration above the base length", () => {
    // Twice the base length on a model whose rate divides cleanly, so the assertion
    // is about the formula rather than about rounding.
    const oneClip = creditCostFor({
      operation: "video_scene",
      modelId: "tal/3.0",
      quality: "1080p",
      durationMs: BASE_SECONDS * 1000,
    });
    const twoClips = creditCostFor({
      operation: "video_scene",
      modelId: "tal/3.0",
      quality: "1080p",
      durationMs: BASE_SECONDS * 2000,
    });

    expect(oneClip).toBe(20);
    expect(twoClips).toBe(40);
  });

  it("prices a missing or zero duration as one base clip, not as nothing", () => {
    /**
     * A scene plan with a zero-length scene is an upstream bug. Charging zero for it
     * would make that bug free, and free generation is the one outcome this module
     * exists to prevent.
     */
    const base = scenePriceFor("tal/2.0", "1080p");

    expect(
      creditCostFor({ operation: "video_scene", modelId: "tal/2.0", quality: "1080p" }),
    ).toBe(base);
    expect(
      creditCostFor({
        operation: "video_scene",
        modelId: "tal/2.0",
        quality: "1080p",
        durationMs: 0,
      }),
    ).toBe(base);
    expect(
      creditCostFor({
        operation: "video_scene",
        modelId: "tal/2.0",
        quality: "1080p",
        durationMs: -5_000,
      }),
    ).toBe(base);
  });

  it("charges the most expensive rate for an unknown model, never the cheapest", () => {
    /**
     * The direction matters. An unrecognised id reaching here means validation was
     * bypassed; over-charging is a support ticket, under-charging is giving away the
     * most expensive backend to anyone who can smuggle an id through.
     */
    const unknown = scenePriceFor("some/model-that-was-deleted", "1080p");
    const dearest = Math.max(...MODELS.map((id) => scenePriceFor(id, "1080p")));

    expect(unknown).toBeGreaterThanOrEqual(dearest);
    expect(hasExplicitRate("some/model-that-was-deleted")).toBe(false);
  });

  it("charges the mock model, so the accounting path is exercised by every test", () => {
    /**
     * One credit rather than zero. Zero would be defensible — the mock spends no
     * vendor money — but every test and every verify script runs on the mock, so a
     * free mock would mean the charge, the ledger write and the refusal were never
     * exercised anywhere.
     */
    expect(scenePriceFor("mock/placeholder", "1080p")).toBe(1);
    expect(imagePriceFor("mock/placeholder", "draft")).toBe(1);
  });

  it("prices the branded models in ascending tiers", () => {
    /**
     * §3's promise is that the model names mean something to the customer: 1.0 is the
     * fast, cheap one and 3.1 is the expensive one. If the prices did not follow the
     * numbering, the picker's ordering would be actively misleading.
     */
    const tiers = ["tal/1.0", "tal/2.0", "tal/3.0", "tal/3.1"];
    const prices = tiers.map((id) => scenePriceFor(id, "1080p"));

    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(new Set(prices).size).toBe(tiers.length);
  });
});

describe("scenePriceFor and imagePriceFor", () => {
  it("quote exactly what creditCostFor will charge", () => {
    /**
     * The property that makes a cost preview trustworthy (§20). These are thin
     * wrappers today; the test exists so they cannot quietly stop being thin — a
     * "display price" that diverged from the charge is the single worst bug this
     * module could have.
     */
    for (const { modelId, quality } of PAIRS) {
      expect(scenePriceFor(modelId, quality)).toBe(
        creditCostFor({
          operation: "video_scene",
          modelId,
          quality,
          durationMs: BASE_SECONDS * 1000,
        }),
      );
      expect(imagePriceFor(modelId, quality)).toBe(
        creditCostFor({ operation: "image", modelId, quality }),
      );
    }
  });
});

describe("the pricing table and the provider catalogue", () => {
  it("prices every model the catalogue can resolve, including legacy ones", () => {
    /**
     * The coverage check §17 makes necessary. A legacy model is still resolvable, so a
     * saved project can still generate on it — and an unpriced model would fall back
     * to `UNKNOWN_RATE`, which is safe but quotes the wrong number. This fails when a
     * backend is added without a rate, which is exactly when it should.
     */
    const unpriced = catalogueModelIds().filter((id) => !hasExplicitRate(id));

    expect(unpriced).toEqual([]);
  });

  it("does not price a model the catalogue has never heard of", () => {
    // The other direction: a rate left behind after a model was deleted is dead
    // weight that reads as a supported option.
    const known = new Set(catalogueModelIds());
    const orphaned = pricedModelIds().filter((id) => !known.has(id));

    expect(orphaned).toEqual([]);
  });
});

describe("qualityMultiplier", () => {
  it("ascends with quality rank", () => {
    const ascending = qualitiesByPrice();
    const multipliers = ascending.map(qualityMultiplier);

    expect(ascending).toEqual([...VIDEO_QUALITIES]);
    expect(multipliers).toEqual([...multipliers].sort((a, b) => a - b));
  });

  it("treats 1080p as the reference price", () => {
    // The rates in the table are quoted at 1080p, so its multiplier must be exactly
    // 1 or every headline figure in the picker is wrong.
    expect(qualityMultiplier("1080p")).toBe(1);
  });
});

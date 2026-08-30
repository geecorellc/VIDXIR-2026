/**
 * What a generation costs in credits (§9).
 *
 * One pure, synchronous function — `creditCostFor` — and a table of rates. It is
 * deliberately free of database access, provider access and `env`, because the same
 * number has to be produced in three places that must never disagree:
 *
 *  1. The **cost preview** the customer is shown before they press Generate (§20).
 *  2. The **charge** taken at the generation call site (§10).
 *  3. The **refund** issued when a generation fails after being charged (§12).
 *
 * If those three ever computed the cost differently, the customer would be quoted one
 * price, billed another, and refunded a third. A pure function called by all three is
 * what makes that class of bug unrepresentable, and it is why the cost is *not*
 * stored on the model definition — a model row is edited by whoever is adding a
 * backend, whereas this file is the pricing decision.
 *
 * ## The formula
 *
 * Video: `ceil(modelRate × qualityMultiplier × seconds / BASE_SECONDS)`
 * Image: `ceil(modelImageRate × qualityMultiplier)`
 *
 * Rates are quoted per five seconds because that is the clip length every catalogued
 * backend actually produces, so the headline number in the picker ("20 credits a
 * scene") is the number for a real scene rather than a per-second figure nobody sees.
 *
 * ## Two rules that hold for every input
 *
 *  - **Never zero.** A successful generation always costs at least one credit, so a
 *    tiny duration or the cheapest quality cannot produce free provider spend. The
 *    `Math.ceil` with a floor of 1 is what enforces it, and `creditCostFor` is tested
 *    against the whole matrix for it.
 *  - **Monotonic in quality.** A higher resolution never costs less than a lower one
 *    on the same model. The multipliers are ascending and the test asserts it across
 *    every model, because a non-monotonic table would let a customer get 2K for the
 *    price of 720p.
 *
 * ## Why the mock model is not free
 *
 * `mock/placeholder` costs one credit rather than zero. Zero would be the obvious
 * choice — the mock spends no vendor money — but it would also mean the charge path,
 * the ledger write and the insufficient-credit refusal were never exercised by any
 * test or verify script, since all of them run on the mock. One credit is the
 * cheapest price that keeps the accounting real.
 */
import { qualityRank, type VideoQuality } from "@/lib/video/quality";

/** Rates are quoted per this many seconds of finished video. */
export const BASE_SECONDS = 5;

/** What is being paid for. Recorded on the ledger row so spend is attributable. */
export type CreditOperation = "video_scene" | "image";

export const CREDIT_OPERATIONS = ["video_scene", "image"] as const;

/**
 * Per-model rates, in credits.
 *
 * Keyed by the *model id* rather than the provider, because the branded model is
 * what the customer chose and what they were quoted (§3): a customer never sees
 * "Wan" or "Seedance", so a price attached to a vendor could not be explained to
 * them. The four ratios (1 : 2 : 4 : 8) mirror the relative vendor cost of the
 * backends behind Tal 1.0 through 3.1.
 */
interface ModelRate {
  /** Credits for a `BASE_SECONDS` clip at `1080p`. */
  video: number;
  /** Credits for one still at `1080p`. */
  image: number;
}

const RATES: Record<string, ModelRate> = {
  "tal/1.0": { video: 5, image: 1 },
  "tal/2.0": { video: 10, image: 2 },
  "tal/3.0": { video: 20, image: 3 },
  "tal/3.1": { video: 40, image: 4 },
  /**
   * The legacy Runway model (§17). Priced because a project saved before it was
   * retired still renders, and a render nobody can price is a render nobody can
   * charge for — it would generate free of charge indefinitely.
   */
  "runway/gen4-turbo": { video: 15, image: 1 },
  "mock/placeholder": { video: 1, image: 1 },
};

/**
 * The rate for an unknown model id.
 *
 * Reached when a project stored a model that has since been removed from the
 * catalogue outright rather than marked legacy. Priced at the most expensive rate
 * rather than the cheapest, and never at zero: the alternative to over-charging for
 * an unrecognised model is giving away the most expensive backend to anyone who can
 * get an unknown id past validation.
 *
 * In practice `resolveModel` rejects unknown ids long before this is reached, so this
 * is the second line of defence rather than the first.
 */
const UNKNOWN_RATE: ModelRate = { video: 40, image: 4 };

/**
 * Resolution multipliers, ascending with `qualityRank`.
 *
 * Ascending is a checked property, not just an observation — see the monotonicity
 * test. `2k` is 1.75× rather than 2× because vendor pricing for the top tier is
 * sub-linear in pixels; `draft` is half price rather than free for the same reason
 * the mock is not free.
 */
const QUALITY_MULTIPLIER: Record<VideoQuality, number> = {
  draft: 0.5,
  "720p": 0.75,
  "1080p": 1,
  "2k": 1.75,
};

export interface CreditCostRequest {
  operation: CreditOperation;
  /** A catalogued model id, e.g. `tal/3.0`. */
  modelId: string;
  quality: VideoQuality;
  /**
   * Clip length in milliseconds. Required for `video_scene`, ignored for `image`.
   *
   * Milliseconds rather than seconds because that is the unit `GenerateClipRequest`
   * already carries, and converting at the call site is where an off-by-1000 would
   * live.
   */
  durationMs?: number;
}

/**
 * The price of one generation, in whole credits.
 *
 * Always at least 1. Never fractional: credits are an integer currency, so a
 * fractional price would either need rounding at every display site or a decimal
 * balance column, and `ceil` here means the customer is never charged more than the
 * quoted figure.
 */
export function creditCostFor(request: CreditCostRequest): number {
  const rate = RATES[request.modelId] ?? UNKNOWN_RATE;
  const multiplier = QUALITY_MULTIPLIER[request.quality];

  if (request.operation === "image") {
    return atLeastOne(Math.ceil(rate.image * multiplier));
  }

  /**
   * A missing or nonsensical duration is priced as one base clip rather than as
   * nothing. `durationMs` comes from a scene plan, and a plan with a zero-length
   * scene is a bug upstream — charging zero for it would make that bug free.
   */
  const seconds =
    typeof request.durationMs === "number" && request.durationMs > 0
      ? request.durationMs / 1000
      : BASE_SECONDS;

  return atLeastOne(Math.ceil((rate.video * multiplier * seconds) / BASE_SECONDS));
}

function atLeastOne(value: number): number {
  return value < 1 ? 1 : value;
}

/**
 * The headline price shown next to a model in the picker (§3, §4).
 *
 * One base-length scene at the given quality — the same call `creditCostFor` gets at
 * generation time, so the number in the picker is the number that will be charged
 * rather than a separately-maintained marketing figure.
 */
export function scenePriceFor(modelId: string, quality: VideoQuality): number {
  return creditCostFor({
    operation: "video_scene",
    modelId,
    quality,
    durationMs: BASE_SECONDS * 1000,
  });
}

/** The price of one still, for the same purpose. */
export function imagePriceFor(modelId: string, quality: VideoQuality): number {
  return creditCostFor({ operation: "image", modelId, quality });
}

/**
 * Every model id this table prices, for the test that keeps it in step with the
 * provider catalogue.
 *
 * Exported rather than inlined into the test because the property being checked is
 * "the pricing table covers the catalogue", and a test that hard-codes its own list
 * of ids would pass while a newly-added model silently fell through to
 * `UNKNOWN_RATE` — which is safe, but is the *expensive* rate and would mis-quote.
 */
export function pricedModelIds(): string[] {
  return Object.keys(RATES);
}

/** Whether a model id has an explicit rate rather than falling back. */
export function hasExplicitRate(modelId: string): boolean {
  return Object.hasOwn(RATES, modelId);
}

/**
 * A quality's multiplier, for the monotonicity test and for the UI's "2× the price"
 * copy. Ordered by `qualityRank`, which is the ordering the assertion uses.
 */
export function qualityMultiplier(quality: VideoQuality): number {
  return QUALITY_MULTIPLIER[quality];
}

/** Qualities in ascending price order. Identical to `qualityRank` order by design. */
export function qualitiesByPrice(): VideoQuality[] {
  return (Object.keys(QUALITY_MULTIPLIER) as VideoQuality[]).sort(
    (a, b) => qualityRank(a) - qualityRank(b),
  );
}

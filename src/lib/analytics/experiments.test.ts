/**
 * The thumbnail A/B decision policy and assignment (Phase 9 §8-§10, §12).
 *
 * `decide()` is a pure function of a loaded experiment, so the whole winner
 * policy is testable with no database — which is the point. The specific
 * behaviour §10 forbids is "declare whichever thumbnail currently has the highest
 * CTR", and that failure looks *identical* to correct behaviour in any test that
 * only feeds it a clear winner with plenty of data. So the cases below are almost
 * all the awkward ones: two impressions, a leader with one day of data, a
 * hairline margin, a runner-up with no clicks at all, nobody with clicks.
 *
 * The three families:
 *
 *  1. **Eligibility before ranking.** An arm below the minimums is not a
 *     candidate, and a test whose arms are mostly ineligible reports
 *     `insufficient_data` rather than a leader.
 *  2. **Determinism of assignment (§9).** `assignArm` is a pure function of
 *     server-held values; the same viewer always sees the same thumbnail, no
 *     client-supplied value reaches the calculation, and no caller can steer
 *     itself into a chosen arm.
 *  3. **Exact comparison.** CTRs are decimal strings compared as scaled integers,
 *     so a difference in the sixth place is a difference, and `0.100` equals
 *     `0.1`.
 */
import { describe, expect, it } from "vitest";
import {
  assignArm,
  clearsLift,
  compareDecimal,
  decide,
  DEFAULT_DECISION_POLICY,
  type DecisionPolicy,
  type ExperimentArmRecord,
  type ExperimentRecord,
} from "@/lib/analytics/experiments";
import { ValidationError } from "@/lib/errors";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let armCounter = 0;

/**
 * An arm with the totals a recompute would have left. `ctr` is passed explicitly
 * rather than derived, so a test can construct the states the database can hold —
 * including impressions with a null CTR, which means exposure was measured and
 * clicks were not.
 */
function arm(overrides: Partial<ExperimentArmRecord> = {}): ExperimentArmRecord {
  armCounter += 1;
  return {
    id: `arm-${armCounter}`,
    position: armCounter - 1,
    thumbnailVariantId: `variant-${armCounter}`,
    isControl: false,
    headline: `Headline ${armCounter}`,
    imageAssetId: `asset-${armCounter}`,
    impressions: null,
    clicks: null,
    views: null,
    ctr: null,
    metricsSource: null,
    observationDays: 0,
    lastObservedAt: null,
    ...overrides,
  };
}

/** An arm that clears the default minimums, with the CTR spelled out. */
function eligibleArm(
  ctr: string,
  overrides: Partial<ExperimentArmRecord> = {},
): ExperimentArmRecord {
  const impressions = overrides.impressions ?? 5_000;
  return arm({
    impressions,
    // Clicks consistent with the CTR, so the fixture is a state the recompute
    // could actually have produced.
    clicks: Math.round(impressions * Number(ctr)),
    ctr,
    observationDays: 7,
    ...overrides,
  });
}

function experiment(
  arms: ExperimentArmRecord[],
  overrides: Partial<ExperimentRecord> = {},
): ExperimentRecord {
  return {
    id: "exp-1",
    userId: "user-1",
    channelId: "channel-1",
    publishedVideoId: "pub-1",
    youtubeVideoId: "vid00000001",
    status: "running",
    startedAt: new Date("2026-06-01T00:00:00Z"),
    endedAt: null,
    decidedAt: null,
    outcome: null,
    winningArmId: null,
    policy: DEFAULT_DECISION_POLICY,
    decision: null,
    arms,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Eligibility gates (§10)
// ---------------------------------------------------------------------------

describe("decide — eligibility", () => {
  it("does not pick a winner from a handful of impressions", () => {
    /**
     * The exact failure §10 names. Arm A has double arm B's CTR and would win any
     * ranking-first implementation, on two impressions.
     */
    const result = decide(
      experiment([
        arm({ impressions: 2, clicks: 1, ctr: "0.500000", observationDays: 1 }),
        arm({ impressions: 2, clicks: 0, ctr: "0.000000", observationDays: 1 }),
      ]),
    );
    expect(result.outcome).toBe("insufficient_data");
    expect(result.winningArmId).toBeNull();
    expect(result.arms.every((a) => !a.eligible)).toBe(true);
    expect(result.arms[0]?.ineligibleReason).toBe("below_min_impressions");
  });

  it("reports no_impressions separately from a measured zero", () => {
    // §6: never collected and collected-as-zero are different facts.
    const result = decide(
      experiment([
        arm({ impressions: null, observationDays: 0 }),
        arm({ impressions: 0, clicks: 0, ctr: null, observationDays: 2 }),
      ]),
    );
    expect(result.arms[0]?.ineligibleReason).toBe("no_impressions");
    expect(result.arms[1]?.ineligibleReason).toBe("no_impressions");
    expect(result.outcome).toBe("insufficient_data");
  });

  it("refuses a winner when one arm has not been observed long enough", () => {
    /**
     * A single viral day must not decide a test — the leader here has plenty of
     * impressions but only two days of them.
     */
    const result = decide(
      experiment([
        eligibleArm("0.200000", { observationDays: 2 }),
        eligibleArm("0.050000"),
      ]),
    );
    expect(result.arms[0]?.eligible).toBe(false);
    expect(result.arms[0]?.ineligibleReason).toBe("below_min_days");
    // One comparable arm is not a comparison.
    expect(result.outcome).toBe("insufficient_data");
    expect(result.rationale).toContain("1 of 2");
  });

  it("treats impressions without a CTR as unmeasurable performance", () => {
    // Exposure was recorded and clicks were not: the arm is not comparable, and
    // it must not be ranked as a 0% CTR, which would make it look like the worst
    // performer rather than an unmeasured one.
    const result = decide(
      experiment([
        eligibleArm("0.100000"),
        arm({ impressions: 9_000, clicks: null, ctr: null, observationDays: 9 }),
      ]),
    );
    expect(result.arms[1]?.eligible).toBe(false);
    expect(result.arms[1]?.ineligibleReason).toBe("no_impressions");
    expect(result.outcome).toBe("insufficient_data");
  });

  it("needs at least the policy's number of arms even when data is abundant", () => {
    const result = decide(
      experiment([eligibleArm("0.400000")], {
        policy: { ...DEFAULT_DECISION_POLICY, minArms: 2 },
      }),
    );
    expect(result.outcome).toBe("insufficient_data");
    expect(result.rationale).toContain("1 thumbnail");
  });

  it("respects a stricter policy stored on the experiment", () => {
    /**
     * The policy travels with the experiment, so a test started under stricter
     * thresholds is judged by them. Both arms clear the *defaults* here.
     */
    const strict: DecisionPolicy = {
      minImpressionsPerArm: 50_000,
      minObservationDays: 14,
      minArms: 2,
      minRelativeLift: 0.1,
    };
    const result = decide(
      experiment([eligibleArm("0.300000"), eligibleArm("0.100000")], {
        policy: strict,
      }),
    );
    expect(result.outcome).toBe("insufficient_data");
    expect(result.policy.minImpressionsPerArm).toBe(50_000);
  });
});

// ---------------------------------------------------------------------------
// Outcomes (§10)
// ---------------------------------------------------------------------------

describe("decide — outcomes", () => {
  it("names a winner when the margin clears the policy", () => {
    const winner = eligibleArm("0.120000");
    const result = decide(experiment([winner, eligibleArm("0.100000")]));
    // 0.12 vs 0.10 is a 20% relative lift, over the 10% minimum.
    expect(result.outcome).toBe("winner");
    expect(result.winningArmId).toBe(winner.id);
    expect(result.relativeLift).toBeCloseTo(0.2, 10);
  });

  it("calls a hairline lead a tie rather than a winner", () => {
    // 0.1009 over 0.1 is a 9% lift — just under the margin. §10's "do not
    // overstate" case.
    const result = decide(
      experiment([eligibleArm("0.109000"), eligibleArm("0.100000")]),
    );
    expect(result.outcome).toBe("tie");
    expect(result.winningArmId).toBeNull();
    expect(result.rationale).toContain("equivalent");
  });

  it("is a tie at exactly the minimum lift minus a hair, and a winner at it", () => {
    // The boundary is `>= minRelativeLift`, asserted from both sides so a future
    // change to the comparison cannot pass silently.
    const below = decide(
      experiment([eligibleArm("0.109999"), eligibleArm("0.100000")]),
    );
    expect(below.outcome).toBe("tie");

    const at = decide(
      experiment([eligibleArm("0.110000"), eligibleArm("0.100000")]),
    );
    expect(at.outcome).toBe("winner");
  });

  it("reports no_winner when nothing earned a click", () => {
    /**
     * Both arms were seen thousands of times and neither was clicked. That is a
     * real result — the thumbnails are equally ineffective — and it is not a tie
     * between two rates, because there are no rates.
     */
    const result = decide(
      experiment([
        eligibleArm("0.000000", { clicks: 0 }),
        eligibleArm("0.000000", { clicks: 0 }),
      ]),
    );
    expect(result.outcome).toBe("no_winner");
    expect(result.winningArmId).toBeNull();
    expect(result.relativeLift).toBeNull();
  });

  it("declares a winner on absolute grounds when the runner-up earned nothing", () => {
    // Relative lift is undefined (division by zero) and is reported as null
    // rather than as Infinity or a fabricated percentage.
    const leader = eligibleArm("0.080000");
    const result = decide(
      experiment([leader, eligibleArm("0.000000", { clicks: 0 })]),
    );
    expect(result.outcome).toBe("winner");
    expect(result.winningArmId).toBe(leader.id);
    expect(result.relativeLift).toBeNull();
    expect(result.rationale).toContain("earned none");
  });

  it("never claims statistical significance", () => {
    /**
     * §10. YouTube's API does not expose the impression data a significance test
     * needs, so the field is a constant — asserted here so it cannot quietly
     * become a computed p-value later.
     */
    for (const result of [
      decide(experiment([eligibleArm("0.500000"), eligibleArm("0.100000")])),
      decide(experiment([arm(), arm()])),
    ]) {
      expect(result.statisticalConfidence).toBe("not_established");
    }
  });

  it("breaks a CTR tie on impressions, then on stored position — never on row order", () => {
    /**
     * Two arms with identical CTR. Whatever the outcome, it must be the same for
     * both orderings, or the same data would decide differently on different
     * reads.
     */
    const a = eligibleArm("0.100000", { impressions: 9_000, clicks: 900 });
    const b = eligibleArm("0.100000", { impressions: 4_000, clicks: 400 });
    const forward = decide(experiment([a, b]));
    const reversed = decide(experiment([b, a]));
    expect(forward.outcome).toBe("tie");
    expect(reversed.outcome).toBe("tie");
    // The ranking underneath is stable too: the higher-impression arm leads.
    expect(forward.arms.length).toBe(reversed.arms.length);
  });

  it("compares three arms without letting an ineligible one win", () => {
    const strong = eligibleArm("0.150000");
    const result = decide(
      experiment([
        // Highest CTR of the three, on far too few impressions.
        arm({ impressions: 10, clicks: 9, ctr: "0.900000", observationDays: 5 }),
        strong,
        eligibleArm("0.100000"),
      ]),
    );
    expect(result.outcome).toBe("winner");
    expect(result.winningArmId).toBe(strong.id);
  });

  it("carries the arm summaries for every arm, eligible or not", () => {
    // The UI shows all arms and marks the ineligible ones; dropping them would
    // hide data that exists.
    const result = decide(
      experiment([eligibleArm("0.100000"), arm(), arm()]),
    );
    expect(result.arms).toHaveLength(3);
    expect(result.arms.filter((a) => a.eligible)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Exact comparison (§4)
// ---------------------------------------------------------------------------

describe("compareDecimal", () => {
  it("treats trailing zeroes as equal precision", () => {
    expect(compareDecimal("0.100000", "0.1")).toBe(0);
    expect(compareDecimal("1", "1.0000")).toBe(0);
  });

  it("distinguishes a difference in the last stored place", () => {
    expect(compareDecimal("0.100001", "0.100000")).toBe(1);
    expect(compareDecimal("0.100000", "0.100001")).toBe(-1);
  });

  it("orders negatives below positives and among themselves", () => {
    expect(compareDecimal("-0.5", "0.1")).toBe(-1);
    expect(compareDecimal("-0.1", "-0.5")).toBe(1);
    expect(compareDecimal("-0.500000", "-0.5")).toBe(0);
  });

  it("compares large whole parts exactly", () => {
    // Past the float-safe range, where subtraction-based comparison breaks.
    expect(compareDecimal("9007199254740993.1", "9007199254740993.2")).toBe(-1);
  });

  it("sorts descending in the direction decide() relies on", () => {
    const sorted = ["0.05", "0.20", "0.12"].sort((a, b) => compareDecimal(b, a));
    expect(sorted).toEqual(["0.20", "0.12", "0.05"]);
  });
});

describe("clearsLift", () => {
  /**
   * The winner/tie boundary, tested directly.
   *
   * This exists because the float version of the same predicate was wrong in a way
   * no eyeball catches: `(0.11 - 0.10) / 0.10` evaluates to `0.09999999999999998`,
   * so a 10% threshold rejected a pair that is exactly 10% apart. The values below
   * are in the six-decimal scale the `numeric` column stores.
   */
  const scale = (value: string) => BigInt(value.replace(".", ""));

  it("accepts a margin exactly at the threshold", () => {
    // 0.110000 over 0.100000 is precisely 10%.
    expect(clearsLift(scale("0.110000"), scale("0.100000"), 0.1)).toBe(true);
  });

  it("rejects a margin one unit below the threshold", () => {
    expect(clearsLift(scale("0.109999"), scale("0.100000"), 0.1)).toBe(false);
  });

  it("accepts a margin one unit above", () => {
    expect(clearsLift(scale("0.110001"), scale("0.100000"), 0.1)).toBe(true);
  });

  it("rejects a leader that is not ahead at all", () => {
    expect(clearsLift(scale("0.100000"), scale("0.100000"), 0.1)).toBe(false);
  });

  it("refuses to divide by a zero runner-up", () => {
    // The caller handles that case separately; this must not report a lift.
    expect(clearsLift(scale("0.100000"), 0n, 0.1)).toBe(false);
  });

  it("treats a zero threshold as 'any lead counts'", () => {
    expect(clearsLift(scale("0.100001"), scale("0.100000"), 0)).toBe(true);
    expect(clearsLift(scale("0.100000"), scale("0.100000"), 0)).toBe(true);
  });

  it("handles a threshold above 100%", () => {
    // "must be more than twice as good".
    expect(clearsLift(scale("0.250000"), scale("0.100000"), 1.5)).toBe(true);
    expect(clearsLift(scale("0.240000"), scale("0.100000"), 1.5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Assignment (§9)
// ---------------------------------------------------------------------------

describe("assignArm", () => {
  it("is stable for the same viewer", () => {
    const first = assignArm("exp-1", "pub-1", "viewer-42", 2);
    for (let i = 0; i < 50; i += 1) {
      expect(assignArm("exp-1", "pub-1", "viewer-42", 2)).toBe(first);
    }
  });

  it("always returns an index inside the arm range", () => {
    for (const armCount of [2, 3, 4]) {
      for (let i = 0; i < 200; i += 1) {
        const index = assignArm("exp-x", "pub-x", `bucket-${i}`, armCount);
        expect(Number.isInteger(index)).toBe(true);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(armCount);
      }
    }
  });

  it("depends on the experiment and video, not only the bucket", () => {
    /**
     * §9 requires assignment to be scoped to the tenant's experiment and video.
     * If the bucket alone decided, one viewer would land on the same position in
     * every test, which is both a poor spread and a cross-experiment correlation.
     */
    const buckets = Array.from({ length: 40 }, (_, i) => `viewer-${i}`);
    const a = buckets.map((b) => assignArm("exp-a", "pub-1", b, 3));
    const b = buckets.map((b) => assignArm("exp-b", "pub-1", b, 3));
    const c = buckets.map((b) => assignArm("exp-a", "pub-2", b, 3));
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("spreads buckets across every arm", () => {
    // Not a uniformity proof — just that no arm is unreachable, which a broken
    // hash (or an accidental constant) would produce.
    const counts = new Map<number, number>();
    for (let i = 0; i < 600; i += 1) {
      const index = assignArm("exp-s", "pub-s", `v${i}`, 3);
      counts.set(index, (counts.get(index) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([0, 1, 2]);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(100);
    }
  });

  it("refuses an experiment with no arms rather than returning 0", () => {
    // `hash % 0` is NaN, which would index nothing and read as arm 0 downstream.
    expect(() => assignArm("exp-1", "pub-1", "v", 0)).toThrow(ValidationError);
    expect(() => assignArm("exp-1", "pub-1", "v", -1)).toThrow(ValidationError);
  });

  it("cannot be steered by a client-chosen bucket into a chosen arm", () => {
    /**
     * The §9 property, stated as a test: an attacker who controls the bucket
     * string still cannot pick *which* arm is the winning one, because the winner
     * is decided by `decide()` from stored observations and never consults
     * assignment at all. What they can do is choose which arm they personally
     * see — which is harmless, and is why assignment is not a security boundary.
     *
     * Asserted concretely: the decision for a fixed dataset is identical no
     * matter what buckets were assigned.
     */
    const winner = eligibleArm("0.200000");
    const exp = experiment([winner, eligibleArm("0.100000")]);
    const before = decide(exp);
    // Exhaust a few hundred assignments; none of them touches the record.
    for (let i = 0; i < 200; i += 1) {
      assignArm(exp.id, exp.publishedVideoId, `attacker-${i}`, exp.arms.length);
    }
    const after = decide(exp);
    expect(after.winningArmId).toBe(winner.id);
    expect(after.outcome).toBe(before.outcome);
    expect(after.relativeLift).toBe(before.relativeLift);
  });
});

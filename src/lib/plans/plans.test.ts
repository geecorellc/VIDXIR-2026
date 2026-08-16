/**
 * Plan catalogue tests (§23, §39).
 *
 * These assert the *commercial contract* the user specified, because the plan
 * table is what every enforcement decision reads. A typo here would silently
 * hand out a paid feature, so the tiers are checked against the spec's exact
 * wording rather than against themselves.
 */
import { describe, expect, it } from "vitest";
import {
  PLAN_CATALOG,
  formatPrice,
  isPlanTier,
  planByTier,
  type FeatureKey,
  type PlanTier,
} from "@/lib/plans";
import { hasFeature, queuePriorityFor, requireFeature } from "@/lib/plans/enforce";
import { FeatureNotInPlanError } from "@/lib/errors";

describe("plan catalogue", () => {
  it("prices the three tiers as specified", () => {
    expect(planByTier("starter").priceCents).toBe(0);
    expect(planByTier("studio").priceCents).toBe(3900);
    expect(planByTier("scale").priceCents).toBe(9900);
  });

  it("limits Starter to 1 channel and 4 videos a month", () => {
    const starter = planByTier("starter");
    expect(starter.maxChannels).toBe(1);
    expect(starter.maxVideosPerMonth).toBe(4);
  });

  it("gives Studio 3 channels and unlimited videos", () => {
    const studio = planByTier("studio");
    expect(studio.maxChannels).toBe(3);
    expect(studio.maxVideosPerMonth).toBeNull();
  });

  it("gives Scale unlimited channels", () => {
    expect(planByTier("scale").maxChannels).toBeNull();
  });

  it("marks exactly one tier as the highlighted plan", () => {
    const highlighted = PLAN_CATALOG.filter((p) => p.highlight);
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]?.tier).toBe("studio");
  });

  it("throws on an unrecognised tier rather than defaulting to a paid plan", () => {
    // A corrupted subscriptions row must fail loudly. Defaulting would be a way
    // to accidentally grant entitlement.
    expect(() => planByTier("enterprise" as PlanTier)).toThrow(/Unknown plan tier/);
  });

  it("narrows unknown values with isPlanTier", () => {
    expect(isPlanTier("studio")).toBe(true);
    expect(isPlanTier("STUDIO")).toBe(false);
    expect(isPlanTier(null)).toBe(false);
    expect(isPlanTier(undefined)).toBe(false);
    expect(isPlanTier(1)).toBe(false);
  });
});

describe("feature gating", () => {
  const PAID_ONLY: FeatureKey[] = [
    "aiVoiceover",
    "brollLibrary",
    "thumbnailAbTest",
    "autoPublish",
    "scheduling",
  ];

  it("locks every paid feature on the free tier", () => {
    for (const feature of PAID_ONLY) {
      expect(hasFeature("starter", feature)).toBe(false);
    }
    expect(hasFeature("starter", "crossChannelAnalytics")).toBe(false);
    expect(hasFeature("starter", "priorityRenderQueue")).toBe(false);
  });

  it("unlocks Studio features on Studio", () => {
    for (const feature of PAID_ONLY) {
      expect(hasFeature("studio", feature)).toBe(true);
    }
  });

  it("keeps cross-channel analytics and priority rendering on Scale only", () => {
    expect(hasFeature("studio", "crossChannelAnalytics")).toBe(false);
    expect(hasFeature("studio", "priorityRenderQueue")).toBe(false);
    expect(hasFeature("scale", "crossChannelAnalytics")).toBe(true);
    expect(hasFeature("scale", "priorityRenderQueue")).toBe(true);
  });

  it("gives Scale everything Studio has", () => {
    const studio = planByTier("studio").features;
    const scale = planByTier("scale").features;
    for (const [feature, enabled] of Object.entries(studio)) {
      if (enabled) expect(scale[feature as FeatureKey]).toBe(true);
    }
  });

  it("requireFeature throws FeatureNotInPlanError naming the plan", () => {
    expect(() => requireFeature("starter", "autoPublish")).toThrowError(
      FeatureNotInPlanError,
    );
    try {
      requireFeature("starter", "autoPublish");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FeatureNotInPlanError);
      expect((error as FeatureNotInPlanError).message).toContain("Starter");
    }
  });

  it("requireFeature is silent when the plan includes the feature", () => {
    expect(() => requireFeature("studio", "autoPublish")).not.toThrow();
  });
});

describe("queue priority", () => {
  it("gives paid tiers a lower BullMQ number, which runs sooner", () => {
    const starter = queuePriorityFor("starter");
    const studio = queuePriorityFor("studio");
    const scale = queuePriorityFor("scale");
    expect(scale).toBeLessThan(studio);
    expect(studio).toBeLessThan(starter);
  });

  it("stays inside BullMQ's positive priority range", () => {
    for (const tier of ["starter", "studio", "scale"] as const) {
      expect(queuePriorityFor(tier)).toBeGreaterThan(0);
    }
  });
});

describe("formatPrice", () => {
  it("renders free as $0", () => {
    expect(formatPrice(0)).toBe("$0");
  });

  it("drops the decimals on whole dollars", () => {
    expect(formatPrice(3900)).toBe("$39");
    expect(formatPrice(9900)).toBe("$99");
  });

  it("keeps cents when they are not zero", () => {
    expect(formatPrice(1999)).toBe("$19.99");
    expect(formatPrice(150)).toBe("$1.50");
  });
});

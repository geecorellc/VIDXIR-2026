/**
 * Onboarding validation tests (§5, §34, §39).
 */
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_LEVELS,
  CONTENT_STYLES,
  LANGUAGES,
  NICHES,
  ONBOARDING_STEPS,
  REQUIRED_FIELDS,
  UPLOAD_FREQUENCIES,
  VIDEO_LENGTHS,
  VOICE_PREFERENCES,
  WEEKDAYS,
  choiceLabel,
  lengthLabel,
  nicheLabel,
  onboardingPatchSchema,
} from "@/lib/onboarding/config";

describe("choice lists", () => {
  const lists = {
    NICHES,
    LANGUAGES,
    VIDEO_LENGTHS,
    UPLOAD_FREQUENCIES,
    CONTENT_STYLES,
    VOICE_PREFERENCES,
    AUTOMATION_LEVELS,
    WEEKDAYS,
  };

  it("have unique, non-empty values and labels", () => {
    for (const [name, list] of Object.entries(lists)) {
      const values = list.map((c) => c.value);
      expect(new Set(values).size, name).toBe(values.length);
      for (const choice of list) {
        expect(choice.value.length, name).toBeGreaterThan(0);
        expect(choice.label.length, name).toBeGreaterThan(0);
      }
    }
  });

  it("covers all seven weekdays", () => {
    expect(WEEKDAYS.map((d) => d.value)).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
  });

  it("offers the three automation levels the schema accepts", () => {
    expect(AUTOMATION_LEVELS.map((l) => l.value)).toEqual([
      "manual",
      "assisted",
      "autopilot",
    ]);
  });

  it("gives every length preset a plausible duration", () => {
    for (const length of VIDEO_LENGTHS) {
      expect(length.seconds).toBeGreaterThan(0);
      expect(length.seconds).toBeLessThanOrEqual(3600);
    }
  });

  it("lets a user opt out of AI voiceover", () => {
    expect(VOICE_PREFERENCES.map((v) => v.value)).toContain("own-voice");
  });
});

describe("onboardingPatchSchema", () => {
  it("accepts one step's answers at a time", () => {
    expect(onboardingPatchSchema.safeParse({ niche: "ai-technology" }).success).toBe(true);
    expect(onboardingPatchSchema.safeParse({ lastStep: 3 }).success).toBe(true);
  });

  it("accepts free-text niches, since the list is a shortcut not a taxonomy", () => {
    expect(
      onboardingPatchSchema.safeParse({ niche: "vintage synthesiser repair" }).success,
    ).toBe(true);
  });

  it("rejects a one-character niche", () => {
    expect(onboardingPatchSchema.safeParse({ niche: "a" }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(onboardingPatchSchema.safeParse({ completedAt: new Date() }).success).toBe(
      false,
    );
    expect(onboardingPatchSchema.safeParse({ userId: "someone-else" }).success).toBe(
      false,
    );
    // Onboarding must not be a route to a paid tier.
    expect(onboardingPatchSchema.safeParse({ tier: "scale" }).success).toBe(false);
  });

  it("validates publish times as HH:MM", () => {
    expect(onboardingPatchSchema.safeParse({ publishTimes: ["07:30"] }).success).toBe(
      true,
    );
    expect(onboardingPatchSchema.safeParse({ publishTimes: ["7:30"] }).success).toBe(
      false,
    );
    expect(onboardingPatchSchema.safeParse({ publishTimes: ["25:00"] }).success).toBe(
      false,
    );
  });

  it("bounds the publish day list to real weekdays", () => {
    expect(onboardingPatchSchema.safeParse({ publishDays: [0, 6] }).success).toBe(true);
    expect(onboardingPatchSchema.safeParse({ publishDays: [7] }).success).toBe(false);
    expect(
      onboardingPatchSchema.safeParse({ publishDays: [0, 1, 2, 3, 4, 5, 6, 0] }).success,
    ).toBe(false);
  });

  it("rejects a content style the UI never offered", () => {
    expect(onboardingPatchSchema.safeParse({ contentStyle: "explainer" }).success).toBe(
      true,
    );
    expect(onboardingPatchSchema.safeParse({ contentStyle: "asmr" }).success).toBe(false);
  });

  it("caps the declared channel URL length", () => {
    expect(
      onboardingPatchSchema.safeParse({ declaredChannelUrl: "x".repeat(600) }).success,
    ).toBe(false);
  });
});

describe("required fields", () => {
  it("names only fields the patch schema accepts", () => {
    // Asserted through parse rather than by reaching into Zod internals: a
    // required field the schema rejects would make onboarding uncompletable.
    for (const field of REQUIRED_FIELDS) {
      const probe = onboardingPatchSchema.safeParse({ [field]: undefined });
      expect(probe.success, field).toBe(true);
      // And an unknown sibling is still refused, proving strictness is intact.
      expect(
        onboardingPatchSchema.safeParse({ [`${field}X`]: "x" }).success,
        field,
      ).toBe(false);
    }
  });

  it("requires the answers the generators actually depend on", () => {
    expect(REQUIRED_FIELDS).toContain("niche");
    expect(REQUIRED_FIELDS).toContain("contentStyle");
    expect(REQUIRED_FIELDS).toContain("automationLevel");
  });
});

describe("wizard steps", () => {
  it("has unique step ids", () => {
    const ids = ONBOARDING_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("numbers the eyebrows in order", () => {
    ONBOARDING_STEPS.forEach((step, index) => {
      expect(step.eyebrow).toBe(`Step ${String(index + 1).padStart(2, "0")}`);
    });
  });
});

describe("labels", () => {
  it("resolves a known length preset to its label", () => {
    expect(lengthLabel(480)).toBe("6–10 minutes");
  });

  it("describes an unlisted duration in minutes rather than failing", () => {
    expect(lengthLabel(600)).toBe("about 10 minutes");
    expect(lengthLabel(30)).toBe("30 seconds");
    expect(lengthLabel(62)).toBe("about a minute");
  });

  it("falls back to the raw value for a free-text niche", () => {
    expect(nicheLabel("ai-technology")).toBe("AI & technology");
    expect(nicheLabel("vintage synthesiser repair")).toBe("vintage synthesiser repair");
  });

  it("falls back to the raw value for an unknown choice", () => {
    expect(choiceLabel(CONTENT_STYLES, "explainer")).toBe("Explainer");
    expect(choiceLabel(CONTENT_STYLES, "mystery")).toBe("mystery");
  });
});

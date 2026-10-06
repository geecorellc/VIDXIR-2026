/**
 * Settings validation tests (§34, §39).
 *
 * These schemas are the request boundary. Two cases matter most:
 *  - `.strict()` must reject unknown keys, because a permissive schema is how a
 *    crafted body reaches a column it was never meant to touch.
 *  - `competitorChannelIds` must reject anything that is not a YouTube channel
 *    id, because those values are later interpolated into API calls.
 */
import { describe, expect, it } from "vitest";
import {
  CAPTION_STYLES,
  THUMBNAIL_STYLES,
  VIDEO_STYLES,
  accountPatchSchema,
  automationPatchSchema,
  brandKitPatchSchema,
  channelSettingsPatchSchema,
  channelUpdateSchema,
} from "@/lib/settings/config";

describe("choice lists", () => {
  it("have unique values", () => {
    for (const list of [VIDEO_STYLES, THUMBNAIL_STYLES, CAPTION_STYLES]) {
      const values = list.map((c) => c.value);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it("offer a way to turn captions off", () => {
    expect(CAPTION_STYLES.map((c) => c.value)).toContain("none");
  });
});

describe("channelSettingsPatchSchema", () => {
  it("accepts a partial patch", () => {
    const result = channelSettingsPatchSchema.safeParse({ uploadsPerWeek: 3 });
    expect(result.success).toBe(true);
  });

  it("accepts an empty patch (the route decides whether that is useful)", () => {
    expect(channelSettingsPatchSchema.safeParse({}).success).toBe(true);
  });

  it("rejects unknown keys", () => {
    // A body carrying e.g. `userId` must not be silently accepted and spread
    // into an UPDATE.
    expect(
      channelSettingsPatchSchema.safeParse({ userId: "someone-else" }).success,
    ).toBe(false);
    expect(
      channelSettingsPatchSchema.safeParse({ uploadsPerWeek: 2, isAdmin: true })
        .success,
    ).toBe(false);
  });

  it("rejects a language the UI never offered", () => {
    expect(
      channelSettingsPatchSchema.safeParse({ contentLanguage: "en-US" }).success,
    ).toBe(true);
    expect(
      channelSettingsPatchSchema.safeParse({ contentLanguage: "xx-ZZ" }).success,
    ).toBe(false);
  });

  it("bounds video length and cadence", () => {
    expect(
      channelSettingsPatchSchema.safeParse({ preferredLengthSeconds: 480 }).success,
    ).toBe(true);
    expect(
      channelSettingsPatchSchema.safeParse({ preferredLengthSeconds: 5 }).success,
    ).toBe(false);
    expect(
      channelSettingsPatchSchema.safeParse({ preferredLengthSeconds: 99999 }).success,
    ).toBe(false);
    expect(channelSettingsPatchSchema.safeParse({ uploadsPerWeek: 0 }).success).toBe(
      false,
    );
    expect(channelSettingsPatchSchema.safeParse({ uploadsPerWeek: 99 }).success).toBe(
      false,
    );
  });

  it("bounds voice speed to a usable range", () => {
    expect(channelSettingsPatchSchema.safeParse({ voiceSpeed: 1 }).success).toBe(true);
    expect(channelSettingsPatchSchema.safeParse({ voiceSpeed: 0.1 }).success).toBe(
      false,
    );
    expect(channelSettingsPatchSchema.safeParse({ voiceSpeed: 4 }).success).toBe(false);
  });

  describe("competitorChannelIds", () => {
    const valid = "UC" + "a".repeat(22);

    it("accepts a well-formed YouTube channel id", () => {
      const result = channelSettingsPatchSchema.safeParse({
        competitorChannelIds: [valid],
      });
      expect(result.success).toBe(true);
    });

    it("rejects ids that are not the YouTube shape", () => {
      for (const bad of [
        "mrbeast",
        "@mrbeast",
        "https://youtube.com/@mrbeast",
        "UC-too-short",
        "UC" + "a".repeat(23),
        "XX" + "a".repeat(22),
      ]) {
        expect(
          channelSettingsPatchSchema.safeParse({ competitorChannelIds: [bad] }).success,
          bad,
        ).toBe(false);
      }
    });

    it("rejects injection-shaped values outright", () => {
      for (const bad of [
        "UC" + "a".repeat(20) + "/..",
        "../../admin",
        "UC" + "a".repeat(21) + "&key=leak",
      ]) {
        expect(
          channelSettingsPatchSchema.safeParse({ competitorChannelIds: [bad] }).success,
          bad,
        ).toBe(false);
      }
    });

    it("caps the list so one request cannot queue unbounded research work", () => {
      const many = Array.from({ length: 26 }, () => valid);
      expect(
        channelSettingsPatchSchema.safeParse({ competitorChannelIds: many }).success,
      ).toBe(false);
    });
  });

  it("caps the keyword list and each keyword's length", () => {
    expect(channelSettingsPatchSchema.safeParse({ keywords: ["ai news"] }).success).toBe(
      true,
    );
    expect(channelSettingsPatchSchema.safeParse({ keywords: ["a"] }).success).toBe(false);
    expect(
      channelSettingsPatchSchema.safeParse({ keywords: ["x".repeat(200)] }).success,
    ).toBe(false);
    expect(
      channelSettingsPatchSchema.safeParse({
        keywords: Array.from({ length: 51 }, (_, i) => `kw${i}`),
      }).success,
    ).toBe(false);
  });
});

describe("brandKitPatchSchema", () => {
  it("accepts 3-, 6- and 8-digit hex colours", () => {
    for (const color of ["#fff", "#E8332B", "#E8332BFF", "#e8332b"]) {
      expect(brandKitPatchSchema.safeParse({ primaryColor: color }).success, color).toBe(
        true,
      );
    }
  });

  it("rejects anything that is not a hex colour", () => {
    for (const color of [
      "red",
      "rgb(232,51,43)",
      "E8332B",
      "#GGGGGG",
      "#12345",
      "javascript:alert(1)",
    ]) {
      expect(brandKitPatchSchema.safeParse({ primaryColor: color }).success, color).toBe(
        false,
      );
    }
  });

  it("accepts only offered caption styles", () => {
    expect(brandKitPatchSchema.safeParse({ captionStyle: "karaoke" }).success).toBe(true);
    expect(brandKitPatchSchema.safeParse({ captionStyle: "flashing" }).success).toBe(
      false,
    );
  });

  it("rejects unknown keys", () => {
    expect(brandKitPatchSchema.safeParse({ logoAssetId: "x" }).success).toBe(false);
  });
});

describe("automationPatchSchema", () => {
  it("accepts a valid schedule", () => {
    const result = automationPatchSchema.safeParse({
      enabled: true,
      level: "assisted",
      publishDays: [1, 3, 5],
      publishTimes: ["09:00", "18:30"],
      timezone: "Europe/London",
      videosPerWeek: 3,
    });
    expect(result.success).toBe(true);
  });

  it("rejects out-of-range weekdays", () => {
    expect(automationPatchSchema.safeParse({ publishDays: [7] }).success).toBe(false);
    expect(automationPatchSchema.safeParse({ publishDays: [-1] }).success).toBe(false);
    expect(automationPatchSchema.safeParse({ publishDays: [] }).success).toBe(false);
  });

  it("rejects malformed times", () => {
    for (const time of ["9:00", "24:00", "12:60", "noon", "09:0", "0900"]) {
      expect(automationPatchSchema.safeParse({ publishTimes: [time] }).success, time).toBe(
        false,
      );
    }
    expect(automationPatchSchema.safeParse({ publishTimes: ["00:00"] }).success).toBe(
      true,
    );
    expect(automationPatchSchema.safeParse({ publishTimes: ["23:59"] }).success).toBe(
      true,
    );
  });

  it("rejects an unknown automation level", () => {
    expect(automationPatchSchema.safeParse({ level: "autopilot" }).success).toBe(true);
    expect(automationPatchSchema.safeParse({ level: "yolo" }).success).toBe(false);
  });

  it("accepts autoPublish as a value — the plan check happens in the service", () => {
    // The schema's job is shape, not entitlement. `updateAutomation` refuses the
    // write on a plan without the feature (§24); see settings/service.
    expect(automationPatchSchema.safeParse({ autoPublish: true }).success).toBe(true);
  });

  it("rejects unknown keys such as a smuggled tier", () => {
    expect(automationPatchSchema.safeParse({ tier: "scale" }).success).toBe(false);
    expect(automationPatchSchema.safeParse({ plan: "studio" }).success).toBe(false);
  });
});

describe("channelUpdateSchema", () => {
  it("accepts any single section", () => {
    expect(channelUpdateSchema.safeParse({ settings: { uploadsPerWeek: 2 } }).success).toBe(
      true,
    );
    expect(channelUpdateSchema.safeParse({ brand: { brandName: "Vidxir AI" } }).success).toBe(
      true,
    );
    expect(channelUpdateSchema.safeParse({ automation: { enabled: false } }).success).toBe(
      true,
    );
  });

  it("accepts several sections at once", () => {
    expect(
      channelUpdateSchema.safeParse({
        settings: { uploadsPerWeek: 2 },
        brand: { primaryColor: "#E8332B" },
      }).success,
    ).toBe(true);
  });

  it("rejects an empty body", () => {
    expect(channelUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a top-level key that is not a known section", () => {
    expect(
      channelUpdateSchema.safeParse({ channelId: "other-tenant-channel" }).success,
    ).toBe(false);
  });

  it("propagates a nested validation failure", () => {
    expect(
      channelUpdateSchema.safeParse({ brand: { primaryColor: "not-a-colour" } }).success,
    ).toBe(false);
  });
});

describe("accountPatchSchema", () => {
  it("accepts a name and trims it", () => {
    const result = accountPatchSchema.safeParse({ name: "  Ada  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("Ada");
  });

  it("rejects a blank name", () => {
    expect(accountPatchSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("rejects an email change — that path must re-run verification", () => {
    expect(accountPatchSchema.safeParse({ email: "new@example.com" }).success).toBe(false);
  });

  it("rejects privilege-shaped keys", () => {
    expect(accountPatchSchema.safeParse({ emailVerifiedAt: new Date() }).success).toBe(
      false,
    );
    expect(accountPatchSchema.safeParse({ onboardedAt: new Date() }).success).toBe(false);
  });
});

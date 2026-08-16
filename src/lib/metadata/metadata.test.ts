/**
 * Metadata unit tests (§17, §39, §42).
 *
 * These cover the parts that decide whether an upload is *accepted*, not just
 * whether it looks right: YouTube rejects a whole upload for a tag list over 500
 * characters and silently ignores chapters that are malformed or non-increasing.
 * Discovering either at publish time means a failed publish for a reason the user
 * cannot see, so the constraints are enforced here and pinned here.
 *
 * `chaptersFrom` is not covered here — it reads `scenes`, so it belongs to the
 * integration suite. What is covered is everything downstream of it that decides
 * how a chapter is *rendered*, plus the tag and hashtag hygiene.
 *
 * The subjects are `format.ts` and `prompt.ts`, neither of which touches the
 * database, so this file needs no services running.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_TAGS,
  composeDescription,
  normaliseHashtags,
  normaliseTags,
  timecode,
  type DescriptionParts,
} from "@/lib/metadata/format";
import {
  MetadataDraftSchema,
  METADATA_SYSTEM_PROMPT,
  buildMetadataPrompt,
  type MetadataBrief,
} from "@/lib/metadata/prompt";

function record(overrides: Partial<DescriptionParts> = {}): DescriptionParts {
  return {
    description: "The budget tier nobody reviews, measured over three weeks.",
    chapters: [],
    hashtags: ["smarthome"],
    ...overrides,
  };
}

describe("normaliseTags", () => {
  it("strips a leading hash the model was told not to add", () => {
    expect(normaliseTags(["#smarthome", "sensors"])).toEqual([
      "smarthome",
      "sensors",
    ]);
  });

  it("removes case-insensitive duplicates", () => {
    // YouTube treats these as one tag, so keeping both spends the character
    // budget twice for a single effect.
    expect(normaliseTags(["Smart Home", "smart home", "SMART HOME"])).toEqual([
      "Smart Home",
    ]);
  });

  it("keeps at most MAX_TAGS", () => {
    const many = Array.from({ length: 40 }, (_, i) => `tag${i}`);
    expect(normaliseTags(many)).toHaveLength(MAX_TAGS);
  });

  it("stays inside YouTube's 500-character total budget", () => {
    // The real constraint, and the one that fails an upload outright rather than
    // degrading. 15 tags of 40 characters would be 615 with separators.
    const long = Array.from({ length: 15 }, (_, i) =>
      `${String(i).padStart(2, "0")}${"x".repeat(38)}`,
    );
    const tags = normaliseTags(long);
    const total = tags.join(",").length;

    expect(total).toBeLessThanOrEqual(500);
    expect(tags.length).toBeLessThan(15);
  });

  it("skips an over-budget tag but keeps a later one that fits", () => {
    // Truncating the long tag would change what the user or model asked for;
    // dropping it and keeping the short one that follows spends the remaining
    // budget usefully.
    const tags = normaliseTags([
      "x".repeat(40),
      ...Array.from({ length: 12 }, () => "y".repeat(38)),
      "ok",
    ]);
    expect(tags).toContain("ok");
  });

  it("drops single characters and empty strings", () => {
    expect(normaliseTags(["a", "", "  ", "#", "valid"])).toEqual(["valid"]);
  });

  it("truncates a single tag to the per-tag cap rather than dropping it", () => {
    const [tag] = normaliseTags(["z".repeat(120)]);
    expect(tag).toHaveLength(40);
  });
});

describe("normaliseHashtags", () => {
  it("removes hashes and internal spaces", () => {
    // "#smart home" would render as "#smart" plus a stray word on YouTube.
    expect(normaliseHashtags(["#smart home"])).toEqual(["smarthome"]);
  });

  it("keeps at most three, which is all YouTube shows above the title", () => {
    expect(normaliseHashtags(["a1", "b2", "c3", "d4", "e5"])).toEqual([
      "a1",
      "b2",
      "c3",
    ]);
  });

  it("deduplicates case-insensitively", () => {
    expect(normaliseHashtags(["SmartHome", "smarthome"])).toEqual(["SmartHome"]);
  });
});

describe("timecode", () => {
  it("renders the first chapter as 0:00, which YouTube requires", () => {
    // Chapters do not activate at all unless the first marker is exactly 0:00.
    expect(timecode(0)).toBe("0:00");
  });

  it("omits the hour when there is none", () => {
    expect(timecode(65_000)).toBe("1:05");
    expect(timecode(599_000)).toBe("9:59");
  });

  it("pads minutes once an hour is present", () => {
    expect(timecode(3_723_000)).toBe("1:02:03");
    expect(timecode(3_600_000)).toBe("1:00:00");
  });

  it("floors rather than rounds", () => {
    // 1.9s is still within the first second of the chapter; rounding up would
    // point at a moment the chapter has not started.
    expect(timecode(1_900)).toBe("0:01");
  });

  it("treats a negative offset as zero rather than emitting a broken marker", () => {
    expect(timecode(-500)).toBe("0:00");
  });
});

describe("composeDescription", () => {
  it("appends chapters and hashtags to the body", () => {
    const text = composeDescription(
      record({
        chapters: [
          { startMs: 0, label: "The claim" },
          { startMs: 60_000, label: "The test" },
          { startMs: 240_000, label: "The result" },
        ],
      }),
    );

    expect(text).toContain("The budget tier nobody reviews");
    expect(text).toContain("Chapters");
    expect(text).toContain("0:00 The claim");
    expect(text).toContain("4:00 The result");
    expect(text).toContain("#smarthome");
  });

  it("omits the chapter block below three chapters", () => {
    // YouTube needs three to enable the feature. Two timestamps in a description
    // are noise that does nothing.
    const text = composeDescription(
      record({
        chapters: [
          { startMs: 0, label: "One" },
          { startMs: 30_000, label: "Two" },
        ],
      }),
    );
    expect(text).not.toContain("Chapters");
  });

  it("omits the hashtag line when there are none", () => {
    expect(composeDescription(record({ hashtags: [] }))).not.toContain("#");
  });

  it("truncates to YouTube's description limit", () => {
    // Over the limit the upload is rejected, so the cut happens here rather than
    // at the API boundary.
    const text = composeDescription(
      record({ description: "w".repeat(MAX_DESCRIPTION_CHARS + 500) }),
    );
    expect(text).toHaveLength(MAX_DESCRIPTION_CHARS);
  });
});

describe("MetadataDraftSchema", () => {
  const valid = {
    title: "Why cheap sensors beat expensive ones",
    description:
      "A three-week test of the budget smart home tier nobody reviews, with the failure rate.",
    tags: ["budget smart home", "cheap sensors", "home automation"],
    hashtags: ["smarthome"],
    chapterLabels: ["The claim", "The test", "The result"],
    categoryId: "28",
  };

  it("accepts a well-formed draft", () => {
    expect(MetadataDraftSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a title over 100 characters", () => {
    expect(
      MetadataDraftSchema.safeParse({ ...valid, title: "x".repeat(101) }).success,
    ).toBe(false);
  });

  it("rejects a non-numeric category id", () => {
    // The Data API takes a numeric id; "Education" would be rejected at upload.
    expect(
      MetadataDraftSchema.safeParse({ ...valid, categoryId: "Education" }).success,
    ).toBe(false);
  });

  it("requires at least three tags", () => {
    expect(
      MetadataDraftSchema.safeParse({ ...valid, tags: ["one", "two"] }).success,
    ).toBe(false);
  });

  it("has no field for chapter timings", () => {
    // The model contributes labels only. A generated timestamp is a claim about
    // the video file, and the model has never seen it (§42).
    expect(Object.keys(MetadataDraftSchema.shape)).not.toContain("chapters");
    expect(MetadataDraftSchema.shape).toHaveProperty("chapterLabels");
  });
});

describe("METADATA_SYSTEM_PROMPT", () => {
  it("forbids timestamps, since the model cannot know them", () => {
    expect(METADATA_SYSTEM_PROMPT).toMatch(/never include timestamps/i);
  });

  it("forbids over-promising and inventing figures", () => {
    expect(METADATA_SYSTEM_PROMPT).toMatch(/does not deliver/i);
    expect(METADATA_SYSTEM_PROMPT).toMatch(/never invent a statistic/i);
  });

  it("forbids implying a sponsorship that does not exist", () => {
    expect(METADATA_SYSTEM_PROMPT).toMatch(/sponsorship/i);
  });
});

describe("buildMetadataPrompt", () => {
  function brief(overrides: Partial<MetadataBrief> = {}): MetadataBrief {
    return {
      channelTitle: "Wired Cottage",
      niche: "home automation",
      targetAudience: "first-time renters",
      contentLanguage: "en-GB",
      scriptTitle: "Why cheap sensors beat expensive ones",
      titleIdeas: ["The six pound sensor test"],
      hook: "Every review tests the flagship. Nobody tests the cheap one.",
      introduction: "So I bought twelve of them.",
      sections: [
        { heading: "The claim", body: "Budget sensors are said to fail fast." },
        { heading: "The test", body: "Twelve sensors, three weeks, one hallway." },
        { heading: "The result", body: "Two failed. Ten did not." },
      ],
      conclusion: "The cheap tier is fine for anything non-critical.",
      cta: "Grab the parts list.",
      references: [{ label: "Manufacturer datasheet" }],
      keywords: ["smart home"],
      brandName: "Wired Cottage",
      defaultCta: "Grab the parts list",
      ...overrides,
    };
  }

  it("includes the whole script, because the description must describe it", () => {
    const prompt = buildMetadataPrompt(brief());
    expect(prompt).toContain("Twelve sensors, three weeks, one hallway.");
    expect(prompt).toContain("Two failed. Ten did not.");
  });

  it("asks for one more label than there are sections", () => {
    // The opening gets a chapter of its own, so labels = sections + 1.
    expect(buildMetadataPrompt(brief())).toContain("Return exactly 4 chapter labels");
  });

  it("passes the script's sources through for the description", () => {
    expect(buildMetadataPrompt(brief())).toContain("Manufacturer datasheet");
  });

  it("survives a sparse brief without emitting undefined", () => {
    const prompt = buildMetadataPrompt(
      brief({
        channelTitle: null,
        niche: null,
        targetAudience: null,
        introduction: null,
        conclusion: null,
        cta: null,
        references: [],
        keywords: [],
        brandName: null,
        defaultCta: null,
        titleIdeas: [],
      }),
    );
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("null");
  });
});

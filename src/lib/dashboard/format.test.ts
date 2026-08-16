/**
 * Formatting tests (§39).
 *
 * These helpers render every number the user sees, so an off-by-a-thousand here
 * would misreport real analytics as confidently as a fake figure would.
 */
import { describe, expect, it } from "vitest";
import { compact, formatMs, formatTime, relativeTime } from "@/lib/dashboard/format";

describe("compact", () => {
  it("matches the prototype's formatting", () => {
    expect(compact(817_000)).toBe("817K");
    expect(compact(631_000)).toBe("631K");
  });

  it("leaves values under a thousand alone", () => {
    expect(compact(0)).toBe("0");
    expect(compact(7)).toBe("7");
    expect(compact(999)).toBe("999");
  });

  it("switches unit at each threshold", () => {
    expect(compact(1_000)).toBe("1K");
    expect(compact(1_500)).toBe("1.5K");
    expect(compact(999_999)).toBe("1000K");
    expect(compact(1_000_000)).toBe("1M");
    expect(compact(2_400_000)).toBe("2.4M");
    expect(compact(1_000_000_000)).toBe("1B");
  });

  it("keeps one decimal below 100 and drops it above", () => {
    expect(compact(1_234)).toBe("1.2K");
    expect(compact(123_400)).toBe("123K");
  });

  it("handles negatives", () => {
    expect(compact(-2_500)).toBe("-2.5K");
  });

  it("renders a dash rather than NaN for a non-finite value", () => {
    // An analytics gap must read as "no data", not as a number.
    expect(compact(Number.NaN)).toBe("—");
    expect(compact(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatTime", () => {
  it("matches the prototype's fmtTime", () => {
    expect(formatTime(327)).toBe("5:27");
  });

  it("pads seconds", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(5)).toBe("0:05");
    expect(formatTime(60)).toBe("1:00");
    expect(formatTime(61)).toBe("1:01");
  });

  it("counts past an hour in minutes, as YouTube durations do", () => {
    expect(formatTime(3_600)).toBe("60:00");
    expect(formatTime(3_661)).toBe("61:01");
  });

  it("truncates fractional seconds rather than rounding up past the end", () => {
    expect(formatTime(59.9)).toBe("0:59");
  });

  it("clamps invalid input to zero", () => {
    expect(formatTime(-5)).toBe("0:00");
    expect(formatTime(Number.NaN)).toBe("0:00");
  });
});

describe("formatMs", () => {
  it("converts milliseconds to a timeline position", () => {
    expect(formatMs(327_000)).toBe("5:27");
    expect(formatMs(1_500)).toBe("0:01");
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-08-16T12:00:00Z");

  it("describes the recent past", () => {
    expect(relativeTime(new Date("2026-08-16T11:58:00Z"), now)).toBe("2 minutes ago");
    expect(relativeTime(new Date("2026-08-16T09:00:00Z"), now)).toBe("3 hours ago");
    expect(relativeTime(new Date("2026-08-15T12:00:00Z"), now)).toBe("yesterday");
  });

  it("describes the future, for scheduled publishes", () => {
    expect(relativeTime(new Date("2026-08-16T15:00:00Z"), now)).toBe("in 3 hours");
    expect(relativeTime(new Date("2026-08-17T12:00:00Z"), now)).toBe("tomorrow");
  });

  it("falls through to seconds for a just-now timestamp", () => {
    expect(relativeTime(new Date("2026-08-16T11:59:59Z"), now)).toBe("1 second ago");
  });
});

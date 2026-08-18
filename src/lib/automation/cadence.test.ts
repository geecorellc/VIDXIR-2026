/**
 * Cadence arithmetic (§19).
 *
 * These tests exist because the failure mode is invisible: a cadence that is an
 * hour out publishes at the wrong time and nothing errors. The cases below are the
 * ones a naive implementation gets wrong — DST in both directions, a zone with a
 * half-hour offset, a southern-hemisphere zone whose transitions run the opposite
 * way from Europe's, and midnight, which is where "next day" and "next slot"
 * disagree.
 *
 * Every expectation is written as a UTC instant, because that is what the column
 * stores and what the scheduler compares against.
 */
import { describe, expect, it } from "vitest";
import { cadenceIsRunnable, nextSlot, safeZone } from "@/lib/automation/cadence";

/** Monday/Wednesday/Friday at 18:00 — the schema's own default. */
function cadence(overrides: Partial<Parameters<typeof nextSlot>[0]> = {}) {
  return {
    publishDays: [1, 3, 5],
    publishTimes: ["18:00"],
    timezone: "UTC",
    ...overrides,
  };
}

describe("nextSlot", () => {
  it("finds the next matching weekday and time", () => {
    // Monday 2026-03-02 09:00 UTC → the same day's 18:00.
    const slot = nextSlot(cadence(), new Date("2026-03-02T09:00:00Z"));
    expect(slot?.toISOString()).toBe("2026-03-02T18:00:00.000Z");
  });

  it("moves to the next scheduled day once today's slot has passed", () => {
    // Monday 19:00 is past 18:00, so the answer is Wednesday.
    const slot = nextSlot(cadence(), new Date("2026-03-02T19:00:00Z"));
    expect(slot?.toISOString()).toBe("2026-03-04T18:00:00.000Z");
  });

  it("is strictly after the given instant, so a claimed slot is not re-claimed", () => {
    // Exactly on the slot. Returning it again would make the scheduler start a
    // second video for the slot it just claimed.
    const slot = nextSlot(cadence(), new Date("2026-03-02T18:00:00Z"));
    expect(slot?.toISOString()).toBe("2026-03-04T18:00:00.000Z");
  });

  it("wraps across a week boundary", () => {
    // Friday 20:00 → Monday.
    const slot = nextSlot(cadence(), new Date("2026-03-06T20:00:00Z"));
    expect(slot?.toISOString()).toBe("2026-03-09T18:00:00.000Z");
  });

  it("takes the earliest of several times on the same day", () => {
    const slot = nextSlot(
      cadence({ publishTimes: ["21:00", "07:30", "12:00"] }),
      new Date("2026-03-02T08:00:00Z"),
    );
    // Sorted internally, so the order they were stored in does not matter.
    expect(slot?.toISOString()).toBe("2026-03-02T12:00:00.000Z");
  });

  it("handles midnight, where the slot belongs to the day it starts", () => {
    const slot = nextSlot(
      cadence({ publishDays: [1], publishTimes: ["00:00"] }),
      new Date("2026-03-01T23:00:00Z"),
    );
    expect(slot?.toISOString()).toBe("2026-03-02T00:00:00.000Z");
  });

  it("returns null for a cadence with no days", () => {
    expect(nextSlot(cadence({ publishDays: [] }), new Date())).toBeNull();
  });

  it("returns null for a cadence with no times", () => {
    expect(nextSlot(cadence({ publishTimes: [] }), new Date())).toBeNull();
  });

  it("drops malformed entries rather than failing the whole cadence", () => {
    const slot = nextSlot(
      cadence({ publishTimes: ["not-a-time", "25:00", "18:00", "18:99"] }),
      new Date("2026-03-02T09:00:00Z"),
    );
    expect(slot?.toISOString()).toBe("2026-03-02T18:00:00.000Z");
  });

  it("ignores out-of-range weekdays", () => {
    const slot = nextSlot(
      cadence({ publishDays: [9, -1, 3] }),
      new Date("2026-03-02T09:00:00Z"),
    );
    expect(slot?.toISOString()).toBe("2026-03-04T18:00:00.000Z");
  });
});

/**
 * The reason this module does not store an offset. "18:00 in London" is 17:00Z in
 * winter and 16:00Z in summer, so a cadence computed once in January and reused
 * would publish an hour late for eight months of the year.
 */
describe("nextSlot across daylight saving", () => {
  it("resolves a zoned time to the right instant in winter", () => {
    // 2026-03-02 is before the UK's spring transition (2026-03-29).
    const slot = nextSlot(
      cadence({ timezone: "Europe/London" }),
      new Date("2026-03-02T09:00:00Z"),
    );
    expect(slot?.toISOString()).toBe("2026-03-02T18:00:00.000Z");
  });

  it("resolves the same wall-clock time to a different instant in summer", () => {
    // 2026-06-01 is BST: 18:00 local is 17:00Z.
    const slot = nextSlot(
      cadence({ timezone: "Europe/London" }),
      new Date("2026-06-01T09:00:00Z"),
    );
    expect(slot?.toISOString()).toBe("2026-06-01T17:00:00.000Z");
  });

  it("crosses a spring-forward boundary without losing an hour", () => {
    // Friday 2026-03-27 20:00 local (GMT) → Monday 2026-03-30 18:00 local, which
    // is BST by then: 17:00Z, not 18:00Z.
    const slot = nextSlot(
      cadence({ timezone: "Europe/London" }),
      new Date("2026-03-27T20:00:00Z"),
    );
    expect(slot?.toISOString()).toBe("2026-03-30T17:00:00.000Z");
  });

  it("crosses an autumn-back boundary without gaining one", () => {
    // The UK returns to GMT on 2026-10-25. Friday 2026-10-23 20:00 BST is 19:00Z;
    // the next Monday slot is 18:00 GMT = 18:00Z.
    const slot = nextSlot(
      cadence({ timezone: "Europe/London" }),
      new Date("2026-10-23T19:00:00Z"),
    );
    expect(slot?.toISOString()).toBe("2026-10-26T18:00:00.000Z");
  });

  it("resolves a wall-clock time that does not exist to the hour after the gap", () => {
    // US Eastern springs forward 2026-03-08 at 02:00, so 02:30 never happens.
    // Landing on 03:30 is what every calendar does, and what "run at 02:30" means
    // on the day 02:30 was skipped. 03:30 EDT = 07:30Z.
    const slot = nextSlot(
      { publishDays: [0], publishTimes: ["02:30"], timezone: "America/New_York" },
      new Date("2026-03-08T04:00:00Z"),
    );
    expect(slot?.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("handles a southern-hemisphere zone, whose transitions run the other way", () => {
    // Sydney is UTC+11 (AEDT) in January: Monday 2026-01-05 18:00 local = 07:00Z.
    const slot = nextSlot(
      cadence({ timezone: "Australia/Sydney" }),
      new Date("2026-01-05T00:00:00Z"),
    );
    expect(slot?.toISOString()).toBe("2026-01-05T07:00:00.000Z");
  });

  it("handles a zone with a half-hour offset", () => {
    // Kolkata is UTC+5:30 year round: 18:00 local = 12:30Z.
    const slot = nextSlot(
      cadence({ timezone: "Asia/Kolkata" }),
      new Date("2026-03-02T00:00:00Z"),
    );
    expect(slot?.toISOString()).toBe("2026-03-02T12:30:00.000Z");
  });

  it("falls back to UTC for an unrecognised zone rather than throwing", () => {
    // The column is a free-text varchar. Running at the wrong hour is a much
    // smaller failure than a scheduler task that dies on one bad row.
    const slot = nextSlot(
      cadence({ timezone: "Mars/Olympus_Mons" }),
      new Date("2026-03-02T09:00:00Z"),
    );
    expect(slot?.toISOString()).toBe("2026-03-02T18:00:00.000Z");
  });
});

describe("safeZone", () => {
  it("accepts a real IANA zone", () => {
    expect(safeZone("Europe/Berlin")).toBe("Europe/Berlin");
  });

  it("substitutes UTC for anything Intl rejects", () => {
    expect(safeZone("Not/AZone")).toBe("UTC");
    expect(safeZone("")).toBe("UTC");
  });
});

describe("cadenceIsRunnable", () => {
  it("is true for a cadence that will fire", () => {
    expect(cadenceIsRunnable(cadence())).toBe(true);
  });

  it("is false when every day or every time is unusable", () => {
    expect(cadenceIsRunnable(cadence({ publishDays: [] }))).toBe(false);
    expect(cadenceIsRunnable(cadence({ publishTimes: [] }))).toBe(false);
    expect(cadenceIsRunnable(cadence({ publishDays: [7, 8] }))).toBe(false);
    expect(cadenceIsRunnable(cadence({ publishTimes: ["nope"] }))).toBe(false);
  });
});

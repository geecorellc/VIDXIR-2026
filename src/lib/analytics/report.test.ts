/**
 * Exact decimal arithmetic and the three-state metric model (Phase 9 §4, §6).
 *
 * These are the two places where analytics can lie quietly. Nothing here needs a
 * database, because nothing here is a query — it is the arithmetic and the
 * formatting that decide whether a figure the product calls "revenue" is the
 * figure Postgres holds.
 *
 * Two families:
 *
 *  1. **Money never touches a float.** `addDecimalStrings` and `formatMoney` are
 *     asserted on the cases where IEEE-754 diverges from decimal — `0.1 + 0.2`,
 *     long fractions, values past 2^53 minor units — because those are the ones
 *     that pass a casual eyeball and then disagree with the report they came
 *     from. Truncation over rounding in `formatMoney` is asserted deliberately:
 *     a displayed total must never exceed the stored one.
 *
 *  2. **Absence is not zero.** `isDecimalZero` has to call "0.000000" zero and
 *     must not be reachable by the `null` path, and `decimalToCents` returns null
 *     rather than 0 for input it cannot parse. A zero produced from unparseable
 *     input would be a fabricated earning of nothing (§6, §42).
 */
import { describe, expect, it } from "vitest";
import { addDecimalStrings, formatMoney } from "@/lib/analytics/report";
import {
  analyticsDate,
  decimalToCents,
  defaultWindow,
  isDecimalZero,
  isRevenueFinal,
  REVENUE_FINALISE_DAYS,
} from "@/lib/channels/analytics";

describe("addDecimalStrings", () => {
  it("adds the case floats get wrong", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in float. Not here.
    expect(addDecimalStrings(["0.100000", "0.200000"])).toBe("0.300000");
  });

  it("returns an exact zero for an empty set rather than throwing", () => {
    expect(addDecimalStrings([])).toBe("0.000000");
  });

  it("keeps full precision across many small values", () => {
    // A hundred thousandths of a cent. Float summation drifts here; integer
    // arithmetic cannot.
    const values = Array.from({ length: 100 }, () => "0.000001");
    expect(addDecimalStrings(values)).toBe("0.000100");
  });

  it("stays exact past the float-safe integer range", () => {
    // 9_007_199_254.740993 scaled by 1e6 exceeds Number.MAX_SAFE_INTEGER, so a
    // float implementation would lose the last digit.
    expect(addDecimalStrings(["9007199254.740993", "0.000001"])).toBe(
      "9007199254.740994",
    );
  });

  it("handles negatives, so a refund reduces a total", () => {
    expect(addDecimalStrings(["10.500000", "-2.250000"])).toBe("8.250000");
  });

  it("nets to exactly zero rather than a residue", () => {
    expect(addDecimalStrings(["3.140000", "-3.140000"])).toBe("0.000000");
  });

  it("normalises inputs with differing precision", () => {
    expect(addDecimalStrings(["1", "0.5", "0.25"])).toBe("1.750000");
  });

  it("truncates beyond the requested scale rather than rounding up", () => {
    // Truncation, not rounding: a total must never be larger than the sum of the
    // values that produced it.
    expect(addDecimalStrings(["0.0000009"], 6)).toBe("0.000000");
  });

  it("ignores a value that is not a decimal instead of coercing it to zero", () => {
    // A non-decimal would mean the numeric column held something impossible;
    // skipping it keeps the rest of the total exact.
    expect(addDecimalStrings(["1.000000", "not-a-number", "2.000000"])).toBe(
      "3.000000",
    );
  });
});

describe("formatMoney", () => {
  it("groups thousands and shows two places", () => {
    expect(formatMoney("4280.500000", "USD")).toBe("$4,280.50");
  });

  it("pads a bare integer", () => {
    expect(formatMoney("7", "USD")).toBe("$7.00");
  });

  it("truncates rather than rounding up, so display never exceeds the stored value", () => {
    expect(formatMoney("0.999999", "USD")).toBe("$0.99");
  });

  it("prefixes a non-USD currency with its code rather than a wrong symbol", () => {
    // Showing "$" for EUR would misstate the currency, which §6 treats the same
    // way as misstating the amount.
    expect(formatMoney("12.340000", "EUR")).toBe("EUR 12.34");
  });

  it("treats a null currency as dollars, matching the ingest default", () => {
    expect(formatMoney("1.000000", null)).toBe("$1.00");
  });

  it("keeps the sign outside the symbol", () => {
    expect(formatMoney("-3.500000", "USD")).toBe("-$3.50");
  });

  it("groups large totals correctly", () => {
    expect(formatMoney("1234567.890000", "USD")).toBe("$1,234,567.89");
  });

  it("renders an exact zero as $0.00, not as a dash", () => {
    // A *measured* zero is a real figure and must render as one. Distinguishing
    // it from absence is the caller's job, and the caller passes null instead.
    expect(formatMoney("0.000000", "USD")).toBe("$0.00");
  });
});

describe("isDecimalZero", () => {
  it("recognises zero in every written form", () => {
    for (const value of ["0", "0.0", "0.000000", "+0.00", "-0.00", ".0", "00"]) {
      expect(isDecimalZero(value), value).toBe(true);
    }
  });

  it("does not call a small non-zero figure zero", () => {
    // A sixth-decimal earning is real money at scale. `Number("0.000001") === 0`
    // is false, but a naive `toFixed(2)` comparison would have said true.
    for (const value of ["0.000001", "-0.000001", "0.01", "1"]) {
      expect(isDecimalZero(value), value).toBe(false);
    }
  });

  it("tolerates surrounding whitespace from a driver round-trip", () => {
    expect(isDecimalZero("  0.00  ")).toBe(true);
  });
});

describe("decimalToCents", () => {
  it("converts without a float round-trip", () => {
    expect(decimalToCents("1.23")).toBe(123);
    expect(decimalToCents("0.10")).toBe(10);
    expect(decimalToCents("12")).toBe(1200);
  });

  it("rounds half-up on the third decimal", () => {
    expect(decimalToCents("1.005")).toBe(101);
    expect(decimalToCents("1.004")).toBe(100);
  });

  it("keeps the sign", () => {
    expect(decimalToCents("-1.23")).toBe(-123);
  });

  it("returns null — not zero — for input it cannot parse", () => {
    // The distinction §6 exists for: "we could not read this" must not become a
    // stored earning of nothing.
    for (const value of ["", "abc", "1.2.3", "$1.00", "1e5"]) {
      expect(decimalToCents(value), value).toBeNull();
    }
  });

  it("reads a value with no whole part", () => {
    expect(decimalToCents(".50")).toBe(50);
  });
});

describe("isRevenueFinal", () => {
  const now = new Date("2026-06-01T12:00:00Z");

  it("treats a recent day as provisional, so the UI labels it an estimate", () => {
    expect(isRevenueFinal("2026-05-30", now)).toBe(false);
  });

  it("treats a day past the revision window as settled", () => {
    const old = new Date(
      now.getTime() - (REVENUE_FINALISE_DAYS + 2) * 86_400_000,
    );
    expect(isRevenueFinal(analyticsDate(old), now)).toBe(true);
  });

  it("is false exactly on the boundary rather than optimistically true", () => {
    /**
     * Both instants at UTC midnight, so the gap is exactly the window and
     * nothing rounds. The comparison is strict `>`, which is the conservative
     * direction: a figure YouTube may still revise stays labelled an estimate.
     */
    const midnight = new Date("2026-06-01T00:00:00Z");
    const boundary = new Date(
      midnight.getTime() - REVENUE_FINALISE_DAYS * 86_400_000,
    );
    expect(isRevenueFinal(analyticsDate(boundary), midnight)).toBe(false);
    // One day older is settled, so the boundary is the only ambiguous case.
    const older = new Date(boundary.getTime() - 86_400_000);
    expect(isRevenueFinal(analyticsDate(older), midnight)).toBe(true);
  });

  it("refuses to call an unparseable date final", () => {
    expect(isRevenueFinal("not-a-date", now)).toBe(false);
  });
});

describe("defaultWindow", () => {
  it("re-pulls the resettle period so revised figures converge", () => {
    const window = defaultWindow(new Date("2026-06-10T08:00:00Z"));
    expect(window.endDate).toBe("2026-06-10");
    expect(window.startDate).toBe("2026-06-06");
  });

  it("crosses a month boundary correctly", () => {
    const window = defaultWindow(new Date("2026-07-02T00:30:00Z"));
    expect(window.startDate).toBe("2026-06-28");
    expect(window.endDate).toBe("2026-07-02");
  });
});

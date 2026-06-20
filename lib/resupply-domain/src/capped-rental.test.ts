import { describe, expect, it } from "vitest";

import {
  decideCappedRentalAdvance,
  pickCappedRentalModifiers,
} from "./capped-rental";

describe("pickCappedRentalModifiers", () => {
  it("always includes RR and KH for months 1-3", () => {
    expect(pickCappedRentalModifiers("E0601", 1, false)).toEqual(["RR", "KH"]);
    expect(pickCappedRentalModifiers("E0601", 3, true)).toEqual(["RR", "KH"]);
  });

  it("uses KI for months 4-13 and adds KX only when compliant + gated HCPCS", () => {
    expect(pickCappedRentalModifiers("E0601", 4, true)).toEqual([
      "RR",
      "KI",
      "KX",
    ]);
    expect(pickCappedRentalModifiers("E0601", 13, false)).toEqual(["RR", "KI"]);
    // Compliant but a non-gated HCPCS → no KX.
    expect(pickCappedRentalModifiers("E1390", 5, true)).toEqual(["RR", "KI"]);
  });

  it("carries only RR past month 13", () => {
    expect(pickCappedRentalModifiers("E0601", 14, true)).toEqual(["RR"]);
  });
});

describe("decideCappedRentalAdvance", () => {
  const start = "2026-01-01";

  it("no-ops before the anniversary is reached", () => {
    // Month 1 anniversary = start + 30d = 2026-01-31; as of 2026-01-15 → noop.
    const d = decideCappedRentalAdvance({
      startDate: start,
      currentMonth: 1,
      maxMonths: 13,
      asOf: new Date("2026-01-15T00:00:00Z"),
    });
    expect(d.action).toBe("noop");
    expect(d.nextMonth).toBe(1);
  });

  it("advances one month once the anniversary passes", () => {
    const d = decideCappedRentalAdvance({
      startDate: start,
      currentMonth: 1,
      maxMonths: 13,
      asOf: new Date("2026-02-15T00:00:00Z"),
    });
    expect(d.action).toBe("advance");
    expect(d.nextMonth).toBe(2);
  });

  it("transfers ownership at the cap", () => {
    const d = decideCappedRentalAdvance({
      startDate: start,
      currentMonth: 13,
      maxMonths: 13,
      asOf: new Date("2030-01-01T00:00:00Z"),
    });
    expect(d.action).toBe("transfer");
  });
});

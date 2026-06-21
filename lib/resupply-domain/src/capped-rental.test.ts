import { describe, expect, it } from "vitest";

import {
  decideCappedRentalAdvance,
  pickCappedRentalModifiers,
} from "./capped-rental";

describe("pickCappedRentalModifiers — CMS capped-rental sequence", () => {
  it("emits KH for month 1, KI for months 2-3, KJ for months 4 onward", () => {
    expect(pickCappedRentalModifiers("E0601", 1, false)).toEqual(["RR", "KH"]);
    expect(pickCappedRentalModifiers("E0601", 2, false)).toEqual(["RR", "KI"]);
    expect(pickCappedRentalModifiers("E0601", 3, false)).toEqual(["RR", "KI"]);
    expect(pickCappedRentalModifiers("E0601", 4, false)).toEqual(["RR", "KJ"]);
    expect(pickCappedRentalModifiers("E0601", 13, false)).toEqual(["RR", "KJ"]);
  });

  it("keeps KJ through the longer rental caps (no bare-RR continuation claims)", () => {
    // A 36-month (oxygen-length) cycle must never send a continuation claim
    // with only "RR" — every month 4+ carries KJ.
    expect(pickCappedRentalModifiers("E1390", 14, false)).toEqual(["RR", "KJ"]);
    expect(pickCappedRentalModifiers("E1390", 15, false)).toEqual(["RR", "KJ"]);
    expect(pickCappedRentalModifiers("E1390", 36, false)).toEqual(["RR", "KJ"]);
  });

  it("adds KX on the KJ months for a compliant gated HCPCS only", () => {
    expect(pickCappedRentalModifiers("E0601", 4, true)).toEqual([
      "RR",
      "KJ",
      "KX",
    ]);
    expect(pickCappedRentalModifiers("E0470", 20, true)).toEqual([
      "RR",
      "KJ",
      "KX",
    ]);
    // Compliant but a non-gated HCPCS → no KX.
    expect(pickCappedRentalModifiers("E1390", 4, true)).toEqual(["RR", "KJ"]);
    // KX never rides on the KH/KI (month 1-3) claims.
    expect(pickCappedRentalModifiers("E0601", 1, true)).toEqual(["RR", "KH"]);
    expect(pickCappedRentalModifiers("E0601", 2, true)).toEqual(["RR", "KI"]);
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

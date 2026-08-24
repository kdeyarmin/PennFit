// The adult/pediatric boundary, by the calendar.
//
// This is a real clinical switch — it picks the plausibility window, the
// tier-1 service-line filter, and the service line the fit request tells
// staff — and an off-by-a-day in it is invisible in every other test.
//
// The original computation divided elapsed milliseconds by 365.25 days.
// That divisor is short of a real 18 years by however many leap days
// fell inside them, so a patient standing on their exact 18th birthday
// computed to 17.9986 and was classified PEDIATRIC for the day.

import { describe, it, expect } from "vitest";

import { classifyPopulationFromDob } from "./fit-assess";

/** A fixed "today" so these assertions never drift. */
const TODAY = new Date(Date.UTC(2026, 7, 24)); // 2026-08-24

describe("classifyPopulationFromDob", () => {
  it("is ADULT on the exact 18th birthday", () => {
    // The regression: 6574 elapsed days / 365.25 = 17.9986 < 18.
    expect(classifyPopulationFromDob("2008-08-24", null, TODAY)).toBe("adult");
  });

  it("is pediatric the day BEFORE the 18th birthday", () => {
    expect(classifyPopulationFromDob("2008-08-25", null, TODAY)).toBe(
      "pediatric",
    );
  });

  it("is adult the day after", () => {
    expect(classifyPopulationFromDob("2008-08-23", null, TODAY)).toBe("adult");
  });

  it("handles a leap-day birthday without drifting", () => {
    // Born 2008-02-29; on 2026-08-24 they are 18.
    expect(classifyPopulationFromDob("2008-02-29", null, TODAY)).toBe("adult");
    // Born 2012-02-29; they are 14.
    expect(classifyPopulationFromDob("2012-02-29", null, TODAY)).toBe(
      "pediatric",
    );
  });

  it("classifies an obvious child and an obvious adult", () => {
    expect(classifyPopulationFromDob("2018-01-01", null, TODAY)).toBe(
      "pediatric",
    );
    expect(classifyPopulationFromDob("1959-04-12", null, TODAY)).toBe("adult");
  });

  it("accepts a full timestamp, not just a date", () => {
    expect(classifyPopulationFromDob("2008-08-24T13:45:00Z", null, TODAY)).toBe(
      "adult",
    );
  });

  it("returns the fallback for an unparseable date rather than guessing", () => {
    // Guessing a service line from a malformed chart value is exactly the
    // failure this whole change exists to prevent.
    expect(classifyPopulationFromDob("", null, TODAY)).toBeNull();
    expect(classifyPopulationFromDob("not-a-date", null, TODAY)).toBeNull();
    expect(classifyPopulationFromDob("", "adult", TODAY)).toBe("adult");
  });
});

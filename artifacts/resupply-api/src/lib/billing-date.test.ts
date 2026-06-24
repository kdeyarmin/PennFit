import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  calendarDaysBetweenIso,
  localDateIso,
  practiceTimezone,
  practiceTodayIso,
} from "./billing-date";

describe("billing-date helpers", () => {
  const origTz = process.env.RESUPPLY_PRACTICE_TIMEZONE;
  beforeEach(() => {
    delete process.env.RESUPPLY_PRACTICE_TIMEZONE;
  });
  afterEach(() => {
    if (origTz === undefined) delete process.env.RESUPPLY_PRACTICE_TIMEZONE;
    else process.env.RESUPPLY_PRACTICE_TIMEZONE = origTz;
  });

  it("localDateIso resolves the practice-local calendar day, not UTC", () => {
    // 2026-06-02T02:30:00Z is still 2026-06-01 (10:30pm) in America/New_York.
    const instant = new Date("2026-06-02T02:30:00Z");
    expect(localDateIso(instant, "America/New_York")).toBe("2026-06-01");
    expect(localDateIso(instant, "UTC")).toBe("2026-06-02");
  });

  it("localDateIso falls back to America/New_York (not UTC) on an invalid tz", () => {
    const instant = new Date("2026-06-02T02:30:00Z");
    expect(localDateIso(instant, "Not/AZone")).toBe("2026-06-01");
  });

  it("practiceTimezone defaults to America/New_York when unset", () => {
    expect(practiceTimezone()).toBe("America/New_York");
  });

  it("practiceTimezone honors RESUPPLY_PRACTICE_TIMEZONE", () => {
    process.env.RESUPPLY_PRACTICE_TIMEZONE = "America/Los_Angeles";
    expect(practiceTimezone()).toBe("America/Los_Angeles");
    // 2026-06-02T05:30:00Z is 2026-06-01 (10:30pm) Pacific.
    expect(practiceTodayIso(new Date("2026-06-02T05:30:00Z"))).toBe(
      "2026-06-01",
    );
  });

  it("calendarDaysBetweenIso counts whole calendar days (DST-safe)", () => {
    expect(calendarDaysBetweenIso("2026-06-01", "2026-06-08")).toBe(7);
    expect(calendarDaysBetweenIso("2026-06-08", "2026-06-01")).toBe(-7);
    // Spans the US spring-forward DST boundary (2026-03-08) — still 7 days.
    expect(calendarDaysBetweenIso("2026-03-05", "2026-03-12")).toBe(7);
    expect(calendarDaysBetweenIso("2026-06-01T23:59:59Z", "2026-06-02")).toBe(
      1,
    );
  });
});

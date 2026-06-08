import { describe, it, expect } from "vitest";

import { resolveSnoozeUntil, MAX_SNOOZE_DAYS } from "./snooze-spec";

// A fixed Wednesday so business-day math is deterministic.
const NOW = new Date("2026-06-03T09:00:00.000Z"); // Wed

describe("resolveSnoozeUntil", () => {
  it("resolves hour/day/week durations relative to now", () => {
    expect(resolveSnoozeUntil("4h", NOW)).toEqual({
      ok: true,
      untilIso: "2026-06-03T13:00:00.000Z",
    });
    expect(resolveSnoozeUntil("1d", NOW)).toEqual({
      ok: true,
      untilIso: "2026-06-04T09:00:00.000Z",
    });
    expect(resolveSnoozeUntil("2w", NOW)).toEqual({
      ok: true,
      untilIso: "2026-06-17T09:00:00.000Z",
    });
  });

  it("is case/space-insensitive", () => {
    expect(resolveSnoozeUntil("  1D ", NOW)).toEqual({
      ok: true,
      untilIso: "2026-06-04T09:00:00.000Z",
    });
  });

  it("resolves next_business_day to the next weekday at the morning anchor", () => {
    // Wed → Thu 13:00 UTC.
    expect(resolveSnoozeUntil("next_business_day", NOW)).toEqual({
      ok: true,
      untilIso: "2026-06-04T13:00:00.000Z",
    });
    // Fri → skips Sat/Sun → Mon.
    const fri = new Date("2026-06-05T09:00:00.000Z");
    expect(resolveSnoozeUntil("next_business_day", fri)).toEqual({
      ok: true,
      untilIso: "2026-06-08T13:00:00.000Z",
    });
  });

  it("resolves next_week to +7 days", () => {
    expect(resolveSnoozeUntil("next_week", NOW)).toEqual({
      ok: true,
      untilIso: "2026-06-10T09:00:00.000Z",
    });
  });

  it("rejects unrecognized specs", () => {
    expect(resolveSnoozeUntil("someday", NOW)).toEqual({
      ok: false,
      reason: "unrecognized",
    });
    expect(resolveSnoozeUntil("0d", NOW)).toEqual({
      ok: false,
      reason: "out_of_range",
    });
  });

  it("rejects specs beyond the max horizon", () => {
    const res = resolveSnoozeUntil(`${MAX_SNOOZE_DAYS + 1}d`, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("out_of_range");
  });
});

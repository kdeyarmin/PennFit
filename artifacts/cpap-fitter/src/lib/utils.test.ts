import { describe, expect, it } from "vitest";

import {
  appDateIsoOffset,
  appDateTimeLocalInputValue,
  formatAppDate,
  formatDateOnly,
  parseAppDateTimeLocalInput,
  todayAppDateIso,
} from "./utils";

describe("app timezone date helpers", () => {
  it("derives today's ISO date in New York instead of UTC", () => {
    expect(todayAppDateIso(new Date("2026-06-13T03:30:00.000Z"))).toBe(
      "2026-06-12",
    );
    expect(todayAppDateIso(new Date("2026-06-13T04:00:00.000Z"))).toBe(
      "2026-06-13",
    );
  });

  it("formats instants using the New York calendar date", () => {
    expect(formatAppDate("2026-06-13T03:30:00.000Z", { day: "numeric" })).toBe(
      "12",
    );
  });

  it("keeps date-only values on their calendar date", () => {
    expect(formatDateOnly("2026-06-13", { day: "numeric" })).toBe("13");
  });

  it("offsets from the New York calendar date", () => {
    expect(appDateIsoOffset(1, new Date("2026-06-13T03:30:00.000Z"))).toBe(
      "2026-06-13",
    );
  });

  it("builds datetime-local values from the New York calendar date", () => {
    expect(
      appDateTimeLocalInputValue({
        date: new Date("2026-06-13T03:30:00.000Z"),
        daysFromToday: 1,
        hour: 9,
        minute: 0,
      }),
    ).toBe("2026-06-13T09:00");
  });

  it("parses New York datetime-local values as real instants", () => {
    expect(parseAppDateTimeLocalInput("2026-06-13T09:00")?.toISOString()).toBe(
      "2026-06-13T13:00:00.000Z",
    );
    expect(parseAppDateTimeLocalInput("2026-01-13T09:00")?.toISOString()).toBe(
      "2026-01-13T14:00:00.000Z",
    );
  });

  it("rejects nonexistent New York wall times during spring DST", () => {
    expect(parseAppDateTimeLocalInput("2026-03-08T02:30")).toBeNull();
  });
});

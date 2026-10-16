import { describe, expect, it } from "vitest";

import { olderThanOneBusinessDay } from "./business-day";

describe("olderThanOneBusinessDay", () => {
  it("is false inside the same weekday", () => {
    const created = new Date("2026-06-10T14:00:00Z"); // Wednesday 10:00 ET
    const now = new Date("2026-06-11T13:00:00Z"); // Thursday 09:00 ET
    expect(olderThanOneBusinessDay(created, now)).toBe(false);
  });

  it("is true after 24 weekday hours", () => {
    const created = new Date("2026-06-10T14:00:00Z");
    const now = new Date("2026-06-11T15:00:00Z");
    expect(olderThanOneBusinessDay(created, now)).toBe(true);
  });

  it("does not count a weekend as the business day", () => {
    // Friday 17:00 ET is 21:00 UTC. Monday 09:00 ET is 13:00 UTC.
    const created = new Date("2026-06-12T21:00:00Z");
    const mondayMorning = new Date("2026-06-15T13:00:00Z");
    expect(olderThanOneBusinessDay(created, mondayMorning)).toBe(false);
    const mondayEvening = new Date("2026-06-15T21:00:00Z");
    expect(olderThanOneBusinessDay(created, mondayEvening)).toBe(true);
  });
});

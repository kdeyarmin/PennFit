import { describe, expect, it } from "vitest";
import {
  ownerAnalyticsChange,
  ownerAnalyticsQuerySchema,
  ownerAnalyticsWindow,
} from "./owner-analytics";

const now = new Date("2026-09-14T15:00:00.000Z");
describe("owner analytics reporting windows", () => {
  it("defaults to 30 elapsed days with a separate equal prior period", () => {
    expect(ownerAnalyticsWindow({}, now)).toEqual({
      from: "2026-08-15T15:00:00.000Z",
      to: now.toISOString(),
      previousFrom: "2026-07-16T15:00:00.000Z",
      previousTo: "2026-08-15T15:00:00.000Z",
    });
  });
  it("turns inclusive historical dates into half-open UTC windows", () => {
    expect(
      ownerAnalyticsWindow({ from: "2026-09-01", to: "2026-09-07" }, now),
    ).toEqual({
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-08T00:00:00.000Z",
      previousFrom: "2026-08-25T00:00:00.000Z",
      previousTo: "2026-09-01T00:00:00.000Z",
    });
  });
  it("compares today's partial period with the same elapsed prior duration", () => {
    expect(
      ownerAnalyticsWindow({ from: "2026-09-14", to: "2026-09-14" }, now),
    ).toEqual({
      from: "2026-09-14T00:00:00.000Z",
      to: now.toISOString(),
      previousFrom: "2026-09-13T09:00:00.000Z",
      previousTo: "2026-09-14T00:00:00.000Z",
    });
  });
  it("handles a leap day and a 366-day range without local timezone shifts", () => {
    expect(
      ownerAnalyticsWindow({ from: "2024-01-01", to: "2024-12-31" }, now),
    ).toMatchObject({
      from: "2024-01-01T00:00:00.000Z",
      to: "2025-01-01T00:00:00.000Z",
    });
    expect(
      ownerAnalyticsWindow({ from: "2024-02-29", to: "2024-02-29" }, now).to,
    ).toBe("2024-03-01T00:00:00.000Z");
  });
  it.each([
    { from: "2026-09-15", to: "2026-09-15" },
    { from: "2026-09-10", to: "2026-09-09" },
    { from: "2024-01-01", to: "2025-01-01" },
  ])("rejects future, reversed or oversized dates: %j", (query) => {
    expect(() => ownerAnalyticsWindow(query, now)).toThrow(
      "invalid_date_range",
    );
  });
  it.each([
    { from: "2026-02-30", to: "2026-03-01" },
    { from: "2026-09-01" },
    { to: "2026-09-01" },
    { from: "2026-09-01", to: "2026-09-02", days: 7 },
    { days: 1 },
    { days: 366 },
    { days: -30 },
    { days: [7, 30] },
    { days: [7] },
    { days: true },
    { days: "30junk" },
    { orgId: "another-tenant" },
  ])("rejects ambiguous or malformed input: %j", (query) => {
    expect(ownerAnalyticsQuerySchema.safeParse(query).success).toBe(false);
  });
  it("does not manufacture percentage growth from a zero comparison or invert losses", () => {
    expect(ownerAnalyticsChange(100, 0)).toBeNull();
    expect(ownerAnalyticsChange(0, 0)).toBeNull();
    expect(ownerAnalyticsChange(-50, -100)).toBe(50);
    expect(ownerAnalyticsChange(80, 100)).toBe(-20);
  });
});

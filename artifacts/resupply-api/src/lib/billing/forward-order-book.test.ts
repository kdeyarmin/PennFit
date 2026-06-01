// Tests for Owner #4 slice 2 — the forward resupply order book.

import { describe, it, expect } from "vitest";

import {
  projectForwardOrderBook,
  type DuePrescription,
} from "./forward-order-book";

const ASOF = "2026-06-01T00:00:00Z";
const daysBefore = (n: number) =>
  new Date(Date.parse(ASOF) - n * 86_400_000).toISOString();

describe("projectForwardOrderBook", () => {
  it("buckets by when each prescription becomes eligible (lastFill + cadence)", () => {
    const rx: DuePrescription[] = [
      // last fill 80d ago, 90d cadence → eligible in 10 days → ≤30
      { lastFillIso: daysBefore(80), cadenceDays: 90 },
      // last fill 45d ago, 90d cadence → eligible in 45 days → 31–60
      { lastFillIso: daysBefore(45), cadenceDays: 90 },
      // last fill 10d ago, 90d cadence → eligible in 80 days → 61–90
      { lastFillIso: daysBefore(10), cadenceDays: 90 },
      // last fill 5d ago, 90d cadence → eligible in 85... wait 61–90 too
    ];
    const book = projectForwardOrderBook(rx, {
      asOf: ASOF,
      expectedOrderValueCents: 10000,
      confirmRate: 0.5,
    });
    expect(book.dueCount).toBe(3);
    const b30 = book.horizons.find((h) => h.withinDays === 30)!;
    const b60 = book.horizons.find((h) => h.withinDays === 60)!;
    expect(b30.dueCount).toBe(1);
    expect(b30.expectedCents).toBe(5000); // 10000 × 0.5
    expect(b60.dueCount).toBe(1);
    expect(book.totalExpectedCents).toBe(15000); // 3 × 5000
  });

  it("counts overdue prescriptions in the nearest bucket", () => {
    const rx: DuePrescription[] = [
      // last fill 200d ago, 90d cadence → eligible 110d ago (overdue) → ≤30
      { lastFillIso: daysBefore(200), cadenceDays: 90 },
    ];
    const book = projectForwardOrderBook(rx, {
      asOf: ASOF,
      expectedOrderValueCents: 8000,
      confirmRate: 1,
    });
    const b30 = book.horizons.find((h) => h.withinDays === 30)!;
    expect(b30.dueCount).toBe(1);
    expect(book.totalExpectedCents).toBe(8000);
  });

  it("skips prescriptions not yet due within the horizon", () => {
    const rx: DuePrescription[] = [
      // last fill today, 90d cadence → eligible in 90d; horizon 60 → skip
      { lastFillIso: daysBefore(0), cadenceDays: 90 },
    ];
    const book = projectForwardOrderBook(rx, { asOf: ASOF, horizonDays: 60 });
    expect(book.dueCount).toBe(0);
    expect(book.horizons).toHaveLength(2); // ≤30, 31–60 only
  });

  it("skips prescriptions with no fulfillment baseline or bad cadence", () => {
    const rx: DuePrescription[] = [
      { lastFillIso: null, cadenceDays: 90 },
      { lastFillIso: daysBefore(100), cadenceDays: 0 },
      { lastFillIso: "not-a-date", cadenceDays: 90 },
    ];
    const book = projectForwardOrderBook(rx, { asOf: ASOF });
    expect(book.dueCount).toBe(0);
    expect(book.totalExpectedCents).toBe(0);
  });

  it("echoes the assumptions", () => {
    const book = projectForwardOrderBook([], {
      asOf: ASOF,
      expectedOrderValueCents: 7500,
      confirmRate: 0.6,
      horizonDays: 90,
    });
    expect(book.assumptions).toEqual({
      expectedOrderValueCents: 7500,
      confirmRate: 0.6,
      horizonDays: 90,
      asOf: new Date(ASOF).toISOString(),
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  type ResupplyEntitlementInput,
  resolveResupplyEntitlement,
} from "./entitlement";

const NOW = new Date("2026-05-30T12:00:00Z");

// A7032 nasal cushion: every 15 days, 2 per 30-day period.
function baseInput(
  overrides: Partial<ResupplyEntitlementInput> = {},
): ResupplyEntitlementInput {
  return {
    lastFulfilledAt: null,
    minIntervalDays: 15,
    maxQuantityPerPeriod: 2,
    periodDays: 30,
    quantityInPeriod: 0,
    requestedQuantity: 1,
    now: NOW,
    ...overrides,
  };
}

function daysBefore(d: Date, days: number): Date {
  return new Date(d.getTime() - days * 24 * 60 * 60 * 1000);
}

describe("resolveResupplyEntitlement", () => {
  it("is eligible when never dispensed", () => {
    const r = resolveResupplyEntitlement(baseInput({ lastFulfilledAt: null }));
    expect(r.status).toBe("eligible");
    expect(r.eligible).toBe(true);
    expect(r.daysUntilEligible).toBe(0);
    expect(r.eligibleOn.getTime()).toBe(NOW.getTime());
    expect(r.maxQuantityNow).toBe(2);
  });

  it("blocks a too-soon reorder and reports the eligible date", () => {
    // Dispensed 5 days ago; needs 15 → 10 days to go.
    const r = resolveResupplyEntitlement(
      baseInput({ lastFulfilledAt: daysBefore(NOW, 5) }),
    );
    expect(r.status).toBe("too_soon");
    expect(r.eligible).toBe(false);
    expect(r.daysUntilEligible).toBe(10);
    expect(r.eligibleOn.getTime()).toBe(daysBefore(NOW, 5 - 15).getTime());
  });

  it("is eligible exactly at the interval boundary", () => {
    // Dispensed exactly 15 days ago: eligibleOn == now, not > now.
    const r = resolveResupplyEntitlement(
      baseInput({ lastFulfilledAt: daysBefore(NOW, 15) }),
    );
    expect(r.status).toBe("eligible");
    expect(r.eligible).toBe(true);
    expect(r.daysUntilEligible).toBe(0);
  });

  it("is eligible once the interval has fully elapsed", () => {
    const r = resolveResupplyEntitlement(
      baseInput({ lastFulfilledAt: daysBefore(NOW, 40) }),
    );
    expect(r.eligible).toBe(true);
    expect(r.status).toBe("eligible");
  });

  it("rounds a partial remaining day up", () => {
    // 14.5 days ago → 0.5 days remaining → ceil to 1.
    const r = resolveResupplyEntitlement(
      baseInput({
        lastFulfilledAt: new Date(NOW.getTime() - 14.5 * 24 * 60 * 60 * 1000),
      }),
    );
    expect(r.status).toBe("too_soon");
    expect(r.daysUntilEligible).toBe(1);
  });

  it("blocks when the requested quantity would exceed the period cap", () => {
    // On the interval (never dispensed), but 2 of 2 already used.
    const r = resolveResupplyEntitlement(
      baseInput({ quantityInPeriod: 2, requestedQuantity: 1 }),
    );
    expect(r.status).toBe("quantity_exceeded");
    expect(r.eligible).toBe(false);
    expect(r.maxQuantityNow).toBe(0);
  });

  it("allows a request that fits in the remaining period allowance", () => {
    const r = resolveResupplyEntitlement(
      baseInput({ quantityInPeriod: 1, requestedQuantity: 1 }),
    );
    expect(r.status).toBe("eligible");
    expect(r.eligible).toBe(true);
    expect(r.maxQuantityNow).toBe(1);
  });

  it("reports the interval block first when both gates fail", () => {
    const r = resolveResupplyEntitlement(
      baseInput({
        lastFulfilledAt: daysBefore(NOW, 5),
        quantityInPeriod: 2,
        requestedQuantity: 1,
      }),
    );
    expect(r.status).toBe("too_soon");
    expect(r.eligible).toBe(false);
    // Quantity info still surfaced for the UI.
    expect(r.maxQuantityNow).toBe(0);
  });

  it("defaults requestedQuantity to 1 when omitted", () => {
    const r = resolveResupplyEntitlement(
      baseInput({ requestedQuantity: undefined, quantityInPeriod: 2 }),
    );
    expect(r.status).toBe("quantity_exceeded");
  });

  it("clamps a negative quantityInPeriod to zero", () => {
    const r = resolveResupplyEntitlement(
      baseInput({ quantityInPeriod: -5, requestedQuantity: 2 }),
    );
    expect(r.maxQuantityNow).toBe(2);
    expect(r.eligible).toBe(true);
  });

  it("treats a single-unit-per-period item (headgear) correctly", () => {
    // A7035 headgear: every 180 days, 1 per 180.
    const r = resolveResupplyEntitlement({
      lastFulfilledAt: daysBefore(NOW, 200),
      minIntervalDays: 180,
      maxQuantityPerPeriod: 1,
      periodDays: 180,
      quantityInPeriod: 0,
      requestedQuantity: 1,
      now: NOW,
    });
    expect(r.eligible).toBe(true);
  });

  describe("bad reference data must not silently authorize a dispense", () => {
    it("does not mark a just-dispensed patient eligible on a NaN interval", () => {
      // Un-clamped, NaN would make eligibleOn an Invalid Date → tooSoon
      // false → silently eligible. Clamped to 0 it is deterministic and
      // explainable (no interval gate), never an Invalid-Date artifact.
      const r = resolveResupplyEntitlement(
        baseInput({
          lastFulfilledAt: daysBefore(NOW, 1),
          minIntervalDays: Number.NaN,
        }),
      );
      expect(Number.isNaN(r.eligibleOn.getTime())).toBe(false);
      expect(r.daysUntilEligible).toBe(0);
    });

    it("clamps a negative interval to 0 rather than the past", () => {
      const r = resolveResupplyEntitlement(
        baseInput({
          lastFulfilledAt: daysBefore(NOW, 1),
          minIntervalDays: -30,
        }),
      );
      expect(r.eligibleOn.getTime()).toBe(daysBefore(NOW, 1).getTime());
    });

    it("clamps an Infinity quantity cap to 0 (no quantity allowed)", () => {
      const r = resolveResupplyEntitlement(
        baseInput({
          maxQuantityPerPeriod: Number.POSITIVE_INFINITY,
          requestedQuantity: 1,
        }),
      );
      expect(r.status).toBe("quantity_exceeded");
      expect(r.maxQuantityNow).toBe(0);
    });
  });

  describe("graceDays aligns the interval gate with the ship window", () => {
    it("opens the interval gate graceDays early", () => {
      // Dispensed 12 days ago, 15-day interval → normally 3 days to go,
      // but a 5-day grace clears it now.
      const r = resolveResupplyEntitlement(
        baseInput({ lastFulfilledAt: daysBefore(NOW, 12), graceDays: 5 }),
      );
      expect(r.eligible).toBe(true);
      expect(r.daysUntilEligible).toBe(0);
    });

    it("never pushes the effective interval below zero", () => {
      const r = resolveResupplyEntitlement(
        baseInput({ lastFulfilledAt: daysBefore(NOW, 1), graceDays: 999 }),
      );
      expect(r.eligibleOn.getTime()).toBe(daysBefore(NOW, 1).getTime());
    });
  });

  describe("quantityEligibleOn dates the quantity gate when possible", () => {
    it("returns the date the earliest in-period dispense rolls off", () => {
      const earliest = daysBefore(NOW, 10);
      const r = resolveResupplyEntitlement(
        baseInput({
          lastFulfilledAt: daysBefore(NOW, 20), // interval already open
          quantityInPeriod: 2, // cap reached
          requestedQuantity: 1,
          earliestDispenseInPeriodAt: earliest,
        }),
      );
      expect(r.status).toBe("quantity_exceeded");
      expect(r.quantityEligibleOn?.getTime()).toBe(
        new Date(earliest.getTime() + 30 * 24 * 60 * 60 * 1000).getTime(),
      );
      expect(r.reason).toContain("frees up on");
    });

    it("is null when the earliest dispense wasn't supplied", () => {
      const r = resolveResupplyEntitlement(
        baseInput({
          lastFulfilledAt: daysBefore(NOW, 20),
          quantityInPeriod: 2,
        }),
      );
      expect(r.status).toBe("quantity_exceeded");
      expect(r.quantityEligibleOn).toBeNull();
    });

    it("is null when quantity is not the binding constraint", () => {
      const r = resolveResupplyEntitlement(
        baseInput({
          lastFulfilledAt: daysBefore(NOW, 5), // too soon dominates
          quantityInPeriod: 2,
          earliestDispenseInPeriodAt: daysBefore(NOW, 5),
        }),
      );
      expect(r.status).toBe("too_soon");
      expect(r.quantityEligibleOn).toBeNull();
    });
  });
});

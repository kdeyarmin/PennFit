import { describe, expect, it } from "vitest";

import {
  REFILL_CONTACT_LEAD_DAYS,
  REFILL_SHIP_LEAD_DAYS,
  resolveRefillWindow,
  type RefillWindowInput,
} from "./refill-window";

const NOW = new Date("2026-06-19T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysBefore(d: Date, days: number): Date {
  return new Date(d.getTime() - days * DAY_MS);
}

// 30-day supply (e.g. a 1-per-30-days cushion family).
function input(overrides: Partial<RefillWindowInput> = {}): RefillWindowInput {
  return {
    lastFulfilledAt: daysBefore(NOW, 30),
    supplyDurationDays: 30,
    now: NOW,
    ...overrides,
  };
}

describe("resolveRefillWindow", () => {
  it("opens both windows on a first fill (null last dispense)", () => {
    const r = resolveRefillWindow(input({ lastFulfilledAt: null }));
    expect(r.contactAllowed).toBe(true);
    expect(r.shipAllowed).toBe(true);
    expect(r.expectedDepletionOn).toBeNull();
    expect(r.earliestContactOn).toBeNull();
    expect(r.earliestShipOn).toBeNull();
    expect(r.daysUntilContact).toBe(0);
    expect(r.daysUntilShip).toBe(0);
  });

  it("computes depletion = last dispense + supply duration", () => {
    const last = daysBefore(NOW, 10);
    const r = resolveRefillWindow(
      input({ lastFulfilledAt: last, supplyDurationDays: 30 }),
    );
    expect(r.expectedDepletionOn?.getTime()).toBe(last.getTime() + 30 * DAY_MS);
  });

  it("blocks contact before the 14-day contact window opens", () => {
    // Dispensed today, 30-day supply → depletion in 30d, contact opens in
    // 30 − 14 = 16 days. Nothing should be contactable yet.
    const r = resolveRefillWindow(
      input({ lastFulfilledAt: NOW, supplyDurationDays: 30 }),
    );
    expect(r.contactAllowed).toBe(false);
    expect(r.shipAllowed).toBe(false);
    expect(r.daysUntilContact).toBe(30 - REFILL_CONTACT_LEAD_DAYS);
    expect(r.daysUntilShip).toBe(30 - REFILL_SHIP_LEAD_DAYS);
  });

  it("allows contact but not ship inside the 14d but outside the 10d window", () => {
    // Depletion 12 days out: contact window (≤14d) is open, ship window
    // (≤10d) is not.
    const last = daysBefore(NOW, 30 - 12);
    const r = resolveRefillWindow(
      input({ lastFulfilledAt: last, supplyDurationDays: 30 }),
    );
    expect(r.contactAllowed).toBe(true);
    expect(r.shipAllowed).toBe(false);
    expect(r.daysUntilContact).toBe(0);
    expect(r.daysUntilShip).toBe(2);
  });

  it("allows ship exactly at the 10-day-early boundary", () => {
    // Depletion exactly 10 days out → earliestShipOn === now → allowed.
    const last = daysBefore(NOW, 30 - REFILL_SHIP_LEAD_DAYS);
    const r = resolveRefillWindow(
      input({ lastFulfilledAt: last, supplyDurationDays: 30 }),
    );
    expect(r.shipAllowed).toBe(true);
    expect(r.daysUntilShip).toBe(0);
  });

  it("allows both windows once the supply is at/after depletion", () => {
    const last = daysBefore(NOW, 40); // depleted 10 days ago
    const r = resolveRefillWindow(
      input({ lastFulfilledAt: last, supplyDurationDays: 30 }),
    );
    expect(r.contactAllowed).toBe(true);
    expect(r.shipAllowed).toBe(true);
  });

  it("clamps a non-positive supply duration to at least 1 day", () => {
    const r = resolveRefillWindow(
      input({ lastFulfilledAt: NOW, supplyDurationDays: 0 }),
    );
    // duration clamps to 1 → depletion tomorrow → already inside both
    // windows (1 < 10 < 14).
    expect(r.contactAllowed).toBe(true);
    expect(r.shipAllowed).toBe(true);
  });
});

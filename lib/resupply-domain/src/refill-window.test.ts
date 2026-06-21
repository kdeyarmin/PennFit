import { describe, expect, it } from "vitest";

import {
  REFILL_AFFIRMATION_STATEMENT,
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

  it("falls back to 1 day for non-finite supply durations (no Invalid Dates)", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const r = resolveRefillWindow(
        input({ lastFulfilledAt: NOW, supplyDurationDays: bad }),
      );
      // Treated as a 1-day supply → both windows open, valid dates.
      expect(r.contactAllowed).toBe(true);
      expect(r.shipAllowed).toBe(true);
      expect(Number.isNaN(r.expectedDepletionOn?.getTime() ?? NaN)).toBe(false);
    }
  });

  describe("same-or-similar (related last-dispense dates)", () => {
    it("is identical to single-family when the related array is omitted", () => {
      const last = daysBefore(NOW, 30 - 12); // depletion 12 days out
      const withOut = resolveRefillWindow(
        input({ lastFulfilledAt: last, supplyDurationDays: 30 }),
      );
      const withEmpty = resolveRefillWindow(
        input({
          lastFulfilledAt: last,
          supplyDurationDays: 30,
          relatedLastFulfilledAt: [],
        }),
      );
      expect(withEmpty).toEqual(withOut);
      // Sanity: this is the "contact-but-not-ship" window from above.
      expect(withOut.contactAllowed).toBe(true);
      expect(withOut.shipAllowed).toBe(false);
    });

    it("uses the MAX (latest) of family + related as the effective last dispense", () => {
      // Family was dispensed 40 days ago (already depleted → both open),
      // BUT a same-or-similar item was dispensed TODAY. The later (today)
      // date wins, pushing depletion 30 days out → nothing contactable yet.
      const r = resolveRefillWindow(
        input({
          lastFulfilledAt: daysBefore(NOW, 40),
          relatedLastFulfilledAt: [NOW],
          supplyDurationDays: 30,
        }),
      );
      expect(r.expectedDepletionOn?.getTime()).toBe(
        NOW.getTime() + 30 * DAY_MS,
      );
      expect(r.contactAllowed).toBe(false);
      expect(r.shipAllowed).toBe(false);
      expect(r.daysUntilContact).toBe(30 - REFILL_CONTACT_LEAD_DAYS);
      expect(r.daysUntilShip).toBe(30 - REFILL_SHIP_LEAD_DAYS);
    });

    it("ignores null and Invalid-Date related entries (never NaN-poisons the MAX)", () => {
      const last = daysBefore(NOW, 30); // depleted today → both open
      const r = resolveRefillWindow(
        input({
          lastFulfilledAt: last,
          relatedLastFulfilledAt: [null, new Date("not-a-date")],
          supplyDurationDays: 30,
        }),
      );
      // Bad entries dropped → MAX is just `last` → behaves as single-family.
      expect(r.expectedDepletionOn?.getTime()).toBe(
        last.getTime() + 30 * DAY_MS,
      );
      expect(r.contactAllowed).toBe(true);
      expect(r.shipAllowed).toBe(true);
    });

    it("blocks via a related date even when the family is a first fill (null)", () => {
      // No family last-dispense, but a similar item went out today → the
      // window is computed off the related date, NOT treated as a first fill.
      const r = resolveRefillWindow(
        input({
          lastFulfilledAt: null,
          relatedLastFulfilledAt: [NOW],
          supplyDurationDays: 30,
        }),
      );
      expect(r.expectedDepletionOn?.getTime()).toBe(
        NOW.getTime() + 30 * DAY_MS,
      );
      expect(r.contactAllowed).toBe(false);
      expect(r.shipAllowed).toBe(false);
    });

    it("treats null family + only bad related entries as a first fill (open)", () => {
      const r = resolveRefillWindow(
        input({
          lastFulfilledAt: null,
          relatedLastFulfilledAt: [null, new Date("nope")],
          supplyDurationDays: 30,
        }),
      );
      expect(r.expectedDepletionOn).toBeNull();
      expect(r.contactAllowed).toBe(true);
      expect(r.shipAllowed).toBe(true);
    });
  });

  describe("non-finite guards", () => {
    it("blocks deterministically (finite countdowns) when `now` is an Invalid Date", () => {
      const r = resolveRefillWindow(
        input({
          lastFulfilledAt: NOW,
          supplyDurationDays: 30,
          now: new Date("not-a-date"),
        }),
      );
      // Can't prove a window is open with no clock → block both, report the
      // full lead as a finite worst-case countdown (never NaN).
      expect(r.contactAllowed).toBe(false);
      expect(r.shipAllowed).toBe(false);
      expect(r.daysUntilContact).toBe(REFILL_CONTACT_LEAD_DAYS);
      expect(r.daysUntilShip).toBe(REFILL_SHIP_LEAD_DAYS);
      expect(Number.isNaN(r.daysUntilContact)).toBe(false);
      expect(Number.isNaN(r.daysUntilShip)).toBe(false);
      // Dates are still the real computed window, not Invalid.
      expect(Number.isNaN(r.expectedDepletionOn?.getTime() ?? NaN)).toBe(false);
    });

    it("treats an Invalid-Date `lastFulfilledAt` (no rescuing related) as a first fill", () => {
      const r = resolveRefillWindow(
        input({
          lastFulfilledAt: new Date("garbage"),
          supplyDurationDays: 30,
        }),
      );
      expect(r.expectedDepletionOn).toBeNull();
      expect(r.contactAllowed).toBe(true);
      expect(r.shipAllowed).toBe(true);
    });
  });

  describe("per-call lead overrides", () => {
    it("honors a custom contactLeadDays / shipLeadDays", () => {
      // Depletion 20 days out. Default 14/10 leads → neither open. With a
      // 25-day contact lead and 21-day ship lead → both open early.
      const last = daysBefore(NOW, 30 - 20);
      const base = { lastFulfilledAt: last, supplyDurationDays: 30 };
      const def = resolveRefillWindow(input(base));
      expect(def.contactAllowed).toBe(false);
      expect(def.shipAllowed).toBe(false);

      const wide = resolveRefillWindow(
        input({ ...base, contactLeadDays: 25, shipLeadDays: 21 }),
      );
      expect(wide.contactAllowed).toBe(true);
      expect(wide.shipAllowed).toBe(true);
      expect(wide.earliestContactOn?.getTime()).toBe(
        (wide.expectedDepletionOn?.getTime() ?? NaN) - 25 * DAY_MS,
      );
      expect(wide.earliestShipOn?.getTime()).toBe(
        (wide.expectedDepletionOn?.getTime() ?? NaN) - 21 * DAY_MS,
      );
    });

    it("clamps negative / non-finite lead overrides to a safe whole-day value", () => {
      // Depletion exactly today (dispensed 30d ago, 30d supply). A negative
      // contact lead clamps to 0 → earliestContactOn === depletion === now.
      const last = daysBefore(NOW, 30);
      const r = resolveRefillWindow(
        input({
          lastFulfilledAt: last,
          supplyDurationDays: 30,
          contactLeadDays: -5,
          shipLeadDays: NaN, // non-finite → default 10
        }),
      );
      // contactLead clamped to 0 → opens exactly at depletion (now).
      expect(r.earliestContactOn?.getTime()).toBe(
        r.expectedDepletionOn?.getTime(),
      );
      expect(r.contactAllowed).toBe(true);
      // shipLead fell back to the default 10.
      expect(r.earliestShipOn?.getTime()).toBe(
        (r.expectedDepletionOn?.getTime() ?? NaN) -
          REFILL_SHIP_LEAD_DAYS * DAY_MS,
      );
    });
  });

  it("locks the exact regulatory wording of REFILL_AFFIRMATION_STATEMENT", () => {
    // This is snapshotted onto every refill_confirmations row as the proof
    // the patient saw — it must NOT silently change. Assert the full text.
    expect(REFILL_AFFIRMATION_STATEMENT).toBe(
      "I confirm that I am still using my equipment and that my current " +
        "supplies are running low or used up, and I am requesting a refill.",
    );
    // Spot-check the two load-bearing clauses survive any future reflow.
    expect(REFILL_AFFIRMATION_STATEMENT).toContain("still using my equipment");
    expect(REFILL_AFFIRMATION_STATEMENT).toContain("requesting a refill");
  });
});

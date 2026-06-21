import { describe, expect, it } from "vitest";

import { prorateCents } from "./proration";

describe("prorateCents", () => {
  it("prorates to the remaining fraction and rounds", () => {
    expect(
      prorateCents({ amountCents: 3000, daysRemaining: 15, periodDays: 30 }),
    ).toBe(1500);
    expect(
      prorateCents({ amountCents: 1000, daysRemaining: 10, periodDays: 30 }),
    ).toBe(333);
  });

  it("returns the full amount at a full period remaining", () => {
    expect(
      prorateCents({ amountCents: 2500, daysRemaining: 30, periodDays: 30 }),
    ).toBe(2500);
  });

  it("returns 0 for a non-positive period", () => {
    expect(
      prorateCents({ amountCents: 2500, daysRemaining: 5, periodDays: 0 }),
    ).toBe(0);
    expect(
      prorateCents({ amountCents: 2500, daysRemaining: 5, periodDays: -3 }),
    ).toBe(0);
  });

  it("clamps daysRemaining into [0, periodDays]", () => {
    expect(
      prorateCents({ amountCents: 3000, daysRemaining: 99, periodDays: 30 }),
    ).toBe(3000);
    expect(
      prorateCents({ amountCents: 3000, daysRemaining: -5, periodDays: 30 }),
    ).toBe(0);
  });

  it("prorates a negative amount (credit)", () => {
    expect(
      prorateCents({ amountCents: -3000, daysRemaining: 15, periodDays: 30 }),
    ).toBe(-1500);
  });

  it("guards non-finite inputs", () => {
    expect(
      prorateCents({
        amountCents: Number.NaN,
        daysRemaining: 15,
        periodDays: 30,
      }),
    ).toBe(0);
    expect(
      prorateCents({
        amountCents: 3000,
        daysRemaining: 15,
        periodDays: Number.POSITIVE_INFINITY,
      }),
    ).toBe(0);
  });
});

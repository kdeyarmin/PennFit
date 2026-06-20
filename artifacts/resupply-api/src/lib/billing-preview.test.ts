import { describe, expect, it } from "vitest";

import { computeBillingPreview } from "./billing-preview";

describe("computeBillingPreview", () => {
  it("prorates an upgrade by the fraction of the period remaining", () => {
    // 30-day period, exactly half elapsed → half the monthly delta lands now.
    const preview = computeBillingPreview({
      currentMonthlyCents: 19900,
      newMonthlyCents: 29900,
      currentPeriodStart: "2026-06-01T00:00:00.000Z",
      currentPeriodEnd: "2026-07-01T00:00:00.000Z",
      now: new Date("2026-06-16T00:00:00.000Z"),
    });
    expect(preview.deltaMonthlyCents).toBe(10000);
    expect(preview.periodDays).toBe(30);
    expect(preview.daysRemaining).toBe(15);
    expect(preview.proratedNowCents).toBe(5000); // 10000 * 15/30
  });

  it("returns a negative prorated amount (credit) for a downgrade", () => {
    const preview = computeBillingPreview({
      currentMonthlyCents: 29900,
      newMonthlyCents: 19900,
      currentPeriodStart: "2026-06-01T00:00:00.000Z",
      currentPeriodEnd: "2026-07-01T00:00:00.000Z",
      now: new Date("2026-06-16T00:00:00.000Z"),
    });
    expect(preview.deltaMonthlyCents).toBe(-10000);
    expect(preview.proratedNowCents).toBe(-5000);
  });

  it("charges nearly the full delta at the very start of a period", () => {
    const preview = computeBillingPreview({
      currentMonthlyCents: 0,
      newMonthlyCents: 30000,
      currentPeriodStart: "2026-06-01T00:00:00.000Z",
      currentPeriodEnd: "2026-07-01T00:00:00.000Z",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(preview.daysRemaining).toBe(30);
    expect(preview.proratedNowCents).toBe(30000);
  });

  it("clamps a 'now' past the period end to zero days remaining (no proration)", () => {
    const preview = computeBillingPreview({
      currentMonthlyCents: 19900,
      newMonthlyCents: 29900,
      currentPeriodStart: "2026-06-01T00:00:00.000Z",
      currentPeriodEnd: "2026-07-01T00:00:00.000Z",
      now: new Date("2026-08-01T00:00:00.000Z"),
    });
    expect(preview.daysRemaining).toBe(0);
    expect(preview.proratedNowCents).toBe(0);
  });

  it("returns null proration when the billing period is unknown", () => {
    const preview = computeBillingPreview({
      currentMonthlyCents: 19900,
      newMonthlyCents: 29900,
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });
    expect(preview.deltaMonthlyCents).toBe(10000);
    expect(preview.proratedNowCents).toBeNull();
    expect(preview.daysRemaining).toBeNull();
    expect(preview.periodDays).toBeNull();
  });

  it("returns null proration for a malformed or inverted period", () => {
    const preview = computeBillingPreview({
      currentMonthlyCents: 100,
      newMonthlyCents: 200,
      currentPeriodStart: "2026-07-01T00:00:00.000Z",
      currentPeriodEnd: "2026-06-01T00:00:00.000Z",
      now: new Date("2026-06-16T00:00:00.000Z"),
    });
    expect(preview.proratedNowCents).toBeNull();
  });
});

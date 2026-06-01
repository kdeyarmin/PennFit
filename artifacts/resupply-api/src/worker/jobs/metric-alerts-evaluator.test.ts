import { describe, it, expect } from "vitest";

import { shiftDateUtc, buildAlertMessage } from "./metric-alerts-evaluator";

describe("shiftDateUtc", () => {
  it("subtracts 7 days across a month boundary", () => {
    expect(shiftDateUtc("2026-06-03", -7)).toBe("2026-05-27");
    expect(shiftDateUtc("2026-05-30", -7)).toBe("2026-05-23");
  });

  it("adds days as well", () => {
    expect(shiftDateUtc("2026-05-30", 7)).toBe("2026-06-06");
  });
});

describe("buildAlertMessage", () => {
  it("absolute mode formats cents", () => {
    const m = buildAlertMessage({
      metricKey: "revenue_net_cents",
      unit: "cents",
      mode: "absolute",
      comparison: "lt",
      thresholdValue: 100000,
      observedValue: 45000,
      comparedValue: 45000,
      baselineValue: null,
    });
    expect(m).toContain("revenue_net_cents is $450.00");
    expect(m).toContain("lt threshold $1000.00");
  });

  it("delta_7d mode shows the week-over-week move and both values", () => {
    const m = buildAlertMessage({
      metricKey: "denial_rate_pct",
      unit: "pct",
      mode: "delta_7d",
      comparison: "gt",
      thresholdValue: 5,
      observedValue: 12,
      comparedValue: 6,
      baselineValue: 6,
    });
    expect(m).toContain("moved 6.0% week-over-week");
    expect(m).toContain("now 12.0%, was 6.0%");
  });

  it("delta_pct_7d mode shows the percent change", () => {
    const m = buildAlertMessage({
      metricKey: "revenue_net_cents",
      unit: "cents",
      mode: "delta_pct_7d",
      comparison: "lt",
      thresholdValue: -15,
      observedValue: 8000,
      comparedValue: -20,
      baselineValue: 10000,
    });
    expect(m).toContain("changed -20.0% week-over-week");
    expect(m).toContain("now $80.00, was $100.00");
  });
});

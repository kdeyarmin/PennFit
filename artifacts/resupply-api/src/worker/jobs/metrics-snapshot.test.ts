import { describe, it, expect } from "vitest";

import { dailyWindowUtc, buildMetricRows } from "./metrics-snapshot";

describe("dailyWindowUtc", () => {
  it("returns the just-completed UTC day window", () => {
    const w = dailyWindowUtc(new Date("2026-05-31T06:30:00.000Z"));
    expect(w.metricDate).toBe("2026-05-30");
    expect(w.startIso).toBe("2026-05-30T00:00:00.000Z");
    expect(w.endIso).toBe("2026-05-31T00:00:00.000Z");
  });

  it("handles a month boundary", () => {
    const w = dailyWindowUtc(new Date("2026-06-01T00:05:00.000Z"));
    expect(w.metricDate).toBe("2026-05-31");
    expect(w.startIso).toBe("2026-05-31T00:00:00.000Z");
    expect(w.endIso).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("buildMetricRows", () => {
  it("emits the four KPI rows with net derived from gross − refunded", () => {
    const rows = buildMetricRows("2026-05-30", {
      ordersPaidCount: 12,
      revenueGrossCents: 480000,
      revenueRefundedCents: 30000,
    });
    expect(rows).toEqual([
      {
        metric_date: "2026-05-30",
        metric_key: "orders_paid_count",
        metric_value: 12,
        unit: "count",
      },
      {
        metric_date: "2026-05-30",
        metric_key: "revenue_gross_cents",
        metric_value: 480000,
        unit: "cents",
      },
      {
        metric_date: "2026-05-30",
        metric_key: "revenue_refunded_cents",
        metric_value: 30000,
        unit: "cents",
      },
      {
        metric_date: "2026-05-30",
        metric_key: "revenue_net_cents",
        metric_value: 450000,
        unit: "cents",
      },
    ]);
  });

  it("nets to zero on an empty day", () => {
    const rows = buildMetricRows("2026-05-30", {
      ordersPaidCount: 0,
      revenueGrossCents: 0,
      revenueRefundedCents: 0,
    });
    expect(
      rows.find((r) => r.metric_key === "revenue_net_cents")?.metric_value,
    ).toBe(0);
  });
});

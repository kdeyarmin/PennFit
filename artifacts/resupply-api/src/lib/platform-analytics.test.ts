import { describe, it, expect } from "vitest";

import {
  aggregatePlatformAnalytics,
  bucketCountByDay,
  bucketSumByDay,
  pctChange,
  utcDayKey,
  windowDayKeys,
  type AnalyticsTenantInput,
} from "./platform-analytics";

// A fixed "now": 2026-06-18T12:00:00Z so day math is deterministic.
const NOW = Date.parse("2026-06-18T12:00:00.000Z");

describe("windowDayKeys", () => {
  it("returns `days` UTC keys, oldest first, ending today", () => {
    const keys = windowDayKeys(NOW, 3);
    expect(keys).toEqual(["2026-06-16", "2026-06-17", "2026-06-18"]);
  });

  it("works for a single-day window", () => {
    expect(windowDayKeys(NOW, 1)).toEqual(["2026-06-18"]);
  });
});

describe("utcDayKey", () => {
  it("formats an instant as a UTC date", () => {
    expect(utcDayKey(NOW)).toBe("2026-06-18");
    // An instant late in UTC day still belongs to that UTC day.
    expect(utcDayKey(Date.parse("2026-06-18T23:59:59Z"))).toBe("2026-06-18");
  });
});

describe("bucketCountByDay", () => {
  const keys = windowDayKeys(NOW, 3); // 16, 17, 18

  it("counts timestamps into their UTC day bucket", () => {
    const out = bucketCountByDay(
      ["2026-06-16T01:00:00Z", "2026-06-18T05:00:00Z", "2026-06-18T22:00:00Z"],
      keys,
    );
    expect(out).toEqual([1, 0, 2]);
  });

  it("ignores timestamps outside the window and unparseable values", () => {
    const out = bucketCountByDay(
      ["2026-06-10T00:00:00Z", "not-a-date", "2026-06-17T00:00:00Z"],
      keys,
    );
    expect(out).toEqual([0, 1, 0]);
  });
});

describe("bucketSumByDay", () => {
  it("sums cents into day buckets", () => {
    const keys = windowDayKeys(NOW, 2); // 17, 18
    const out = bucketSumByDay(
      [
        { iso: "2026-06-17T00:00:00Z", cents: 500 },
        { iso: "2026-06-18T00:00:00Z", cents: 250 },
        { iso: "2026-06-18T10:00:00Z", cents: 250 },
      ],
      keys,
    );
    expect(out).toEqual([500, 500]);
  });
});

describe("pctChange", () => {
  it("computes a rounded percentage change", () => {
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(50, 100)).toBe(-50);
    expect(pctChange(133, 100)).toBe(33);
  });

  it("returns null when there is no baseline", () => {
    expect(pctChange(10, 0)).toBeNull();
  });
});

function tenant(
  over: Partial<AnalyticsTenantInput> &
    Pick<AnalyticsTenantInput, "id" | "slug">,
): AnalyticsTenantInput {
  return {
    name: over.name ?? over.slug,
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    allTime: { patients: 0, orders: 0, conversations: 0 },
    patientCreatedAt: [],
    orders: [],
    conversationCreatedAt: [],
    ...over,
  };
}

describe("aggregatePlatformAnalytics", () => {
  it("rolls up fleet totals, deltas, series, and a sorted leaderboard", () => {
    const result = aggregatePlatformAnalytics({
      nowMs: NOW,
      days: 7,
      tenants: [
        tenant({
          id: "t-small",
          slug: "small",
          status: "active",
          allTime: { patients: 10, orders: 4, conversations: 2 },
          // 1 patient this window, 0 prior.
          patientCreatedAt: ["2026-06-17T00:00:00Z"],
          // 1 order this window paid $20; 1 order prior window paid $10.
          orders: [
            {
              createdAt: "2026-06-17T00:00:00Z",
              paidAt: "2026-06-17T00:00:00Z",
              amountCents: 2000,
              refundedCents: 0,
            },
            {
              createdAt: "2026-06-05T00:00:00Z",
              paidAt: "2026-06-05T00:00:00Z",
              amountCents: 1000,
              refundedCents: 0,
            },
          ],
          conversationCreatedAt: ["2026-06-18T00:00:00Z"],
        }),
        tenant({
          id: "t-big",
          slug: "big",
          status: "suspended",
          allTime: { patients: 100, orders: 50, conversations: 30 },
          patientCreatedAt: ["2026-06-16T00:00:00Z", "2026-06-18T00:00:00Z"],
          orders: [
            {
              createdAt: "2026-06-16T00:00:00Z",
              paidAt: "2026-06-16T00:00:00Z",
              amountCents: 10000,
              refundedCents: 1000,
            },
          ],
          conversationCreatedAt: [],
        }),
      ],
    });

    // Fleet status breakdown.
    expect(result.totals.tenants).toEqual({
      total: 2,
      active: 1,
      suspended: 1,
      archived: 0,
    });
    // All-time sums.
    expect(result.totals.patients).toBe(110);
    expect(result.totals.orders).toBe(54);
    expect(result.totals.conversations).toBe(32);

    // Current window: 3 new patients, 2 new orders, 1 conversation.
    expect(result.window.newPatients).toBe(3);
    expect(result.window.newOrders).toBe(2);
    expect(result.window.newConversations).toBe(1);
    // GMV current = $20 + ($100 − $10) = 2000 + 9000 = 11000 cents.
    expect(result.window.gmvCents).toBe(11000);

    // Delta vs prior 7-day window: orders went 1 → 2 = +100%.
    expect(result.window.delta.newOrders).toBe(100);
    // Prior patients were 0 → no baseline.
    expect(result.window.delta.newPatients).toBeNull();

    // Series length matches the window.
    expect(result.series.newPatients).toHaveLength(7);
    expect(result.dayKeys).toHaveLength(7);
    // Sum of the series equals the window total.
    expect(result.series.newPatients.reduce((a, b) => a + b, 0)).toBe(3);
    expect(result.series.gmvCents.reduce((a, b) => a + b, 0)).toBe(11000);

    // Leaderboard sorted by window GMV desc → big ($90) before small ($20).
    expect(result.tenants.map((t) => t.id)).toEqual(["t-big", "t-small"]);
    expect(result.tenants[0]).toMatchObject({
      id: "t-big",
      windowGmvCents: 9000,
      windowNewPatients: 2,
      windowOrders: 1,
      patients: 100,
    });
  });

  it("reports null all-time totals only when every tenant's count failed", () => {
    const result = aggregatePlatformAnalytics({
      nowMs: NOW,
      days: 30,
      tenants: [
        tenant({
          id: "a",
          slug: "a",
          allTime: { patients: null, orders: null, conversations: null },
        }),
        tenant({
          id: "b",
          slug: "b",
          allTime: { patients: null, orders: 5, conversations: null },
        }),
      ],
    });
    expect(result.totals.patients).toBeNull();
    expect(result.totals.conversations).toBeNull();
    // One tenant had a real order count → not null.
    expect(result.totals.orders).toBe(5);
  });

  it("counts a newly-created tenant in the window", () => {
    const result = aggregatePlatformAnalytics({
      nowMs: NOW,
      days: 30,
      tenants: [
        tenant({ id: "new", slug: "new", createdAt: "2026-06-10T00:00:00Z" }),
        tenant({ id: "old", slug: "old", createdAt: "2025-01-01T00:00:00Z" }),
      ],
    });
    expect(result.window.newTenants).toBe(1);
    expect(result.series.newTenants.reduce((a, b) => a + b, 0)).toBe(1);
  });
});

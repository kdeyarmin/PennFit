import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  dailyWindowUtc,
  buildMetricRows,
  runMetricsSnapshot,
} from "./metrics-snapshot";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "metrics-snapshot.ts"), "utf8");

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

// Multi-tenant fan-out (migration 0380). The snapshot now writes one daily
// series PER tenant: it fans out across active tenants and stamps each
// metrics_daily row with the tenant's org_id on the re-keyed PK.
describe("runMetricsSnapshot — multi-tenant fan-out", () => {
  const NOW = new Date("2026-05-31T06:30:00.000Z"); // metricDate 2026-05-30

  beforeEach(() => supabaseMock.reset());

  it("stamps org_id on every row and upserts on the re-keyed PK, once per tenant", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    // Each tenant reads its own paid orders for the day.
    stageSupabaseResponse("shop_orders", "select", {
      data: [{ amount_total_cents: 1000, amount_refunded_cents: 0 }],
    });
    stageSupabaseResponse("shop_orders", "select", {
      data: [{ amount_total_cents: 2000, amount_refunded_cents: 500 }],
    });

    const stats = await runMetricsSnapshot(NOW);

    expect(stats.metricDate).toBe("2026-05-30");
    // 4 KPI rows per tenant × 2 tenants.
    expect(stats.written).toBe(8);
    // One upsert call per tenant.
    expect(getSupabaseCallCount("metrics_daily", "upsert")).toBe(2);

    const writes = getSupabaseWritePayloads("metrics_daily", "upsert");
    expect(writes).toHaveLength(2);
    // Every row in every upsert carries its tenant's org_id.
    const orgAWrite = writes[0] as Array<Record<string, unknown>>;
    const orgBWrite = writes[1] as Array<Record<string, unknown>>;
    expect(orgAWrite.every((r) => r.org_id === "org-a")).toBe(true);
    expect(orgBWrite.every((r) => r.org_id === "org-b")).toBe(true);
  });

  it("no-ops when there are no active tenants", async () => {
    stageSupabaseResponse("organizations", "select", { data: [] });
    const stats = await runMetricsSnapshot(NOW);
    expect(stats.written).toBe(0);
    expect(getSupabaseCallCount("metrics_daily", "upsert")).toBe(0);
    expect(getSupabaseCallCount("shop_orders", "select")).toBe(0);
  });

  // The mock records only the upsert payload, not its options, so the
  // re-keyed conflict target is source-pinned (migration 0380).
  it("upserts on the (org_id, metric_date, metric_key) conflict target", () => {
    expect(SRC).toContain('onConflict: "org_id,metric_date,metric_key"');
  });
});

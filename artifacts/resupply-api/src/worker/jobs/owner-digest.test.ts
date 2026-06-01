// Tests for the weekly owner digest job (owner-digest.ts) — the pure
// digest builder + text renderer + the run() fail-soft paths.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  buildOwnerDigest,
  formatDigestText,
  runOwnerDigest,
  type DigestAlertRow,
  type DigestMetricRow,
} from "./owner-digest";

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  supabaseMock.reset();
  process.env = { ...ORIGINAL_ENV };
});
afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe("buildOwnerDigest (pure)", () => {
  const asOf = "2026-05-15"; // this week [05-08,05-15), prior [05-01,05-08)
  const rows: DigestMetricRow[] = [
    {
      metricKey: "revenue_net_cents",
      metricDate: "2026-05-10",
      metricValue: 1000,
    },
    {
      metricKey: "revenue_net_cents",
      metricDate: "2026-05-03",
      metricValue: 500,
    },
    {
      metricKey: "orders_paid_count",
      metricDate: "2026-05-12",
      metricValue: 10,
    },
    // Outside the 14-day window — ignored.
    {
      metricKey: "revenue_net_cents",
      metricDate: "2026-04-01",
      metricValue: 9999,
    },
  ];

  it("computes this-week vs prior-week sums and delta", () => {
    const d = buildOwnerDigest(rows, [], asOf);
    expect(d.windowStart).toBe("2026-05-08");
    const net = d.metrics.find((m) => m.metricKey === "revenue_net_cents")!;
    expect(net.thisWeek).toBe(1000);
    expect(net.priorWeek).toBe(500);
    expect(net.deltaPct).toBeCloseTo(1.0, 5);
    const orders = d.metrics.find((m) => m.metricKey === "orders_paid_count")!;
    expect(orders.thisWeek).toBe(10);
    expect(orders.priorWeek).toBe(0);
    expect(orders.deltaPct).toBeNull(); // no prior-week baseline
    expect(d.hasData).toBe(true);
  });

  it("picks the highest-severity, most-recent alert as the biggest fire", () => {
    const alerts: DigestAlertRow[] = [
      {
        severity: "warning",
        metricKey: "orders_paid_count",
        metricDate: "2026-05-14",
        message: "orders dip",
      },
      {
        severity: "critical",
        metricKey: "revenue_net_cents",
        metricDate: "2026-05-13",
        message: "net rev crash",
      },
    ];
    const d = buildOwnerDigest([], alerts, asOf);
    expect(d.topAlert).toEqual({
      severity: "critical",
      metricKey: "revenue_net_cents",
      message: "net rev crash",
    });
  });

  it("hasData is false with no movement and no alerts", () => {
    expect(buildOwnerDigest([], [], asOf).hasData).toBe(false);
  });
});

describe("formatDigestText", () => {
  it("renders KPI labels + the biggest fire line", () => {
    const d = buildOwnerDigest(
      [
        {
          metricKey: "revenue_net_cents",
          metricDate: "2026-05-10",
          metricValue: 123400,
        },
      ],
      [
        {
          severity: "critical",
          metricKey: "revenue_net_cents",
          metricDate: "2026-05-13",
          message: "crash",
        },
      ],
      "2026-05-15",
    );
    const text = formatDigestText(d);
    expect(text).toContain("Net revenue");
    expect(text).toContain("$1,234"); // 123400 cents
    expect(text).toContain("Biggest fire: [CRITICAL]");
  });

  it("shows the no-alerts line when there are none", () => {
    const d = buildOwnerDigest([], [], "2026-05-15");
    expect(formatDigestText(d)).toContain("No open KPI alerts");
  });
});

describe("runOwnerDigest", () => {
  it("skips the send when RESUPPLY_ADMIN_EMAILS is empty", async () => {
    process.env.RESUPPLY_ADMIN_EMAILS = "";
    stageSupabaseResponse("metrics_daily", "select", { data: [] });
    stageSupabaseResponse("metric_alerts", "select", { data: [] });
    const r = await runOwnerDigest();
    expect(r.skippedNoRecipients).toBe(true);
    expect(r.emailed).toBe(0);
  });

  it("emails via the injected sender when configured", async () => {
    process.env.RESUPPLY_ADMIN_EMAILS = "owner@penn.example.com";
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "info@pennpaps.com";
    stageSupabaseResponse("metrics_daily", "select", {
      data: [
        {
          metric_key: "revenue_net_cents",
          metric_date: "2026-05-10",
          metric_value: 1000,
        },
      ],
    });
    stageSupabaseResponse("metric_alerts", "select", { data: [] });
    const sendEmail = vi.fn<
      (c: unknown, r: string[], s: string, b: string) => Promise<void>
    >(async () => undefined);
    const r = await runOwnerDigest({ sendEmail });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [, recipients, subject] = sendEmail.mock.calls[0]!;
    expect(recipients).toEqual(["owner@penn.example.com"]);
    expect(String(subject)).toContain("weekly digest");
    expect(r.emailed).toBe(1);
  });
});

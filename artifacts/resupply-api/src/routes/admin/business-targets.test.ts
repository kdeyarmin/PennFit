// Route tests for /admin/business-targets (Phase 1, Owner #8).

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({ logAudit: logAuditMock }));

import businessTargetsRouter from "./business-targets";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "owner@penn.example.com",
  role: "admin",
};
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(businessTargetsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("GET /admin/business-targets", () => {
  it("401s without admin", async () => {
    expect(
      (await request(makeApp()).get("/admin/business-targets")).status,
    ).toBe(401);
  });

  it("403s for the CSR tier (lacks targets.manage)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).get("/admin/business-targets");
    expect(res.status).toBe(403);
    expect(res.body.requiredPermission).toBe("targets.manage");
  });

  it("maps the target rows", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("business_targets", "select", {
      data: [
        {
          id: "t1",
          metric_key: "revenue_net_cents",
          period: "2026-05",
          target_value: 5000000,
          unit: "cents",
          notes: null,
          created_by_email: "owner@penn.example.com",
          created_at: "2026-05-01T00:00:00Z",
          updated_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get("/admin/business-targets");
    expect(res.status).toBe(200);
    expect(res.body.targets[0]).toMatchObject({
      metricKey: "revenue_net_cents",
      period: "2026-05",
      targetValue: 5000000,
      unit: "cents",
    });
  });

  it("enriches each target with pace-to-goal from metrics_daily (windowed sum)", async () => {
    mockAdmin.current = ADMIN;
    // A fully-elapsed past period so the pace is deterministic regardless
    // of the clock: Jan 2020 (31 days), target 100.
    stageSupabaseResponse("business_targets", "select", {
      data: [
        {
          id: "t1",
          metric_key: "orders_paid_count",
          period: "2020-01",
          target_value: 100,
          unit: "count",
          notes: null,
          created_by_email: "owner@penn.example.com",
          created_at: "2020-01-01T00:00:00Z",
          updated_at: "2020-01-01T00:00:00Z",
        },
      ],
    });
    stageSupabaseResponse("metrics_daily", "select", {
      data: [
        {
          metric_key: "orders_paid_count",
          metric_date: "2020-01-05",
          metric_value: 40,
        },
        {
          metric_key: "orders_paid_count",
          metric_date: "2020-01-20",
          metric_value: 50,
        },
        // Outside the period window — must be excluded by the in-memory sum.
        {
          metric_key: "orders_paid_count",
          metric_date: "2020-02-05",
          metric_value: 1000,
        },
      ],
    });

    const res = await request(makeApp()).get("/admin/business-targets");
    expect(res.status).toBe(200);
    const pace = res.body.targets[0].pace;
    expect(pace).not.toBeNull();
    expect(pace.actualToDate).toBe(90); // 40 + 50, Feb row excluded
    expect(pace.daysInPeriod).toBe(31);
    expect(pace.attainmentRatio).toBeCloseTo(0.9, 5);
    // Fully elapsed → expected == target → pace 0.9 → on_track.
    expect(pace.status).toBe("on_track");
  });

  it("reports pace: null for a target whose period can't be parsed", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("business_targets", "select", {
      data: [
        {
          id: "t2",
          metric_key: "orders_paid_count",
          period: "2026-Q2",
          target_value: 100,
          unit: "count",
          notes: null,
          created_by_email: "owner@penn.example.com",
          created_at: "2026-04-01T00:00:00Z",
          updated_at: "2026-04-01T00:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get("/admin/business-targets");
    expect(res.status).toBe(200);
    expect(res.body.targets[0].pace).toBeNull();
  });
});

describe("PUT /admin/business-targets", () => {
  it("403s for the CSR tier", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).put("/admin/business-targets").send({
      metricKey: "orders_paid_count",
      period: "2026-05",
      targetValue: 200,
    });
    expect(res.status).toBe(403);
    expect(getSupabaseCallCount("business_targets", "upsert")).toBe(0);
  });

  it("400s on a bad metricKey", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .put("/admin/business-targets")
      .send({ metricKey: "Orders Paid", period: "2026-05", targetValue: 200 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("upserts + audits the target", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("business_targets", "upsert", {
      data: {
        id: "t1",
        metric_key: "orders_paid_count",
        period: "2026-05",
        target_value: 200,
        unit: "count",
        notes: null,
        created_by_email: "owner@penn.example.com",
        created_at: "2026-05-01T00:00:00Z",
        updated_at: "2026-05-10T00:00:00Z",
      },
    });
    const res = await request(makeApp()).put("/admin/business-targets").send({
      metricKey: "orders_paid_count",
      period: "2026-05",
      targetValue: 200,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      metricKey: "orders_paid_count",
      period: "2026-05",
      targetValue: 200,
    });

    const payload = getSupabaseWritePayloads(
      "business_targets",
      "upsert",
    )[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      metric_key: "orders_paid_count",
      period: "2026-05",
      target_value: 200,
      unit: "count",
    });

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("business_target.upsert");
    expect(audit.metadata).toEqual({
      metric_key: "orders_paid_count",
      period: "2026-05",
      target_value: 200,
    });
  });
});

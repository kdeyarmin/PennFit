// Route tests for /admin/metric-alerts (Phase 0 / F2 metrics substrate).

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
  getSupabaseFilterCalls,
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

import metricAlertsRouter from "./metric-alerts";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};
const ALERT_ID = "alert_1";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(metricAlertsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("GET /admin/metric-alerts", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get("/admin/metric-alerts");
    expect(res.status).toBe(401);
  });

  it("403s for the CSR tier (lacks metrics.read)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).get("/admin/metric-alerts");
    expect(res.status).toBe(403);
    expect(res.body.requiredPermission).toBe("metrics.read");
  });

  it("defaults to the open feed and maps rows", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("metric_alerts", "select", {
      data: [
        {
          id: ALERT_ID,
          threshold_id: "t1",
          metric_key: "revenue_net_cents",
          metric_date: "2026-05-30",
          observed_value: 45000,
          compared_value: 45000,
          baseline_value: null,
          severity: "warning",
          message: "revenue_net_cents is $450.00 (lt threshold $1000.00).",
          status: "open",
          notified_at: null,
          created_at: "2026-05-31T06:45:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get("/admin/metric-alerts");
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0]).toMatchObject({
      id: ALERT_ID,
      metricKey: "revenue_net_cents",
      severity: "warning",
      status: "open",
    });
    // Default applies an eq("status","open") filter.
    const filters = getSupabaseFilterCalls("metric_alerts", "select");
    expect(filters).toContainEqual({ verb: "eq", args: ["status", "open"] });
  });

  it("status=all skips the status filter", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("metric_alerts", "select", { data: [] });
    const res = await request(makeApp()).get("/admin/metric-alerts?status=all");
    expect(res.status).toBe(200);
    const filters = getSupabaseFilterCalls("metric_alerts", "select");
    expect(filters.some((f) => f.verb === "eq" && f.args[0] === "status")).toBe(
      false,
    );
  });
});

describe("PATCH /admin/metric-alerts/:id", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .patch(`/admin/metric-alerts/${ALERT_ID}`)
      .send({ status: "resolved" });
    expect(res.status).toBe(401);
  });

  it("403s for the CSR tier", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp())
      .patch(`/admin/metric-alerts/${ALERT_ID}`)
      .send({ status: "resolved" });
    expect(res.status).toBe(403);
    expect(getSupabaseCallCount("metric_alerts", "update")).toBe(0);
  });

  it("400s on an invalid status", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .patch(`/admin/metric-alerts/${ALERT_ID}`)
      .send({ status: "bogus" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(getSupabaseCallCount("metric_alerts", "update")).toBe(0);
  });

  it("404s when the alert doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("metric_alerts", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/metric-alerts/${ALERT_ID}`)
      .send({ status: "acknowledged" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("alert_not_found");
  });

  it("updates the status + audits", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("metric_alerts", "update", {
      data: { id: ALERT_ID, status: "resolved" },
    });
    const res = await request(makeApp())
      .patch(`/admin/metric-alerts/${ALERT_ID}`)
      .send({ status: "resolved" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: ALERT_ID, status: "resolved" });

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      targetTable: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("metric_alert.update");
    expect(audit.targetTable).toBe("metric_alerts");
    expect(audit.metadata).toEqual({ status: "resolved" });
  });
});

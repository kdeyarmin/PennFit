// Route tests for /admin/metric-thresholds (Owner #5).

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

import metricThresholdsRouter from "./metric-thresholds";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "owner@penn.example.com",
  role: "admin",
};
// csr lacks both metrics.read and admin.tools.manage.
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};
const ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(metricThresholdsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("GET /admin/metric-thresholds", () => {
  it("401s without admin", async () => {
    expect(
      (await request(makeApp()).get("/admin/metric-thresholds")).status,
    ).toBe(401);
  });

  it("403s for a role without metrics.read (csr)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).get("/admin/metric-thresholds");
    expect(res.status).toBe(403);
  });

  it("lists thresholds mapped to camelCase", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("metric_thresholds", "select", {
      data: [
        {
          id: ID,
          metric_key: "revenue_net_cents",
          comparison: "lt",
          threshold_value: 1000000,
          mode: "absolute",
          severity: "warning",
          enabled: true,
          description: "net revenue floor",
          created_at: "2026-05-01T00:00:00Z",
          updated_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get("/admin/metric-thresholds");
    expect(res.status).toBe(200);
    expect(res.body.thresholds[0]).toMatchObject({
      id: ID,
      metricKey: "revenue_net_cents",
      comparison: "lt",
      thresholdValue: 1000000,
      mode: "absolute",
    });
  });
});

describe("POST /admin/metric-thresholds", () => {
  it("403s for a role without admin.tools.manage (csr)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).post("/admin/metric-thresholds").send({
      metricKey: "orders_paid_count",
      comparison: "lt",
      thresholdValue: 5,
    });
    expect(res.status).toBe(403);
    expect(getSupabaseCallCount("metric_thresholds", "insert")).toBe(0);
  });

  it("400s on an invalid comparison", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).post("/admin/metric-thresholds").send({
      metricKey: "orders_paid_count",
      comparison: "between",
      thresholdValue: 5,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("creates a threshold + audits", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("metric_thresholds", "insert", {
      data: {
        id: ID,
        metric_key: "orders_paid_count",
        comparison: "lt",
        threshold_value: 5,
        mode: "absolute",
        severity: "warning",
        enabled: true,
        description: null,
        created_at: "2026-05-01T00:00:00Z",
        updated_at: "2026-05-01T00:00:00Z",
      },
    });
    const res = await request(makeApp()).post("/admin/metric-thresholds").send({
      metricKey: "orders_paid_count",
      comparison: "lt",
      thresholdValue: 5,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: ID, metricKey: "orders_paid_count" });
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect((logAuditMock.mock.calls[0]?.[0] as { action: string }).action).toBe(
      "metric_threshold.create",
    );
  });
});

describe("PATCH /admin/metric-thresholds/:id", () => {
  it("400s on a non-uuid id", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .patch("/admin/metric-thresholds/not-a-uuid")
      .send({ enabled: false });
    expect(res.status).toBe(400);
  });

  it("404s when the threshold doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("metric_thresholds", "update", { data: [] });
    const res = await request(makeApp())
      .patch(`/admin/metric-thresholds/${ID}`)
      .send({ enabled: false });
    expect(res.status).toBe(404);
  });

  it("toggles enabled + audits", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("metric_thresholds", "update", {
      data: [
        {
          id: ID,
          metric_key: "orders_paid_count",
          comparison: "lt",
          threshold_value: 5,
          mode: "absolute",
          severity: "warning",
          enabled: false,
          description: null,
          created_at: "2026-05-01T00:00:00Z",
          updated_at: "2026-05-02T00:00:00Z",
        },
      ],
    });
    const res = await request(makeApp())
      .patch(`/admin/metric-thresholds/${ID}`)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect((logAuditMock.mock.calls[0]?.[0] as { action: string }).action).toBe(
      "metric_threshold.update",
    );
  });
});

describe("DELETE /admin/metric-thresholds/:id", () => {
  it("404s when the threshold doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("metric_thresholds", "delete", { data: [] });
    const res = await request(makeApp()).delete(
      `/admin/metric-thresholds/${ID}`,
    );
    expect(res.status).toBe(404);
  });

  it("deletes + audits", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("metric_thresholds", "delete", {
      data: [{ id: ID }],
    });
    const res = await request(makeApp()).delete(
      `/admin/metric-thresholds/${ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deletedId: ID });
  });
});

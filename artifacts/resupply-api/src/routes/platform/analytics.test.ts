// GET /platform/analytics — platform super-admin analytics dashboard.
//
// The gate (requirePlatformAdmin) and the aggregation math have their own
// focused tests; here we cover the route contract (gate, validation, and
// a single-tenant happy path that the deterministic FIFO mock can stage).

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequirePlatformAdminMock,
  type MockPlatformAdminRef,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockPlatformAdmin } = vi.hoisted(() => ({
  mockPlatformAdmin: { current: null } as MockPlatformAdminRef,
}));
vi.mock("../../middlewares/requirePlatformAdmin", () =>
  makeRequirePlatformAdminMock(mockPlatformAdmin),
);

import analyticsRouter from "./analytics";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(analyticsRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  mockPlatformAdmin.current = null;
});

const recentIso = (daysAgo: number): string =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString();

describe("GET /platform/analytics", () => {
  it("401s when the caller is not a platform admin", async () => {
    const res = await request(makeApp()).get("/platform/analytics");
    expect(res.status).toBe(401);
  });

  it("400s on an out-of-range window", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    const res = await request(makeApp()).get("/platform/analytics?days=9999");
    expect(res.status).toBe(400);
  });

  it("returns fleet totals, series, and a tenant leaderboard", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };

    // 1. tenant directory
    stageSupabaseResponse("organizations", "select", {
      data: [
        {
          id: "org-1",
          slug: "acme",
          name: "Acme DME",
          status: "active",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    // 2. per-tenant HEAD counts (first), then windowed selects (second).
    stageSupabaseResponse("patients", "select", { count: 10, data: null });
    stageSupabaseResponse("shop_orders", "select", { count: 4, data: null });
    stageSupabaseResponse("conversations", "select", { count: 2, data: null });
    stageSupabaseResponse("patients", "select", {
      data: [{ created_at: recentIso(3) }],
    });
    stageSupabaseResponse("shop_orders", "select", {
      data: [
        {
          created_at: recentIso(2),
          paid_at: recentIso(2),
          amount_total_cents: 5000,
          amount_refunded_cents: 0,
        },
      ],
    });
    stageSupabaseResponse("conversations", "select", {
      data: [{ created_at: recentIso(1) }],
    });

    const res = await request(makeApp()).get("/platform/analytics?days=30");

    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(30);
    expect(res.body.dayKeys).toHaveLength(30);
    expect(res.body.totals.tenants).toMatchObject({ total: 1, active: 1 });
    expect(res.body.totals.patients).toBe(10);
    expect(res.body.totals.orders).toBe(4);
    expect(res.body.window.newPatients).toBe(1);
    expect(res.body.window.newOrders).toBe(1);
    expect(res.body.window.gmvCents).toBe(5000);
    expect(res.body.series.gmvCents).toHaveLength(30);
    expect(res.body.tenants[0]).toMatchObject({
      id: "org-1",
      patients: 10,
      windowOrders: 1,
      windowGmvCents: 5000,
    });
    expect(typeof res.body.generatedAt).toBe("string");
  });

  it("500s when the tenant directory query fails", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("organizations", "select", {
      error: { message: "boom" },
    });
    const res = await request(makeApp()).get("/platform/analytics");
    expect(res.status).toBe(500);
  });
});

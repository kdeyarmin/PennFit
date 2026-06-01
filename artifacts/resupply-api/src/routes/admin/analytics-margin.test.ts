// Tests for /admin/analytics/margin (Owner #1) — the pure breakdown
// builder + the HTTP route.

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
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import analyticsMarginRouter, {
  buildMarginBreakdown,
  type MarginLine,
} from "./analytics-margin";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "owner@penn.example.com",
  role: "admin",
};
// csr lacks cost.read (finance-only) → 403.
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(analyticsMarginRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("buildMarginBreakdown (pure)", () => {
  it("rolls up overall margin and groups by product, biggest revenue first", () => {
    const lines: MarginLine[] = [
      {
        productId: "prod_A",
        revenueCents: 10000,
        unitCostCents: 2000,
        quantity: 2,
      },
      {
        productId: "prod_A",
        revenueCents: 5000,
        unitCostCents: 2000,
        quantity: 1,
      },
      {
        productId: "prod_B",
        revenueCents: 3000,
        unitCostCents: null,
        quantity: 1,
      },
    ];
    const { overall, byProduct } = buildMarginBreakdown(lines);

    expect(overall.revenueCents).toBe(18000);
    expect(overall.costedRevenueCents).toBe(15000);
    expect(overall.uncostedRevenueCents).toBe(3000);
    // cost = 2000*2 + 2000*1 = 6000; margin over costed = 15000-6000.
    expect(overall.costCents).toBe(6000);
    expect(overall.marginCents).toBe(9000);
    expect(overall.marginRatio).toBeCloseTo(0.6, 5);

    expect(byProduct.map((p) => p.productId)).toEqual(["prod_A", "prod_B"]);
    expect(byProduct[0]!.revenueCents).toBe(15000);
    expect(byProduct[1]!.uncostedRevenueCents).toBe(3000);
    expect(byProduct[1]!.marginRatio).toBeNull();
  });
});

describe("GET /admin/analytics/margin", () => {
  it("401s without admin", async () => {
    expect(
      (await request(makeApp()).get("/admin/analytics/margin")).status,
    ).toBe(401);
  });

  it("403s for a role without cost.read (csr)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).get("/admin/analytics/margin");
    expect(res.status).toBe(403);
    expect(res.body.requiredPermission).toBe("cost.read");
  });

  it("returns the overall rollup + per-product breakdown with name enrichment", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_order_items", "select", {
      data: [
        {
          product_id: "prod_A",
          quantity: 2,
          unit_amount_cents: 5000,
          unit_cost_cents: 2000,
        },
        {
          product_id: "prod_A",
          quantity: 1,
          unit_amount_cents: 5000,
          unit_cost_cents: 2000,
        },
        {
          product_id: "prod_B",
          quantity: 1,
          unit_amount_cents: 3000,
          unit_cost_cents: null,
        },
      ],
    });
    stageSupabaseResponse("inventory_reconciliation_lines", "select", {
      data: [
        {
          product_id: "prod_A",
          product_name: "CPAP Mask",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
    });

    const res = await request(makeApp()).get("/admin/analytics/margin?days=30");
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(30);
    expect(res.body.overall.revenueCents).toBe(18000);
    expect(res.body.overall.marginCents).toBe(9000);
    expect(res.body.overall.uncostedRevenueCents).toBe(3000);
    expect(res.body.byProduct[0]).toMatchObject({
      productId: "prod_A",
      productName: "CPAP Mask",
      revenueCents: 15000,
    });
    // prod_B has no reconciliation name → null.
    expect(res.body.byProduct[1]).toMatchObject({
      productId: "prod_B",
      productName: null,
    });
  });
});

// Tests for /admin/analytics/inventory-turnover (Owner #7).

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

import inventoryTurnoverRouter, {
  buildInventoryTurnover,
  type InvProductInput,
} from "./inventory-turnover";

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
  app.use(inventoryTurnoverRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("buildInventoryTurnover (pure)", () => {
  it("computes value / annualized COGS / turnover / stockout demand", () => {
    const inputs: InvProductInput[] = [
      {
        productId: "x",
        productName: "X",
        unitsSold: 5,
        revenueCents: 0,
        cogsKnownCents: 1000,
        onHandQty: 10,
        unitCostCents: 50,
        unitPriceCents: 200,
        waitingCount: 2,
      },
      {
        productId: "y",
        productName: "Y",
        unitsSold: 1,
        revenueCents: 0,
        cogsKnownCents: 500,
        onHandQty: null, // never reconciled
        unitCostCents: 50,
        unitPriceCents: null,
        waitingCount: 0,
      },
    ];
    const { products, totals } = buildInventoryTurnover(inputs, 90);

    const x = products.find((p) => p.productId === "x")!;
    expect(x.inventoryValueCents).toBe(500); // 10 × 50
    expect(x.annualizedCogsCents).toBe(Math.round(1000 * (365 / 90))); // 4056
    expect(x.turnover).toBeCloseTo(x.annualizedCogsCents / 500, 5);
    expect(x.stockoutDemandCents).toBe(400); // 2 × 200

    const y = products.find((p) => p.productId === "y")!;
    expect(y.inventoryValueCents).toBeNull();
    expect(y.turnover).toBeNull(); // no reconciliation → honest null
    expect(y.stockoutDemandCents).toBeNull(); // no price

    expect(totals.inventoryValueCents).toBe(500);
    expect(totals.productsWithoutReconciliation).toBe(1);
    expect(totals.stockoutDemandCents).toBe(400);
    // Biggest COGS first.
    expect(products[0]!.productId).toBe("x");
  });
});

describe("GET /admin/analytics/inventory-turnover", () => {
  it("401s without admin", async () => {
    expect(
      (await request(makeApp()).get("/admin/analytics/inventory-turnover"))
        .status,
    ).toBe(401);
  });

  it("403s for a role without cost.read (csr)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).get(
      "/admin/analytics/inventory-turnover",
    );
    expect(res.status).toBe(403);
    expect(res.body.requiredPermission).toBe("cost.read");
  });

  it("joins sales, reconciliation, and the waitlist into per-SKU turnover", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_order_items", "select", {
      data: [
        {
          product_id: "pA",
          quantity: 2,
          unit_amount_cents: 5000,
          unit_cost_cents: 2000,
          paid_at: "2026-05-20T00:00:00Z",
        },
      ],
    });
    stageSupabaseResponse("inventory_reconciliation_lines", "select", {
      data: [
        {
          product_id: "pA",
          product_name: "Mask",
          counted_qty: 10,
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    stageSupabaseResponse("shop_back_in_stock_notifications", "select", {
      data: [
        { product_id: "pA", notified_at: null },
        { product_id: "pA", notified_at: null },
        { product_id: "pA", notified_at: null },
      ],
    });

    const res = await request(makeApp()).get(
      "/admin/analytics/inventory-turnover?days=90",
    );
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(90);
    const pA = res.body.products.find(
      (p: { productId: string }) => p.productId === "pA",
    );
    expect(pA.productName).toBe("Mask");
    expect(pA.onHandQty).toBe(10);
    expect(pA.cogsKnownCents).toBe(4000);
    expect(pA.inventoryValueCents).toBe(20000); // 10 × 2000
    expect(pA.waitingCount).toBe(3);
    expect(pA.stockoutDemandCents).toBe(15000); // 3 × 5000
    expect(res.body.totals.inventoryValueCents).toBe(20000);
  });
});

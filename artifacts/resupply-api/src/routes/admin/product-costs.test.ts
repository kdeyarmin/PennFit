// Route tests for /admin/product-costs (Phase 0 / F1 cost capture).
//
// Coverage:
//   * 401 (no admin) + 403 (CSR tier lacks cost.read / cost.write)
//   * GET returns the mapped cost list
//   * PUT validates the :sku param + the body (negative cents)
//   * PUT upserts with the expected row shape + a non-PHI audit envelope
//     that DOES carry the cost figure (cost is not PHI)

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
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

import productCostsRouter from "./product-costs";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};
// A front-line CSR: coarse "agent" with the granular csr role, which
// holds neither cost.read nor cost.write.
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(productCostsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("GET /admin/product-costs", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get("/admin/product-costs");
    expect(res.status).toBe(401);
  });

  it("403s for the CSR tier (lacks cost.read)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).get("/admin/product-costs");
    expect(res.status).toBe(403);
    expect(res.body.requiredPermission).toBe("cost.read");
    expect(getSupabaseCallCount("product_costs", "select")).toBe(0);
  });

  it("returns the mapped cost list", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("product_costs", "select", {
      data: [
        {
          sku: "CUSHION",
          unit_cost_cents: 1850,
          currency: "usd",
          cost_source: "invoice",
          effective_from: new Date("2026-05-01T00:00:00Z").toISOString(),
          notes: null,
          updated_at: new Date("2026-05-01T00:00:00Z").toISOString(),
        },
      ],
    });

    const res = await request(makeApp()).get("/admin/product-costs");
    expect(res.status).toBe(200);
    expect(res.body.costs).toHaveLength(1);
    expect(res.body.costs[0]).toMatchObject({
      sku: "CUSHION",
      unitCostCents: 1850,
      currency: "usd",
      costSource: "invoice",
    });
  });
});

describe("PUT /admin/product-costs/:sku", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .put("/admin/product-costs/MASK")
      .send({ unitCostCents: 4200 });
    expect(res.status).toBe(401);
  });

  it("403s for the CSR tier (lacks cost.write)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp())
      .put("/admin/product-costs/MASK")
      .send({ unitCostCents: 4200 });
    expect(res.status).toBe(403);
    expect(res.body.requiredPermission).toBe("cost.write");
    expect(getSupabaseCallCount("product_costs", "upsert")).toBe(0);
  });

  it("400s on a malformed sku", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .put("/admin/product-costs/MASK!")
      .send({ unitCostCents: 4200 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_sku");
    expect(getSupabaseCallCount("product_costs", "upsert")).toBe(0);
  });

  it("400s on a negative cost", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .put("/admin/product-costs/MASK")
      .send({ unitCostCents: -5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(getSupabaseCallCount("product_costs", "upsert")).toBe(0);
  });

  it("upserts + audits with the cost figure (cost is not PHI)", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("product_costs", "upsert", {
      data: {
        sku: "MASK",
        unit_cost_cents: 4200,
        currency: "usd",
        cost_source: "invoice",
        effective_from: new Date("2026-05-31T12:00:00Z").toISOString(),
        updated_at: new Date("2026-05-31T12:00:00Z").toISOString(),
      },
    });

    const res = await request(makeApp())
      .put("/admin/product-costs/MASK")
      .send({ unitCostCents: 4200, costSource: "invoice" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sku: "MASK",
      unitCostCents: 4200,
      costSource: "invoice",
    });

    // The row written carries the cents + source + normalized currency.
    const payload = getSupabaseWritePayloads("product_costs", "upsert")[0] as
      | Record<string, unknown>
      | undefined;
    expect(payload).toMatchObject({
      sku: "MASK",
      unit_cost_cents: 4200,
      cost_source: "invoice",
      currency: "usd",
    });

    // Audit fires with the figure (deliberately, cost is not PHI).
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      targetTable: string;
      targetId: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("product_cost.upsert");
    expect(audit.targetTable).toBe("product_costs");
    expect(audit.targetId).toBe("MASK");
    expect(audit.metadata).toEqual({
      sku: "MASK",
      unit_cost_cents: 4200,
      cost_source: "invoice",
    });
  });
});

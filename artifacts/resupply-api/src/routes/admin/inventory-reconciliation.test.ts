// Route tests for /admin/shop/inventory/reconciliations.
//
// Mirrors the auth-mock + supabase-mock pattern used in
// `return-notes.test.ts` and `shop-products.test.ts`. The reconciliation
// surface has four endpoints; we exercise:
//   * POST create        — validation + 201 + audit envelope shape.
//   * GET list           — happy path + supabase error → 500.
//   * GET detail         — 400/404 paths + draft vs submitted shape.
//   * POST submit        — auth, validation, duplicate-product guard,
//                          already_submitted 409, applyToStripe=false
//                          path, partial-Stripe-failure path, RPC
//                          error mapping.

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
  stageSupabaseRpcResponse,
  getSupabaseRpcCallCount,
  getSupabaseRpcArgs,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const adminRateLimitSpy = vi.hoisted(() =>
  vi.fn(
    (_opts: { name: string; preset: string }) =>
      (_req: unknown, _res: unknown, next: () => void) =>
        next(),
  ),
);
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: adminRateLimitSpy,
}));

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

// Stripe stub. The submit path calls products.list (catalog fetch) +
// products.update (per-SKU metadata write). The detail GET on a draft
// also fetches the catalog. The list/create paths don't touch Stripe.
const { stripeListMock, stripeUpdateMock, stripeConfiguredRef } = vi.hoisted(
  () => ({
    stripeListMock: vi.fn(),
    stripeUpdateMock: vi.fn(),
    stripeConfiguredRef: { current: true },
  }),
);
vi.mock("../../lib/stripe/config", () => ({
  readStripeConfigOrNull: () =>
    stripeConfiguredRef.current ? { secretKey: "sk_test_x" } : null,
  getStripeClient: () => ({
    products: {
      list: (...a: unknown[]) => stripeListMock(...a),
      update: (...a: unknown[]) => stripeUpdateMock(...a),
    },
  }),
}));

// Minimal projection — the route only reads id, name, and stockCount.
vi.mock("../../lib/stripe/products-meta", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/stripe/products-meta")
  >("../../lib/stripe/products-meta");
  return {
    ...actual,
    projectProduct: (raw: {
      id: string;
      name?: string;
      metadata?: { stock_count?: string; low_stock_threshold?: string };
    }) => {
      const meta = raw.metadata ?? {};
      return {
        id: raw.id,
        name: raw.name ?? raw.id,
        description: null,
        category: "accessory",
        tagline: null,
        isBundle: false,
        bundleContents: [],
        replacementHint: null,
        imageUrl: null,
        manufacturer: null,
        modelNumber: null,
        stockCount:
          meta.stock_count === undefined ? null : Number(meta.stock_count),
        lowStockThreshold:
          meta.low_stock_threshold === undefined
            ? null
            : Number(meta.low_stock_threshold),
        price: { id: "price_x", unitAmount: 1000, currency: "usd" },
        recurringPrice: null,
      };
    },
  };
});

import inventoryReconciliationRouter from "./inventory-reconciliation";

const RECON_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(inventoryReconciliationRouter);
  return app;
}

function stageStripeCatalog(
  products: Array<{ id: string; name: string; stockCount: number | null }>,
) {
  stripeListMock.mockResolvedValueOnce({
    data: products.map((p) => ({
      id: p.id,
      name: p.name,
      metadata:
        p.stockCount === null ? {} : { stock_count: String(p.stockCount) },
    })),
    has_more: false,
  });
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
  stripeListMock.mockReset();
  stripeUpdateMock.mockReset();
  adminRateLimitSpy.mockClear();
  stripeConfiguredRef.current = true;
});

describe("POST /admin/shop/inventory/reconciliations", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post("/admin/shop/inventory/reconciliations")
      .send({ periodLabel: "2026-05" });
    expect(res.status).toBe(401);
  });

  it("400s when periodLabel is missing", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/shop/inventory/reconciliations")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("400s when periodLabel is too short", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/shop/inventory/reconciliations")
      .send({ periodLabel: "x" });
    expect(res.status).toBe(400);
  });

  it("201s with the inserted id + audit envelope", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("inventory_reconciliations", "insert", {
      data: { id: RECON_ID, started_at: "2026-05-21T22:00:00.000Z" },
    });

    const res = await request(makeApp())
      .post("/admin/shop/inventory/reconciliations")
      .send({ periodLabel: "2026-05", notes: "Monthly count" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: RECON_ID,
      startedAt: "2026-05-21T22:00:00.000Z",
    });

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      targetTable: string;
      targetId: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("inventory_reconciliation.create");
    expect(audit.targetTable).toBe("inventory_reconciliations");
    expect(audit.targetId).toBe(RECON_ID);
    expect(audit.metadata).toEqual({ period_label: "2026-05" });
  });
});

describe("GET /admin/shop/inventory/reconciliations", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      "/admin/shop/inventory/reconciliations",
    );
    expect(res.status).toBe(401);
  });

  it("returns the rows projected into camelCase", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: [
        {
          id: RECON_ID,
          period_label: "2026-05",
          status: "submitted",
          started_by_email: "ops@penn.example.com",
          started_at: "2026-05-01T00:00:00Z",
          submitted_at: "2026-05-01T01:00:00Z",
          total_lines: 12,
          total_variance_units: 3,
          applied_to_stripe: true,
        },
      ],
    });

    const res = await request(makeApp()).get(
      "/admin/shop/inventory/reconciliations",
    );
    expect(res.status).toBe(200);
    expect(res.body.reconciliations).toHaveLength(1);
    expect(res.body.reconciliations[0]).toMatchObject({
      id: RECON_ID,
      periodLabel: "2026-05",
      status: "submitted",
      totalLines: 12,
      totalVarianceUnits: 3,
      appliedToStripe: true,
    });
  });

  it("500s when the supabase query errors", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("inventory_reconciliations", "select", {
      error: { message: "boom" },
    });
    const res = await request(makeApp()).get(
      "/admin/shop/inventory/reconciliations",
    );
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("query_failed");
  });
});

describe("GET /admin/shop/inventory/reconciliations/:id", () => {
  it("400s on a non-uuid id", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      "/admin/shop/inventory/reconciliations/not-a-uuid",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_id");
  });

  it("404s when the reconciliation does not exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: null,
    });
    const res = await request(makeApp()).get(
      `/admin/shop/inventory/reconciliations/${RECON_ID}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("attaches the live catalog (currentProducts) for drafts", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: {
        id: RECON_ID,
        period_label: "2026-05",
        status: "draft",
        started_by_email: "ops@penn.example.com",
        started_by_user_id: "u_admin",
        started_at: "2026-05-01T00:00:00Z",
        submitted_at: null,
        notes: null,
        total_lines: 0,
        total_variance_units: 0,
        applied_to_stripe: false,
      },
    });
    stageSupabaseResponse("inventory_reconciliation_lines", "select", {
      data: [],
    });
    stageStripeCatalog([
      { id: "prod_A", name: "Mask", stockCount: 10 },
      { id: "prod_B", name: "Filter", stockCount: 3 },
    ]);

    const res = await request(makeApp()).get(
      `/admin/shop/inventory/reconciliations/${RECON_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.currentProducts).toHaveLength(2);
    expect(res.body.currentProducts[0]).toMatchObject({
      productId: "prod_A",
      systemCount: 10,
    });
  });

  it("omits currentProducts for submitted reconciliations", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: {
        id: RECON_ID,
        period_label: "2026-05",
        status: "submitted",
        started_by_email: "ops@penn.example.com",
        started_by_user_id: "u_admin",
        started_at: "2026-05-01T00:00:00Z",
        submitted_at: "2026-05-01T01:00:00Z",
        notes: null,
        total_lines: 1,
        total_variance_units: 2,
        applied_to_stripe: true,
      },
    });
    stageSupabaseResponse("inventory_reconciliation_lines", "select", {
      data: [
        {
          id: "line_1",
          product_id: "prod_A",
          product_name: "Mask",
          system_count: 10,
          counted_qty: 12,
          variance: 2,
          applied: true,
          created_at: "2026-05-01T01:00:00Z",
        },
      ],
    });

    const res = await request(makeApp()).get(
      `/admin/shop/inventory/reconciliations/${RECON_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.currentProducts).toBeNull();
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0]).toMatchObject({
      productId: "prod_A",
      variance: 2,
      applied: true,
    });
    // No Stripe fetch on a submitted reconciliation.
    expect(stripeListMock).not.toHaveBeenCalled();
  });
});

describe("POST /admin/shop/inventory/reconciliations/:id/submit", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post(`/admin/shop/inventory/reconciliations/${RECON_ID}/submit`)
      .send({
        lines: [{ productId: "prod_A", countedQty: 1 }],
        applyToStripe: false,
      });
    expect(res.status).toBe(401);
  });

  it("400s on an invalid id", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/shop/inventory/reconciliations/not-a-uuid/submit")
      .send({
        lines: [{ productId: "prod_A", countedQty: 1 }],
        applyToStripe: false,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_id");
  });

  it("400s when lines is empty", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/admin/shop/inventory/reconciliations/${RECON_ID}/submit`)
      .send({ lines: [], applyToStripe: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("400s on a productId that doesn't start with prod_", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/admin/shop/inventory/reconciliations/${RECON_ID}/submit`)
      .send({
        lines: [{ productId: "bad-id", countedQty: 1 }],
        applyToStripe: false,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("400s with duplicate_product_in_lines when the same prod_ id appears twice", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/admin/shop/inventory/reconciliations/${RECON_ID}/submit`)
      .send({
        lines: [
          { productId: "prod_A", countedQty: 1 },
          { productId: "prod_A", countedQty: 2 },
        ],
        applyToStripe: false,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("duplicate_product_in_lines");
    expect(res.body.productId).toBe("prod_A");
    // Fast-fail before ANY database call.
    expect(getSupabaseRpcCallCount("submit_inventory_reconciliation")).toBe(0);
  });

  it("404s when the reconciliation does not exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: null,
    });
    const res = await request(makeApp())
      .post(`/admin/shop/inventory/reconciliations/${RECON_ID}/submit`)
      .send({
        lines: [{ productId: "prod_A", countedQty: 1 }],
        applyToStripe: false,
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("409s when the reconciliation is already submitted (pre-Stripe guard)", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: { id: RECON_ID, status: "submitted" },
    });
    const res = await request(makeApp())
      .post(`/admin/shop/inventory/reconciliations/${RECON_ID}/submit`)
      .send({
        lines: [{ productId: "prod_A", countedQty: 1 }],
        applyToStripe: false,
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_submitted");
    // Neither Stripe nor the RPC should have been touched.
    expect(stripeListMock).not.toHaveBeenCalled();
    expect(getSupabaseRpcCallCount("submit_inventory_reconciliation")).toBe(0);
  });

  it("503s when Stripe is not configured", async () => {
    mockAdmin.current = ADMIN;
    stripeConfiguredRef.current = false;
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: { id: RECON_ID, status: "draft" },
    });
    const res = await request(makeApp())
      .post(`/admin/shop/inventory/reconciliations/${RECON_ID}/submit`)
      .send({
        lines: [{ productId: "prod_A", countedQty: 1 }],
        applyToStripe: false,
      });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("stripe_not_configured");
  });

  it("400s when no input lines match the live catalog (no_valid_lines)", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: { id: RECON_ID, status: "draft" },
    });
    // Catalog returns a different SKU than what the operator submitted.
    stageStripeCatalog([{ id: "prod_OTHER", name: "Other", stockCount: 5 }]);
    const res = await request(makeApp())
      .post(`/admin/shop/inventory/reconciliations/${RECON_ID}/submit`)
      .send({
        lines: [{ productId: "prod_GHOST", countedQty: 1 }],
        applyToStripe: false,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_valid_lines");
  });

  it("submits with applyToStripe=false: no Stripe writes, RPC called atomically", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: { id: RECON_ID, status: "draft" },
    });
    stageStripeCatalog([
      { id: "prod_A", name: "Mask", stockCount: 10 },
      { id: "prod_B", name: "Filter", stockCount: 4 },
    ]);
    stageSupabaseRpcResponse("submit_inventory_reconciliation", {
      data: { ok: true, total_lines: 2, total_variance_units: 3 },
    });

    const res = await request(makeApp())
      .post(`/admin/shop/inventory/reconciliations/${RECON_ID}/submit`)
      .send({
        lines: [
          { productId: "prod_A", countedQty: 12 }, // +2
          { productId: "prod_B", countedQty: 3 }, // -1
        ],
        applyToStripe: false,
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: RECON_ID,
      totalLines: 2,
      totalVarianceUnits: 3,
      appliedToStripe: false,
      stripeApplyFailures: 0,
    });
    // Critical invariant: applyToStripe=false MUST NOT call products.update.
    expect(stripeUpdateMock).not.toHaveBeenCalled();
    // RPC called exactly once with the snapshotted lines, all applied=false
    // (the order flip means applied flags are stamped AFTER the RPC, in a
    // follow-up UPDATE).
    expect(getSupabaseRpcCallCount("submit_inventory_reconciliation")).toBe(1);
    const rpcArgs = getSupabaseRpcArgs(
      "submit_inventory_reconciliation",
    )[0] as {
      p_id: string;
      p_applied_to_stripe: boolean;
      p_total_variance_units: number;
      p_lines: Array<{
        product_id: string;
        system_count: number;
        counted_qty: number;
        variance: number;
        applied: boolean;
      }>;
    };
    expect(rpcArgs.p_id).toBe(RECON_ID);
    expect(rpcArgs.p_applied_to_stripe).toBe(false);
    expect(rpcArgs.p_total_variance_units).toBe(3);
    expect(rpcArgs.p_lines).toHaveLength(2);
    expect(rpcArgs.p_lines.every((l) => l.applied === false)).toBe(true);
    expect(rpcArgs.p_lines[0]).toMatchObject({
      product_id: "prod_A",
      system_count: 10,
      counted_qty: 12,
      variance: 2,
    });
    // applyToStripe=false: no follow-up update on the lines table either.
    expect(
      getSupabaseWritePayloads("inventory_reconciliation_lines", "update"),
    ).toHaveLength(0);
  });

  it("applyToStripe=true: only non-zero variances are pushed to Stripe; applied flag stamped via follow-up UPDATE", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: { id: RECON_ID, status: "draft" },
    });
    stageStripeCatalog([
      { id: "prod_A", name: "Mask", stockCount: 10 },
      { id: "prod_NOOP", name: "Same", stockCount: 7 },
    ]);
    stripeUpdateMock.mockResolvedValue({ id: "prod_A" });
    stageSupabaseRpcResponse("submit_inventory_reconciliation", {
      data: { ok: true, total_lines: 2, total_variance_units: 1 },
    });
    stageSupabaseResponse("inventory_reconciliation_lines", "update", {
      data: null,
    });

    const res = await request(makeApp())
      .post(`/admin/shop/inventory/reconciliations/${RECON_ID}/submit`)
      .send({
        lines: [
          { productId: "prod_A", countedQty: 11 }, // +1
          { productId: "prod_NOOP", countedQty: 7 }, // 0
        ],
        applyToStripe: true,
      });

    expect(res.status).toBe(200);
    // Only the SKU with a non-zero delta should be pushed.
    expect(stripeUpdateMock).toHaveBeenCalledTimes(1);
    expect(stripeUpdateMock).toHaveBeenCalledWith("prod_A", {
      metadata: { stock_count: "11" },
    });
    // RPC's lines all carry applied=false; the applied=true stamps land
    // via the follow-up UPDATE on inventory_reconciliation_lines.
    const rpcArgs = getSupabaseRpcArgs(
      "submit_inventory_reconciliation",
    )[0] as {
      p_lines: Array<{ product_id: string; applied: boolean }>;
    };
    expect(rpcArgs.p_lines.every((l) => l.applied === false)).toBe(true);
    const updates = getSupabaseWritePayloads(
      "inventory_reconciliation_lines",
      "update",
    ) as Array<Record<string, unknown>>;
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ applied: true });
  });

  it("records partial Stripe failures and still flips the reconciliation", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: { id: RECON_ID, status: "draft" },
    });
    stageStripeCatalog([
      { id: "prod_A", name: "Mask", stockCount: 10 },
      { id: "prod_BROKEN", name: "Broken", stockCount: 5 },
    ]);
    stripeUpdateMock.mockImplementation(async (id: string) => {
      if (id === "prod_BROKEN") throw new Error("stripe_unavailable");
      return { id };
    });
    stageSupabaseRpcResponse("submit_inventory_reconciliation", {
      data: { ok: true, total_lines: 2, total_variance_units: 3 },
    });
    stageSupabaseResponse("inventory_reconciliation_lines", "update", {
      data: null,
    });

    const res = await request(makeApp())
      .post(`/admin/shop/inventory/reconciliations/${RECON_ID}/submit`)
      .send({
        lines: [
          { productId: "prod_A", countedQty: 11 },
          { productId: "prod_BROKEN", countedQty: 7 },
        ],
        applyToStripe: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.stripeApplyFailures).toBe(1);

    // Audit envelope reflects the partial-failure count.
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      metadata: Record<string, unknown>;
    };
    expect(audit.metadata.stripe_apply_failures).toBe(1);

    // The follow-up UPDATE was fired exactly once — only the
    // successful SKU's row should be flipped to applied=true. Filter
    // verbs on the chain carry the `.in("product_id", [...])` arg.
    expect(
      getSupabaseWritePayloads("inventory_reconciliation_lines", "update"),
    ).toHaveLength(1);
  });

  it("skips the applied-flag UPDATE when every Stripe write fails", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: { id: RECON_ID, status: "draft" },
    });
    stageStripeCatalog([{ id: "prod_A", name: "Mask", stockCount: 10 }]);
    stripeUpdateMock.mockRejectedValue(new Error("stripe_down"));
    stageSupabaseRpcResponse("submit_inventory_reconciliation", {
      data: { ok: true, total_lines: 1, total_variance_units: 1 },
    });

    const res = await request(makeApp())
      .post(`/admin/shop/inventory/reconciliations/${RECON_ID}/submit`)
      .send({
        lines: [{ productId: "prod_A", countedQty: 11 }],
        applyToStripe: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.stripeApplyFailures).toBe(1);
    // No SKUs reached Stripe → no UPDATE call (nothing to flip).
    expect(
      getSupabaseWritePayloads("inventory_reconciliation_lines", "update"),
    ).toHaveLength(0);
  });

  it("maps the RPC already_submitted error to 409 WITHOUT mutating Stripe (race protection)", async () => {
    // After the order flip: the RPC is now called BEFORE any Stripe
    // writes. A loser of the row-lock race sees `already_submitted`
    // immediately and returns 409 without ever touching Stripe — no
    // split-brain between the reconciliation record and the catalog.
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: { id: RECON_ID, status: "draft" },
    });
    stageStripeCatalog([{ id: "prod_A", name: "Mask", stockCount: 10 }]);
    stageSupabaseRpcResponse("submit_inventory_reconciliation", {
      data: { ok: false, error: "already_submitted" },
    });

    const res = await request(makeApp())
      .post(`/admin/shop/inventory/reconciliations/${RECON_ID}/submit`)
      .send({
        lines: [{ productId: "prod_A", countedQty: 11 }],
        applyToStripe: true,
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_submitted");
    // The fix: Stripe is NOT mutated when the RPC loses the race.
    expect(stripeUpdateMock).not.toHaveBeenCalled();
    // No applied-flag UPDATE either.
    expect(
      getSupabaseWritePayloads("inventory_reconciliation_lines", "update"),
    ).toHaveLength(0);
  });

  it("maps the RPC duplicate_line error to 400", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: { id: RECON_ID, status: "draft" },
    });
    stageStripeCatalog([{ id: "prod_A", name: "Mask", stockCount: 10 }]);
    stageSupabaseRpcResponse("submit_inventory_reconciliation", {
      data: { ok: false, error: "duplicate_line" },
    });

    const res = await request(makeApp())
      .post(`/admin/shop/inventory/reconciliations/${RECON_ID}/submit`)
      .send({
        lines: [{ productId: "prod_A", countedQty: 11 }],
        applyToStripe: false,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("duplicate_line");
  });

  it("maps a raw RPC error envelope to 500 submit_rpc_failed", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: { id: RECON_ID, status: "draft" },
    });
    stageStripeCatalog([{ id: "prod_A", name: "Mask", stockCount: 10 }]);
    stageSupabaseRpcResponse("submit_inventory_reconciliation", {
      error: { message: "connection lost" },
    });

    const res = await request(makeApp())
      .post(`/admin/shop/inventory/reconciliations/${RECON_ID}/submit`)
      .send({
        lines: [{ productId: "prod_A", countedQty: 11 }],
        applyToStripe: false,
      });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("submit_rpc_failed");
  });
});

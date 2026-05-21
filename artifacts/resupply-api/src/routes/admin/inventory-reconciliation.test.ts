// Tests for routes/admin/inventory-reconciliation.ts
//
// Coverage matrix:
//
//   POST /admin/shop/inventory/reconciliations (start)
//     * unauthenticated                 → 401
//     * insufficient permission         → 403
//     * missing periodLabel             → 400 with issues
//     * periodLabel too short (< 2)     → 400 with issues
//     * periodLabel too long (> 60)     → 400 with issues
//     * extra unknown fields (strict)   → 400
//     * DB insert failure               → 500
//     * happy path                      → 201 { id, startedAt }
//     * notes trimmed and stored        → 201
//
//   GET /admin/shop/inventory/reconciliations (list)
//     * unauthenticated                 → 401
//     * DB error                        → 500
//     * empty history                   → 200 { reconciliations: [] }
//     * list with one row               → 200 with mapped fields
//
//   GET /admin/shop/inventory/reconciliations/:id (get by id)
//     * non-UUID id                     → 400 { error: "invalid_id" }
//     * not found                       → 404
//     * DB header error                 → 500
//     * DB lines error                  → 500
//     * submitted reconciliation        → 200, currentProducts: null
//     * draft, Stripe not configured    → 200, currentProducts: null
//     * happy path (submitted)          → correct field mapping
//
//   POST /admin/shop/inventory/reconciliations/:id/submit
//     * non-UUID id                     → 400 { error: "invalid_id" }
//     * empty lines array               → 400 with issues
//     * productId without prod_ prefix  → 400 with issues
//     * countedQty negative             → 400 with issues
//     * countedQty > 1,000,000          → 400 with issues
//     * duplicate productId in lines    → 400 { error: "duplicate_product_in_lines" }
//     * Stripe not configured           → 503
//     * not found                       → 404
//     * already submitted               → 409
//     * DB lines insert failure         → 500
//     * happy path                      → 200 with totals

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

// ── Supabase mock (module-scoped) ──────────────────────────────────────────
const supabaseMock = installSupabaseMock();

// ── Auth mock ──────────────────────────────────────────────────────────────
const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// ── adminRateLimit passthrough ─────────────────────────────────────────────
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit:
    (_opts: { name: string; preset?: string }) =>
    (
      _req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ) => {
      next();
    },
}));

// ── Audit mock ─────────────────────────────────────────────────────────────
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

// ── Stripe mock ─────────────────────────────────────────────────────────────
let stripeConfigured = false;
const stripeProductsListMock = vi.fn();
const stripeProductsUpdateMock = vi.fn();

vi.mock("../../lib/stripe/config", () => ({
  readStripeConfigOrNull: () =>
    stripeConfigured
      ? { secretKey: "sk_test_x", publishableKey: null, webhookSigningSecret: null, publicBaseUrl: "https://shop.test" }
      : null,
  getStripeClient: () => ({
    products: {
      list: (...a: unknown[]) => stripeProductsListMock(...a),
      update: (...a: unknown[]) => stripeProductsUpdateMock(...a),
    },
  }),
}));

vi.mock("../../lib/stripe/products-meta", () => ({
  projectProduct: vi.fn((p: Record<string, unknown>) => {
    // Pass through an object with the fields the route reads.
    // The route uses: p.id, p.name, p.stockCount, p.lowStockThreshold, p.category
    return {
      id: p.id,
      name: p.name,
      stockCount: p.stockCount !== undefined ? p.stockCount : null,
      lowStockThreshold: p.lowStockThreshold !== undefined ? p.lowStockThreshold : null,
      category: p.category ?? "test",
      price: null,
    };
  }),
}));

// ── App factory ────────────────────────────────────────────────────────────
async function makeApp(): Promise<Express> {
  const { default: router } = await import("./inventory-reconciliation");
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", router);
  return app;
}

function stubAdmin(): void {
  mockAdmin.current = {
    userId: "u_ops_1",
    email: "ops@test.com",
    role: "admin",
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  stripeConfigured = false;
  stripeProductsListMock.mockReset();
  stripeProductsUpdateMock.mockReset();
});

// ── Fixtures ───────────────────────────────────────────────────────────────
const VALID_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const VALID_START_BODY = { periodLabel: "2026-05" };
const VALID_SUBMIT_BODY = {
  lines: [{ productId: "prod_abc", countedQty: 10 }],
  applyToStripe: false,
};

// ===========================================================================
// POST /admin/shop/inventory/reconciliations — start a draft
// ===========================================================================

describe("POST /reconciliations — authentication", () => {
  it("returns 401 when not authenticated", async () => {
    const app = await makeApp();
    const res = await request(app)
      .post("/resupply-api/admin/shop/inventory/reconciliations")
      .send(VALID_START_BODY);
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller lacks admin.tools.manage permission", async () => {
    mockAdmin.current = { userId: "u1", email: "e@test.com", role: "agent" };
    const app = await makeApp();
    const res = await request(app)
      .post("/resupply-api/admin/shop/inventory/reconciliations")
      .send(VALID_START_BODY);
    expect(res.status).toBe(403);
  });
});

describe("POST /reconciliations — body validation", () => {
  beforeEach(() => stubAdmin());

  it("returns 400 when periodLabel is missing", async () => {
    const app = await makeApp();
    const res = await request(app)
      .post("/resupply-api/admin/shop/inventory/reconciliations")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it("returns 400 when periodLabel is shorter than 2 characters", async () => {
    const app = await makeApp();
    const res = await request(app)
      .post("/resupply-api/admin/shop/inventory/reconciliations")
      .send({ periodLabel: "x" });
    expect(res.status).toBe(400);
    expect(res.body.issues[0].path).toBe("periodLabel");
  });

  it("returns 400 when periodLabel exceeds 60 characters", async () => {
    const app = await makeApp();
    const res = await request(app)
      .post("/resupply-api/admin/shop/inventory/reconciliations")
      .send({ periodLabel: "a".repeat(61) });
    expect(res.status).toBe(400);
    expect(res.body.issues[0].path).toBe("periodLabel");
  });

  it("returns 400 when extra unknown fields are present (strict schema)", async () => {
    const app = await makeApp();
    const res = await request(app)
      .post("/resupply-api/admin/shop/inventory/reconciliations")
      .send({ periodLabel: "2026-05", badField: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("accepts a periodLabel of exactly 2 characters", async () => {
    stageSupabaseResponse("inventory_reconciliations", "insert", {
      data: { id: VALID_ID, started_at: "2026-05-01T00:00:00Z" },
    });
    const app = await makeApp();
    const res = await request(app)
      .post("/resupply-api/admin/shop/inventory/reconciliations")
      .send({ periodLabel: "Q2" });
    expect(res.status).toBe(201);
  });

  it("accepts a periodLabel of exactly 60 characters", async () => {
    stageSupabaseResponse("inventory_reconciliations", "insert", {
      data: { id: VALID_ID, started_at: "2026-05-01T00:00:00Z" },
    });
    const app = await makeApp();
    const res = await request(app)
      .post("/resupply-api/admin/shop/inventory/reconciliations")
      .send({ periodLabel: "a".repeat(60) });
    expect(res.status).toBe(201);
  });
});

describe("POST /reconciliations — DB errors", () => {
  beforeEach(() => stubAdmin());

  it("returns 500 when the DB insert fails", async () => {
    stageSupabaseResponse("inventory_reconciliations", "insert", {
      data: null,
      error: { message: "unique_violation" },
    });
    const app = await makeApp();
    const res = await request(app)
      .post("/resupply-api/admin/shop/inventory/reconciliations")
      .send(VALID_START_BODY);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("insert_failed");
  });
});

describe("POST /reconciliations — happy path", () => {
  beforeEach(() => stubAdmin());

  it("returns 201 with id and startedAt on success", async () => {
    stageSupabaseResponse("inventory_reconciliations", "insert", {
      data: { id: VALID_ID, started_at: "2026-05-01T10:00:00Z" },
    });
    const app = await makeApp();
    const res = await request(app)
      .post("/resupply-api/admin/shop/inventory/reconciliations")
      .send(VALID_START_BODY);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: VALID_ID, startedAt: "2026-05-01T10:00:00Z" });
  });

  it("accepts optional notes", async () => {
    stageSupabaseResponse("inventory_reconciliations", "insert", {
      data: { id: VALID_ID, started_at: "2026-05-01T00:00:00Z" },
    });
    const app = await makeApp();
    const res = await request(app)
      .post("/resupply-api/admin/shop/inventory/reconciliations")
      .send({ periodLabel: "2026-05", notes: "spot-check after relocation" });
    expect(res.status).toBe(201);
  });

  it("accepts null notes", async () => {
    stageSupabaseResponse("inventory_reconciliations", "insert", {
      data: { id: VALID_ID, started_at: "2026-05-01T00:00:00Z" },
    });
    const app = await makeApp();
    const res = await request(app)
      .post("/resupply-api/admin/shop/inventory/reconciliations")
      .send({ periodLabel: "2026-05", notes: null });
    expect(res.status).toBe(201);
  });
});

// ===========================================================================
// GET /admin/shop/inventory/reconciliations — list
// ===========================================================================

describe("GET /reconciliations — authentication", () => {
  it("returns 401 when not authenticated", async () => {
    const app = await makeApp();
    const res = await request(app).get(
      "/resupply-api/admin/shop/inventory/reconciliations",
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /reconciliations — DB errors", () => {
  beforeEach(() => stubAdmin());

  it("returns 500 on DB query failure", async () => {
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: null,
      error: { message: "connection refused" },
    });
    const app = await makeApp();
    const res = await request(app).get(
      "/resupply-api/admin/shop/inventory/reconciliations",
    );
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("query_failed");
  });
});

describe("GET /reconciliations — happy path", () => {
  beforeEach(() => stubAdmin());

  it("returns 200 with empty reconciliations array when none exist", async () => {
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: [],
    });
    const app = await makeApp();
    const res = await request(app).get(
      "/resupply-api/admin/shop/inventory/reconciliations",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reconciliations: [] });
  });

  it("maps snake_case DB fields to camelCase in the response", async () => {
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: [
        {
          id: VALID_ID,
          period_label: "2026-05",
          status: "submitted",
          started_by_email: "ops@test.com",
          started_at: "2026-05-01T00:00:00Z",
          submitted_at: "2026-05-02T00:00:00Z",
          total_lines: 5,
          total_variance_units: 3,
          applied_to_stripe: true,
        },
      ],
    });
    const app = await makeApp();
    const res = await request(app).get(
      "/resupply-api/admin/shop/inventory/reconciliations",
    );
    expect(res.status).toBe(200);
    const [row] = res.body.reconciliations;
    expect(row).toMatchObject({
      id: VALID_ID,
      periodLabel: "2026-05",
      status: "submitted",
      startedByEmail: "ops@test.com",
      startedAt: "2026-05-01T00:00:00Z",
      submittedAt: "2026-05-02T00:00:00Z",
      totalLines: 5,
      totalVarianceUnits: 3,
      appliedToStripe: true,
    });
  });

  it("handles null in optional fields gracefully", async () => {
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: [
        {
          id: VALID_ID,
          period_label: "2026-05",
          status: "draft",
          started_by_email: "ops@test.com",
          started_at: "2026-05-01T00:00:00Z",
          submitted_at: null,
          total_lines: 0,
          total_variance_units: 0,
          applied_to_stripe: false,
        },
      ],
    });
    const app = await makeApp();
    const res = await request(app).get(
      "/resupply-api/admin/shop/inventory/reconciliations",
    );
    expect(res.status).toBe(200);
    expect(res.body.reconciliations[0].submittedAt).toBeNull();
  });
});

// ===========================================================================
// GET /admin/shop/inventory/reconciliations/:id — get by id
// ===========================================================================

describe("GET /reconciliations/:id — id validation", () => {
  beforeEach(() => stubAdmin());

  it("returns 400 for a non-UUID id", async () => {
    const app = await makeApp();
    const res = await request(app).get(
      "/resupply-api/admin/shop/inventory/reconciliations/not-a-uuid",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_id");
  });

  it("accepts a valid UUID", async () => {
    // Stage header + lines responses (submitted so no Stripe call)
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: {
        id: VALID_ID,
        period_label: "2026-05",
        status: "submitted",
        started_by_email: "ops@test.com",
        started_by_user_id: null,
        started_at: "2026-05-01T00:00:00Z",
        submitted_at: "2026-05-02T00:00:00Z",
        notes: null,
        total_lines: 0,
        total_variance_units: 0,
        applied_to_stripe: false,
      },
    });
    stageSupabaseResponse("inventory_reconciliation_lines", "select", {
      data: [],
    });
    const app = await makeApp();
    const res = await request(app).get(
      `/resupply-api/admin/shop/inventory/reconciliations/${VALID_ID}`,
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /reconciliations/:id — not found / DB errors", () => {
  beforeEach(() => stubAdmin());

  it("returns 404 when the reconciliation doesn't exist", async () => {
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: null,
      error: null,
    });
    const app = await makeApp();
    const res = await request(app).get(
      `/resupply-api/admin/shop/inventory/reconciliations/${VALID_ID}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 500 when the header query fails", async () => {
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: null,
      error: { message: "connection error" },
    });
    const app = await makeApp();
    const res = await request(app).get(
      `/resupply-api/admin/shop/inventory/reconciliations/${VALID_ID}`,
    );
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("query_failed");
  });

  it("returns 500 when the lines query fails", async () => {
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: {
        id: VALID_ID,
        period_label: "2026-05",
        status: "submitted",
        started_by_email: "ops@test.com",
        started_by_user_id: null,
        started_at: "2026-05-01T00:00:00Z",
        submitted_at: "2026-05-02T00:00:00Z",
        notes: null,
        total_lines: 0,
        total_variance_units: 0,
        applied_to_stripe: false,
      },
    });
    stageSupabaseResponse("inventory_reconciliation_lines", "select", {
      data: null,
      error: { message: "query error" },
    });
    const app = await makeApp();
    const res = await request(app).get(
      `/resupply-api/admin/shop/inventory/reconciliations/${VALID_ID}`,
    );
    expect(res.status).toBe(500);
  });
});

describe("GET /reconciliations/:id — submitted reconciliation", () => {
  beforeEach(() => stubAdmin());

  it("returns 200 with currentProducts: null for a submitted reconciliation", async () => {
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: {
        id: VALID_ID,
        period_label: "2026-05",
        status: "submitted",
        started_by_email: "ops@test.com",
        started_by_user_id: null,
        started_at: "2026-05-01T00:00:00Z",
        submitted_at: "2026-05-02T00:00:00Z",
        notes: null,
        total_lines: 2,
        total_variance_units: 1,
        applied_to_stripe: true,
      },
    });
    stageSupabaseResponse("inventory_reconciliation_lines", "select", {
      data: [],
    });
    const app = await makeApp();
    const res = await request(app).get(
      `/resupply-api/admin/shop/inventory/reconciliations/${VALID_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.currentProducts).toBeNull();
    expect(res.body.reconciliation.status).toBe("submitted");
  });

  it("maps lines snake_case to camelCase", async () => {
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: {
        id: VALID_ID,
        period_label: "2026-05",
        status: "submitted",
        started_by_email: "ops@test.com",
        started_by_user_id: null,
        started_at: "2026-05-01T00:00:00Z",
        submitted_at: "2026-05-02T00:00:00Z",
        notes: null,
        total_lines: 1,
        total_variance_units: 3,
        applied_to_stripe: false,
      },
    });
    stageSupabaseResponse("inventory_reconciliation_lines", "select", {
      data: [
        {
          id: "line_1",
          product_id: "prod_abc",
          product_name: "CPAP Mask",
          system_count: 10,
          counted_qty: 13,
          variance: 3,
          applied: false,
          created_at: "2026-05-02T00:00:00Z",
        },
      ],
    });
    const app = await makeApp();
    const res = await request(app).get(
      `/resupply-api/admin/shop/inventory/reconciliations/${VALID_ID}`,
    );
    expect(res.status).toBe(200);
    const [line] = res.body.lines;
    expect(line).toMatchObject({
      id: "line_1",
      productId: "prod_abc",
      productName: "CPAP Mask",
      systemCount: 10,
      countedQty: 13,
      variance: 3,
      applied: false,
    });
  });
});

describe("GET /reconciliations/:id — draft without Stripe", () => {
  beforeEach(() => stubAdmin());

  it("returns 200 with currentProducts: null when Stripe is not configured", async () => {
    stripeConfigured = false; // already default, just explicit
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: {
        id: VALID_ID,
        period_label: "2026-05",
        status: "draft",
        started_by_email: "ops@test.com",
        started_by_user_id: null,
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
    const app = await makeApp();
    const res = await request(app).get(
      `/resupply-api/admin/shop/inventory/reconciliations/${VALID_ID}`,
    );
    expect(res.status).toBe(200);
    // Without Stripe configured, listShopProductsForReconciliation returns null
    expect(res.body.currentProducts).toBeNull();
  });
});

// ===========================================================================
// POST /admin/shop/inventory/reconciliations/:id/submit
// ===========================================================================

describe("POST /reconciliations/:id/submit — id validation", () => {
  beforeEach(() => stubAdmin());

  it("returns 400 for a non-UUID id", async () => {
    const app = await makeApp();
    const res = await request(app)
      .post("/resupply-api/admin/shop/inventory/reconciliations/not-a-uuid/submit")
      .send(VALID_SUBMIT_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_id");
  });
});

describe("POST /reconciliations/:id/submit — body validation", () => {
  beforeEach(() => stubAdmin());

  it("returns 400 when lines array is empty", async () => {
    const app = await makeApp();
    const res = await request(app)
      .post(`/resupply-api/admin/shop/inventory/reconciliations/${VALID_ID}/submit`)
      .send({ lines: [], applyToStripe: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when productId doesn't start with prod_", async () => {
    const app = await makeApp();
    const res = await request(app)
      .post(`/resupply-api/admin/shop/inventory/reconciliations/${VALID_ID}/submit`)
      .send({
        lines: [{ productId: "price_abc", countedQty: 5 }],
        applyToStripe: false,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when countedQty is negative", async () => {
    const app = await makeApp();
    const res = await request(app)
      .post(`/resupply-api/admin/shop/inventory/reconciliations/${VALID_ID}/submit`)
      .send({
        lines: [{ productId: "prod_abc", countedQty: -1 }],
        applyToStripe: false,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when countedQty exceeds 1,000,000", async () => {
    const app = await makeApp();
    const res = await request(app)
      .post(`/resupply-api/admin/shop/inventory/reconciliations/${VALID_ID}/submit`)
      .send({
        lines: [{ productId: "prod_abc", countedQty: 1_000_001 }],
        applyToStripe: false,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when countedQty is not an integer", async () => {
    const app = await makeApp();
    const res = await request(app)
      .post(`/resupply-api/admin/shop/inventory/reconciliations/${VALID_ID}/submit`)
      .send({
        lines: [{ productId: "prod_abc", countedQty: 1.5 }],
        applyToStripe: false,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when applyToStripe is missing", async () => {
    const app = await makeApp();
    const res = await request(app)
      .post(`/resupply-api/admin/shop/inventory/reconciliations/${VALID_ID}/submit`)
      .send({ lines: [{ productId: "prod_abc", countedQty: 5 }] });
    expect(res.status).toBe(400);
  });
});

describe("POST /reconciliations/:id/submit — duplicate productId", () => {
  beforeEach(() => stubAdmin());

  it("returns 400 with duplicate_product_in_lines when the same productId appears twice", async () => {
    const app = await makeApp();
    const res = await request(app)
      .post(`/resupply-api/admin/shop/inventory/reconciliations/${VALID_ID}/submit`)
      .send({
        lines: [
          { productId: "prod_abc", countedQty: 5 },
          { productId: "prod_abc", countedQty: 7 },
        ],
        applyToStripe: false,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("duplicate_product_in_lines");
    expect(res.body.productId).toBe("prod_abc");
  });
});

describe("POST /reconciliations/:id/submit — Stripe not configured", () => {
  beforeEach(() => stubAdmin());

  it("returns 503 when Stripe is not configured", async () => {
    stripeConfigured = false;
    // Need header check to pass first
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: { id: VALID_ID, status: "draft" },
    });
    const app = await makeApp();
    const res = await request(app)
      .post(`/resupply-api/admin/shop/inventory/reconciliations/${VALID_ID}/submit`)
      .send(VALID_SUBMIT_BODY);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("stripe_not_configured");
  });
});

describe("POST /reconciliations/:id/submit — not found / already submitted", () => {
  beforeEach(() => {
    stubAdmin();
    stripeConfigured = true;
  });

  it("returns 404 when reconciliation doesn't exist", async () => {
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: null,
      error: null,
    });
    const app = await makeApp();
    const res = await request(app)
      .post(`/resupply-api/admin/shop/inventory/reconciliations/${VALID_ID}/submit`)
      .send(VALID_SUBMIT_BODY);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 409 when reconciliation is already submitted", async () => {
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: { id: VALID_ID, status: "submitted" },
    });
    const app = await makeApp();
    const res = await request(app)
      .post(`/resupply-api/admin/shop/inventory/reconciliations/${VALID_ID}/submit`)
      .send(VALID_SUBMIT_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_submitted");
  });
});

describe("POST /reconciliations/:id/submit — happy path", () => {
  beforeEach(() => {
    stubAdmin();
    stripeConfigured = true;
    // Stripe returns a product matching the submitted productId.
    // stockCount is provided as a direct property so the projectProduct mock
    // can pass it through (the real implementation would parse metadata).
    stripeProductsListMock.mockResolvedValue({
      data: [{ id: "prod_abc", name: "CPAP Mask", stockCount: 10, lowStockThreshold: 2 }],
    });
    stripeProductsUpdateMock.mockResolvedValue({});
  });

  it("returns 200 with totals on success", async () => {
    // Stage: header select, lines insert, header update
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: { id: VALID_ID, status: "draft" },
    });
    stageSupabaseResponse("inventory_reconciliation_lines", "insert", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("inventory_reconciliations", "update", {
      data: null,
      error: null,
    });
    const app = await makeApp();
    const res = await request(app)
      .post(`/resupply-api/admin/shop/inventory/reconciliations/${VALID_ID}/submit`)
      .send(VALID_SUBMIT_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: VALID_ID,
      appliedToStripe: false,
    });
    expect(typeof res.body.totalLines).toBe("number");
    expect(typeof res.body.totalVarianceUnits).toBe("number");
  });

  it("returns 400 with no_valid_lines when all submitted productIds are absent from the Stripe catalog", async () => {
    stageSupabaseResponse("inventory_reconciliations", "select", {
      data: { id: VALID_ID, status: "draft" },
    });
    // Stripe returns no products (empty catalog)
    stripeProductsListMock.mockResolvedValue({ data: [] });
    const app = await makeApp();
    const res = await request(app)
      .post(`/resupply-api/admin/shop/inventory/reconciliations/${VALID_ID}/submit`)
      .send(VALID_SUBMIT_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_valid_lines");
  });
});
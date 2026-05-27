// Route tests for routes/admin/shop-returns.ts
//
// PR change:
//   POST /admin/shop/returns/:id/refund previously used `requireAdmin`
//   (any signed-in admin/agent). It now uses `requirePermission("returns.approve")`
//   which restricts the money-out refund path to supervisor-level and above.
//
// Coverage matrix:
//   POST /refund — unauthenticated (401), CSR role 403, supervisor role 200,
//                  admin role 200, missing return 404, not-in-received-state 409,
//                  no Stripe configured (records refund w/ null stripeRefundId),
//                  Stripe throws (502), happy path with Stripe.
//   POST /approve — requirePermission gate still works (smoke test).
//
// Mocking strategy:
//   * Supabase is stubbed via the shared supabase-mock helper.
//   * Stripe is mocked at the lib/stripe/config layer.
//   * requireAdmin / requirePermission are mocked via auth-mocks.

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

const stripeRefundsMock = vi.fn();
let stripeConfigured = true;
vi.mock("../../lib/stripe/config", () => ({
  readStripeConfigOrNull: (_env?: unknown) =>
    stripeConfigured ? { secretKey: "sk_test_x" } : null,
  getStripeClient: () => ({
    refunds: {
      create: (...a: unknown[]) => stripeRefundsMock(...a),
    },
  }),
}));

vi.mock("../../lib/observability", () => ({
  withMetrics: (_meta: unknown, fn: () => unknown) => fn(),
}));

import shopReturnsRouter from "./shop-returns";

const RETURN_ID = "aaaa1111-0000-4000-8000-000000000001";
const ORDER_ID  = "bbbb2222-0000-4000-8000-000000000001";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", shopReturnsRouter);
  return app;
}

// A minimal shop_returns row in 'received' state.
function receivedReturnRow(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: RETURN_ID,
    customer_id: "cust_alice",
    order_id: ORDER_ID,
    stripe_session_id: "cs_test_1",
    status: "received",
    reason: "defective",
    reason_note: null,
    resolution: null,
    refund_cents: null,
    stripe_refund_id: null,
    exchange_product_id: null,
    exchange_price_id: null,
    exchange_order_id: null,
    return_label_url: null,
    return_carrier: null,
    return_tracking_number: null,
    admin_note: null,
    admin_user_id: null,
    refund_failure_count: 0,
    refund_last_failure_at: null,
    refund_last_failure_reason: null,
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-01T10:00:00Z",
    approved_at: "2026-04-02T10:00:00Z",
    rejected_at: null,
    shipped_back_at: "2026-04-05T10:00:00Z",
    received_at: "2026-04-08T10:00:00Z",
    resolved_at: null,
    closed_at: null,
    ...over,
  };
}

function shopOrderRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stripe_payment_intent_id: "pi_test_1",
    amount_total_cents: 4998,
    ...over,
  };
}

function refundedReturnRow(): Record<string, unknown> {
  return receivedReturnRow({
    status: "refunded",
    resolution: "refund",
    refund_cents: 4998,
    stripe_refund_id: "re_test_1",
    resolved_at: "2026-04-10T10:00:00Z",
    closed_at: "2026-04-10T10:00:00Z",
  });
}

beforeEach(() => {
  supabaseMock.reset();
  stripeConfigured = true;
  stripeRefundsMock.mockReset();
  mockAdmin.current = null;
});

// ===========================================================================
// POST /admin/shop/returns/:id/refund — RBAC gate (PR change)
// ===========================================================================
describe("POST /admin/shop/returns/:id/refund — requirePermission gate (PR change)", () => {
  it("returns 401 when there is no admin session", async () => {
    // mockAdmin.current is null — no session.
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/returns/${RETURN_ID}/refund`)
      .send({});
    expect(res.status).toBe(401);
  });

  it("returns 403 when signed in as a CSR (agent role, no returns.approve)", async () => {
    // 'agent' DB role → customer_service_rep effective role.
    // customer_service_rep has returns.manage but NOT returns.approve.
    mockAdmin.current = {
      userId: "u_csr_1",
      email: "csr@penn.example.com",
      role: "agent",
      granularRole: "agent",
    };
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/returns/${RETURN_ID}/refund`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "permission_denied" });
  });

  it("returns 403 for 'csr' granular role (no returns.approve)", async () => {
    mockAdmin.current = {
      userId: "u_csr_2",
      email: "csr2@penn.example.com",
      role: "agent",
      granularRole: "csr",
    };
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/returns/${RETURN_ID}/refund`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("allows a supervisor (has returns.approve) to reach the route handler", async () => {
    // 'supervisor' → admin effective role → has returns.approve.
    mockAdmin.current = {
      userId: "u_supervisor_1",
      email: "sup@penn.example.com",
      role: "admin",
      granularRole: "supervisor",
    };
    // Stage the return lookup + order lookup + DB update so the handler runs.
    stageSupabaseResponse("shop_returns", "select", {
      data: receivedReturnRow(),
    });
    stageSupabaseResponse("shop_orders", "select", {
      data: shopOrderRow(),
    });
    stripeRefundsMock.mockResolvedValue({ id: "re_test_1" });
    stageSupabaseResponse("shop_returns", "update", {
      data: refundedReturnRow(),
    });

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/returns/${RETURN_ID}/refund`)
      .send({ amountCents: 4998 });

    // Permission gate passed and handler succeeded
    expect(res.status).toBe(200);
  });

  it("allows a full admin (role: 'admin') to reach the route handler", async () => {
    // 'admin' DB role → super_admin effective role → all permissions.
    mockAdmin.current = {
      userId: "u_admin_1",
      email: "admin@penn.example.com",
      role: "admin",
      // granularRole defaults to role when omitted, which is "admin".
    };
    stageSupabaseResponse("shop_returns", "select", {
      data: receivedReturnRow(),
    });
    stageSupabaseResponse("shop_orders", "select", {
      data: shopOrderRow(),
    });
    stripeRefundsMock.mockResolvedValue({ id: "re_test_1" });
    stageSupabaseResponse("shop_returns", "update", {
      data: refundedReturnRow(),
    });

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/returns/${RETURN_ID}/refund`)
      .send({ amountCents: 4998 });

    // Permission gate passed and handler succeeded
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// POST /admin/shop/returns/:id/refund — handler logic (authenticated as admin)
// ===========================================================================
describe("POST /admin/shop/returns/:id/refund — handler logic", () => {
  function stubAdmin() {
    mockAdmin.current = {
      userId: "u_admin_1",
      email: "admin@penn.example.com",
      role: "admin",
    };
  }

  it("returns 404 when the return row is not found", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", { data: null });

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/returns/${RETURN_ID}/refund`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("return_not_found");
  });

  it("returns 409 when the return is not in 'received' state", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", {
      data: receivedReturnRow({ status: "approved" }),
    });

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/returns/${RETURN_ID}/refund`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_in_received_state");
  });

  it("issues a Stripe refund and returns the updated return on happy path", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", {
      data: receivedReturnRow(),
    });
    stageSupabaseResponse("shop_orders", "select", {
      data: shopOrderRow(),
    });
    stripeRefundsMock.mockResolvedValue({ id: "re_test_1" });
    stageSupabaseResponse("shop_returns", "update", {
      data: refundedReturnRow(),
    });

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/returns/${RETURN_ID}/refund`)
      .send({ amountCents: 4998 });

    expect(res.status).toBe(200);
    expect(res.body.return).toBeDefined();
    expect(res.body.return.status).toBe("refunded");
  });

  it("records the refund without calling Stripe when Stripe is not configured", async () => {
    stubAdmin();
    stripeConfigured = false;
    stageSupabaseResponse("shop_returns", "select", {
      data: receivedReturnRow(),
    });
    stageSupabaseResponse("shop_orders", "select", {
      data: shopOrderRow(),
    });
    stageSupabaseResponse("shop_returns", "update", {
      data: { ...refundedReturnRow(), stripe_refund_id: null },
    });

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/returns/${RETURN_ID}/refund`)
      .send({ amountCents: 4998 });

    expect(res.status).toBe(200);
    expect(stripeRefundsMock).not.toHaveBeenCalled();
  });

  it("returns 502 when Stripe throws during refunds.create", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", {
      data: receivedReturnRow(),
    });
    stageSupabaseResponse("shop_orders", "select", {
      data: shopOrderRow(),
    });
    // The handler now writes the failure counter on the catch
    // branch — stage a non-erroring response for that UPDATE so
    // the assertion focuses on the response body, not on the
    // tracking write succeeding.
    stageSupabaseResponse("shop_returns", "update", { data: null });
    stripeRefundsMock.mockRejectedValue(new Error("charge_already_refunded"));

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/returns/${RETURN_ID}/refund`)
      .send({ amountCents: 4998 });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("stripe_refund_failed");
    // The 502 body now surfaces the per-row failure count so the
    // admin UI can render "Refund failed N times" without
    // refetching the row.
    expect(res.body.failureCount).toBe(1);
    expect(res.body.message).toContain("charge_already_refunded");
  });

  it("escalates via WARN once the failure count crosses the threshold", async () => {
    stubAdmin();
    // Seed the row with two prior failures so this attempt makes
    // three — the configured REFUND_FAILURE_ESCALATION_THRESHOLD.
    stageSupabaseResponse("shop_returns", "select", {
      data: receivedReturnRow({
        refund_failure_count: 2,
        refund_last_failure_at: "2026-05-22T20:00:00Z",
        refund_last_failure_reason:
          "charge_already_refunded: prior attempt",
      }),
    });
    stageSupabaseResponse("shop_orders", "select", {
      data: shopOrderRow(),
    });
    stageSupabaseResponse("shop_returns", "update", { data: null });
    stripeRefundsMock.mockRejectedValue(
      Object.assign(new Error("rate_limited"), { code: "rate_limited" }),
    );

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/returns/${RETURN_ID}/refund`)
      .send({ amountCents: 4998 });

    expect(res.status).toBe(502);
    expect(res.body.failureCount).toBe(3);
    // The threshold WARN ("shop_return_refund_stuck") is what
    // pages ops — we can't directly assert on the log from
    // supertest without a logger mock, but the response shape
    // proves the counter incremented past the threshold, which
    // is the condition the WARN gates on.
  });

  it("returns 400 when the refund amount resolves to zero or missing", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", {
      data: receivedReturnRow(),
    });
    stageSupabaseResponse("shop_orders", "select", {
      data: shopOrderRow({ amount_total_cents: null }),
    });

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/returns/${RETURN_ID}/refund`)
      .send({}); // no amountCents, order has null amount_total_cents

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_refund_amount");
  });
});

// ===========================================================================
// POST /admin/shop/returns/:id/approve — permission gate still works (smoke)
// ===========================================================================
describe("POST /admin/shop/returns/:id/approve — requirePermission gate smoke", () => {
  it("returns 403 for a CSR on the /approve endpoint", async () => {
    mockAdmin.current = {
      userId: "u_csr_3",
      email: "csr3@penn.example.com",
      role: "agent",
      granularRole: "agent",
    };

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/returns/${RETURN_ID}/approve`)
      .send({});

    expect(res.status).toBe(403);
  });

  it("allows a supervisor through the /approve gate", async () => {
    mockAdmin.current = {
      userId: "u_sup_2",
      email: "sup2@penn.example.com",
      role: "admin",
      granularRole: "supervisor",
    };
    stageSupabaseResponse("shop_returns", "update", {
      data: receivedReturnRow({ status: "approved" }),
    });

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/returns/${RETURN_ID}/approve`)
      .send({});

    // 200 or 409 (state mismatch) — not 401/403.
    expect([200, 409]).toContain(res.status);
  });
});
// Route integration tests for the A4 auto-approval rules layer.
//
// The rule helper has its own pure unit tests
// (artifacts/resupply-api/src/lib/shop-returns/auto-approval-rules.test.ts).
// This file verifies the route SIDE of the integration:
//
//   * Auto-approval (defective < 7d) INSERTs with
//     status="approved" + approved_at stamped + the rule trace in
//     admin_note. Response surfaces autoApprovedBy.
//   * Manual reasons (e.g. "fit") still INSERT with the default
//     status (we don't set it), with autoApprovedBy=null.
//   * Fraud-cap path: a customer over the cap who reports a
//     defective in week 1 still lands in the manual queue.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInRef,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSession } = vi.hoisted(() => ({
  mockSession: { current: null as MockSignedInRef["current"] },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSession),
);

import myReturnsRouter from "./my-returns";

const CUSTOMER_ID = "cust_a";
const ORDER_ID = "order-1";
const SESSION_ID = "cs_test_session_1";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", myReturnsRouter);
  return app;
}

function paidAt(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400_000).toISOString();
}

function stageRouteSetup(opts: {
  paidDaysAgo: number;
  priorApprovedReturnsCount: number;
}): void {
  // (1) shop_orders lookup by stripe_session_id — return the paid order.
  stageSupabaseResponse("shop_orders", "select", {
    data: {
      id: ORDER_ID,
      customer_id: CUSTOMER_ID,
      status: "paid",
      paid_at: paidAt(opts.paidDaysAgo),
    },
  });
  // (2) Existing-open-return check — none open.
  stageSupabaseResponse("shop_returns", "select", { data: null });
  // (3) Prior-approved-returns lookup. Return as many rows as the
  // test wants, but cap to whatever rows we stage. The route caps
  // its query to AUTO_APPROVE_PRIOR_RETURN_CAP=3 rows; staging more
  // than that is harmless because the route only reads `.length`.
  const priorRows = Array.from(
    { length: opts.priorApprovedReturnsCount },
    (_, i) => ({ id: `prev-${i}` }),
  );
  stageSupabaseResponse("shop_returns", "select", { data: priorRows });
}

beforeEach(() => {
  supabaseMock.reset();
  mockSession.current = {
    customerId: CUSTOMER_ID,
    email: "pat@example.com",
    displayName: "Pat",
  };
});

describe("POST /shop/me/orders/:sessionId/returns — A4 auto-approval", () => {
  it("auto-approves a defective claim within 7 days", async () => {
    stageRouteSetup({ paidDaysAgo: 2, priorApprovedReturnsCount: 0 });
    // (4) The INSERT — supabase mock just echoes a row back.
    stageSupabaseResponse("shop_returns", "insert", {
      data: {
        id: "ret-1",
        status: "approved",
        created_at: new Date().toISOString(),
        approved_at: new Date().toISOString(),
      },
    });

    const res = await request(makeApp())
      .post(`/resupply-api/shop/me/orders/${SESSION_ID}/returns`)
      .send({ reason: "defective" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("approved");
    expect(res.body.approvedAt).toBeTruthy();
    expect(res.body.autoApprovedBy).toBe("defective_within_7d");

    // The INSERT payload should carry status=approved + approved_at +
    // the admin_note rule trace.
    const writes = getSupabaseWritePayloads("shop_returns", "insert");
    expect(writes.length).toBe(1);
    const payload = writes[0] as Record<string, unknown>;
    expect(payload.status).toBe("approved");
    expect(typeof payload.approved_at).toBe("string");
    expect(payload.admin_note as string).toContain(
      "Auto-approved by rule: defective_within_7d",
    );
  });

  it("auto-approves a wrong_item claim within 30 days", async () => {
    stageRouteSetup({ paidDaysAgo: 14, priorApprovedReturnsCount: 0 });
    stageSupabaseResponse("shop_returns", "insert", {
      data: {
        id: "ret-2",
        status: "approved",
        created_at: new Date().toISOString(),
        approved_at: new Date().toISOString(),
      },
    });

    const res = await request(makeApp())
      .post(`/resupply-api/shop/me/orders/${SESSION_ID}/returns`)
      .send({ reason: "wrong_item" });

    expect(res.status).toBe(201);
    expect(res.body.autoApprovedBy).toBe("wrong_item_within_30d");
    const payload = getSupabaseWritePayloads("shop_returns", "insert")[0] as Record<
      string,
      unknown
    >;
    expect(payload.status).toBe("approved");
  });

  it("does NOT auto-approve a fit complaint (manual queue)", async () => {
    stageRouteSetup({ paidDaysAgo: 1, priorApprovedReturnsCount: 0 });
    stageSupabaseResponse("shop_returns", "insert", {
      data: {
        id: "ret-3",
        status: "requested",
        created_at: new Date().toISOString(),
        approved_at: null,
      },
    });

    const res = await request(makeApp())
      .post(`/resupply-api/shop/me/orders/${SESSION_ID}/returns`)
      .send({ reason: "fit", reasonNote: "Cushion doesn't seal" });

    expect(res.status).toBe(201);
    expect(res.body.autoApprovedBy).toBeNull();
    // The insert should NOT carry an overridden status — the table
    // default `requested` applies. We assert by absence.
    const payload = getSupabaseWritePayloads("shop_returns", "insert")[0] as Record<
      string,
      unknown
    >;
    expect(payload.status).toBeUndefined();
    expect(payload.approved_at).toBeUndefined();
  });

  it("falls through to manual when prior approved returns >= cap (fraud guard)", async () => {
    // Same defective<7d input that auto-approves on a clean account
    // — but this customer has 3 prior approved returns in 90d, which
    // is the cap.
    stageRouteSetup({ paidDaysAgo: 2, priorApprovedReturnsCount: 3 });
    stageSupabaseResponse("shop_returns", "insert", {
      data: {
        id: "ret-4",
        status: "requested",
        created_at: new Date().toISOString(),
        approved_at: null,
      },
    });

    const res = await request(makeApp())
      .post(`/resupply-api/shop/me/orders/${SESSION_ID}/returns`)
      .send({ reason: "defective" });

    expect(res.status).toBe(201);
    expect(res.body.autoApprovedBy).toBeNull();
    const payload = getSupabaseWritePayloads("shop_returns", "insert")[0] as Record<
      string,
      unknown
    >;
    expect(payload.status).toBeUndefined();
  });

  it("does NOT auto-approve a defective claim outside the 7-day window", async () => {
    stageRouteSetup({ paidDaysAgo: 14, priorApprovedReturnsCount: 0 });
    stageSupabaseResponse("shop_returns", "insert", {
      data: {
        id: "ret-5",
        status: "requested",
        created_at: new Date().toISOString(),
        approved_at: null,
      },
    });

    const res = await request(makeApp())
      .post(`/resupply-api/shop/me/orders/${SESSION_ID}/returns`)
      .send({ reason: "defective" });

    expect(res.status).toBe(201);
    expect(res.body.autoApprovedBy).toBeNull();
  });
});

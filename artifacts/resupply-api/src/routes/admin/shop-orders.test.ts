// Route tests for routes/admin/shop-orders.ts.
//
// Coverage matrix:
//   POST /tracking   — admin gate, id format, body validation,
//                      not-found, status guard, happy-path UPDATE,
//                      overwrite re-stamps shipped_at.
//   POST /delivered  — admin gate, id, not-found, not-shipped guard,
//                      happy-path UPDATE, idempotent re-fire.
//   PATCH /shipping-address — admin gate, id, body, not-found,
//                              happy-path UPDATE allowed post-ship.
//   POST /refund     — admin gate, id, not-found, status guards,
//                      missing payment_intent, amount cap,
//                      stripe-not-configured (503), stripe-error (502),
//                      happy-path Stripe refunds.create.
//
// Mocking strategy:
//   * Supabase client is stubbed via the shared `supabase-mock` helper.
//     Each test stages the rows it expects each query to see, in order.
//   * Stripe is mocked at the lib/stripe/config layer; only refunds
//     are exercised here.
//   * The auth provider is mocked via auth-deps; the admin gate
//     resolves a verified email matching RESUPPLY_ADMIN_EMAILS.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

const stripeRefundsCreateMock = vi.fn();
let stripeConfigured = true;
vi.mock("../../lib/stripe/config", () => ({
  readStripeConfigOrNull: () =>
    stripeConfigured ? { secretKey: "sk_test_x" } : null,
  getStripeClient: () => ({
    refunds: {
      create: (...a: unknown[]) => stripeRefundsCreateMock(...a),
    },
  }),
}));

// SendGrid mock — the tracking handler triggers an email after the
// UPDATE.
const sendEmailMock = vi.fn();
const createSendgridClientMock = vi.fn<
  () => { sendEmail: typeof sendEmailMock }
>(() => ({ sendEmail: sendEmailMock }));
vi.mock("@workspace/resupply-email", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-email")
  >("@workspace/resupply-email");
  return {
    ...actual,
    createSendgridClient: () => createSendgridClientMock(),
  };
});

// Web-push mock — wired into shipping notifications (Phase G.2).
const sendPushToCustomerMock = vi.hoisted(() =>
  vi.fn<
    (
      customerId: string,
      payload: {
        title: string;
        body: string;
        url?: string;
        tag?: string;
      },
    ) => Promise<{ delivered: number; expired: number; transient: number }>
  >(async () => ({ delivered: 0, expired: 0, transient: 0 })),
);
vi.mock("../../lib/web-push", () => ({
  sendPushToCustomer: sendPushToCustomerMock,
  isPushConfigured: () => false,
}));

import shopOrdersAdminRouter from "./shop-orders";

const ALLOWED_EMAIL = "ops@penn.example.com";
const VALID_ID = "11111111-2222-3333-8444-555555555555";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", shopOrdersAdminRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  mockAdmin.current = {
    userId: "user_op",
    email: ALLOWED_EMAIL,
    role: "admin",
  };
}

// Snake-case row shape PostgREST returns. The route's response
// mapper projects to camelCase for the JSON body.
function paidOrderRow(
  over: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: VALID_ID,
    stripe_session_id: "cs_test_1",
    stripe_payment_intent_id: "pi_test_1",
    status: "paid",
    amount_total_cents: 4998,
    currency: "usd",
    customer_id: "user_alice",
    created_at: new Date("2026-04-20T12:00:00Z").toISOString(),
    paid_at: new Date("2026-04-20T12:01:00Z").toISOString(),
    shipping_address_json: null,
    tracking_carrier: null,
    tracking_number: null,
    shipped_at: null,
    delivered_at: null,
    shipping_email_sent_at: null,
    customer_email: null,
    ...over,
  };
}

const ENV_KEYS = [
  "RESUPPLY_ADMIN_EMAILS",
  "NODE_ENV",
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "SENDGRID_FROM_NAME",
  "SHOP_PUBLIC_BASE_URL",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.NODE_ENV = "test";
  process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
  process.env.SHOP_PUBLIC_BASE_URL = "https://test.example.com";
  stripeConfigured = true;
  supabaseMock.reset();
  stripeRefundsCreateMock.mockReset();
  sendEmailMock.mockReset();
  createSendgridClientMock.mockReset();
  createSendgridClientMock.mockImplementation(() => ({
    sendEmail: sendEmailMock,
  }));
  sendPushToCustomerMock.mockClear();
  mockAdmin.current = null;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

// =====================================================================
// POST /admin/shop/orders/:orderId/tracking
// =====================================================================
describe("POST /admin/shop/orders/:orderId/tracking", () => {
  it("rejects callers without admin sign-in", async () => {
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/tracking`)
      .send({ carrier: "UPS", number: "1Z999AA1" });
    expect([401, 403]).toContain(res.status);
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(0);
  });

  it("rejects ids that aren't a UUID", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/orders/not-a-uuid/tracking")
      .send({ carrier: "UPS", number: "1Z999AA1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_order_id");
    expect(getSupabaseCallCount("shop_orders", "select")).toBe(0);
  });

  it("rejects empty carrier or number", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/tracking`)
      .send({ carrier: "  ", number: "1Z999" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(getSupabaseCallCount("shop_orders", "select")).toBe(0);
  });

  it("returns 404 when no row matches the id", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: null });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/tracking`)
      .send({ carrier: "UPS", number: "1Z999AA1" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("order_not_found");
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(0);
  });

  it("returns 409 when the order isn't paid", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: paidOrderRow({ status: "pending" }),
    });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/tracking`)
      .send({ carrier: "UPS", number: "1Z999AA1" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_not_paid");
    expect(res.body.currentStatus).toBe("pending");
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(0);
  });

  it("writes tracking + shipped_at and returns the projected order", async () => {
    stubVerifiedAdmin();
    const shippedAtIso = new Date("2026-04-25T09:00:00Z").toISOString();
    stageSupabaseResponse("shop_orders", "select", { data: paidOrderRow() }); // loadOrder
    stageSupabaseResponse("shop_orders", "update", {
      data: paidOrderRow({
        tracking_carrier: "UPS",
        tracking_number: "1Z999AA1",
        shipped_at: shippedAtIso,
      }),
    }); // tracking UPDATE returning
    // The helper's atomic claim wins (timestamp was cleared). Then
    // the customer lookup returns no row, so the helper RELEASES
    // the claim — that's a separate UPDATE.
    stageSupabaseResponse("shop_orders", "update", {
      data: paidOrderRow({
        tracking_carrier: "UPS",
        tracking_number: "1Z999AA1",
        shipped_at: shippedAtIso,
      }),
    }); // atomic claim returning
    stageSupabaseResponse("shop_customers", "select", { data: null }); // empty
    stageSupabaseResponse("shop_orders", "update", { error: null }); // release
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/tracking`)
      .send({ carrier: "UPS", number: "1Z999AA1" });
    expect(res.status).toBe(200);
    expect(res.body.order.trackingCarrier).toBe("UPS");
    expect(res.body.order.trackingNumber).toBe("1Z999AA1");
    expect(res.body.order.shippedAt).toBe(shippedAtIso);
    // Three UPDATEs total — tracking write + atomic claim + release.
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(3);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("allows overwriting tracking on a re-shipped order", async () => {
    stubVerifiedAdmin();
    const reShippedAtIso = new Date("2026-04-29T09:00:00Z").toISOString();
    stageSupabaseResponse("shop_orders", "select", {
      data: paidOrderRow({
        tracking_carrier: "USPS",
        tracking_number: "9400-old",
        shipped_at: new Date("2026-04-21T09:00:00Z").toISOString(),
      }),
    }); // loadOrder
    stageSupabaseResponse("shop_orders", "update", {
      data: paidOrderRow({
        tracking_carrier: "FedEx",
        tracking_number: "FX-NEW",
        shipped_at: reShippedAtIso,
      }),
    }); // tracking UPDATE returning
    stageSupabaseResponse("shop_orders", "update", {
      data: paidOrderRow({
        tracking_carrier: "FedEx",
        tracking_number: "FX-NEW",
        shipped_at: reShippedAtIso,
      }),
    }); // atomic claim returning
    stageSupabaseResponse("shop_customers", "select", { data: null });
    stageSupabaseResponse("shop_orders", "update", { error: null }); // release
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/tracking`)
      .send({ carrier: "FedEx", number: "FX-NEW" });
    expect(res.status).toBe(200);
    expect(res.body.order.trackingCarrier).toBe("FedEx");
    expect(res.body.order.shippedAt).toBe(reShippedAtIso);
    // tracking write + atomic claim + release = 3 updates.
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(3);
  });

  // -------------------------------------------------------------------
  // Shipping notification email (T005 wire-up). These cases pin the
  // idempotency contract: send once on first tracking entry, re-send
  // on a tracking change, skip on identical re-entry.
  // -------------------------------------------------------------------
  it("sends shipping notification email on first tracking entry — atomic claim wins, no extra stamp UPDATE", async () => {
    stubVerifiedAdmin();
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_ship_first" });

    const shippedAtIso = new Date("2026-04-25T09:00:00Z").toISOString();
    stageSupabaseResponse("shop_orders", "select", { data: paidOrderRow() }); // loadOrder
    stageSupabaseResponse("shop_orders", "update", {
      data: paidOrderRow({
        tracking_carrier: "UPS",
        tracking_number: "1Z999",
        shipped_at: shippedAtIso,
      }),
    }); // tracking UPDATE returning
    stageSupabaseResponse("shop_orders", "update", {
      data: paidOrderRow({
        tracking_carrier: "UPS",
        tracking_number: "1Z999",
        shipped_at: shippedAtIso,
      }),
    }); // atomic claim returning
    stageSupabaseResponse("shop_customers", "select", {
      data: { email_lower: "buyer@example.com" },
    });

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/tracking`)
      .send({ carrier: "UPS", number: "1Z999" });

    expect(res.status).toBe(200);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.subject).toBe("Your PennPaps order has shipped");
    expect(arg.to).toBe("buyer@example.com");
    expect(arg.html).toContain("ups.com/track");
    // Two UPDATEs — tracking write + atomic claim. No release on the
    // success path.
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(2);
    // Phase G.2 — push fan-out fires after a successful email,
    // scoped to the linked customer.
    expect(sendPushToCustomerMock).toHaveBeenCalledTimes(1);
    const [pushCustId, pushPayload] = sendPushToCustomerMock.mock.calls[0]!;
    expect(pushCustId).toBe("user_alice");
    expect(pushPayload).toMatchObject({
      title: "Your PennPaps order shipped",
      url: "/account/orders",
    });
    expect(pushPayload.body).toContain("UPS");
    expect(pushPayload.body).toContain("1Z999");
    expect(pushPayload.tag).toMatch(/^shop_order_shipped:/);
  });

  it("does NOT resend shipping notification when admin re-saves identical tracking — atomic claim returns no rows", async () => {
    stubVerifiedAdmin();
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";

    const sentAtIso = new Date("2026-04-25T09:00:00Z").toISOString();
    stageSupabaseResponse("shop_orders", "select", {
      data: paidOrderRow({
        tracking_carrier: "UPS",
        tracking_number: "1Z999",
        shipped_at: sentAtIso,
        shipping_email_sent_at: sentAtIso,
      }),
    }); // loadOrder
    // Tracking UPDATE: identical values → CASE-WHEN keeps
    // shipping_email_sent_at non-null. Returns the row with stamp intact.
    stageSupabaseResponse("shop_orders", "update", {
      data: paidOrderRow({
        tracking_carrier: "UPS",
        tracking_number: "1Z999",
        shipped_at: new Date("2026-04-26T09:00:00Z").toISOString(),
        shipping_email_sent_at: sentAtIso,
      }),
    });
    // Atomic claim attempt finds shipping_email_sent_at non-null →
    // returns null. Helper short-circuits with "already_sent_or_missing".
    stageSupabaseResponse("shop_orders", "update", { data: null });

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/tracking`)
      .send({ carrier: "UPS", number: "1Z999" });

    expect(res.status).toBe(200);
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Two UPDATEs — tracking write + (failed) claim attempt.
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(2);
    // Phase G.2 — push must NOT fire when the claim is skipped.
    expect(sendPushToCustomerMock).not.toHaveBeenCalled();
  });

  it("resends shipping notification when tracking number changes — claim wins on cleared timestamp", async () => {
    stubVerifiedAdmin();
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_ship_reship" });

    const oldSentAtIso = new Date("2026-04-21T09:00:00Z").toISOString();
    const newShippedAtIso = new Date("2026-04-29T09:00:00Z").toISOString();
    stageSupabaseResponse("shop_orders", "select", {
      data: paidOrderRow({
        tracking_carrier: "USPS",
        tracking_number: "9400-old",
        shipped_at: oldSentAtIso,
        shipping_email_sent_at: oldSentAtIso,
      }),
    }); // loadOrder — already had tracking + email sent
    stageSupabaseResponse("shop_orders", "update", {
      data: paidOrderRow({
        tracking_carrier: "FedEx",
        tracking_number: "FX-NEW",
        shipped_at: newShippedAtIso,
        shipping_email_sent_at: null,
      }),
    });
    // Atomic claim wins on the freshly-cleared timestamp.
    stageSupabaseResponse("shop_orders", "update", {
      data: paidOrderRow({
        tracking_carrier: "FedEx",
        tracking_number: "FX-NEW",
        shipped_at: newShippedAtIso,
      }),
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: { email_lower: "buyer@example.com" },
    });

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/tracking`)
      .send({ carrier: "FedEx", number: "FX-NEW" });

    expect(res.status).toBe(200);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.html).toContain("FX-NEW");
    expect(arg.html).toContain("fedex.com");
    // Two UPDATEs — tracking write + atomic claim.
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(2);
  });

  it("falls back to persisted customer_email when customer_id is null (guest re-ship)", async () => {
    stubVerifiedAdmin();
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_ship_guest" });

    const shippedAtIso = new Date("2026-04-30T09:00:00Z").toISOString();
    stageSupabaseResponse("shop_orders", "select", {
      data: paidOrderRow({
        customer_id: null,
        customer_email: "guest@example.com",
      }),
    }); // loadOrder
    stageSupabaseResponse("shop_orders", "update", {
      data: paidOrderRow({
        customer_id: null,
        customer_email: "guest@example.com",
        tracking_carrier: "UPS",
        tracking_number: "1Z-GUEST",
        shipped_at: shippedAtIso,
      }),
    }); // tracking UPDATE
    stageSupabaseResponse("shop_orders", "update", {
      data: paidOrderRow({
        customer_id: null,
        customer_email: "guest@example.com",
        tracking_carrier: "UPS",
        tracking_number: "1Z-GUEST",
        shipped_at: shippedAtIso,
      }),
    }); // atomic claim
    // No shop_customers SELECT expected — customer_id is null.

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/tracking`)
      .send({ carrier: "UPS", number: "1Z-GUEST" });

    expect(res.status).toBe(200);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0]![0].to).toBe("guest@example.com");
    // Two UPDATEs (tracking + claim), no release.
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(2);
    // Phase G.2 — push is gated on customer_id; guest orders must NOT
    // trigger a push notification.
    expect(sendPushToCustomerMock).not.toHaveBeenCalled();
  });

  it("RELEASES the claim when the post-claim shop_customers SELECT throws transiently", async () => {
    stubVerifiedAdmin();
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";

    const shippedAtIso = new Date("2026-04-30T10:00:00Z").toISOString();
    stageSupabaseResponse("shop_orders", "select", { data: paidOrderRow() }); // loadOrder
    stageSupabaseResponse("shop_orders", "update", {
      data: paidOrderRow({
        tracking_carrier: "UPS",
        tracking_number: "1Z-TRANS",
        shipped_at: shippedAtIso,
      }),
    }); // tracking UPDATE
    stageSupabaseResponse("shop_orders", "update", {
      data: paidOrderRow({
        tracking_carrier: "UPS",
        tracking_number: "1Z-TRANS",
        shipped_at: shippedAtIso,
      }),
    }); // atomic claim wins
    // Customer-lookup SELECT errors — simulates a transient pg error
    // after the claim was acquired. The catch-all release path must
    // still fire so a future admin re-save can retry.
    stageSupabaseResponse("shop_customers", "select", {
      error: new Error("ECONNRESET while reading shop_customers"),
    });
    stageSupabaseResponse("shop_orders", "update", { error: null }); // release

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/tracking`)
      .send({ carrier: "UPS", number: "1Z-TRANS" });

    // Route must NOT 500 — email failures (including post-claim
    // throws) are non-fatal to the admin tracking write.
    expect(res.status).toBe(200);
    // Email was never actually sent.
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Three UPDATEs — tracking + claim + release.
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(3);
    // Phase G.2 — push must NOT fire when the claim was released.
    expect(sendPushToCustomerMock).not.toHaveBeenCalled();
  });

  it("RELEASES the claim and 200s the route when SendGrid throws (claim available for retry)", async () => {
    stubVerifiedAdmin();
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockRejectedValueOnce(new Error("upstream 503"));

    const shippedAtIso = new Date("2026-04-30T09:00:00Z").toISOString();
    stageSupabaseResponse("shop_orders", "select", { data: paidOrderRow() }); // loadOrder
    stageSupabaseResponse("shop_orders", "update", {
      data: paidOrderRow({
        tracking_carrier: "UPS",
        tracking_number: "1Z999",
        shipped_at: shippedAtIso,
      }),
    }); // tracking UPDATE
    stageSupabaseResponse("shop_orders", "update", {
      data: paidOrderRow({
        tracking_carrier: "UPS",
        tracking_number: "1Z999",
        shipped_at: shippedAtIso,
      }),
    }); // atomic claim
    stageSupabaseResponse("shop_customers", "select", {
      data: { email_lower: "buyer@example.com" },
    });
    stageSupabaseResponse("shop_orders", "update", { error: null }); // release

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/tracking`)
      .send({ carrier: "UPS", number: "1Z999" });

    // Route must NOT 500 just because email upstream is flapping.
    expect(res.status).toBe(200);
    // Three UPDATEs — tracking + claim + release.
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(3);
    // Phase G.2 — push must NOT fire when the email send failed and
    // the claim was released.
    expect(sendPushToCustomerMock).not.toHaveBeenCalled();
  });
});

// =====================================================================
// POST /admin/shop/orders/:orderId/delivered
// =====================================================================
describe("POST /admin/shop/orders/:orderId/delivered", () => {
  it("rejects callers without admin sign-in", async () => {
    const res = await request(makeApp()).post(
      `/resupply-api/admin/shop/orders/${VALID_ID}/delivered`,
    );
    expect([401, 403]).toContain(res.status);
  });

  it("returns 404 when the order doesn't exist", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: null });
    const res = await request(makeApp()).post(
      `/resupply-api/admin/shop/orders/${VALID_ID}/delivered`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("order_not_found");
  });

  it("returns 409 when the order hasn't shipped", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: paidOrderRow() });
    const res = await request(makeApp()).post(
      `/resupply-api/admin/shop/orders/${VALID_ID}/delivered`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_not_shipped");
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(0);
  });

  it("stamps delivered_at on a shipped order", async () => {
    stubVerifiedAdmin();
    const shippedAtIso = new Date("2026-04-25T09:00:00Z").toISOString();
    const deliveredAtIso = new Date("2026-04-28T15:00:00Z").toISOString();
    stageSupabaseResponse("shop_orders", "select", {
      data: paidOrderRow({ shipped_at: shippedAtIso }),
    });
    stageSupabaseResponse("shop_orders", "update", {
      data: paidOrderRow({
        shipped_at: shippedAtIso,
        delivered_at: deliveredAtIso,
      }),
    });
    const res = await request(makeApp()).post(
      `/resupply-api/admin/shop/orders/${VALID_ID}/delivered`,
    );
    expect(res.status).toBe(200);
    expect(res.body.order.deliveredAt).toBe(deliveredAtIso);
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(1);
  });

  it("is idempotent on a re-fire (does not bump delivered_at)", async () => {
    stubVerifiedAdmin();
    const shippedAtIso = new Date("2026-04-25T09:00:00Z").toISOString();
    const originalDeliveredAtIso = new Date(
      "2026-04-28T15:00:00Z",
    ).toISOString();
    stageSupabaseResponse("shop_orders", "select", {
      data: paidOrderRow({
        shipped_at: shippedAtIso,
        delivered_at: originalDeliveredAtIso,
      }),
    });
    const res = await request(makeApp()).post(
      `/resupply-api/admin/shop/orders/${VALID_ID}/delivered`,
    );
    expect(res.status).toBe(200);
    expect(res.body.order.deliveredAt).toBe(originalDeliveredAtIso);
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(0);
  });
});

// =====================================================================
// PATCH /admin/shop/orders/:orderId/shipping-address
// =====================================================================
describe("PATCH /admin/shop/orders/:orderId/shipping-address", () => {
  const validAddress = {
    line1: "123 Main St",
    line2: "Apt 4",
    city: "Philadelphia",
    state: "pa",
    postalCode: "19104",
    country: "US",
  };

  it("rejects callers without admin sign-in", async () => {
    const res = await request(makeApp())
      .patch(`/resupply-api/admin/shop/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    expect([401, 403]).toContain(res.status);
  });

  it("rejects bodies missing required fields", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .patch(`/resupply-api/admin/shop/orders/${VALID_ID}/shipping-address`)
      .send({ line1: "1 Main", city: "Philly" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 404 when the order doesn't exist", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: null });
    const res = await request(makeApp())
      .patch(`/resupply-api/admin/shop/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("order_not_found");
  });

  it("writes the address (uppercasing state) and returns the projected order", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: paidOrderRow() });
    stageSupabaseResponse("shop_orders", "update", {
      data: paidOrderRow({
        shipping_address_json: { ...validAddress, state: "PA" },
      }),
    });
    const res = await request(makeApp())
      .patch(`/resupply-api/admin/shop/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    expect(res.status).toBe(200);
    expect(res.body.order.shippingAddress.state).toBe("PA");
    expect(res.body.order.shippingAddress.line1).toBe("123 Main St");
  });

  it("allows the override even after shipment", async () => {
    stubVerifiedAdmin();
    const shippedAtIso = new Date("2026-04-25T09:00:00Z").toISOString();
    stageSupabaseResponse("shop_orders", "select", {
      data: paidOrderRow({ shipped_at: shippedAtIso }),
    });
    stageSupabaseResponse("shop_orders", "update", {
      data: paidOrderRow({
        shipped_at: shippedAtIso,
        shipping_address_json: { ...validAddress, state: "PA" },
      }),
    });
    const res = await request(makeApp())
      .patch(`/resupply-api/admin/shop/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    expect(res.status).toBe(200);
    expect(res.body.order.shippedAt).toBe(shippedAtIso);
  });
});

// =====================================================================
// POST /admin/shop/orders/:orderId/refund
// =====================================================================
describe("POST /admin/shop/orders/:orderId/refund", () => {
  it("rejects callers without admin sign-in", async () => {
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({});
    expect([401, 403]).toContain(res.status);
  });

  it("returns 404 when the order doesn't exist", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: null });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("order_not_found");
  });

  it("returns 409 when the order is already refunded", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: paidOrderRow({ status: "refunded" }),
    });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_already_refunded");
    expect(stripeRefundsCreateMock).not.toHaveBeenCalled();
  });

  it("returns 409 when the order isn't paid yet", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: paidOrderRow({ status: "pending" }),
    });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_not_paid");
    expect(stripeRefundsCreateMock).not.toHaveBeenCalled();
  });

  it("returns 409 when there's no captured payment_intent", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: paidOrderRow({ stripe_payment_intent_id: null }),
    });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_no_payment_intent");
  });

  it("returns 409 when amountCents exceeds the order total", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: paidOrderRow({ amount_total_cents: 4998 }),
    });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({ amountCents: 9999 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("refund_exceeds_amount");
    expect(res.body.amountTotalCents).toBe(4998);
    expect(stripeRefundsCreateMock).not.toHaveBeenCalled();
  });

  it("returns 503 when Stripe isn't configured", async () => {
    stubVerifiedAdmin();
    stripeConfigured = false;
    stageSupabaseResponse("shop_orders", "select", { data: paidOrderRow() });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("stripe_not_configured");
  });

  it("forwards Stripe errors as 502", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: paidOrderRow() });
    stripeRefundsCreateMock.mockRejectedValue(
      Object.assign(new Error("stripe down"), { statusCode: 502 }),
    );
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({});
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("stripe_refund_failed");
  });

  it("issues a full refund when amount is omitted", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: paidOrderRow() });
    stripeRefundsCreateMock.mockResolvedValue({
      id: "re_test_1",
      amount: 4998,
      status: "succeeded",
    });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.refund.id).toBe("re_test_1");
    expect(res.body.refund.amountCents).toBe(4998);
    // Verify we passed the payment_intent through.
    const callArgs = stripeRefundsCreateMock.mock.calls[0]?.[0] as {
      payment_intent?: string;
      amount?: number;
      reason?: string;
    };
    expect(callArgs.payment_intent).toBe("pi_test_1");
    expect(callArgs.amount).toBeUndefined();
    expect(callArgs.reason).toBeUndefined();
  });

  it("forwards amount + reason on a partial refund", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: paidOrderRow() });
    stripeRefundsCreateMock.mockResolvedValue({
      id: "re_test_partial",
      amount: 1000,
      status: "succeeded",
    });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({ amountCents: 1000, reason: "requested_by_customer" });
    expect(res.status).toBe(200);
    expect(res.body.refund.amountCents).toBe(1000);
    const callArgs = stripeRefundsCreateMock.mock.calls[0]?.[0] as {
      amount?: number;
      reason?: string;
      metadata?: Record<string, string>;
    };
    expect(callArgs.amount).toBe(1000);
    expect(callArgs.reason).toBe("requested_by_customer");
    // Defense in depth: admin email + order id are recorded on the
    // Stripe Refund metadata so the audit trail survives outside our DB.
    expect(callArgs.metadata?.admin_email).toBe(ALLOWED_EMAIL);
    expect(callArgs.metadata?.shop_order_id).toBe(VALID_ID);
  });
});

// =====================================================================
// In-store pickup lifecycle: ready-for-pickup + picked-up
// =====================================================================
// A pickup order (fulfillment_method='pickup') uses ready_for_pickup_at
// / picked_up_at instead of shipped_at / delivered_at. The ship
// endpoints refuse pickup orders and vice versa.
function pickupOrderRow(
  over: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return paidOrderRow({
    fulfillment_method: "pickup",
    pickup_location_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ready_for_pickup_at: null,
    picked_up_at: null,
    ready_for_pickup_email_sent_at: null,
    ...over,
  });
}

describe("POST /admin/shop/orders/:orderId/ready-for-pickup", () => {
  it("rejects callers without admin sign-in", async () => {
    const res = await request(makeApp()).post(
      `/resupply-api/admin/shop/orders/${VALID_ID}/ready-for-pickup`,
    );
    expect([401, 403]).toContain(res.status);
  });

  it("409s when the order is a ship order, not pickup", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: paidOrderRow() });
    const res = await request(makeApp()).post(
      `/resupply-api/admin/shop/orders/${VALID_ID}/ready-for-pickup`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_is_ship");
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(0);
  });

  it("409s when the order isn't paid", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: pickupOrderRow({ status: "pending" }),
    });
    const res = await request(makeApp()).post(
      `/resupply-api/admin/shop/orders/${VALID_ID}/ready-for-pickup`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_not_paid");
  });

  it("stamps ready_for_pickup_at on a paid pickup order", async () => {
    stubVerifiedAdmin();
    const readyIso = new Date("2026-05-02T09:00:00Z").toISOString();
    stageSupabaseResponse("shop_orders", "select", { data: pickupOrderRow() }); // loadOrder
    // stamp update (no .select) + the email helper's claim update both
    // resolve to the unstaged default — claim returns null → email skip.
    // Final loadOrder returns the now-ready row for projection.
    stageSupabaseResponse("shop_orders", "select", {
      data: pickupOrderRow({ ready_for_pickup_at: readyIso }),
    });
    const res = await request(makeApp()).post(
      `/resupply-api/admin/shop/orders/${VALID_ID}/ready-for-pickup`,
    );
    expect(res.status).toBe(200);
    expect(res.body.order.fulfillmentMethod).toBe("pickup");
    expect(res.body.order.readyForPickupAt).toBe(readyIso);
  });
});

describe("POST /admin/shop/orders/:orderId/picked-up", () => {
  it("409s when the order is a ship order", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: paidOrderRow() });
    const res = await request(makeApp()).post(
      `/resupply-api/admin/shop/orders/${VALID_ID}/picked-up`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_is_ship");
  });

  it("409s when the order isn't ready for pickup yet", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: pickupOrderRow({ ready_for_pickup_at: null }),
    });
    const res = await request(makeApp()).post(
      `/resupply-api/admin/shop/orders/${VALID_ID}/picked-up`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_not_ready_for_pickup");
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(0);
  });

  it("stamps picked_up_at on a ready pickup order", async () => {
    stubVerifiedAdmin();
    const readyIso = new Date("2026-05-02T09:00:00Z").toISOString();
    const pickedIso = new Date("2026-05-03T15:00:00Z").toISOString();
    stageSupabaseResponse("shop_orders", "select", {
      data: pickupOrderRow({ ready_for_pickup_at: readyIso }),
    }); // loadOrder
    stageSupabaseResponse("shop_orders", "update", {
      data: pickupOrderRow({
        ready_for_pickup_at: readyIso,
        picked_up_at: pickedIso,
      }),
    }); // picked_up UPDATE returning
    const res = await request(makeApp()).post(
      `/resupply-api/admin/shop/orders/${VALID_ID}/picked-up`,
    );
    expect(res.status).toBe(200);
    expect(res.body.order.pickedUpAt).toBe(pickedIso);
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(1);
  });

  it("is idempotent on a re-fire (keeps the original picked_up_at)", async () => {
    stubVerifiedAdmin();
    const readyIso = new Date("2026-05-02T09:00:00Z").toISOString();
    const pickedIso = new Date("2026-05-03T15:00:00Z").toISOString();
    stageSupabaseResponse("shop_orders", "select", {
      data: pickupOrderRow({
        ready_for_pickup_at: readyIso,
        picked_up_at: pickedIso,
      }),
    });
    const res = await request(makeApp()).post(
      `/resupply-api/admin/shop/orders/${VALID_ID}/picked-up`,
    );
    expect(res.status).toBe(200);
    expect(res.body.order.pickedUpAt).toBe(pickedIso);
    // No UPDATE — idempotent short-circuit on the already-picked-up row.
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(0);
  });
});

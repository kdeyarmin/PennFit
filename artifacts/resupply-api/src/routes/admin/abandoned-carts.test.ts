// Route tests for the cart-abandonment admin dispatcher.
//
// Coverage:
//   * candidate select short-circuits when nothing is eligible
//   * stamps reminded_at on success (claim sticks, no unclaim UPDATE)
//   * idempotency — empty candidate set = zero sends, zero claim,
//     zero unclaims
//   * SendGrid not configured — returns sendgridConfigured:false and
//     UNCLAIMS the row so the next run can retry once env is fixed
//   * SendGrid 4xx — counts as skippedFailed and UNCLAIMS the row
//
// Note: the legacy raw-SQL atomic claim was unwound into chained
// Supabase calls (`SELECT ids` → `UPDATE … IN (ids) IS null
// .select(...)`). The pre-Supabase test asserted on the raw SQL
// fragments to prove the claim was a single UPDATE … RETURNING; with
// PostgREST that introspection is no longer possible, so the
// behavioural contract — claim only fires when there are candidates,
// and unclaim fires on failure — is what we pin instead.

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

import { EmailConfigError } from "@workspace/resupply-email";

import abandonedCartsRouter from "./abandoned-carts";

const ALLOWED_EMAIL = "ops@penn.example.com";
const ROW_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROW_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", abandonedCartsRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  mockAdmin.current = {
    userId: "user_op",
    email: ALLOWED_EMAIL,
    role: "admin",
  };
}

const ENV_KEYS = [
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "SENDGRID_FROM_NAME",
  "RESUPPLY_ADMIN_EMAILS",
  "SHOP_PUBLIC_BASE_URL",
  "NODE_ENV",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

function setSendgridEnv(): void {
  process.env.SENDGRID_API_KEY = "SG.testkey";
  process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
  process.env.SENDGRID_FROM_NAME = "PennPaps";
  process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
  process.env.SHOP_PUBLIC_BASE_URL = "https://test.example.com";
  process.env.NODE_ENV = "test";
}

function makeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ROW_A,
    customer_id: "user_a",
    email: "joan@example.com",
    items: [
      {
        priceId: "price_1",
        productId: "prod_1",
        name: "Headgear",
        quantity: 1,
        unitAmountCents: 4500,
        currency: "usd",
        mode: "payment",
      },
    ],
    subtotal_cents: 4500,
    currency: "usd",
    ...over,
  };
}

describe("POST /admin/shop/abandoned-carts/send-due", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NODE_ENV = "test";
    mockAdmin.current = null;
    supabaseMock.reset();
    sendEmailMock.mockReset();
    createSendgridClientMock.mockReset();
    createSendgridClientMock.mockImplementation(() => ({
      sendEmail: sendEmailMock,
    }));
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("delivers one email per claimed row and leaves the claim stamped", async () => {
    setSendgridEnv();
    stubVerifiedAdmin();
    // Step 1: candidate ids.
    stageSupabaseResponse("shop_abandoned_carts", "select", {
      data: [{ id: ROW_A }, { id: ROW_B }],
    });
    // Step 2: atomic claim — UPDATE … RETURNING the rows.
    stageSupabaseResponse("shop_abandoned_carts", "update", {
      data: [makeRow({ id: ROW_A }), makeRow({ id: ROW_B })],
    });
    // Step 3: bulk comm-prefs lookup.
    stageSupabaseResponse("shop_customers", "select", { data: [] });

    sendEmailMock.mockResolvedValue({ messageId: "SG_TEST_1" });

    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/abandoned-carts/send-due")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      scanned: 2,
      sent: 2,
      skippedNoConfig: 0,
      skippedFailed: 0,
      skippedOptOut: 0,
      sendgridConfigured: true,
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    // No unclaim UPDATEs on the success path. Exactly one UPDATE
    // total (the atomic claim).
    expect(getSupabaseCallCount("shop_abandoned_carts", "update")).toBe(1);
    // Subject line + cart contents are public catalog data; subtotal
    // is rendered in the email body, but no PHI should be there.
    const call = sendEmailMock.mock.calls[0][0];
    expect(call.to).toBe("joan@example.com");
    expect(call.subject).toContain("PennPaps cart");
    expect(call.html).toContain("Headgear");
    expect(call.text).toContain("Headgear");
    expect(call.customArgs).toEqual({ kind: "cart_abandonment_v1" });
  });

  it("is idempotent: zero candidates = zero claim, zero sends, zero unclaims", async () => {
    setSendgridEnv();
    stubVerifiedAdmin();
    // No eligible rows → handler short-circuits before the claim
    // UPDATE.
    stageSupabaseResponse("shop_abandoned_carts", "select", { data: [] });

    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/abandoned-carts/send-due")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      scanned: 0,
      sent: 0,
      skippedNoConfig: 0,
      skippedFailed: 0,
      skippedOptOut: 0,
      sendgridConfigured: true,
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(getSupabaseCallCount("shop_abandoned_carts", "update")).toBe(0);
  });

  it("returns sendgridConfigured:false and UNCLAIMS the row when SendGrid env is missing", async () => {
    process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
    process.env.NODE_ENV = "test";
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_abandoned_carts", "select", {
      data: [{ id: ROW_A }],
    });
    stageSupabaseResponse("shop_abandoned_carts", "update", {
      data: [makeRow({ id: ROW_A })],
    });
    stageSupabaseResponse("shop_customers", "select", { data: [] });
    // Per-row unclaim + remaining-rows unclaim (in this case 0
    // remaining → unclaimMany guards itself, only one unclaim hits).
    stageSupabaseResponse("shop_abandoned_carts", "update", { error: null });
    // The helper catches EmailConfigError and surfaces it as
    // {configured:false}.
    createSendgridClientMock.mockImplementation(() => {
      throw new EmailConfigError("SENDGRID_API_KEY is required");
    });

    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/abandoned-carts/send-due")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      scanned: 1,
      sent: 0,
      skippedNoConfig: 1,
      skippedFailed: 0,
      skippedOptOut: 0,
      sendgridConfigured: false,
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Two UPDATEs total: the atomic claim, plus the unclaim. Without
    // the unclaim the row would be silently swallowed and never
    // re-tried after the operator wires up env.
    expect(getSupabaseCallCount("shop_abandoned_carts", "update")).toBe(2);
  });

  it("counts SendGrid 4xx/5xx as skippedFailed and UNCLAIMS the row", async () => {
    setSendgridEnv();
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_abandoned_carts", "select", {
      data: [{ id: ROW_A }],
    });
    stageSupabaseResponse("shop_abandoned_carts", "update", {
      data: [makeRow({ id: ROW_A })],
    });
    stageSupabaseResponse("shop_customers", "select", { data: [] });
    // Per-row unclaim after the SendGrid 4xx.
    stageSupabaseResponse("shop_abandoned_carts", "update", { error: null });
    sendEmailMock.mockRejectedValue(
      Object.assign(new Error("blocked"), {
        name: "EmailApiError",
        status: 550,
      }),
    );

    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/abandoned-carts/send-due")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.scanned).toBe(1);
    expect(res.body.sent).toBe(0);
    expect(res.body.skippedFailed).toBe(1);
    // We tried SendGrid (configured was true), so configured stays true.
    expect(res.body.sendgridConfigured).toBe(true);
    // Two UPDATEs total: the atomic claim + the per-row unclaim.
    expect(getSupabaseCallCount("shop_abandoned_carts", "update")).toBe(2);
  });
});

describe("GET /admin/shop/abandoned-carts", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NODE_ENV = "test";
    process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
    mockAdmin.current = null;
    supabaseMock.reset();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("redacts the email and returns aggregated counts per row", async () => {
    stubVerifiedAdmin();
    const nowIso = "2026-04-29T12:00:00.000Z";
    stageSupabaseResponse("shop_abandoned_carts", "select", {
      data: [
        {
          id: ROW_A,
          customer_id: "user_a",
          email: "joan@example.com",
          items: [
            { quantity: 2, name: "Headgear" },
            { quantity: 1, name: "Tubing" },
          ],
          subtotal_cents: 12000,
          currency: "usd",
          updated_at: nowIso,
          reminded_at: null,
          recovered_at: null,
          cleared_at: null,
          created_at: nowIso,
        },
      ],
    });

    const res = await request(makeApp()).get(
      "/resupply-api/admin/shop/abandoned-carts",
    );

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    const row = res.body.rows[0];
    expect(row.id).toBe(ROW_A);
    expect(row.itemCount).toBe(3);
    // Email must be partially redacted in the JSON response.
    expect(row.emailRedacted).not.toBe("joan@example.com");
    expect(row.emailRedacted).toMatch(/@example\.com$/);
    expect(row.emailRedacted.startsWith("jo")).toBe(true);
  });
});

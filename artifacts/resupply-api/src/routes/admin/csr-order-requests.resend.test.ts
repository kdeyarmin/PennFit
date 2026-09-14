import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  getSupabaseFilterCalls,
  getSupabaseWritePayloads,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const db = installSupabaseMock();
const mocks = vi.hoisted(() => ({
  admin: { current: null as MockAdminCtx | null },
  link: vi.fn(),
  send: vi.fn(),
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mocks.admin),
);
vi.mock("../../lib/auth-deps", () => ({
  getAuthDeps: () => ({ publicBaseUrl: "https://example.invalid" }),
}));
vi.mock("../../lib/tenant-branding", () => ({
  resolveTenantLinkBaseUrl: async () => "https://example.invalid",
}));
vi.mock("../../lib/csr-order/order", async (original) => ({
  ...(await original<typeof import("../../lib/csr-order/order")>()),
  buildCsrOrderSigningLink: mocks.link,
  deliverCsrOrderInvite: mocks.send,
}));
import router from "./csr-order-requests";

const id = "00000000-0000-4000-8000-000000000001";
const quoteId = "00000000-0000-4000-8000-000000000002";
const patientId = "00000000-0000-4000-8000-000000000003";
const endpoint = `/admin/csr-order-requests/${id}/resend`;
const app = () => express().use(express.json()).use(router);
function stageOrder(priced = true) {
  stageSupabaseResponse("csr_order_requests", "select", {
    data: {
      id,
      patient_id: patientId,
      pricing_quote_id: priced ? quoteId : null,
      status: "sent",
      signed_at: null,
      link_version: 2,
      customer_name: "Synthetic Patient",
      customer_email: "patient@example.invalid",
      customer_phone: null,
      order_reference: "TEST-ORDER",
      documents: [],
    },
  });
}
function stageQuote(validUntil: string, overrides = {}) {
  stageSupabaseResponse("pricing_quotes", "select", {
    data: {
      valid_until: validUntil,
      status: "bound",
      bound_order_id: id,
      patient_id: patientId,
      ...overrides,
    },
  });
}
beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  mocks.admin.current = {
    userId: "manager",
    email: "manager@example.invalid",
    role: "admin",
  };
  mocks.link.mockResolvedValue(
    "https://example.invalid/order-sign?token=synthetic",
  );
  mocks.send.mockResolvedValue({ emailSent: true, smsSent: false });
});

describe("CSR order resend preserves financial deadlines", () => {
  it("caps the new link at the bound quote deadline and checks the committed version before sending", async () => {
    stageOrder();
    const deadline = new Date(Date.now() + 30 * 60_000).toISOString();
    stageQuote(deadline);
    stageSupabaseResponse("csr_order_requests", "update", { data: { id } });
    const response = await request(app()).post(endpoint).send({});
    expect(response.status).toBe(200);
    expect(getSupabaseWritePayloads("csr_order_requests", "update")).toEqual([
      expect.objectContaining({ link_version: 3, expires_at: deadline }),
    ]);
    expect(getSupabaseFilterCalls("csr_order_requests", "update")).toEqual(
      expect.arrayContaining([
        { verb: "eq", args: ["link_version", 2] },
        { verb: "in", args: ["status", ["sent", "viewed"]] },
        { verb: "is", args: ["signed_at", null] },
      ]),
    );
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("rejects an expired quote without invalidating the old link or sending a new invite", async () => {
    stageOrder();
    stageQuote("2020-01-01T00:00:00Z");
    const response = await request(app()).post(endpoint).send({});
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("quote_expired");
    expect(getSupabaseWritePayloads("csr_order_requests", "update")).toEqual(
      [],
    );
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("rejects a quote bound to a different order", async () => {
    stageOrder();
    stageQuote("2099-01-01T00:00:00Z", { bound_order_id: "other-order" });
    const response = await request(app()).post(endpoint).send({});
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("quote_not_found");
    expect(getSupabaseWritePayloads("csr_order_requests", "update")).toEqual(
      [],
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each([
    {
      error: { code: "PT409", message: "quote_expired" },
      expected: "quote_expired",
    },
    { error: null, expected: "revision_conflict" },
  ])(
    "does not send when the atomic reissue fails with $expected",
    async ({ error, expected }) => {
      stageOrder();
      stageQuote("2099-01-01T00:00:00Z");
      stageSupabaseResponse("csr_order_requests", "update", {
        data: null,
        error,
      });
      const response = await request(app()).post(endpoint).send({});
      expect(response.status).toBe(409);
      expect(response.body.error).toBe(expected);
      expect(mocks.link).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );
  it("keeps the ordinary resend window for an unpriced order", async () => {
    stageOrder(false);
    stageSupabaseResponse("csr_order_requests", "update", { data: { id } });
    const start = Date.now();
    expect((await request(app()).post(endpoint).send({})).status).toBe(200);
    const write = getSupabaseWritePayloads(
      "csr_order_requests",
      "update",
    )[0] as { expires_at: string };
    expect(Date.parse(write.expires_at)).toBeGreaterThanOrEqual(
      start + 30 * 86_400_000,
    );
    expect(Date.parse(write.expires_at)).toBeLessThanOrEqual(
      Date.now() + 30 * 86_400_000,
    );
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});

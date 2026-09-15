import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  getSupabaseFilterCalls,
  getSupabaseWritePayloads,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const db = installSupabaseMock();
const mocks = vi.hoisted(() => ({ audit: vi.fn(), dispense: vi.fn() }));
vi.mock("@workspace/resupply-audit", () => ({ logAudit: mocks.audit }));
vi.mock("../../lib/csr-order/dispense-on-sign", () => ({
  dispenseSignedCsrOrder: mocks.dispense,
}));
vi.mock("../../lib/storefront/signed-link-org", () => ({
  resolveOrgIdForSignedRecord: async () =>
    "00000000-0000-4000-8000-000000000002",
}));
vi.mock("../../lib/csr-order/token", () => ({
  verifyCsrOrderToken: () => ({
    valid: true,
    orderRequestId: "00000000-0000-4000-8000-000000000001",
    linkVersion: 2,
  }),
}));
import router from "./csr-orders";
const id = "00000000-0000-4000-8000-000000000001";
const app = () => express().use(express.json()).use(router);
const body = {
  token: "synthetic-valid-token",
  signerName: "Synthetic Patient",
  consentEsign: true,
  acknowledgedDocumentKeys: [],
};
function stageOrder(expiresAt = "2099-01-01T00:00:00Z") {
  stageSupabaseResponse("csr_order_requests", "select", {
    data: {
      id,
      status: "sent",
      signed_at: null,
      documents: [],
      link_version: 2,
      expires_at: expiresAt,
    },
  });
}
beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  mocks.audit.mockResolvedValue(undefined);
  mocks.dispense.mockResolvedValue({ fulfillmentIds: [], skipped: null });
});
afterEach(() => vi.restoreAllMocks());

describe("CSR public signature deadline", () => {
  it("returns expired when the database catches a quote deadline after the link read", async () => {
    stageOrder();
    stageSupabaseResponse("csr_order_requests", "update", {
      data: null,
      error: { code: "PT409", message: "quote_expired" },
    });
    const response = await request(app()).post("/csr-orders/sign").send(body);
    expect(response.status).toBe(410);
    expect(response.body).toEqual({ error: "expired" });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.dispense).not.toHaveBeenCalled();
  });
  it("rejects a link at its exact expiry before attempting a signature write", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    stageOrder(new Date(now).toISOString());
    const response = await request(app()).post("/csr-orders/sign").send(body);
    expect(response.status).toBe(410);
    expect(response.body.error).toBe("expired");
    expect(getSupabaseWritePayloads("csr_order_requests", "update")).toEqual(
      [],
    );
    expect(mocks.dispense).not.toHaveBeenCalled();
  });
  it("commits only the still-current open link version before fulfillment", async () => {
    stageOrder();
    stageSupabaseResponse("csr_order_requests", "update", { data: [{ id }] });
    const response = await request(app()).post("/csr-orders/sign").send(body);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("signed");
    expect(getSupabaseFilterCalls("csr_order_requests", "update")).toEqual(
      expect.arrayContaining([
        { verb: "eq", args: ["link_version", 2] },
        { verb: "in", args: ["status", ["sent", "viewed"]] },
      ]),
    );
    expect(mocks.dispense).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch fulfillment if resend invalidated the link before the update", async () => {
    stageOrder();
    stageSupabaseResponse("csr_order_requests", "update", { data: [] });
    expect(
      (await request(app()).post("/csr-orders/sign").send(body)).status,
    ).toBe(409);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.dispense).not.toHaveBeenCalled();
  });
});

// Route tests for the prescription-packet fax dispatch endpoints:
//   POST /admin/prescription-requests/:id/send-fax
//   POST /admin/prescription-requests/:id/resend-fax
//
// Focus: the per-route status guards (which lifecycle states each
// endpoint accepts) and the shared dispatch happy-path — a re-send
// re-faxes the same packet and audits a DISTINCT resent_fax action so
// it can't be mistaken for an accidental double-send.
//
// The heavy dispatch dependencies (input resolver/validator, token
// signer, Telnyx client, public base URL) are mocked; the supabase
// data path uses the shared mock.

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
vi.mock("@workspace/resupply-audit", () => ({ logAudit: logAuditMock }));

vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit:
    () =>
    (
      _req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ) =>
      next(),
}));

// ── Dispatch-pipeline dependency mocks ──────────────────────────────
const sendFaxMock = vi.hoisted(() =>
  vi.fn(async () => ({ id: "fax_vendor_ref_1" })),
);
vi.mock("@workspace/resupply-telecom", () => ({
  createTelnyxFaxClient: () => ({ sendFax: sendFaxMock }),
  TelnyxApiError: class TelnyxApiError extends Error {},
}));
vi.mock("../../lib/prescription-request-resolver", () => ({
  resolvePrescriptionRequestInputs: async () => ({
    kind: "ok",
    inputs: {},
  }),
}));
vi.mock("../../lib/prescription-request-pdf", () => ({
  validatePrescriptionRequestInputs: () => ({ ok: true, inputs: {} }),
  renderPrescriptionRequest: () => undefined,
}));
vi.mock("../../lib/prescription-request-token", () => ({
  signPrescriptionRequestToken: () => "signed-token",
}));
vi.mock("./physician-fax-outreach", () => ({
  getFaxPublicBaseUrl: () => "https://app.example.com",
}));

import prescriptionRequestsRouter from "./prescription-requests";

const PACKET_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "csr@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(prescriptionRequestsRouter);
  return app;
}

function stagePacket(status: string): void {
  stageSupabaseResponse("prescription_request_packets", "select", {
    data: { id: PACKET_ID, status, return_fax_e164: "+12155551212" },
  });
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
  sendFaxMock.mockClear();
  // Telnyx env required by the dispatch config-check.
  vi.stubEnv("TELNYX_API_KEY", "key");
  vi.stubEnv("TELNYX_FAX_CONNECTION_ID", "conn");
  vi.stubEnv("TELNYX_PUBLIC_KEY", "pub");
  vi.stubEnv("TELNYX_FAX_FROM_NUMBER", "+12155550100");
});

describe("POST /admin/prescription-requests/:id/resend-fax", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).post(
      `/admin/prescription-requests/${PACKET_ID}/resend-fax`,
    );
    expect(res.status).toBe(401);
  });

  it("404s for an unknown packet", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("prescription_request_packets", "select", {
      data: null,
    });
    const res = await request(makeApp()).post(
      `/admin/prescription-requests/${PACKET_ID}/resend-fax`,
    );
    expect(res.status).toBe(404);
  });

  it("409s with send-fax guidance when the packet was never sent (draft)", async () => {
    mockAdmin.current = ADMIN;
    stagePacket("draft");
    const res = await request(makeApp()).post(
      `/admin/prescription-requests/${PACKET_ID}/resend-fax`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invalid_status");
    expect(res.body.message).toMatch(/send-fax/);
    expect(sendFaxMock).not.toHaveBeenCalled();
  });

  it("409s on a terminal status (signed)", async () => {
    mockAdmin.current = ADMIN;
    stagePacket("signed");
    const res = await request(makeApp()).post(
      `/admin/prescription-requests/${PACKET_ID}/resend-fax`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invalid_status");
    expect(sendFaxMock).not.toHaveBeenCalled();
  });

  it("re-faxes an in-flight packet and audits resent_fax", async () => {
    mockAdmin.current = ADMIN;
    stagePacket("sent_fax");
    const res = await request(makeApp()).post(
      `/admin/prescription-requests/${PACKET_ID}/resend-fax`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "sent_fax", resent: true });
    expect(sendFaxMock).toHaveBeenCalledTimes(1);

    // Re-send clears the prior delivery/failure stamps for the new
    // webhook callback and re-stamps sent_at.
    const updates = getSupabaseWritePayloads(
      "prescription_request_packets",
      "update",
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      status: "sent_fax",
      vendor_ref: "fax_vendor_ref_1",
      delivered_at: null,
      failed_at: null,
    });

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("prescription_request.resent_fax");
    expect(audit.metadata).toMatchObject({ resend: true });
  });
});

describe("POST /admin/prescription-requests/:id/send-fax", () => {
  it("409s with re-send guidance when already sent", async () => {
    mockAdmin.current = ADMIN;
    stagePacket("sent_fax");
    const res = await request(makeApp()).post(
      `/admin/prescription-requests/${PACKET_ID}/send-fax`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invalid_status");
    expect(res.body.message).toMatch(/re-send/);
    expect(sendFaxMock).not.toHaveBeenCalled();
  });

  it("dispatches a draft packet and audits sent_fax (not resent)", async () => {
    mockAdmin.current = ADMIN;
    stagePacket("draft");
    const res = await request(makeApp()).post(
      `/admin/prescription-requests/${PACKET_ID}/send-fax`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "sent_fax", resent: false });
    expect(sendFaxMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as { action: string };
    expect(audit.action).toBe("prescription_request.sent_fax");
  });
});

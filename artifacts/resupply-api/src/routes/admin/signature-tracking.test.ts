// Route tests for /admin/signature-tracking — the unified
// outstanding-signatures dashboard, the barcode lookup, and the
// mark-returned cascade onto the source prescription packet. The
// grouping math is pinned in lib/signature-tracking/service.test.ts;
// this covers the HTTP surface + the cascade write.

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

import signatureTrackingRouter from "./signature-tracking";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "owner@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(signatureTrackingRouter);
  return app;
}

function dbRow(overrides: Record<string, unknown>) {
  return {
    id: "t1",
    tracking_code: "PFS-ABCD2345",
    document_kind: "prescription_request",
    document_id: "doc-1",
    patient_id: null,
    provider_id: "p1",
    patient_label: "Doe, Jane",
    provider_label: "Dr. A",
    practice_name: "Sleep Clinic",
    title: "Prescription request",
    status: "awaiting_signature",
    delivery_channel: "fax",
    return_fax_e164: "+12155550000",
    sent_count: 1,
    last_sent_at: "2026-06-01T00:00:00Z",
    returned_at: null,
    canceled_at: null,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  supabaseMock.reset();
  mockAdmin.current = ADMIN;
});

describe("GET /admin/signature-tracking", () => {
  it("returns outstanding items with a documentPdfPath and provider rollup", async () => {
    stageSupabaseResponse("signature_tracking", "select", {
      data: [dbRow({})],
    });
    const res = await request(makeApp()).get("/admin/signature-tracking");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.items[0].documentPdfPath).toBe(
      "/resupply-api/admin/prescription-requests/doc-1/pdf",
    );
    expect(res.body.byProvider[0]).toMatchObject({ label: "Dr. A", count: 1 });
  });

  it("lists never-sent drafts under ?status=unsent", async () => {
    stageSupabaseResponse("signature_tracking", "select", {
      data: [dbRow({ sent_count: 0, delivery_channel: "none" })],
    });
    const res = await request(makeApp()).get(
      "/admin/signature-tracking?status=unsent",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    // The pseudo-status maps to awaiting_signature + sent_count = 0.
    const filters = supabaseMock.filterCalls("signature_tracking", "select");
    expect(filters).toContainEqual({
      verb: "eq",
      args: ["status", "awaiting_signature"],
    });
    expect(filters).toContainEqual({ verb: "eq", args: ["sent_count", 0] });
  });
});

describe("GET /admin/signature-tracking/lookup", () => {
  it("resolves a code (normalising case/spacing)", async () => {
    stageSupabaseResponse("signature_tracking", "select", { data: dbRow({}) });
    const res = await request(makeApp()).get(
      "/admin/signature-tracking/lookup?code=pfs-abcd2345",
    );
    expect(res.status).toBe(200);
    expect(res.body.item.trackingCode).toBe("PFS-ABCD2345");
  });

  it("404s when no document matches", async () => {
    stageSupabaseResponse("signature_tracking", "select", { data: null });
    const res = await request(makeApp()).get(
      "/admin/signature-tracking/lookup?code=PFS-NOPE2345",
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/signature-tracking/:id/mark-returned", () => {
  it("marks the tracking row returned and cascades to the prescription packet", async () => {
    // getTrackingById → the row.
    stageSupabaseResponse("signature_tracking", "select", { data: dbRow({}) });
    const res = await request(makeApp()).post(
      "/admin/signature-tracking/11111111-1111-4111-8111-111111111111/mark-returned",
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("returned_signed");
    // The tracking row was updated, and the source packet was stamped signed.
    expect(supabaseMock.callCount("signature_tracking", "update")).toBe(1);
    const packetUpdates = supabaseMock.writePayloads(
      "prescription_request_packets",
      "update",
    );
    expect(packetUpdates).toHaveLength(1);
    expect(packetUpdates[0]).toMatchObject({ status: "signed" });
  });

  it("is idempotent when already returned", async () => {
    stageSupabaseResponse("signature_tracking", "select", {
      data: dbRow({ status: "returned_signed" }),
    });
    const res = await request(makeApp()).post(
      "/admin/signature-tracking/11111111-1111-4111-8111-111111111111/mark-returned",
    );
    expect(res.status).toBe(200);
    expect(res.body.alreadyReturned).toBe(true);
    // No writes when it was already terminal.
    expect(supabaseMock.callCount("signature_tracking", "update")).toBe(0);
  });
});

describe("POST /admin/signature-tracking/:id/mark-hand-delivered", () => {
  it("records a hand_delivery dispatch (the row becomes outstanding)", async () => {
    // getTrackingById → an unsent draft.
    stageSupabaseResponse("signature_tracking", "select", {
      data: dbRow({ sent_count: 0, delivery_channel: "none" }),
    });
    // recordTrackingSent's own row read.
    stageSupabaseResponse("signature_tracking", "select", {
      data: { id: "t1", sent_count: 0 },
    });
    const res = await request(makeApp()).post(
      "/admin/signature-tracking/11111111-1111-4111-8111-111111111111/mark-hand-delivered",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "awaiting_signature",
      deliveryChannel: "hand_delivery",
    });
    const updates = supabaseMock.writePayloads("signature_tracking", "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      sent_count: 1,
      delivery_channel: "hand_delivery",
      status: "awaiting_signature",
    });
  });

  it("409s on a terminal row instead of silently reopening it", async () => {
    stageSupabaseResponse("signature_tracking", "select", {
      data: dbRow({ status: "returned_signed" }),
    });
    const res = await request(makeApp()).post(
      "/admin/signature-tracking/11111111-1111-4111-8111-111111111111/mark-hand-delivered",
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_awaiting");
    expect(supabaseMock.callCount("signature_tracking", "update")).toBe(0);
  });
});

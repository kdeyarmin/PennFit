// Route tests for /patients/:id/insurance-claims endpoints.
//
// Endpoints under test:
//   GET    /patients/:id/insurance-claims                  — list
//   POST   /patients/:id/insurance-claims                  — create
//   GET    /patients/:id/insurance-claims/:claimId         — detail
//   PATCH  /patients/:id/insurance-claims/:claimId         — transition/edit
//   POST   /patients/:id/insurance-claims/:claimId/lines   — add line
//   PATCH  /patients/:id/insurance-claims/:claimId/lines/:lineId — patch line
//   POST   /patients/:id/insurance-claims/:claimId/events  — append event

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
  getSupabaseCallCount,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
  logAuditBestEffort: (...a: unknown[]) => logAuditMock(...a),
}));

import insuranceClaimsRouter from "./insurance-claims";

// ── Test IDs ─────────────────────────────────────────────────────────
const ADMIN_EMAIL = "billing@penn.example.com";
const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const CLAIM_ID = "22222222-2222-4222-8222-222222222222";
const LINE_ID = "33333333-3333-4333-8333-333333333333";
const EVENT_ID = "44444444-4444-4444-8444-444444444444";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", insuranceClaimsRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  mockAdmin.current = {
    userId: "admin_user_1",
    email: ADMIN_EMAIL,
    role: "admin",
  };
}

function makeClaimRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CLAIM_ID,
    patient_id: PATIENT_ID,
    insurance_coverage_id: null,
    payer_name: "Medicare Part B",
    claim_number: null,
    date_of_service: "2026-01-15",
    fulfillment_id: null,
    status: "draft",
    total_billed_cents: 0,
    total_allowed_cents: 0,
    total_paid_cents: 0,
    patient_responsibility_cents: 0,
    submitted_at: null,
    decision_at: null,
    paid_at: null,
    denial_reason: null,
    notes: null,
    created_at: "2026-01-15T10:00:00Z",
    updated_at: "2026-01-15T10:00:00Z",
    ...overrides,
  };
}

function makeLineRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: LINE_ID,
    claim_id: CLAIM_ID,
    hcpcs_code: "E0601",
    modifier: null,
    description: "CPAP device",
    quantity: 1,
    billed_cents: 50000,
    allowed_cents: 0,
    paid_cents: 0,
    status: "pending",
    denial_reason: null,
    created_at: "2026-01-15T10:00:00Z",
    updated_at: "2026-01-15T10:00:00Z",
    ...overrides,
  };
}

function makeEventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EVENT_ID,
    claim_id: CLAIM_ID,
    event_type: "note",
    amount_cents: null,
    payer_ref: null,
    document_id: null,
    note: "EOB received",
    actor_email: ADMIN_EMAIL,
    occurred_at: "2026-01-16T09:00:00Z",
    ...overrides,
  };
}

describe("GET /patients/:id/insurance-claims", () => {
  beforeEach(() => {
    mockAdmin.current = null;
    supabaseMock.reset();
    logAuditMock.mockReset().mockResolvedValue(undefined);
  });

  it("returns 401 without a session", async () => {
    const res = await request(makeApp()).get(
      `/resupply-api/patients/${PATIENT_ID}/insurance-claims`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 for a non-uuid patient id", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp()).get(
      "/resupply-api/patients/not-a-uuid/insurance-claims",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns empty array when no claims exist", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
    const res = await request(makeApp()).get(
      `/resupply-api/patients/${PATIENT_ID}/insurance-claims`,
    );
    expect(res.status).toBe(200);
    expect(res.body.insuranceClaims).toEqual([]);
  });

  it("maps snake_case DB columns to camelCase API response", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: [makeClaimRow({ payer_name: "Aetna", status: "submitted" })],
    });
    const res = await request(makeApp()).get(
      `/resupply-api/patients/${PATIENT_ID}/insurance-claims`,
    );
    expect(res.status).toBe(200);
    const claim = res.body.insuranceClaims[0];
    expect(claim.payerName).toBe("Aetna");
    expect(claim.status).toBe("submitted");
    expect(claim).not.toHaveProperty("payer_name");
    expect(claim).not.toHaveProperty("date_of_service");
  });

  it("returns multiple claims", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        makeClaimRow({ id: CLAIM_ID }),
        makeClaimRow({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      ],
    });
    const res = await request(makeApp()).get(
      `/resupply-api/patients/${PATIENT_ID}/insurance-claims`,
    );
    expect(res.status).toBe(200);
    expect(res.body.insuranceClaims).toHaveLength(2);
  });
});

// ── GET detail ───────────────────────────────────────────────────────
describe("GET /patients/:id/insurance-claims/:claimId", () => {
  beforeEach(() => {
    mockAdmin.current = null;
    supabaseMock.reset();
    logAuditMock.mockReset().mockResolvedValue(undefined);
  });

  it("returns 401 without a session", async () => {
    const res = await request(makeApp()).get(
      `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when claimId is not a UUID", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp()).get(
      `/resupply-api/patients/${PATIENT_ID}/insurance-claims/not-a-uuid`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when claim is not found in DB", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    const res = await request(makeApp()).get(
      `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns claim with line items and events on success", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: makeClaimRow(),
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [makeLineRow()],
    });
    stageSupabaseResponse("insurance_claim_events", "select", {
      data: [makeEventRow()],
    });

    const res = await request(makeApp()).get(
      `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.claim.id).toBe(CLAIM_ID);
    expect(res.body.lineItems).toHaveLength(1);
    expect(res.body.lineItems[0].hcpcsCode).toBe("E0601");
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].eventType).toBe("note");
    expect(res.body.events[0].actorEmail).toBe(ADMIN_EMAIL);
  });

  it("returns empty lineItems and events when none exist", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: makeClaimRow(),
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [],
    });
    stageSupabaseResponse("insurance_claim_events", "select", {
      data: [],
    });

    const res = await request(makeApp()).get(
      `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.lineItems).toEqual([]);
    expect(res.body.events).toEqual([]);
  });
});

// ── POST create ───────────────────────────────────────────────────────
describe("POST /patients/:id/insurance-claims", () => {
  beforeEach(() => {
    mockAdmin.current = null;
    supabaseMock.reset();
    logAuditMock.mockReset().mockResolvedValue(undefined);
  });

  it("returns 401 without a session", async () => {
    const res = await request(makeApp())
      .post(`/resupply-api/patients/${PATIENT_ID}/insurance-claims`)
      .send({ payerName: "Aetna", dateOfService: "2026-01-15" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-uuid patient id", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post("/resupply-api/patients/not-a-uuid/insurance-claims")
      .send({ payerName: "Aetna", dateOfService: "2026-01-15" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when payerName is missing", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post(`/resupply-api/patients/${PATIENT_ID}/insurance-claims`)
      .send({ dateOfService: "2026-01-15" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when dateOfService is not YYYY-MM-DD", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post(`/resupply-api/patients/${PATIENT_ID}/insurance-claims`)
      .send({ payerName: "Aetna", dateOfService: "01/15/2026" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for extra unknown fields (strict schema)", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("insurance_claims", "insert", {
      data: { id: CLAIM_ID },
    });
    const res = await request(makeApp())
      .post(`/resupply-api/patients/${PATIENT_ID}/insurance-claims`)
      .send({
        payerName: "Aetna",
        dateOfService: "2026-01-15",
        unknownField: "oops",
      });
    expect(res.status).toBe(400);
  });

  it("returns 404 when patient does not exist in DB", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("patients", "select", { data: null });
    const res = await request(makeApp())
      .post(`/resupply-api/patients/${PATIENT_ID}/insurance-claims`)
      .send({ payerName: "Aetna", dateOfService: "2026-01-15" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 201 with new claim id on success", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("insurance_claims", "insert", {
      data: { id: CLAIM_ID },
    });
    const res = await request(makeApp())
      .post(`/resupply-api/patients/${PATIENT_ID}/insurance-claims`)
      .send({ payerName: "Aetna", dateOfService: "2026-01-15" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(CLAIM_ID);
  });

  it("inserts with status: draft", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("insurance_claims", "insert", {
      data: { id: CLAIM_ID },
    });
    await request(makeApp())
      .post(`/resupply-api/patients/${PATIENT_ID}/insurance-claims`)
      .send({ payerName: "Aetna", dateOfService: "2026-01-15" });

    const payloads = getSupabaseWritePayloads("insurance_claims", "insert");
    expect(payloads).toHaveLength(1);
    expect((payloads[0] as Record<string, unknown>).status).toBe("draft");
  });

  it("includes optional claimNumber and notes in insert payload", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("insurance_claims", "insert", {
      data: { id: CLAIM_ID },
    });
    await request(makeApp())
      .post(`/resupply-api/patients/${PATIENT_ID}/insurance-claims`)
      .send({
        payerName: "Aetna",
        dateOfService: "2026-01-15",
        claimNumber: "CLM-001",
        notes: "First dispense",
      });

    const payloads = getSupabaseWritePayloads("insurance_claims", "insert");
    const p = payloads[0] as Record<string, unknown>;
    expect(p.claim_number).toBe("CLM-001");
    expect(p.notes).toBe("First dispense");
  });

  it("writes an audit row on success", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("insurance_claims", "insert", {
      data: { id: CLAIM_ID },
    });
    await request(makeApp())
      .post(`/resupply-api/patients/${PATIENT_ID}/insurance-claims`)
      .send({ payerName: "Aetna", dateOfService: "2026-01-15" });

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "insurance_claim.create",
        targetTable: "insurance_claims",
        targetId: CLAIM_ID,
        adminEmail: ADMIN_EMAIL,
      }),
    );
  });
});

// ── PATCH claim ───────────────────────────────────────────────────────
describe("PATCH /patients/:id/insurance-claims/:claimId", () => {
  beforeEach(() => {
    mockAdmin.current = null;
    supabaseMock.reset();
    logAuditMock.mockReset().mockResolvedValue(undefined);
  });

  it("returns 401 without a session", async () => {
    const res = await request(makeApp())
      .patch(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
      )
      .send({ status: "submitted" });
    expect(res.status).toBe(401);
  });

  it("returns 404 when claim not found", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    const res = await request(makeApp())
      .patch(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
      )
      .send({ status: "submitted" });
    expect(res.status).toBe(404);
  });

  it("returns 409 on invalid status transition (draft → paid)", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "draft" },
    });
    const res = await request(makeApp())
      .patch(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
      )
      .send({ status: "paid" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invalid_transition");
    expect(res.body.from).toBe("draft");
    expect(res.body.to).toBe("paid");
  });

  it("returns 200 on valid status transition (draft → submitted)", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "draft" },
    });
    // The PATCH uses an optimistic-concurrency guard
    // (`.eq("status", current.status).select("id")`) and 409s when the
    // UPDATE matches zero rows, so the mock must return the updated row.
    stageSupabaseResponse("insurance_claims", "update", {
      data: [{ id: CLAIM_ID }],
      error: null,
    });
    stageSupabaseResponse("insurance_claim_events", "insert", { error: null });
    const res = await request(makeApp())
      .patch(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
      )
      .send({ status: "submitted" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns 200 on valid transition submitted → accepted", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "submitted" },
    });
    stageSupabaseResponse("insurance_claims", "update", {
      data: [{ id: CLAIM_ID }],
      error: null,
    });
    stageSupabaseResponse("insurance_claim_events", "insert", { error: null });
    const res = await request(makeApp())
      .patch(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
      )
      .send({ status: "accepted" });
    expect(res.status).toBe(200);
  });

  it("appends a status-change event when transition is valid", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "draft" },
    });
    stageSupabaseResponse("insurance_claims", "update", {
      data: [{ id: CLAIM_ID }],
      error: null,
    });
    stageSupabaseResponse("insurance_claim_events", "insert", { error: null });

    await request(makeApp())
      .patch(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
      )
      .send({ status: "submitted" });

    expect(getSupabaseCallCount("insurance_claim_events", "insert")).toBe(1);
    const eventPayloads = getSupabaseWritePayloads("insurance_claim_events", "insert");
    expect((eventPayloads[0] as Record<string, unknown>).event_type).toBe(
      "submitted",
    );
  });

  it("does NOT append an event when status doesn't change", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "draft" },
    });
    stageSupabaseResponse("insurance_claims", "update", { error: null });

    await request(makeApp())
      .patch(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
      )
      .send({ claimNumber: "CLM-100" });

    expect(getSupabaseCallCount("insurance_claim_events", "insert")).toBe(0);
  });

  it("returns 400 on unknown fields in the body (strict schema)", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .patch(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
      )
      .send({ unknownField: "oops" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("allows all valid state-machine transitions without 409", async () => {
    stubVerifiedAdmin();
    const transitions: Array<[string, string]> = [
      ["draft", "submitted"],
      ["submitted", "accepted"],
      ["submitted", "denied"],
      ["accepted", "paid"],
      ["accepted", "denied"],
      ["denied", "appealed"],
      ["denied", "closed"],
      ["appealed", "accepted"],
      ["appealed", "denied"],
      ["paid", "closed"],
    ];

    for (const [from, to] of transitions) {
      supabaseMock.reset();
      stageSupabaseResponse("insurance_claims", "select", {
        data: { id: CLAIM_ID, status: from },
      });
      stageSupabaseResponse("insurance_claims", "update", {
        data: [{ id: CLAIM_ID }],
        error: null,
      });
      stageSupabaseResponse("insurance_claim_events", "insert", {
        error: null,
      });

      const res = await request(makeApp())
        .patch(
          `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
        )
        .send({ status: to });
      expect(res.status).toBe(200);
    }
  });

  it("rejects backward transitions (submitted → draft)", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "submitted" },
    });
    const res = await request(makeApp())
      .patch(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
      )
      .send({ status: "draft" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invalid_transition");
  });
});

// ── POST lines ────────────────────────────────────────────────────────
describe("POST /patients/:id/insurance-claims/:claimId/lines", () => {
  beforeEach(() => {
    mockAdmin.current = null;
    supabaseMock.reset();
    logAuditMock.mockReset().mockResolvedValue(undefined);
  });

  it("returns 401 without a session", async () => {
    const res = await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines`,
      )
      .send({ hcpcsCode: "E0601", billedCents: 50000 });
    expect(res.status).toBe(401);
  });

  it("returns 404 when claim is not found", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    const res = await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines`,
      )
      .send({ hcpcsCode: "E0601", billedCents: 50000 });
    expect(res.status).toBe(404);
  });

  it("returns 400 when hcpcsCode is invalid format", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines`,
      )
      .send({ hcpcsCode: "INVALID", billedCents: 50000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when billedCents is missing", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines`,
      )
      .send({ hcpcsCode: "E0601" });
    expect(res.status).toBe(400);
  });

  it("returns 201 with line id on success", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "draft" },
    });
    stageSupabaseResponse("insurance_claim_line_items", "insert", {
      data: { id: LINE_ID },
    });
    // recomputeTotals selects lines then updates claim
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [{ billed_cents: 50000, allowed_cents: 0, paid_cents: 0 }],
    });
    stageSupabaseResponse("insurance_claims", "update", { error: null });

    const res = await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines`,
      )
      .send({ hcpcsCode: "E0601", billedCents: 50000 });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(LINE_ID);
  });

  it("uppercases the hcpcsCode in the insert payload", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "draft" },
    });
    stageSupabaseResponse("insurance_claim_line_items", "insert", {
      data: { id: LINE_ID },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [],
    });
    stageSupabaseResponse("insurance_claims", "update", { error: null });

    await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines`,
      )
      .send({ hcpcsCode: "e0601", billedCents: 50000 });

    const payloads = getSupabaseWritePayloads(
      "insurance_claim_line_items",
      "insert",
    );
    expect((payloads[0] as Record<string, unknown>).hcpcs_code).toBe("E0601");
  });

  it("recomputes totals after inserting a line", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "draft" },
    });
    stageSupabaseResponse("insurance_claim_line_items", "insert", {
      data: { id: LINE_ID },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [{ billed_cents: 50000, allowed_cents: 0, paid_cents: 0 }],
    });
    stageSupabaseResponse("insurance_claims", "update", { error: null });

    await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines`,
      )
      .send({ hcpcsCode: "E0601", billedCents: 50000 });

    // The recompute triggers an update on insurance_claims.
    expect(getSupabaseCallCount("insurance_claims", "update")).toBe(1);
    const updatePayloads = getSupabaseWritePayloads(
      "insurance_claims",
      "update",
    );
    expect(
      (updatePayloads[0] as Record<string, unknown>).total_billed_cents,
    ).toBe(50000);
  });

  it("writes an audit row on success", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "draft" },
    });
    stageSupabaseResponse("insurance_claim_line_items", "insert", {
      data: { id: LINE_ID },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [],
    });
    stageSupabaseResponse("insurance_claims", "update", { error: null });

    await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines`,
      )
      .send({ hcpcsCode: "E0601", billedCents: 50000 });

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "insurance_claim.line.create",
        targetTable: "insurance_claim_line_items",
        targetId: LINE_ID,
      }),
    );
  });
});

// ── PATCH line ────────────────────────────────────────────────────────
describe("PATCH /patients/:id/insurance-claims/:claimId/lines/:lineId", () => {
  beforeEach(() => {
    mockAdmin.current = null;
    supabaseMock.reset();
    logAuditMock.mockReset().mockResolvedValue(undefined);
  });

  it("returns 401 without a session", async () => {
    const res = await request(makeApp())
      .patch(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines/${LINE_ID}`,
      )
      .send({ status: "accepted" });
    expect(res.status).toBe(401);
  });

  it("returns 404 when line is not found", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: null,
    });
    const res = await request(makeApp())
      .patch(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines/${LINE_ID}`,
      )
      .send({ status: "accepted" });
    expect(res.status).toBe(404);
  });

  it("returns 200 on valid patch", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: { id: LINE_ID, claim_id: CLAIM_ID },
    });
    stageSupabaseResponse("insurance_claim_line_items", "update", {
      error: null,
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [],
    });
    stageSupabaseResponse("insurance_claims", "update", { error: null });

    const res = await request(makeApp())
      .patch(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines/${LINE_ID}`,
      )
      .send({ status: "paid", paidCents: 40000, allowedCents: 40000 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("recomputes totals after patching a line", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: { id: LINE_ID, claim_id: CLAIM_ID },
    });
    stageSupabaseResponse("insurance_claim_line_items", "update", {
      error: null,
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [{ billed_cents: 50000, allowed_cents: 40000, paid_cents: 40000 }],
    });
    stageSupabaseResponse("insurance_claims", "update", { error: null });

    await request(makeApp())
      .patch(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines/${LINE_ID}`,
      )
      .send({ paidCents: 40000, allowedCents: 40000 });

    const updatePayloads = getSupabaseWritePayloads(
      "insurance_claims",
      "update",
    );
    expect(
      (updatePayloads[0] as Record<string, unknown>).total_paid_cents,
    ).toBe(40000);
  });

  it("returns 404 when patching a line whose claim/patient id doesn't match", async () => {
    stubVerifiedAdmin();
    const wrongPatientId = "99999999-9999-4999-8999-999999999999";
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: null,
    });
    const res = await request(makeApp())
      .patch(
        `/resupply-api/patients/${wrongPatientId}/insurance-claims/${CLAIM_ID}/lines/${LINE_ID}`,
      )
      .send({ paidCents: 40000 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 500 when detail/select lookup returns a Supabase error", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      error: { message: "DB connection lost" },
    });
    const res = await request(makeApp())
      .patch(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines/${LINE_ID}`,
      )
      .send({ paidCents: 40000 });
    expect(res.status).toBe(500);
  });
});


// ── POST events ───────────────────────────────────────────────────────
describe("POST /patients/:id/insurance-claims/:claimId/events", () => {
  beforeEach(() => {
    mockAdmin.current = null;
    supabaseMock.reset();
    logAuditMock.mockReset().mockResolvedValue(undefined);
  });

  it("returns 401 without a session", async () => {
    const res = await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/events`,
      )
      .send({ eventType: "note", note: "EOB received" });
    expect(res.status).toBe(401);
  });

  it("returns 404 when claim is not found", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    const res = await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/events`,
      )
      .send({ eventType: "note" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when eventType is not in the allowed set", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/events`,
      )
      .send({ eventType: "unknown_event" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when eventType is missing", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/events`,
      )
      .send({ note: "just a note" });
    expect(res.status).toBe(400);
  });

  it("returns 201 with event id on success", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID },
    });
    stageSupabaseResponse("insurance_claim_events", "insert", {
      data: { id: EVENT_ID },
    });

    const res = await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/events`,
      )
      .send({ eventType: "note", note: "EOB received" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(EVENT_ID);
  });

  it("stores the actor_email from the admin session", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID },
    });
    stageSupabaseResponse("insurance_claim_events", "insert", {
      data: { id: EVENT_ID },
    });

    await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/events`,
      )
      .send({ eventType: "paid", amountCents: 40000 });

    const payloads = getSupabaseWritePayloads(
      "insurance_claim_events",
      "insert",
    );
    expect((payloads[0] as Record<string, unknown>).actor_email).toBe(
      ADMIN_EMAIL,
    );
  });

  it("stores amountCents and payerRef when provided", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID },
    });
    stageSupabaseResponse("insurance_claim_events", "insert", {
      data: { id: EVENT_ID },
    });

    await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/events`,
      )
      .send({
        eventType: "partial_pay",
        amountCents: 20000,
        payerRef: "EOB-2026-001",
      });

    const payloads = getSupabaseWritePayloads(
      "insurance_claim_events",
      "insert",
    );
    const p = payloads[0] as Record<string, unknown>;
    expect(p.amount_cents).toBe(20000);
    expect(p.payer_ref).toBe("EOB-2026-001");
  });

  it("writes an audit row on success", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID },
    });
    stageSupabaseResponse("insurance_claim_events", "insert", {
      data: { id: EVENT_ID },
    });

    await request(makeApp())
      .post(
        `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/events`,
      )
      .send({ eventType: "note", note: "Initial note" });

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "insurance_claim.event.create",
        targetTable: "insurance_claim_events",
        targetId: EVENT_ID,
      }),
    );
  });

  it("accepts all valid eventType values", async () => {
    stubVerifiedAdmin();
    const validEventTypes = [
      "submitted",
      "accepted",
      "denied",
      "partial_pay",
      "paid",
      "appealed",
      "closed",
      "note",
    ];

    for (const eventType of validEventTypes) {
      supabaseMock.reset();
      stageSupabaseResponse("insurance_claims", "select", {
        data: { id: CLAIM_ID },
      });
      stageSupabaseResponse("insurance_claim_events", "insert", {
        data: { id: EVENT_ID },
      });

      const res = await request(makeApp())
        .post(
          `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/events`,
        )
        .send({ eventType });
      expect(res.status).toBe(201);
    }
  });
});
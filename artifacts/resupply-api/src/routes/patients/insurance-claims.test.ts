// Route tests for /patients/:id/insurance-claims and sub-routes.
//
// Coverage:
//   * GET /patients/:id/insurance-claims — list, 401, 404 bad UUID
//   * POST /patients/:id/insurance-claims — create, validation, 404 no patient
//   * GET /patients/:id/insurance-claims/:claimId — detail, 404 not found
//   * PATCH /patients/:id/insurance-claims/:claimId — status transitions,
//     invalid transition → 409, field edits, audit log
//   * POST /patients/:id/insurance-claims/:claimId/lines — add HCPCS line,
//     validation, recompute totals
//   * POST /patients/:id/insurance-claims/:claimId/events — append event, 404

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
  getSupabaseWritePayloads,
  getSupabaseCallCount,
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
}));

import insuranceClaimsRouter from "./insurance-claims";

const ADMIN_EMAIL = "billing@example.com";
const PATIENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAIM_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LINE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(insuranceClaimsRouter);
  return app;
}

function stubAdmin(): void {
  mockAdmin.current = {
    userId: "uid_admin",
    email: ADMIN_EMAIL,
    role: "admin",
  };
}

const claimRow = {
  id: CLAIM_ID,
  patient_id: PATIENT_ID,
  insurance_coverage_id: null,
  payer_name: "Aetna",
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
  created_at: "2026-01-15T12:00:00Z",
  updated_at: "2026-01-15T12:00:00Z",
};

const ENV_KEYS = ["RESUPPLY_ADMIN_EMAILS", "NODE_ENV"] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  process.env.NODE_ENV = "test";
  process.env.RESUPPLY_ADMIN_EMAILS = ADMIN_EMAIL;
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

// ── LIST ─────────────────────────────────────────────────────────────────────

describe("GET /patients/:id/insurance-claims", () => {
  it("returns 401 without an admin session", async () => {
    const res = await request(makeApp()).get(
      `/patients/${PATIENT_ID}/insurance-claims`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 for a non-uuid patient id", async () => {
    stubAdmin();
    const res = await request(makeApp()).get(
      "/patients/not-a-uuid/insurance-claims",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns empty list when no claims exist", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
    const res = await request(makeApp()).get(
      `/patients/${PATIENT_ID}/insurance-claims`,
    );
    expect(res.status).toBe(200);
    expect(res.body.insuranceClaims).toEqual([]);
  });

  it("returns camelCase claims list when rows exist", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: [claimRow],
    });
    const res = await request(makeApp()).get(
      `/patients/${PATIENT_ID}/insurance-claims`,
    );
    expect(res.status).toBe(200);
    expect(res.body.insuranceClaims).toHaveLength(1);
    const claim = res.body.insuranceClaims[0] as Record<string, unknown>;
    expect(claim.id).toBe(CLAIM_ID);
    expect(claim.payerName).toBe("Aetna");
    expect(claim.dateOfService).toBe("2026-01-15");
    expect(claim.status).toBe("draft");
    // No snake_case keys in the API response
    expect(claim).not.toHaveProperty("payer_name");
    expect(claim).not.toHaveProperty("date_of_service");
  });
});

// ── CREATE ────────────────────────────────────────────────────────────────────

describe("POST /patients/:id/insurance-claims", () => {
  it("returns 401 without admin session", async () => {
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims`)
      .send({ payerName: "Aetna", dateOfService: "2026-01-15" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-uuid patient id", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/patients/not-a-uuid/insurance-claims")
      .send({ payerName: "Aetna", dateOfService: "2026-01-15" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when payerName is missing", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims`)
      .send({ dateOfService: "2026-01-15" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when dateOfService is not YYYY-MM-DD", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims`)
      .send({ payerName: "Aetna", dateOfService: "01/15/2026" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 404 when the patient doesn't exist", async () => {
    stubAdmin();
    // Patient lookup returns null
    stageSupabaseResponse("patients", "select", { data: null });
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims`)
      .send({ payerName: "Aetna", dateOfService: "2026-01-15" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("creates a draft claim and returns 201 with id", async () => {
    stubAdmin();
    stageSupabaseResponse("patients", "select", {
      data: { id: PATIENT_ID },
    });
    stageSupabaseResponse("insurance_claims", "insert", {
      data: { id: CLAIM_ID },
    });
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims`)
      .send({ payerName: "Medicare", dateOfService: "2026-02-01" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(CLAIM_ID);
  });

  it("inserts a row with status=draft and the provided payer + DOS", async () => {
    stubAdmin();
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("insurance_claims", "insert", {
      data: { id: CLAIM_ID },
    });
    await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims`)
      .send({
        payerName: "Blue Shield",
        dateOfService: "2026-03-10",
        claimNumber: "CLM-9999",
        notes: "First batch",
      });
    const inserts = getSupabaseWritePayloads("insurance_claims", "insert");
    expect(inserts).toHaveLength(1);
    const payload = inserts[0] as Record<string, unknown>;
    expect(payload.status).toBe("draft");
    expect(payload.payer_name).toBe("Blue Shield");
    expect(payload.date_of_service).toBe("2026-03-10");
    expect(payload.claim_number).toBe("CLM-9999");
  });

  it("writes an audit row after successful creation", async () => {
    stubAdmin();
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("insurance_claims", "insert", {
      data: { id: CLAIM_ID },
    });
    await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims`)
      .send({ payerName: "Humana", dateOfService: "2026-04-01" });
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

// ── DETAIL ────────────────────────────────────────────────────────────────────

describe("GET /patients/:id/insurance-claims/:claimId", () => {
  it("returns 401 without admin session", async () => {
    const res = await request(makeApp()).get(
      `/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-uuid params", async () => {
    stubAdmin();
    const res = await request(makeApp()).get(
      "/patients/not-a-uuid/insurance-claims/also-not-a-uuid",
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the claim doesn't exist", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    const res = await request(makeApp()).get(
      `/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns claim + empty lineItems + empty events", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: claimRow });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [],
    });
    stageSupabaseResponse("insurance_claim_events", "select", { data: [] });
    const res = await request(makeApp()).get(
      `/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.claim.id).toBe(CLAIM_ID);
    expect(res.body.lineItems).toEqual([]);
    expect(res.body.events).toEqual([]);
  });

  it("maps line items to camelCase", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: claimRow });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        {
          id: LINE_ID,
          claim_id: CLAIM_ID,
          hcpcs_code: "E0601",
          modifier: "RR",
          description: "CPAP rental",
          quantity: 1,
          billed_cents: 15000,
          allowed_cents: 12000,
          paid_cents: 10000,
          status: "paid",
          denial_reason: null,
          created_at: "2026-01-15T12:00:00Z",
          updated_at: "2026-01-15T12:00:00Z",
        },
      ],
    });
    stageSupabaseResponse("insurance_claim_events", "select", { data: [] });
    const res = await request(makeApp()).get(
      `/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
    );
    expect(res.status).toBe(200);
    const line = res.body.lineItems[0] as Record<string, unknown>;
    expect(line.id).toBe(LINE_ID);
    expect(line.hcpcsCode).toBe("E0601");
    expect(line.billedCents).toBe(15000);
    expect(line).not.toHaveProperty("hcpcs_code");
  });
});

// ── PATCH (status transitions) ────────────────────────────────────────────────

describe("PATCH /patients/:id/insurance-claims/:claimId", () => {
  it("returns 401 without admin session", async () => {
    const res = await request(makeApp())
      .patch(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`)
      .send({ status: "submitted" });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the claim does not exist", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    const res = await request(makeApp())
      .patch(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`)
      .send({ status: "submitted" });
    expect(res.status).toBe(404);
  });

  it("returns 400 on an invalid body field", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`)
      .send({ unknownField: "oops" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 409 on an invalid status transition (draft → paid)", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "draft" },
    });
    const res = await request(makeApp())
      .patch(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`)
      .send({ status: "paid" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invalid_transition");
    expect(res.body.from).toBe("draft");
    expect(res.body.to).toBe("paid");
  });

  it("returns 409 on invalid transition submitted → closed", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "submitted" },
    });
    const res = await request(makeApp())
      .patch(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`)
      .send({ status: "closed" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invalid_transition");
  });

  it("allows draft → submitted transition", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "draft" },
    });
    stageSupabaseResponse("insurance_claims", "update", { data: null });
    stageSupabaseResponse("insurance_claim_events", "insert", { data: null });
    const res = await request(makeApp())
      .patch(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`)
      .send({ status: "submitted" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("allows submitted → accepted transition", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "submitted" },
    });
    stageSupabaseResponse("insurance_claims", "update", { data: null });
    stageSupabaseResponse("insurance_claim_events", "insert", { data: null });
    const res = await request(makeApp())
      .patch(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`)
      .send({ status: "accepted" });
    expect(res.status).toBe(200);
  });

  it("allows denied → appealed transition", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "denied" },
    });
    stageSupabaseResponse("insurance_claims", "update", { data: null });
    stageSupabaseResponse("insurance_claim_events", "insert", { data: null });
    const res = await request(makeApp())
      .patch(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`)
      .send({ status: "appealed" });
    expect(res.status).toBe(200);
  });

  it("appends a history event row on status change", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "draft" },
    });
    stageSupabaseResponse("insurance_claims", "update", { data: null });
    stageSupabaseResponse("insurance_claim_events", "insert", { data: null });
    await request(makeApp())
      .patch(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`)
      .send({ status: "submitted" });
    expect(getSupabaseCallCount("insurance_claim_events", "insert")).toBe(1);
    const eventInserts = getSupabaseWritePayloads(
      "insurance_claim_events",
      "insert",
    );
    const evt = eventInserts[0] as Record<string, unknown>;
    expect(evt.event_type).toBe("submitted");
    expect(evt.claim_id).toBe(CLAIM_ID);
  });

  it("does NOT append a history event when only non-status fields change", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "draft" },
    });
    stageSupabaseResponse("insurance_claims", "update", { data: null });
    await request(makeApp())
      .patch(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`)
      .send({ claimNumber: "CLM-42" });
    expect(getSupabaseCallCount("insurance_claim_events", "insert")).toBe(0);
  });

  it("writes an audit row on update", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "draft" },
    });
    stageSupabaseResponse("insurance_claims", "update", { data: null });
    stageSupabaseResponse("insurance_claim_events", "insert", { data: null });
    await request(makeApp())
      .patch(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`)
      .send({ status: "submitted" });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "insurance_claim.update",
        targetTable: "insurance_claims",
        targetId: CLAIM_ID,
      }),
    );
  });
});

// ── ADD LINE ITEM ─────────────────────────────────────────────────────────────

describe("POST /patients/:id/insurance-claims/:claimId/lines", () => {
  it("returns 401 without admin session", async () => {
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines`)
      .send({ hcpcsCode: "E0601", billedCents: 15000 });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the claim does not exist", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines`)
      .send({ hcpcsCode: "E0601", billedCents: 15000 });
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid HCPCS code", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines`)
      .send({ hcpcsCode: "INVALID", billedCents: 15000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when billedCents is missing", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines`)
      .send({ hcpcsCode: "E0601" });
    expect(res.status).toBe(400);
  });

  it("creates a line item and returns 201 with id", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "draft" },
    });
    stageSupabaseResponse("insurance_claim_line_items", "insert", {
      data: { id: LINE_ID },
    });
    // recomputeTotals reads lines then updates claims
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [{ billed_cents: 15000, allowed_cents: 0, paid_cents: 0 }],
    });
    stageSupabaseResponse("insurance_claims", "update", { data: null });

    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines`)
      .send({ hcpcsCode: "E0601", billedCents: 15000 });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(LINE_ID);
  });

  it("inserts with status=pending and the HCPCS code uppercase", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "draft" },
    });
    stageSupabaseResponse("insurance_claim_line_items", "insert", {
      data: { id: LINE_ID },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [{ billed_cents: 15000, allowed_cents: 0, paid_cents: 0 }],
    });
    stageSupabaseResponse("insurance_claims", "update", { data: null });

    await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines`)
      .send({ hcpcsCode: "e0601", billedCents: 15000 }); // lowercase input

    const inserts = getSupabaseWritePayloads(
      "insurance_claim_line_items",
      "insert",
    );
    const line = inserts[0] as Record<string, unknown>;
    expect(line.status).toBe("pending");
    expect(line.hcpcs_code).toBe("E0601"); // uppercased
    expect(line.billed_cents).toBe(15000);
  });

  it("recomputes claim totals after adding a line", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "draft" },
    });
    stageSupabaseResponse("insurance_claim_line_items", "insert", {
      data: { id: LINE_ID },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        { billed_cents: 10000, allowed_cents: 8000, paid_cents: 6000 },
        { billed_cents: 5000, allowed_cents: 4000, paid_cents: 3000 },
      ],
    });
    stageSupabaseResponse("insurance_claims", "update", { data: null });

    await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines`)
      .send({ hcpcsCode: "E0601", billedCents: 5000 });

    const updates = getSupabaseWritePayloads("insurance_claims", "update");
    expect(updates).toHaveLength(1);
    const totals = updates[0] as Record<string, unknown>;
    expect(totals.total_billed_cents).toBe(15000);
    expect(totals.total_allowed_cents).toBe(12000);
    expect(totals.total_paid_cents).toBe(9000);
  });

  it("writes an audit row on line creation", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "draft" },
    });
    stageSupabaseResponse("insurance_claim_line_items", "insert", {
      data: { id: LINE_ID },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [{ billed_cents: 15000, allowed_cents: 0, paid_cents: 0 }],
    });
    stageSupabaseResponse("insurance_claims", "update", { data: null });

    await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines`)
      .send({ hcpcsCode: "E0601", billedCents: 15000 });

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "insurance_claim.line.create",
        targetTable: "insurance_claim_line_items",
        targetId: LINE_ID,
      }),
    );
  });
});

// ── PATCH LINE ITEM ───────────────────────────────────────────────────────────

describe("PATCH /patients/:id/insurance-claims/:claimId/lines/:lineId", () => {
  it("returns 401 without admin session", async () => {
    const res = await request(makeApp())
      .patch(
        `/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines/${LINE_ID}`,
      )
      .send({ status: "paid" });
    expect(res.status).toBe(401);
  });

  it("returns 404 when non-uuid params are supplied", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch("/patients/bad/insurance-claims/bad/lines/bad")
      .send({ status: "paid" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the line item does not exist", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: null,
    });
    const res = await request(makeApp())
      .patch(
        `/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines/${LINE_ID}`,
      )
      .send({ status: "paid" });
    expect(res.status).toBe(404);
  });

  it("returns 400 for an unexpected field (strict schema)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(
        `/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines/${LINE_ID}`,
      )
      .send({ unknownField: "oops" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("updates the line item and recomputes totals", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: { id: LINE_ID, claim_id: CLAIM_ID },
    });
    stageSupabaseResponse("insurance_claim_line_items", "update", {
      data: null,
    });
    // recomputeTotals: read lines then update claim
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        { billed_cents: 15000, allowed_cents: 12000, paid_cents: 10000 },
      ],
    });
    stageSupabaseResponse("insurance_claims", "update", { data: null });

    const res = await request(makeApp())
      .patch(
        `/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines/${LINE_ID}`,
      )
      .send({ status: "paid", paidCents: 10000, allowedCents: 12000 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("writes an audit row on line update", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: { id: LINE_ID, claim_id: CLAIM_ID },
    });
    stageSupabaseResponse("insurance_claim_line_items", "update", {
      data: null,
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [{ billed_cents: 15000, allowed_cents: 0, paid_cents: 0 }],
    });
    stageSupabaseResponse("insurance_claims", "update", { data: null });

    await request(makeApp())
      .patch(
        `/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines/${LINE_ID}`,
      )
      .send({ status: "denied", denialReason: "Not covered" });

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "insurance_claim.line.update",
        targetTable: "insurance_claim_line_items",
        targetId: LINE_ID,
      }),
    );
  });
});

// ── APPEND EVENT ──────────────────────────────────────────────────────────────

describe("POST /patients/:id/insurance-claims/:claimId/events", () => {
  it("returns 401 without admin session", async () => {
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/events`)
      .send({ eventType: "note", note: "Checked payer portal" });
    expect(res.status).toBe(401);
  });

  it("returns 404 when claim does not exist", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/events`)
      .send({ eventType: "note" });
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid eventType", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/events`)
      .send({ eventType: "random_invalid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("appends a 'note' event and returns 201 with id", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID },
    });
    stageSupabaseResponse("insurance_claim_events", "insert", {
      data: { id: "evt-new" },
    });
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/events`)
      .send({ eventType: "note", note: "Called Aetna" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("evt-new");
  });

  it("stores actor_email from the admin session", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID },
    });
    stageSupabaseResponse("insurance_claim_events", "insert", {
      data: { id: "evt-actor" },
    });
    await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/events`)
      .send({ eventType: "paid", amountCents: 12000 });
    const inserts = getSupabaseWritePayloads(
      "insurance_claim_events",
      "insert",
    );
    const evt = inserts[0] as Record<string, unknown>;
    expect(evt.actor_email).toBe(ADMIN_EMAIL);
    expect(evt.event_type).toBe("paid");
    expect(evt.amount_cents).toBe(12000);
  });

  it("accepts all valid event types", async () => {
    const eventTypes = [
      "submitted",
      "accepted",
      "denied",
      "partial_pay",
      "paid",
      "appealed",
      "closed",
      "note",
    ] as const;

    for (const eventType of eventTypes) {
      supabaseMock.reset();
      stageSupabaseResponse("insurance_claims", "select", {
        data: { id: CLAIM_ID },
      });
      stageSupabaseResponse("insurance_claim_events", "insert", {
        data: { id: `evt-${eventType}` },
      });
      const res = await request(makeApp())
        .post(
          `/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/events`,
        )
        .send({ eventType });
      expect(res.status).toBe(201);
    }
  });

  it("writes an audit row on event creation", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID },
    });
    stageSupabaseResponse("insurance_claim_events", "insert", {
      data: { id: "evt-audit" },
    });
    await request(makeApp())
      .post(`/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/events`)
      .send({ eventType: "note", note: "Test note" });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "insurance_claim.event.create",
        targetTable: "insurance_claim_events",
      }),
    );
  });
});
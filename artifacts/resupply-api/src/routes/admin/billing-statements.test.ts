// Tests for billing-statements route — adminRateLimit removal.
//
// Scope: only the code changed in this PR:
//   - POST /admin/patients/:id/billing-statements
//     (adminRateLimit with preset "sensitive" was REMOVED)
//
// The route still requires requireAdmin.
//
// Tests verify:
//   1. adminRateLimit is no longer wired (the spy is never invoked).
//   2. Route remains protected by requireAdmin (401).
//   3. Route functions normally without returning 429.
//   4. Validation, not-found, and conflict paths still work.

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
import { type MockBillingIdentity } from "../../test-helpers/billing-mocks";

// ── Supabase mock (module-scoped) ────────────────────────────────────────────
const supabaseMock = installSupabaseMock();

// ── Auth mock ────────────────────────────────────────────────────────────────
const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// ── adminRateLimit spy — verifies it is NOT called ───────────────────────────
const adminRateLimitSpy = vi.hoisted(() =>
  vi.fn(
    (_opts: { name: string; preset?: string }) =>
      (_req: import("express").Request, _res: import("express").Response, next: import("express").NextFunction) => {
        next();
      },
  ),
);
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: adminRateLimitSpy,
}));

// ── Audit mock ───────────────────────────────────────────────────────────────
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

// ── Billing library mocks ────────────────────────────────────────────────────
const FAKE_PDF = Buffer.from("fake-pdf-content");
const renderStatementPdfMock = vi.hoisted(() =>
  vi.fn(async () => ({
    pdf: FAKE_PDF,
    totalPatientResponsibilityCents: 5000,
  })),
);
vi.mock("../../lib/billing/statement-pdf", () => ({
  renderStatementPdf: renderStatementPdfMock,
}));

const resolveBillingIdentityMock = vi.hoisted(() =>
  vi.fn<() => Promise<MockBillingIdentity>>(async () => ({
    source: "db",
    organization: {
      legal_name: "Test DME",
      phone_e164: "+15550001234",
      billing_email: "billing@testdme.com",
    },
    billingProvider: {
      organizationName: "Test DME",
      npi: "1234567890",
      address: {
        line1: "123 Main St",
        city: "Springfield",
        state: "IL",
        zip: "62701",
      },
    },
  })),
);
vi.mock("../../lib/billing/identity-resolver", () => ({
  resolveBillingIdentity: resolveBillingIdentityMock,
}));

vi.mock("../../lib/webhooks/publisher", () => ({
  publishEvent: vi.fn(async () => undefined),
}));

import billingStatementsRouter from "./billing-statements";

const PATIENT_UUID = "bbbbbbbb-2222-4000-8000-000000000001";
const STATEMENT_UUID = "cccccccc-3333-4000-8000-000000000001";
const CLAIM_UUID = "dddddddd-4444-4000-8000-000000000001";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(billingStatementsRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@example.com",
    role: "admin",
  };
}

function makePatientRow() {
  return {
    legal_first_name: "Jane",
    legal_last_name: "Doe",
    address: {
      line1: "456 Oak Ave",
      city: "Springfield",
      state: "IL",
      zip: "62701",
    },
    email: "jane.doe@example.com",
  };
}

function makeClaimRow() {
  return {
    id: CLAIM_UUID,
    payer_name: "BlueCross",
    date_of_service: "2026-01-15",
    total_billed_cents: 10000,
    total_paid_cents: 5000,
    patient_responsibility_cents: 5000,
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  adminRateLimitSpy.mockClear();
  renderStatementPdfMock.mockClear();
  resolveBillingIdentityMock.mockClear();
});

// ── POST /admin/patients/:id/billing-statements ───────────────────────────────

describe("POST /admin/patients/:id/billing-statements — adminRateLimit removed", () => {
  it("adminRateLimit is NOT called (middleware was removed from this route)", async () => {
    await request(makeApp())
      .post(`/admin/patients/${PATIENT_UUID}/billing-statements`)
      .send({});
    expect(adminRateLimitSpy).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated (requireAdmin still gates the route)", async () => {
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_UUID}/billing-statements`)
      .send({});
    expect(res.status).toBe(401);
  });

  it("does NOT return 429 (no rate limiter is present)", async () => {
    stubAdmin();
    stageSupabaseResponse("patients", "select", { data: makePatientRow() });
    stageSupabaseResponse("insurance_claims", "select", {
      data: [makeClaimRow()],
    });
    stageSupabaseResponse("patient_billing_statements", "insert", {
      data: { id: STATEMENT_UUID },
    });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_UUID}/billing-statements`)
      .send({});
    expect(res.status).not.toBe(429);
  });

  it("returns 404 for non-UUID patient id", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/patients/not-a-uuid/billing-statements")
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 400 for invalid body (bad deliveryMethod)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_UUID}/billing-statements`)
      .send({ deliveryMethod: "carrier_pigeon" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 404 when patient does not exist", async () => {
    stubAdmin();
    stageSupabaseResponse("patients", "select", { data: null });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_UUID}/billing-statements`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("patient_not_found");
  });

  it("returns 409 when patient has no open balance claims", async () => {
    stubAdmin();
    stageSupabaseResponse("patients", "select", { data: makePatientRow() });
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_UUID}/billing-statements`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_open_balance");
  });

  it("returns 409 when no DME organization is configured", async () => {
    stubAdmin();
    stageSupabaseResponse("patients", "select", { data: makePatientRow() });
    stageSupabaseResponse("insurance_claims", "select", {
      data: [makeClaimRow()],
    });
    resolveBillingIdentityMock.mockResolvedValueOnce({
      source: "stub" as const,
      organization: null,
      billingProvider: {
        organizationName: "Stub",
        npi: "0000000000",
        address: { line1: "", city: "", state: "", zip: "" },
      },
    });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_UUID}/billing-statements`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_dme_organization");
  });

  it("generates PDF and returns 201 on success", async () => {
    stubAdmin();
    stageSupabaseResponse("patients", "select", { data: makePatientRow() });
    stageSupabaseResponse("insurance_claims", "select", {
      data: [makeClaimRow()],
    });
    stageSupabaseResponse("patient_billing_statements", "insert", {
      data: { id: STATEMENT_UUID },
    });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_UUID}/billing-statements`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["x-statement-id"]).toBe(STATEMENT_UUID);
    expect(res.headers["x-statement-total-cents"]).toBe("5000");
  });
});
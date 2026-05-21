// Tests for billing-batch-submit route — RBAC migration.
//
// Scope: code changed in this PR:
//   - POST /admin/billing/batch-submit-office-ally
//     (requireAdmin → requirePermission("admin.tools.manage"))
//
// Tests verify:
//   1. Returns 401 when unauthenticated.
//   2. Returns 403 when caller lacks admin.tools.manage permission.
//   3. Returns 400 for invalid body (empty array, array too large, non-UUID).
//   4. Returns 404 when no claims match the provided IDs.
//   5. Returns 409 when claims include non-draft status.
//   6. Returns 409 when claims span multiple payer profiles.

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

// ── Supabase mock (module-scoped) ────────────────────────────────────────────
const supabaseMock = installSupabaseMock();

// ── Auth mock ────────────────────────────────────────────────────────────────
const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// ── adminRateLimit spy ───────────────────────────────────────────────────────
const adminRateLimitSpy = vi.hoisted(() =>
  vi.fn(
    (_opts: { name: string; preset?: string }) =>
      (
        _req: import("express").Request,
        _res: import("express").Response,
        next: import("express").NextFunction,
      ) => {
        next();
      },
  ),
);
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: adminRateLimitSpy,
}));

// ── Audit and event mocks ────────────────────────────────────────────────────
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));
vi.mock("../../lib/webhooks/publisher", () => ({
  publishEvent: vi.fn(async () => undefined),
}));

// ── Office Ally integration mocks ─────────────────────────────────────────────
vi.mock("@workspace/resupply-integrations-office-ally", () => ({
  allocateControlNumbers: vi.fn(() => ({
    isaControlNumber: "000000001",
    groupControlNumber: "1",
  })),
  createOfficeAllyAdapter: vi.fn(() => ({
    buildInterchange: vi.fn(() => "ISA*mock~"),
    submitFile: vi.fn(async () => ({ submissionId: "sub_mock_001" })),
  })),
}));

// ── Billing identity mock ─────────────────────────────────────────────────────
vi.mock("../../lib/billing/identity-resolver", () => ({
  resolveBillingIdentity: vi.fn(async () => ({
    source: "db",
    organization: {
      legal_name: "Test DME",
      phone_e164: "+15550001234",
      billing_email: "billing@testdme.com",
    },
    billingProvider: {
      organizationName: "Test DME",
      npi: "1234567890",
      address: { line1: "123 Main St", city: "Springfield", state: "IL", zip: "62701" },
    },
  })),
}));

import billingBatchSubmitRouter from "./billing-batch-submit";

const CLAIM_UUID_1 = "aaaaaaaa-1111-4000-8000-000000000001";
const CLAIM_UUID_2 = "bbbbbbbb-2222-4000-8000-000000000002";
const PAYER_PROFILE_UUID = "cccccccc-3333-4000-8000-000000000001";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(billingBatchSubmitRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@example.com",
    role: "admin",
  };
}

function stubAgent() {
  mockAdmin.current = {
    userId: "u_agent_1",
    email: "agent@example.com",
    role: "agent",
  };
}

function makeDraftClaim(id: string, payerProfileId = PAYER_PROFILE_UUID) {
  return {
    id,
    status: "draft",
    payer_profile_id: payerProfileId,
    payer_name: "Test Payer",
    insurance_coverage_id: "cov-001",
    patient_id: "pat-001",
    total_billed_cents: 10000,
    date_of_service: "2026-01-15",
    latest_scrub_verdict: null,
    latest_denial_analysis_id: null,
    submitted_at: null,
    office_ally_submission_id: null,
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  adminRateLimitSpy.mockClear();
});

// ── Auth gate tests ──────────────────────────────────────────────────────────

describe("POST /admin/billing/batch-submit-office-ally — requirePermission(admin.tools.manage)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .post("/admin/billing/batch-submit-office-ally")
      .send({ claimIds: [CLAIM_UUID_1] });
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent lacks admin.tools.manage permission", async () => {
    stubAgent();
    const res = await request(makeApp())
      .post("/admin/billing/batch-submit-office-ally")
      .send({ claimIds: [CLAIM_UUID_1] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("permission_denied");
  });
});

// ── Body validation tests ────────────────────────────────────────────────────

describe("POST /admin/billing/batch-submit-office-ally — body validation", () => {
  it("returns 400 when claimIds is missing", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/billing/batch-submit-office-ally")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when claimIds is an empty array (min 1)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/billing/batch-submit-office-ally")
      .send({ claimIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when claimIds contains non-UUID strings", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/billing/batch-submit-office-ally")
      .send({ claimIds: ["not-a-uuid"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when claimIds contains more than 100 entries (max 100)", async () => {
    stubAdmin();
    const tooMany = Array.from({ length: 101 }, (_, i) => {
      const hex = i.toString(16).padStart(8, "0");
      return `${hex}-1111-4000-8000-000000000001`;
    });
    const res = await request(makeApp())
      .post("/admin/billing/batch-submit-office-ally")
      .send({ claimIds: tooMany });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for unknown extra field in body (strict schema)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/billing/batch-submit-office-ally")
      .send({ claimIds: [CLAIM_UUID_1], extraField: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for invalid usageIndicator value", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/billing/batch-submit-office-ally")
      .send({ claimIds: [CLAIM_UUID_1], usageIndicator: "X" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("accepts usageIndicator=P (valid)", async () => {
    stubAdmin();
    // Stage empty claims response to hit the 404 path (not a 400)
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    const res = await request(makeApp())
      .post("/admin/billing/batch-submit-office-ally")
      .send({ claimIds: [CLAIM_UUID_1], usageIndicator: "P" });
    // Passes validation — hits the 404 "no_claims_matched" path instead
    expect(res.status).not.toBe(400);
  });

  it("accepts usageIndicator=T (valid)", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    const res = await request(makeApp())
      .post("/admin/billing/batch-submit-office-ally")
      .send({ claimIds: [CLAIM_UUID_1], usageIndicator: "T" });
    expect(res.status).not.toBe(400);
  });
});

// ── Business logic precondition tests ────────────────────────────────────────

describe("POST /admin/billing/batch-submit-office-ally — precondition checks", () => {
  it("returns 404 when no claims match the provided IDs", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    const res = await request(makeApp())
      .post("/admin/billing/batch-submit-office-ally")
      .send({ claimIds: [CLAIM_UUID_1] });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_claims_matched");
  });

  it("returns 404 when Supabase returns empty array", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
    const res = await request(makeApp())
      .post("/admin/billing/batch-submit-office-ally")
      .send({ claimIds: [CLAIM_UUID_1] });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_claims_matched");
  });

  it("returns 409 when some claim IDs are not found", async () => {
    stubAdmin();
    // Only one claim returned for two requested IDs
    stageSupabaseResponse("insurance_claims", "select", {
      data: [makeDraftClaim(CLAIM_UUID_1)],
    });
    const res = await request(makeApp())
      .post("/admin/billing/batch-submit-office-ally")
      .send({ claimIds: [CLAIM_UUID_1, CLAIM_UUID_2] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("some_claims_not_found");
    expect(res.body.missing).toContain(CLAIM_UUID_2);
  });

  it("returns 409 when claims span multiple payer_profile_ids", async () => {
    stubAdmin();
    const OTHER_PAYER_UUID = "dddddddd-4444-4000-8000-000000000001";
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        makeDraftClaim(CLAIM_UUID_1, PAYER_PROFILE_UUID),
        makeDraftClaim(CLAIM_UUID_2, OTHER_PAYER_UUID),
      ],
    });
    const res = await request(makeApp())
      .post("/admin/billing/batch-submit-office-ally")
      .send({ claimIds: [CLAIM_UUID_1, CLAIM_UUID_2] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("batch_payer_mismatch");
  });

  it("returns 409 when claims include non-draft status", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        { ...makeDraftClaim(CLAIM_UUID_1), status: "submitted" },
      ],
    });
    const res = await request(makeApp())
      .post("/admin/billing/batch-submit-office-ally")
      .send({ claimIds: [CLAIM_UUID_1] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("non_draft_claims_in_batch");
    expect(res.body.claimIds).toContain(CLAIM_UUID_1);
  });

  it("returns 409 when batch has no payer_profile_id set on claims", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        { ...makeDraftClaim(CLAIM_UUID_1), payer_profile_id: null },
      ],
    });
    const res = await request(makeApp())
      .post("/admin/billing/batch-submit-office-ally")
      .send({ claimIds: [CLAIM_UUID_1] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("batch_payer_mismatch");
  });
});
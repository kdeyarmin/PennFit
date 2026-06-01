// Tests for Biller #28 secondary/COB — the pure COB derivation + eligible
// filter, plus the two routes' gates and wiring.

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

import secondaryClaimsRouter, {
  deriveSecondaryCob,
  filterSecondaryEligible,
  type EligibleCandidate,
  type PrimaryClaimTotals,
} from "./secondary-claims";

// admin holds reports.read + admin.tools.manage.
const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "biller@penn.example.com",
  role: "admin",
};
// csr holds reports.read but NOT admin.tools.manage.
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};

const PRIMARY_ID = "11111111-1111-4111-8111-111111111111";
const SEC_COV = "22222222-2222-4222-8222-222222222222";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(secondaryClaimsRouter);
  return app;
}

function primary(over: Partial<PrimaryClaimTotals>): PrimaryClaimTotals {
  return {
    status: "paid",
    payer_sequence: "primary",
    total_billed_cents: 20000,
    total_allowed_cents: 15000,
    total_paid_cents: 12000,
    patient_responsibility_cents: 3000,
    secondary_coverage_id: SEC_COV,
    ...over,
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("deriveSecondaryCob (pure)", () => {
  it("derives CO / PR / paid for a paid primary with a balance", () => {
    const d = deriveSecondaryCob(primary({}));
    expect(d.eligible).toBe(true);
    if (d.eligible) {
      expect(d.cob).toEqual({
        primaryPaidCents: 12000,
        contractualCents: 5000, // billed 20000 - allowed 15000
        patientRespCents: 3000,
        billableToSecondaryCents: 3000,
      });
    }
  });

  it("rejects a claim that isn't a primary", () => {
    const d = deriveSecondaryCob(primary({ payer_sequence: "secondary" }));
    expect(d).toEqual({ eligible: false, reason: "not_primary" });
  });

  it("rejects when there's no secondary coverage", () => {
    const d = deriveSecondaryCob(primary({ secondary_coverage_id: null }));
    expect(d).toEqual({ eligible: false, reason: "no_secondary_coverage" });
  });

  it("rejects when the primary isn't paid yet", () => {
    const d = deriveSecondaryCob(primary({ status: "submitted" }));
    expect(d).toEqual({ eligible: false, reason: "primary_not_paid" });
  });

  it("rejects when the primary left no patient balance", () => {
    const d = deriveSecondaryCob(primary({ patient_responsibility_cents: 0 }));
    expect(d).toEqual({ eligible: false, reason: "no_balance" });
  });
});

describe("filterSecondaryEligible (pure)", () => {
  it("drops primaries that already have a secondary, sorts by balance desc", () => {
    const cands: EligibleCandidate[] = [
      {
        id: "a",
        patient_id: "p1",
        payer_name: "Aetna",
        total_billed_cents: 10000,
        total_allowed_cents: 8000,
        total_paid_cents: 6000,
        patient_responsibility_cents: 2000,
        status: "paid",
        payer_sequence: "primary",
        secondary_coverage_id: "cov_a",
      },
      {
        id: "b",
        patient_id: "p2",
        payer_name: "BCBS",
        total_billed_cents: 30000,
        total_allowed_cents: 25000,
        total_paid_cents: 20000,
        patient_responsibility_cents: 5000,
        status: "paid",
        payer_sequence: "primary",
        secondary_coverage_id: "cov_b",
      },
      {
        id: "has_secondary",
        patient_id: "p3",
        payer_name: "Cigna",
        total_billed_cents: 10000,
        total_allowed_cents: 9000,
        total_paid_cents: 8000,
        patient_responsibility_cents: 1000,
        status: "paid",
        payer_sequence: "primary",
        secondary_coverage_id: "cov_c",
      },
    ];
    const items = filterSecondaryEligible(cands, new Set(["has_secondary"]));
    expect(items.map((i) => i.claimId)).toEqual(["b", "a"]); // 5000 > 2000
  });
});

describe("GET /admin/billing/secondary-eligible", () => {
  it("401s without admin", async () => {
    expect(
      (await request(makeApp()).get("/admin/billing/secondary-eligible"))
        .status,
    ).toBe(401);
  });

  it("returns the worklist minus already-generated secondaries", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        {
          id: PRIMARY_ID,
          patient_id: "p1",
          payer_name: "Aetna",
          status: "paid",
          payer_sequence: "primary",
          secondary_coverage_id: SEC_COV,
          total_billed_cents: 20000,
          total_allowed_cents: 15000,
          total_paid_cents: 12000,
          patient_responsibility_cents: 3000,
          date_of_service: "2026-05-01",
          fulfillment_id: null,
        },
      ],
    });
    const res = await request(makeApp()).get(
      "/admin/billing/secondary-eligible",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.eligible[0].claimId).toBe(PRIMARY_ID);
    expect(res.body.eligible[0].patientResponsibilityCents).toBe(3000);
  });
});

describe("POST /admin/claims/:id/generate-secondary", () => {
  it("403s for a role without admin.tools.manage (csr)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).post(
      `/admin/claims/${PRIMARY_ID}/generate-secondary`,
    );
    expect(res.status).toBe(403);
  });

  it("409s when the primary isn't eligible (not paid)", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("insurance_claims", "select", {
      data: {
        id: PRIMARY_ID,
        patient_id: "p1",
        payer_name: "Aetna",
        status: "submitted",
        payer_sequence: "primary",
        secondary_coverage_id: SEC_COV,
        total_billed_cents: 20000,
        total_allowed_cents: 0,
        total_paid_cents: 0,
        patient_responsibility_cents: 0,
        date_of_service: "2026-05-01",
        fulfillment_id: null,
      },
    });
    const res = await request(makeApp()).post(
      `/admin/claims/${PRIMARY_ID}/generate-secondary`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("primary_not_paid");
  });

  it("generates a secondary claim and copies the line items", async () => {
    mockAdmin.current = ADMIN;
    // 1. primary lookup (maybeSingle)
    stageSupabaseResponse("insurance_claims", "select", {
      data: {
        id: PRIMARY_ID,
        patient_id: "p1",
        payer_name: "Aetna",
        status: "paid",
        payer_sequence: "primary",
        secondary_coverage_id: SEC_COV,
        total_billed_cents: 20000,
        total_allowed_cents: 15000,
        total_paid_cents: 12000,
        patient_responsibility_cents: 3000,
        date_of_service: "2026-05-01",
        fulfillment_id: null,
      },
    });
    // 2. dup check (maybeSingle) → null; 3. coverage (maybeSingle); these
    // also key off ("insurance_claims","select") / ("insurance_coverages",
    // "select") — the mock returns the staged response for each table+op.
    stageSupabaseResponse("insurance_coverages", "select", {
      data: { payer_name: "Medicaid Secondary" },
    });
    // 3b. resolve the SECONDARY payer's profile by name (the COB claim
    // must carry the secondary payer's payer_profile_id to be submittable).
    stageSupabaseResponse("payer_profiles", "select", {
      data: { id: "pp_secondary" },
    });
    // 4. insert secondary header (insert→select id)
    stageSupabaseResponse("insurance_claims", "insert", {
      data: { id: "secondary_1" },
    });
    // 5. read primary line items (select on line items table)
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        {
          hcpcs_code: "E0601",
          modifier: "RR",
          description: "CPAP device",
          quantity: 1,
          billed_cents: 20000,
        },
      ],
    });
    // 6. insert copied lines
    stageSupabaseResponse("insurance_claim_line_items", "insert", {
      data: [{ id: "line_copy_1" }],
    });

    const res = await request(makeApp()).post(
      `/admin/claims/${PRIMARY_ID}/generate-secondary`,
    );
    expect(res.status).toBe(201);
    expect(res.body.secondaryClaimId).toBe("secondary_1");
    expect(res.body.cob.patientRespCents).toBe(3000);
    expect(res.body.lineCount).toBe(1);

    // The secondary claim must carry the SECONDARY payer's profile (not
    // the primary's) so executeOfficeAllyBatchSubmit can serialize it.
    const inserted = getSupabaseWritePayloads(
      "insurance_claims",
      "insert",
    )[0] as Record<string, unknown>;
    expect(inserted.payer_profile_id).toBe("pp_secondary");
    expect(inserted.payer_sequence).toBe("secondary");
  });
});

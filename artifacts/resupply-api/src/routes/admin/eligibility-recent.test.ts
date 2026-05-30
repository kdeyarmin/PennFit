// Route tests for /admin/billing/eligibility-recent.
//
// Coverage:
//   * 401 when unauthenticated
//   * happy path returns the row list with payer-profile names
//     resolved + count rollups
//   * `requested_by_email` is NOT exposed (system-wide aggregate;
//     identifier exposure was deliberately stripped — see commit
//     44bbb2b)
//   * invalid `days` is rejected with 400 + the zod issues
//   * status filter routes through to the correct eq() call
//   * payer_profiles lookup error is surfaced (no silent partial)

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
  getSupabaseFilterCalls,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import eligibilityRecentRouter from "./eligibility-recent";

const ALLOWED_EMAIL = "ops@penn.example.com";
const PATIENT_A = "11111111-aaaa-4111-8111-aaaaaaaaaaaa";
const PATIENT_B = "22222222-aaaa-4222-8222-aaaaaaaaaaaa";
const COVERAGE_A = "33333333-aaaa-4333-8333-aaaaaaaaaaaa";
const PAYER_PROFILE_A = "44444444-aaaa-4444-8444-aaaaaaaaaaaa";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", eligibilityRecentRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  mockAdmin.current = {
    userId: "user_op",
    email: ALLOWED_EMAIL,
    role: "admin",
  };
}

describe("/admin/billing/eligibility-recent", () => {
  beforeEach(() => {
    supabaseMock.reset();
    mockAdmin.current = null;
  });

  it("401s when no admin session", async () => {
    const res = await request(makeApp()).get(
      "/resupply-api/admin/billing/eligibility-recent",
    );
    expect(res.status).toBe(401);
  });

  it("returns shaped rows + count summary on the happy path", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("eligibility_checks", "select", {
      data: [
        {
          id: "c1",
          patient_id: PATIENT_A,
          insurance_coverage_id: COVERAGE_A,
          payer_profile_id: PAYER_PROFILE_A,
          service_hcpcs: "E0601",
          status: "parsed",
          is_active: true,
          in_network: true,
          deductible_cents: 50000,
          deductible_met_cents: 10000,
          oop_max_cents: 200000,
          oop_met_cents: 25000,
          copay_cents: 0,
          coinsurance_pct: 20,
          requires_prior_auth: false,
          error_message: null,
          requested_at: "2026-05-15T10:00:00.000Z",
          responded_at: "2026-05-15T10:00:02.500Z",
        },
        {
          id: "c2",
          patient_id: PATIENT_B,
          insurance_coverage_id: COVERAGE_A,
          payer_profile_id: PAYER_PROFILE_A,
          service_hcpcs: null,
          status: "rejected",
          is_active: false,
          in_network: null,
          deductible_cents: null,
          deductible_met_cents: null,
          oop_max_cents: null,
          oop_met_cents: null,
          copay_cents: null,
          coinsurance_pct: null,
          requires_prior_auth: true,
          error_message: "AAA*Y*72: invalid/missing patient name",
          requested_at: "2026-05-14T10:00:00.000Z",
          responded_at: null,
        },
      ],
    });
    stageSupabaseResponse("payer_profiles", "select", {
      data: [{ id: PAYER_PROFILE_A, display_name: "UPMC for You" }],
    });

    const res = await request(makeApp())
      .get("/resupply-api/admin/billing/eligibility-recent")
      .set("Accept", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.checks).toHaveLength(2);
    expect(res.body.checks[0]).toMatchObject({
      id: "c1",
      patientId: PATIENT_A,
      payerProfileId: PAYER_PROFILE_A,
      payerName: "UPMC for You",
      status: "parsed",
      isActive: true,
    });
    expect(res.body.counts).toEqual({
      total: 2,
      byStatus: {
        queued: 0,
        submitted: 0,
        parsed: 1,
        rejected: 1,
        transport_failed: 0,
      },
      activeCoverage: 1,
      inactiveCoverage: 1,
      priorAuthFlagged: 1,
    });
    expect(res.body.windowDays).toBe(30);
  });

  it("never exposes requested_by_email on the system-wide aggregate", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("eligibility_checks", "select", {
      data: [
        {
          id: "c1",
          patient_id: PATIENT_A,
          insurance_coverage_id: COVERAGE_A,
          payer_profile_id: null,
          service_hcpcs: "E0601",
          status: "parsed",
          is_active: true,
          in_network: true,
          deductible_cents: null,
          deductible_met_cents: null,
          oop_max_cents: null,
          oop_met_cents: null,
          copay_cents: null,
          coinsurance_pct: null,
          requires_prior_auth: null,
          error_message: null,
          requested_at: "2026-05-15T10:00:00.000Z",
          responded_at: null,
          // Even if the DB row had it, the response shouldn't surface it.
          requested_by_email: "alice@penn.example.com",
        },
      ],
    });

    const res = await request(makeApp()).get(
      "/resupply-api/admin/billing/eligibility-recent",
    );

    expect(res.status).toBe(200);
    expect(res.body.checks[0]).not.toHaveProperty("requestedByEmail");
    expect(res.body.checks[0]).not.toHaveProperty("requested_by_email");
  });

  it("400s with field-level issues when `days` is out of range", async () => {
    stubVerifiedAdmin();

    const res = await request(makeApp()).get(
      "/resupply-api/admin/billing/eligibility-recent?days=999",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.issues[0].path).toContain("days");
  });

  it("applies the status filter via eq()", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("eligibility_checks", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/resupply-api/admin/billing/eligibility-recent?status=rejected",
    );

    expect(res.status).toBe(200);
    const calls = getSupabaseFilterCalls("eligibility_checks", "select");
    const eqCalls = calls.filter((c) => c.verb === "eq");
    expect(
      eqCalls.some((c) => c.args[0] === "status" && c.args[1] === "rejected"),
    ).toBe(true);
  });

  it("propagates a payer_profiles lookup error rather than returning partial data", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("eligibility_checks", "select", {
      data: [
        {
          id: "c1",
          patient_id: PATIENT_A,
          insurance_coverage_id: COVERAGE_A,
          payer_profile_id: PAYER_PROFILE_A,
          service_hcpcs: "E0601",
          status: "parsed",
          is_active: true,
          in_network: true,
          deductible_cents: null,
          deductible_met_cents: null,
          oop_max_cents: null,
          oop_met_cents: null,
          copay_cents: null,
          coinsurance_pct: null,
          requires_prior_auth: null,
          error_message: null,
          requested_at: "2026-05-15T10:00:00.000Z",
          responded_at: null,
        },
      ],
    });
    stageSupabaseResponse("payer_profiles", "select", {
      error: { message: "boom" },
    });

    const res = await request(makeApp()).get(
      "/resupply-api/admin/billing/eligibility-recent",
    );

    // The handler throws; Express converts to a 500 via the default
    // error handler. The point is it does NOT silently swallow and
    // return rows with payerName "—".
    expect(res.status).toBe(500);
  });
});

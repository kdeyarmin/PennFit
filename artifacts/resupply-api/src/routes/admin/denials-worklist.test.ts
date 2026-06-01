// Tests for /admin/billing/denials-worklist (Biller #33) — the pure
// ranking core + the HTTP route.

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

import denialsWorklistRouter, {
  rankDenialWorklist,
  type DenialClaimInput,
} from "./denials-worklist";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "biller@penn.example.com",
  role: "admin",
};
// rt (clinician bucket) lacks reports.read → 403.
const RT: MockAdminCtx = {
  userId: "u_rt",
  email: "rt@penn.example.com",
  role: "agent",
  granularRole: "rt",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(denialsWorklistRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("rankDenialWorklist (pure)", () => {
  it("ranks by recoverable × win-probability and rolls up totals", () => {
    const claims: DenialClaimInput[] = [
      // recoverable 10000 × 0.9 = 9000
      {
        claimId: "hi",
        patientId: "p",
        payerName: "Aetna",
        recoverableCents: 10000,
        confidence: 0.9,
        recommendation: "auto_resubmit",
        canAutoResubmit: true,
        denialReason: "CO-16",
        decisionAt: null,
      },
      // bigger dollars but unanalyzed: 20000 × 0.3 = 6000
      {
        claimId: "big",
        patientId: "p",
        payerName: "UHC",
        recoverableCents: 20000,
        confidence: null,
        recommendation: null,
        canAutoResubmit: false,
        denialReason: "CO-97",
        decisionAt: null,
      },
    ];
    const { items, totals } = rankDenialWorklist(claims);

    // High-confidence claim outranks the bigger-but-unknown one.
    expect(items.map((i) => i.claimId)).toEqual(["hi", "big"]);
    expect(items[0]!.scoreCents).toBe(9000);
    expect(items[1]!.scoreCents).toBe(6000);
    expect(items[1]!.winProbability).toBeCloseTo(0.3, 5);
    expect(items[1]!.hasAnalysis).toBe(false);

    expect(totals.count).toBe(2);
    expect(totals.recoverableCents).toBe(30000);
    expect(totals.expectedRecoverableCents).toBe(15000);
    expect(totals.autoResubmittable).toBe(1);
    expect(totals.unanalyzed).toBe(1);
  });

  it("floors negative recoverable at 0 and clamps confidence", () => {
    const { items } = rankDenialWorklist([
      {
        claimId: "x",
        patientId: "p",
        payerName: null,
        recoverableCents: -500, // overpaid / credit
        confidence: 1.5, // out of range
        recommendation: "appeal",
        canAutoResubmit: false,
        denialReason: null,
        decisionAt: null,
      },
    ]);
    expect(items[0]!.recoverableCents).toBe(0);
    expect(items[0]!.winProbability).toBe(1);
    expect(items[0]!.scoreCents).toBe(0);
  });
});

describe("GET /admin/billing/denials-worklist", () => {
  it("401s without admin", async () => {
    expect(
      (await request(makeApp()).get("/admin/billing/denials-worklist")).status,
    ).toBe(401);
  });

  it("403s for a role without reports.read (rt)", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp()).get("/admin/billing/denials-worklist");
    expect(res.status).toBe(403);
    expect(res.body.requiredPermission).toBe("reports.read");
  });

  it("joins the latest analysis, excludes resolved denials, ranks the rest", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        {
          id: "c_open",
          patient_id: "p1",
          payer_name: "Aetna",
          total_billed_cents: 10000,
          total_paid_cents: 0,
          denial_reason: "CO-16",
          decision_at: "2026-05-20T00:00:00Z",
        },
        {
          id: "c_resolved",
          patient_id: "p2",
          payer_name: "UHC",
          total_billed_cents: 50000,
          total_paid_cents: 0,
          denial_reason: "CO-97",
          decision_at: "2026-05-19T00:00:00Z",
        },
      ],
    });
    stageSupabaseResponse("claim_denial_analyses", "select", {
      data: [
        {
          claim_id: "c_open",
          confidence: 0.8,
          recommendation: "auto_resubmit",
          can_auto_resubmit: true,
          review_status: "pending",
          created_at: "2026-05-21T00:00:00Z",
        },
        {
          claim_id: "c_resolved",
          confidence: 0.9,
          recommendation: "appeal",
          can_auto_resubmit: false,
          review_status: "accepted_appealed", // resolved → excluded
          created_at: "2026-05-21T00:00:00Z",
        },
      ],
    });

    const res = await request(makeApp()).get("/admin/billing/denials-worklist");
    expect(res.status).toBe(200);
    // The resolved (appealed) denial is excluded despite bigger dollars.
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].claimId).toBe("c_open");
    expect(res.body.items[0].scoreCents).toBe(8000); // 10000 × 0.8
    expect(res.body.items[0].canAutoResubmit).toBe(true);
    expect(res.body.totals.count).toBe(1);
  });
});

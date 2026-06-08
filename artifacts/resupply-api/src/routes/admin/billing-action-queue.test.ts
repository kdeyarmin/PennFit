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

import billingActionQueueRouter, {
  summarizeDenialActions,
} from "./billing-action-queue";
import type { DenialWorkItem } from "./denials-worklist";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(billingActionQueueRouter);
  return app;
}

function workItem(over: Partial<DenialWorkItem>): DenialWorkItem {
  return {
    claimId: "c1",
    patientId: "p1",
    payerName: "Aetna",
    recoverableCents: 10000,
    confidence: 0.8,
    recommendation: "appeal",
    canAutoResubmit: false,
    denialReason: null,
    decisionAt: null,
    winProbability: 0.8,
    scoreCents: 8000,
    hasAnalysis: true,
    ...over,
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("summarizeDenialActions (pure)", () => {
  it("buckets items by recommendation and sums dollars", () => {
    const summary = summarizeDenialActions([
      workItem({
        recommendation: "appeal",
        recoverableCents: 10000,
        scoreCents: 8000,
      }),
      workItem({
        recommendation: "appeal",
        recoverableCents: 5000,
        scoreCents: 4000,
      }),
      workItem({
        recommendation: "auto_resubmit",
        recoverableCents: 2000,
        scoreCents: 1800,
      }),
    ]);
    expect(summary.appeal.count).toBe(2);
    expect(summary.appeal.recoverableCents).toBe(15000);
    expect(summary.appeal.expectedRecoverableCents).toBe(12000);
    expect(summary.auto_resubmit.count).toBe(1);
    expect(summary.write_off.count).toBe(0);
  });

  it("routes items with no recommendation to `unclassified`", () => {
    const summary = summarizeDenialActions([
      workItem({ recommendation: null, hasAnalysis: false }),
    ]);
    expect(summary.unclassified.count).toBe(1);
  });
});

describe("GET /admin/billing/action-queue", () => {
  it("401s when unauthenticated", async () => {
    const res = await request(makeApp()).get("/admin/billing/action-queue");
    expect(res.status).toBe(401);
  });

  it("rolls up denial actions and secondary-eligible totals", async () => {
    mockAdmin.current = ADMIN;
    // denied claims
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        {
          id: "c1",
          patient_id: "p1",
          payer_name: "Aetna",
          total_billed_cents: 10000,
          total_paid_cents: 0,
          denial_reason: "missing modifier",
          decision_at: "2026-06-01T00:00:00.000Z",
        },
      ],
    });
    // latest analyses
    stageSupabaseResponse("claim_denial_analyses", "select", {
      data: [
        {
          claim_id: "c1",
          confidence: 0.8,
          recommendation: "appeal",
          can_auto_resubmit: false,
          review_status: "pending",
          created_at: "2026-06-02T00:00:00.000Z",
        },
      ],
    });
    // secondary-eligible primary-paid claims
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        { patient_responsibility_cents: 2500 },
        { patient_responsibility_cents: 1500 },
      ],
    });

    const res = await request(makeApp()).get("/admin/billing/action-queue");
    expect(res.status).toBe(200);
    expect(res.body.denials.byAction.appeal.count).toBe(1);
    expect(res.body.denials.byAction.appeal.recoverableCents).toBe(10000);
    expect(res.body.denials.totals.count).toBe(1);
    expect(res.body.secondaryEligible.count).toBe(2);
    expect(res.body.secondaryEligible.billableCents).toBe(4000);
  });
});

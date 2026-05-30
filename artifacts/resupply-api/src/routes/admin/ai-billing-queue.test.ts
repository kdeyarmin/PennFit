// Tests for GET /admin/billing/ai-queue — feature flag gate behavior.
//
// Coverage:
//   1. Returns 401 when unauthenticated.
//   2. When ai_billing.suggestions is disabled, returns an empty queue
//      with featureDisabled:true (and zero counts) without touching the DB.
//   3. When the feature is enabled, queries the DB and returns non-disabled shape.
//   4. The featureDisabled flag is absent (or falsy) in the normal path.
//   5. The generatedAt field is present in both paths.
//   6. The empty-queue response has all four claim buckets as arrays.

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

// ─── Supabase mock (must precede SUT import) ──────────────────────────────

const supabaseMock = installSupabaseMock();

// ─── Auth mock ────────────────────────────────────────────────────────────

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// ─── Feature flag mock ────────────────────────────────────────────────────

const isFeatureEnabledMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));

// ─── SUT ──────────────────────────────────────────────────────────────────

import aiBillingQueueRouter from "./ai-billing-queue";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(aiBillingQueueRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@example.com",
    role: "admin",
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  isFeatureEnabledMock.mockClear();
  isFeatureEnabledMock.mockResolvedValue(true);
});

// ─── Auth guard ───────────────────────────────────────────────────────────

describe("GET /admin/billing/ai-queue — auth", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get("/admin/billing/ai-queue");
    expect(res.status).toBe(401);
  });
});

// ─── Feature flag gate ────────────────────────────────────────────────────

describe("GET /admin/billing/ai-queue — feature flag gate", () => {
  it("returns 200 with an empty queue and featureDisabled:true when the flag is off", async () => {
    stubAdmin();
    isFeatureEnabledMock.mockResolvedValue(false);

    const res = await request(makeApp()).get("/admin/billing/ai-queue");

    expect(res.status).toBe(200);
    expect(res.body.featureDisabled).toBe(true);
  });

  it("returns empty arrays for all four claim buckets when the flag is off", async () => {
    stubAdmin();
    isFeatureEnabledMock.mockResolvedValue(false);

    const res = await request(makeApp()).get("/admin/billing/ai-queue");

    expect(res.body.scrubBlockingClaims).toEqual([]);
    expect(res.body.scrubFixableClaims).toEqual([]);
    expect(res.body.deniedNeedsAnalysis).toEqual([]);
    expect(res.body.autoResubmitReady).toEqual([]);
  });

  it("returns zero counts for all four buckets when the flag is off", async () => {
    stubAdmin();
    isFeatureEnabledMock.mockResolvedValue(false);

    const res = await request(makeApp()).get("/admin/billing/ai-queue");

    expect(res.body.counts).toEqual({
      scrubBlocking: 0,
      scrubFixable: 0,
      deniedNeedsAnalysis: 0,
      autoResubmitReady: 0,
    });
  });

  it("includes a generatedAt ISO timestamp in the disabled response", async () => {
    stubAdmin();
    isFeatureEnabledMock.mockResolvedValue(false);

    const res = await request(makeApp()).get("/admin/billing/ai-queue");

    const ts = res.body.generatedAt as string;
    expect(ts).toBeDefined();
    expect(isNaN(Date.parse(ts))).toBe(false);
  });

  it("makes no DB queries when the feature flag is off", async () => {
    stubAdmin();
    isFeatureEnabledMock.mockResolvedValue(false);

    await request(makeApp()).get("/admin/billing/ai-queue");

    expect(supabaseMock.callCount("insurance_claims", "select")).toBe(0);
    expect(supabaseMock.callCount("claim_denial_analyses", "select")).toBe(0);
  });

  it("calls isFeatureEnabled with the correct key", async () => {
    stubAdmin();
    isFeatureEnabledMock.mockResolvedValue(false);

    await request(makeApp()).get("/admin/billing/ai-queue");

    expect(isFeatureEnabledMock).toHaveBeenCalledWith("ai_billing.suggestions");
  });
});

// ─── Normal path (feature enabled) ───────────────────────────────────────

describe("GET /admin/billing/ai-queue — normal path", () => {
  it("returns 200 without featureDisabled when the flag is on", async () => {
    stubAdmin();

    // Stage four empty selects for the four Promise.all queries.
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
    stageSupabaseResponse("claim_denial_analyses", "select", { data: [] });

    const res = await request(makeApp()).get("/admin/billing/ai-queue");

    expect(res.status).toBe(200);
    expect(res.body.featureDisabled).toBeFalsy();
  });

  it("includes a generatedAt ISO timestamp in the enabled response", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
    stageSupabaseResponse("claim_denial_analyses", "select", { data: [] });

    const res = await request(makeApp()).get("/admin/billing/ai-queue");

    expect(res.body.generatedAt).toBeDefined();
  });
});

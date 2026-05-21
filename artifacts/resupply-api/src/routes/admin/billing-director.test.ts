// Tests for billing-director route — RBAC migration.
//
// Scope: code changed in this PR:
//   - GET /admin/billing/director-summary   (requireAdmin → requirePermission("reports.read"))
//
// Tests verify:
//   1. Returns 401 when unauthenticated.
//   2. Returns 403 when caller lacks reports.read permission.
//   3. Returns 200 with the expected response shape for an admin.
//   4. Response includes all required top-level keys.
//   5. counts, dollars, denialRateTrend, topPayersByOpenDollars are present.
//   6. Handles null/empty Supabase responses gracefully (zeroed-out counts).

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

import billingDirectorRouter from "./billing-director";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(billingDirectorRouter);
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

/**
 * Stage all 12 parallel Supabase queries used by the director-summary route
 * with minimal empty data. The route queries these tables in order (Promise.all):
 *  1. insurance_claims (stale drafts)
 *  2. insurance_claims (fresh denials)
 *  3. insurance_claims (stuck submitted)
 *  4. era_files (partial)
 *  5. insurance_claims (scrub blocking)
 *  6. insurance_claims (scrub fixable)
 *  7. insurance_claims (denied no analysis)
 *  8. claim_denial_analyses (auto resubmit ready)
 *  9. insurance_claims (open patient responsibility)
 * 10. webhook_deliveries (queued count — head query)
 * 11. webhook_deliveries (exhausted count — head query)
 * 12. insurance_claims (denial rate rows)
 */
function stageEmptyDirectorResponses() {
  // Queries 1-3, 5-7, 9, 12: insurance_claims select
  for (let i = 0; i < 8; i++) {
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
  }
  // Query 4: era_files select
  stageSupabaseResponse("era_files", "select", { data: [] });
  // Query 8: claim_denial_analyses select
  stageSupabaseResponse("claim_denial_analyses", "select", { data: [] });
  // Queries 10-11: webhook_deliveries (head queries with count)
  stageSupabaseResponse("webhook_deliveries", "select", { data: [] });
  stageSupabaseResponse("webhook_deliveries", "select", { data: [] });
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

// ── Auth gate tests ──────────────────────────────────────────────────────────

describe("GET /admin/billing/director-summary — requirePermission(reports.read)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get(
      "/admin/billing/director-summary",
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent lacks reports.read permission", async () => {
    stubAgent();
    const res = await request(makeApp()).get(
      "/admin/billing/director-summary",
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("permission_denied");
  });
});

// ── Response shape tests ─────────────────────────────────────────────────────

describe("GET /admin/billing/director-summary — response shape", () => {
  it("returns 200 with all required top-level keys", async () => {
    stubAdmin();
    stageEmptyDirectorResponses();
    const res = await request(makeApp()).get(
      "/admin/billing/director-summary",
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("counts");
    expect(res.body).toHaveProperty("dollars");
    expect(res.body).toHaveProperty("denialRateTrend");
    expect(res.body).toHaveProperty("topPayersByOpenDollars");
    expect(res.body).toHaveProperty("windowReferences");
    expect(res.body).toHaveProperty("generatedAt");
  });

  it("counts object contains all expected keys", async () => {
    stubAdmin();
    stageEmptyDirectorResponses();
    const res = await request(makeApp()).get(
      "/admin/billing/director-summary",
    );
    expect(res.status).toBe(200);
    const { counts } = res.body;
    expect(counts).toHaveProperty("staleDrafts");
    expect(counts).toHaveProperty("freshDenials");
    expect(counts).toHaveProperty("stuckSubmittedNoAck");
    expect(counts).toHaveProperty("partialEras");
    expect(counts).toHaveProperty("scrubBlocking");
    expect(counts).toHaveProperty("scrubFixable");
    expect(counts).toHaveProperty("deniedNeedsAnalysis");
    expect(counts).toHaveProperty("autoResubmitReady");
    expect(counts).toHaveProperty("webhooksQueued");
    expect(counts).toHaveProperty("webhooksExhausted24h");
  });

  it("dollars object contains all expected keys", async () => {
    stubAdmin();
    stageEmptyDirectorResponses();
    const res = await request(makeApp()).get(
      "/admin/billing/director-summary",
    );
    expect(res.status).toBe(200);
    const { dollars } = res.body;
    expect(dollars).toHaveProperty("stuckSubmittedCents");
    expect(dollars).toHaveProperty("deniedFreshCents");
    expect(dollars).toHaveProperty("patientResponsibilityCents");
  });

  it("denialRateTrend contains three window buckets", async () => {
    stubAdmin();
    stageEmptyDirectorResponses();
    const res = await request(makeApp()).get(
      "/admin/billing/director-summary",
    );
    expect(res.status).toBe(200);
    const { denialRateTrend } = res.body;
    expect(denialRateTrend).toBeInstanceOf(Array);
    expect(denialRateTrend).toHaveLength(3);
    const windows = denialRateTrend.map((b: { window: string }) => b.window);
    expect(windows).toContain("d0_30");
    expect(windows).toContain("d30_60");
    expect(windows).toContain("d60_90");
  });

  it("all counts are zero when Supabase returns empty arrays", async () => {
    stubAdmin();
    stageEmptyDirectorResponses();
    const res = await request(makeApp()).get(
      "/admin/billing/director-summary",
    );
    expect(res.status).toBe(200);
    const { counts, dollars } = res.body;
    expect(counts.staleDrafts).toBe(0);
    expect(counts.freshDenials).toBe(0);
    expect(counts.stuckSubmittedNoAck).toBe(0);
    expect(counts.partialEras).toBe(0);
    expect(counts.scrubBlocking).toBe(0);
    expect(counts.scrubFixable).toBe(0);
    expect(counts.deniedNeedsAnalysis).toBe(0);
    expect(counts.autoResubmitReady).toBe(0);
    expect(dollars.stuckSubmittedCents).toBe(0);
    expect(dollars.deniedFreshCents).toBe(0);
    expect(dollars.patientResponsibilityCents).toBe(0);
  });

  it("topPayersByOpenDollars is an empty array when no open patient responsibility", async () => {
    stubAdmin();
    stageEmptyDirectorResponses();
    const res = await request(makeApp()).get(
      "/admin/billing/director-summary",
    );
    expect(res.status).toBe(200);
    expect(res.body.topPayersByOpenDollars).toEqual([]);
  });

  it("windowReferences contains expected time-window keys", async () => {
    stubAdmin();
    stageEmptyDirectorResponses();
    const res = await request(makeApp()).get(
      "/admin/billing/director-summary",
    );
    expect(res.status).toBe(200);
    const { windowReferences } = res.body;
    expect(windowReferences).toHaveProperty("t7d");
    expect(windowReferences).toHaveProperty("t14d");
    expect(windowReferences).toHaveProperty("t30d");
    expect(windowReferences).toHaveProperty("t60d");
    expect(windowReferences).toHaveProperty("t90d");
  });

  it("generatedAt is an ISO timestamp string", async () => {
    stubAdmin();
    stageEmptyDirectorResponses();
    const res = await request(makeApp()).get(
      "/admin/billing/director-summary",
    );
    expect(res.status).toBe(200);
    expect(typeof res.body.generatedAt).toBe("string");
    expect(new Date(res.body.generatedAt).getTime()).toBeGreaterThan(0);
  });

  it("correctly aggregates dollars from non-empty insurance_claims data", async () => {
    stubAdmin();
    // stale drafts (query 1) — 2 claims worth $100 and $200
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        { id: "c1", total_billed_cents: 10000 },
        { id: "c2", total_billed_cents: 20000 },
      ],
    });
    // fresh denials (query 2) — 1 claim worth $50
    stageSupabaseResponse("insurance_claims", "select", {
      data: [{ id: "c3", total_billed_cents: 5000, payer_name: "BlueCross" }],
    });
    // stuck submitted (query 3) — 1 claim worth $75
    stageSupabaseResponse("insurance_claims", "select", {
      data: [{ id: "c4", total_billed_cents: 7500 }],
    });
    // era_files (query 4)
    stageSupabaseResponse("era_files", "select", { data: [] });
    // scrub blocking (query 5)
    stageSupabaseResponse("insurance_claims", "select", { data: [{ id: "c5" }] });
    // scrub fixable (query 6)
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
    // denied no analysis (query 7)
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
    // claim_denial_analyses (query 8)
    stageSupabaseResponse("claim_denial_analyses", "select", { data: [] });
    // open patient responsibility (query 9)
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        { payer_name: "Aetna", patient_responsibility_cents: 3000 },
        { payer_name: "Aetna", patient_responsibility_cents: 2000 },
        { payer_name: "BCBS", patient_responsibility_cents: 8000 },
      ],
    });
    // webhook_deliveries (queries 10-11)
    stageSupabaseResponse("webhook_deliveries", "select", { data: [] });
    stageSupabaseResponse("webhook_deliveries", "select", { data: [] });
    // denial rate rows (query 12)
    stageSupabaseResponse("insurance_claims", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/admin/billing/director-summary",
    );
    expect(res.status).toBe(200);
    expect(res.body.counts.staleDrafts).toBe(2);
    expect(res.body.counts.freshDenials).toBe(1);
    expect(res.body.counts.stuckSubmittedNoAck).toBe(1);
    expect(res.body.counts.scrubBlocking).toBe(1);
    expect(res.body.dollars.stuckSubmittedCents).toBe(7500);
    expect(res.body.dollars.deniedFreshCents).toBe(5000);
    expect(res.body.dollars.patientResponsibilityCents).toBe(13000);
  });

  it("topPayersByOpenDollars ranks payers by descending open dollars (max 5)", async () => {
    stubAdmin();
    // Build 6 payers worth of patient responsibility rows
    const payerRows = [
      { payer_name: "PayerA", patient_responsibility_cents: 1000 },
      { payer_name: "PayerB", patient_responsibility_cents: 5000 },
      { payer_name: "PayerC", patient_responsibility_cents: 3000 },
      { payer_name: "PayerD", patient_responsibility_cents: 2000 },
      { payer_name: "PayerE", patient_responsibility_cents: 7000 },
      { payer_name: "PayerF", patient_responsibility_cents: 500 },
    ];

    // Stage all 12 queries with appropriate data
    for (let i = 0; i < 7; i++) {
      stageSupabaseResponse("insurance_claims", "select", { data: [] });
    }
    stageSupabaseResponse("era_files", "select", { data: [] });
    stageSupabaseResponse("claim_denial_analyses", "select", { data: [] });
    stageSupabaseResponse("insurance_claims", "select", { data: payerRows });
    stageSupabaseResponse("webhook_deliveries", "select", { data: [] });
    stageSupabaseResponse("webhook_deliveries", "select", { data: [] });
    stageSupabaseResponse("insurance_claims", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/admin/billing/director-summary",
    );
    expect(res.status).toBe(200);
    const top = res.body.topPayersByOpenDollars;
    expect(top.length).toBeLessThanOrEqual(5);
    // Should be sorted descending
    expect(top[0].payerName).toBe("PayerE");
    expect(top[0].openCents).toBe(7000);
    expect(top[1].payerName).toBe("PayerB");
    expect(top[1].openCents).toBe(5000);
  });
});

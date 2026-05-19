// Route tests for the new analytics surfaces:
//   * GET /admin/analytics/episodes-stuck
//   * GET /admin/analytics/resupply-funnel.csv
//
// The pre-existing JSON endpoints (resupply-funnel, compliance-cohorts,
// csr-productivity) have their behavior pinned in
// lib/analytics/aggregate.test.ts — those routes are thin DB →
// aggregate shims.

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

import analyticsRouter from "./analytics";

const SUPERVISOR: MockAdminCtx = {
  userId: "u_super",
  email: "sup@penn.example.com",
  role: "agent",
  granularRole: "supervisor",
};
const FULFILLMENT: MockAdminCtx = {
  userId: "u_ship",
  email: "ship@penn.example.com",
  role: "agent",
  granularRole: "fulfillment",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(analyticsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/analytics/episodes-stuck", () => {
  it("401s without a session", async () => {
    const res = await request(makeApp()).get(
      "/admin/analytics/episodes-stuck?stage=awaiting_response",
    );
    expect(res.status).toBe(401);
  });

  it("allows customer_service_rep bucket roles (fulfillment folds in)", async () => {
    // Phase B 3-role collapse: `fulfillment` now resolves to the
    // `customer_service_rep` effective bucket, which inherits
    // `reports.read` from the old csr role. Episodes-stuck view is
    // no longer hidden from fulfillment-row holders.
    mockAdmin.current = FULFILLMENT;
    stageSupabaseResponse("episodes", "select", { data: [] });
    const res = await request(makeApp()).get(
      "/admin/analytics/episodes-stuck?stage=awaiting_response",
    );
    expect(res.status).toBe(200);
  });

  it("400s on an invalid stage", async () => {
    mockAdmin.current = SUPERVISOR;
    const res = await request(makeApp()).get(
      "/admin/analytics/episodes-stuck?stage=garbage",
    );
    expect(res.status).toBe(400);
  });

  it("decorates rows with patient name + payer and computes ageDays", async () => {
    mockAdmin.current = SUPERVISOR;
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
    stageSupabaseResponse("episodes", "select", {
      data: [
        {
          id: "e_1",
          patient_id: "p_1",
          status: "awaiting_response",
          created_at: fiveDaysAgo,
          due_at: null,
          expires_at: null,
          prescription_id: "rx_1",
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: "p_1",
          legal_first_name: "Jane",
          legal_last_name: "Smith",
          insurance_payer: "Medicare",
        },
      ],
    });
    const res = await request(makeApp()).get(
      "/admin/analytics/episodes-stuck?stage=awaiting_response",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.episodes[0].patientName).toBe("Jane Smith");
    expect(res.body.episodes[0].insurancePayer).toBe("Medicare");
    // ageDays should be ≥4 (we allow ±1 for rounding around the
    // 86_400_000 boundary).
    expect(res.body.episodes[0].ageDays).toBeGreaterThanOrEqual(4);
    expect(res.body.episodes[0].ageDays).toBeLessThanOrEqual(5);
  });

  it("returns empty list cleanly when no rows match", async () => {
    mockAdmin.current = SUPERVISOR;
    stageSupabaseResponse("episodes", "select", { data: [] });
    const res = await request(makeApp()).get(
      "/admin/analytics/episodes-stuck?stage=confirmed",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.episodes).toEqual([]);
  });
});

describe("GET /admin/analytics/resupply-funnel.csv", () => {
  it("allows customer_service_rep bucket roles (fulfillment folds in)", async () => {
    // Phase B collapse — fulfillment inherits reports.read; the CSV
    // export is no longer 403 for it. See the matching note on
    // /admin/analytics/episodes-stuck above.
    mockAdmin.current = FULFILLMENT;
    stageSupabaseResponse("episodes", "select", { data: [] });
    const res = await request(makeApp()).get(
      "/admin/analytics/resupply-funnel.csv?days=7",
    );
    expect(res.status).toBe(200);
  });

  it("returns CSV with stage rows + summary footer", async () => {
    mockAdmin.current = SUPERVISOR;
    stageSupabaseResponse("episodes", "select", {
      data: [
        { status: "outreach_pending" },
        { status: "outreach_pending" },
        { status: "fulfilled" },
        { status: "fulfilled" },
        { status: "fulfilled" },
        { status: "declined" },
      ],
    });
    const res = await request(makeApp()).get(
      "/admin/analytics/resupply-funnel.csv?days=7",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const csv = res.text;
    // Headline header row.
    expect(csv.split("\n")[0]).toBe("stage,count,kind");
    // Some assertions on the lines so a refactor that swaps the
    // CSV column order fails loud.
    expect(csv).toContain("outreach_pending,2,funnel");
    expect(csv).toContain("fulfilled,3,funnel");
    expect(csv).toContain("declined,1,drop_out");
    expect(csv).toMatch(/total,6,summary/);
  });
});

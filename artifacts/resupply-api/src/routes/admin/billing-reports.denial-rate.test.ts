// Route test for GET /admin/billing/denial-rate.
//
// This endpoint moved off a 10k-row JS reduce onto the
// resupply.billing_denial_rate RPC (migration 0164). The route's
// remaining logic is: call the RPC with a 90-day cutoff, coerce the
// bigint-as-string counts, sum the per-payer rows into the overall
// headline, and sort per-payer by denials desc. This pins that
// behavior + the cutoff argument.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseRpcResponse,
  getSupabaseRpcCallCount,
  getSupabaseRpcArgs,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import billingReportsRouter from "./billing-reports";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(billingReportsRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  mockAdmin.current = ADMIN;
});

describe("GET /admin/billing/denial-rate", () => {
  it("aggregates the per-payer RPC rows into the overall headline", async () => {
    // PostgREST serializes bigint columns as strings — stage them that
    // way to prove the route's Number() coercion works.
    stageSupabaseRpcResponse("billing_denial_rate", {
      data: [
        { payer_name: "Aetna", decisions: "100", denials: "10" },
        { payer_name: "Cigna", decisions: "50", denials: "20" },
        { payer_name: "unknown", decisions: "10", denials: "0" },
      ],
    });

    const res = await request(makeApp()).get("/admin/billing/denial-rate");

    expect(res.status).toBe(200);
    // Overall = sum across payers: 160 decisions, 30 denials.
    expect(res.body.overall.decisions).toBe(160);
    expect(res.body.overall.denials).toBe(30);
    expect(res.body.overall.denialRate).toBeCloseTo(30 / 160, 6);
    expect(res.body.windowDays).toBe(90);

    // Per-payer sorted by denials desc → Cigna (20) first.
    expect(res.body.perPayer[0].payerName).toBe("Cigna");
    expect(res.body.perPayer[0].denialRate).toBeCloseTo(20 / 50, 6);
  });

  it("calls the RPC with a 90-day cutoff ISO timestamp", async () => {
    stageSupabaseRpcResponse("billing_denial_rate", { data: [] });

    await request(makeApp()).get("/admin/billing/denial-rate");

    expect(getSupabaseRpcCallCount("billing_denial_rate")).toBe(1);
    const args = getSupabaseRpcArgs("billing_denial_rate")[0] as {
      p_cutoff: string;
    };
    // ~90 days ago, ISO format. Allow a little slack for test runtime.
    const cutoffMs = new Date(args.p_cutoff).getTime();
    const expectedMs = Date.now() - 90 * 24 * 3600 * 1000;
    expect(Math.abs(cutoffMs - expectedMs)).toBeLessThan(60_000);
  });

  it("returns a null denialRate when there are no decisions", async () => {
    stageSupabaseRpcResponse("billing_denial_rate", { data: [] });

    const res = await request(makeApp()).get("/admin/billing/denial-rate");

    expect(res.status).toBe(200);
    expect(res.body.overall.decisions).toBe(0);
    expect(res.body.overall.denialRate).toBeNull();
    expect(res.body.perPayer).toEqual([]);
  });
});

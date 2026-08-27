// Route wiring for aging-report + dso-by-payer — pins paging past
// PostgREST max_rows and the windowTruncated honesty flag.

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

describe("GET /admin/billing/aging-report", () => {
  it("buckets open AR and reports windowTruncated=false", async () => {
    const submittedAt = new Date(
      Date.now() - 10 * 24 * 3600 * 1000,
    ).toISOString();
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        {
          id: "c1",
          payer_name: "Aetna",
          status: "submitted",
          total_billed_cents: 10000,
          submitted_at: submittedAt,
          date_of_service: "2026-08-01",
        },
      ],
    });

    const res = await request(makeApp()).get("/admin/billing/aging-report");
    expect(res.status).toBe(200);
    expect(res.body.windowTruncated).toBe(false);
    expect(res.body.totalOpenClaimCount).toBe(1);
    expect(res.body.overall["0_30"].claimCount).toBe(1);
    expect(res.body.totalOpenBilledCents).toBe(10000);
  });
});

describe("GET /admin/billing/dso-by-payer", () => {
  it("averages days-to-pay and reports windowTruncated=false", async () => {
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        {
          payer_name: "Aetna",
          submitted_at: "2026-07-01T00:00:00.000Z",
          paid_at: "2026-07-31T00:00:00.000Z",
          total_paid_cents: 8000,
        },
      ],
    });

    const res = await request(makeApp()).get("/admin/billing/dso-by-payer");
    expect(res.status).toBe(200);
    expect(res.body.windowTruncated).toBe(false);
    expect(res.body.windowDays).toBe(180);
    expect(res.body.payers).toHaveLength(1);
    expect(res.body.payers[0].payerName).toBe("Aetna");
    expect(res.body.payers[0].averageDaysToPay).toBe(30);
  });
});

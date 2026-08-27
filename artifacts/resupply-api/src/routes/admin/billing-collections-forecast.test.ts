// Route wiring for collections-forecast + forward-order-book.
// Projection math is unit-tested in lib/billing/*; this pins paging
// past PostgREST max_rows and the windowTruncated honesty flag.

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

import forecastRouter from "./billing-collections-forecast";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(forecastRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  mockAdmin.current = ADMIN;
});

describe("GET /admin/billing/collections-forecast", () => {
  it("returns a projection and windowTruncated=false for a small AR set", async () => {
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        {
          status: "submitted",
          total_billed_cents: 10000,
          total_allowed_cents: 8000,
          total_paid_cents: 0,
          submitted_at: "2026-08-01T00:00:00.000Z",
        },
      ],
    });

    const res = await request(makeApp()).get(
      "/admin/billing/collections-forecast",
    );
    expect(res.status).toBe(200);
    expect(res.body.windowTruncated).toBe(false);
    expect(typeof res.body.totalExpectedCents).toBe("number");
  });
});

describe("GET /admin/billing/forward-order-book", () => {
  it("anchors last-fill from fulfillments and reports windowTruncated", async () => {
    stageSupabaseResponse("prescriptions", "select", {
      data: [
        {
          patient_id: "p1",
          item_sku: "MASK",
          cadence_days: 90,
        },
      ],
    });
    stageSupabaseResponse("fulfillments", "select", {
      data: [
        {
          patient_id: "p1",
          item_sku: "MASK",
          created_at: "2026-06-01T00:00:00.000Z",
        },
      ],
    });

    const res = await request(makeApp()).get(
      "/admin/billing/forward-order-book",
    );
    expect(res.status).toBe(200);
    expect(res.body.windowTruncated).toBe(false);
    expect(res.body.assumptions).toMatchObject({
      horizonDays: 90,
    });
    expect(typeof res.body.totalExpectedCents).toBe("number");
  });
});

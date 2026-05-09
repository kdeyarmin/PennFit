// Route tests for /admin/followups (Phase 18 + 20) — cross-flow
// daily queue of open followups across shop_customers AND patients.

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

import followupsListRouter from "./followups-list";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(followupsListRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/followups", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get("/admin/followups");
    expect(res.status).toBe(401);
  });

  it("returns empty list when both surfaces are empty", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    stageSupabaseResponse("shop_customer_followups", "select", { data: [] });
    stageSupabaseResponse("patient_followups", "select", { data: [] });
    // No identity-table round-trips when there's nothing to embellish
    // (the route guards `customerIds.length > 0` / `patientIds.length > 0`).
    const res = await request(makeApp()).get("/admin/followups");
    expect(res.status).toBe(200);
    expect(res.body.followups).toEqual([]);
  });

  it("merges + sorts shop and patient rows by due_at ascending, kind-discriminated", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    // Followup tables — snake_case as PostgREST returns them.
    stageSupabaseResponse("shop_customer_followups", "select", {
      data: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          customer_id: "user_1",
          body: "Call about UPS claim",
          due_at: new Date("2026-05-01T16:00:00Z").toISOString(),
          created_by_email: "ops@penn.example.com",
          created_at: new Date("2026-04-30T12:00:00Z").toISOString(),
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          customer_id: "user_2",
          body: "Check replacement mask shipment",
          due_at: new Date("2026-05-04T10:00:00Z").toISOString(),
          created_by_email: "csr2@penn.example.com",
          created_at: new Date("2026-05-02T09:00:00Z").toISOString(),
        },
      ],
    });
    stageSupabaseResponse("patient_followups", "select", {
      data: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          patient_id: "44444444-4444-4444-8444-444444444444",
          body: "Confirm Rx renewal",
          due_at: new Date("2026-05-02T12:00:00Z").toISOString(),
          created_by_email: "rx@penn.example.com",
          created_at: new Date("2026-05-01T08:00:00Z").toISOString(),
        },
      ],
    });
    // Identity-table embellishments (second Promise.all in the route).
    stageSupabaseResponse("shop_customers", "select", {
      data: [
        {
          customer_id: "user_1",
          display_name: "Anna Singh",
          email_lower: "anna@example.com",
        },
        {
          customer_id: "user_2",
          display_name: null,
          email_lower: "ben@example.com",
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          legal_first_name: "Carla",
          legal_last_name: "Rivera",
        },
      ],
    });

    const res = await request(makeApp()).get("/admin/followups");
    expect(res.status).toBe(200);
    expect(res.body.followups).toHaveLength(3);

    // Sort order: shop_2026-05-01, patient_2026-05-02, shop_2026-05-04.
    expect(res.body.followups[0]).toMatchObject({
      kind: "shop_customer",
      id: "11111111-1111-4111-8111-111111111111",
      subjectId: "user_1",
      subjectDisplayName: "Anna Singh",
      subjectEmail: "anna@example.com",
      dueAt: "2026-05-01T16:00:00.000Z",
    });
    expect(res.body.followups[1]).toMatchObject({
      kind: "patient",
      id: "33333333-3333-4333-8333-333333333333",
      subjectId: "44444444-4444-4444-8444-444444444444",
      subjectDisplayName: "Carla Rivera",
      // Patient surface deliberately doesn't expose email here —
      // PHI minimization for the cross-flow queue.
      subjectEmail: null,
      dueAt: "2026-05-02T12:00:00.000Z",
    });
    expect(res.body.followups[2]).toMatchObject({
      kind: "shop_customer",
      subjectId: "user_2",
      subjectDisplayName: null,
      subjectEmail: "ben@example.com",
      dueAt: "2026-05-04T10:00:00.000Z",
    });
  });
});

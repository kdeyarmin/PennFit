// Route tests for GET /episodes.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

import listRouter from "./list";

const ALLOWED_EMAIL = "ops@penn.example.com";
const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const RX_ID = "22222222-2222-4222-8222-222222222222";
const EP_ID = "33333333-3333-4333-8333-333333333333";

function makeApp(): Express {
  const app = express();
  app.use("/resupply-api", listRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  mockAdmin.current = {
    userId: "user_op",
    email: ALLOWED_EMAIL,
    role: "admin",
  };
}

const ENV_KEYS = ["RESUPPLY_ADMIN_EMAILS", "NODE_ENV"] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

describe("GET /episodes", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];

    process.env.NODE_ENV = "test";
    process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
    mockAdmin.current = null;
    supabaseMock.reset();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("returns 401 with no session", async () => {
    const res = await request(makeApp()).get("/resupply-api/episodes");
    expect(res.status).toBe(401);
  });

  it("returns 400 invalid_query on bad status", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp()).get(
      "/resupply-api/episodes?status=zzz",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("returns paginated episodes joined with patient + prescription", async () => {
    stubVerifiedAdmin();
    // 1) Main episodes page (with `count`).
    stageSupabaseResponse("episodes", "select", {
      data: [
        {
          id: EP_ID,
          patient_id: PATIENT_ID,
          prescription_id: RX_ID,
          status: "outreach_pending",
          due_at: new Date("2025-04-01T00:00:00Z").toISOString(),
          expires_at: null,
          created_at: new Date("2025-04-01T00:00:00Z").toISOString(),
        },
      ],
      count: 1,
    });
    // 2) Bulk patient lookup (PostgREST has no JOIN — second round-trip).
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: PATIENT_ID,
          legal_first_name: "Alice",
          legal_last_name: "Smith",
        },
      ],
    });
    // 3) Bulk prescription lookup (third round-trip).
    stageSupabaseResponse("prescriptions", "select", {
      data: [
        {
          id: RX_ID,
          item_sku: "MASK-001",
          cadence_days: 90,
        },
      ],
    });

    const res = await request(makeApp()).get(
      "/resupply-api/episodes?status=overdue&limit=25",
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      id: EP_ID,
      patientId: PATIENT_ID,
      patientFirstName: "Alice",
      patientLastName: "Smith",
      itemSku: "MASK-001",
      cadenceDays: 90,
      status: "outreach_pending",
    });
    // daysOverdue is computed JS-side from due_at vs now() so the
    // exact value depends on the test clock; just sanity check it's
    // a non-negative integer.
    expect(res.body.items[0].daysOverdue).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(res.body.items[0].daysOverdue)).toBe(true);
  });

  it("returns empty page on no results", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("episodes", "select", { data: [], count: 0 });
    // No patient/prescription lookups when there are no rows on this
    // page — the route's `patientIds.length > 0` guards skip the
    // round-trips, so we don't stage them.
    const res = await request(makeApp()).get(
      "/resupply-api/episodes?status=confirmed",
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
  });
});

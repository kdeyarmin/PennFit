// Route tests for GET /conversations.

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
const EPISODE_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "33333333-3333-4333-8333-333333333333";

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

describe("GET /conversations", () => {
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
    const res = await request(makeApp()).get("/resupply-api/conversations");
    expect(res.status).toBe(401);
  });

  it("returns 400 invalid_query on bad channel", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp()).get(
      "/resupply-api/conversations?channel=foo",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("returns paginated page joined with patient name", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("conversations", "select", {
      data: [
        {
          id: CONV_ID,
          patient_id: PATIENT_ID,
          customer_id: null,
          episode_id: EPISODE_ID,
          channel: "sms",
          status: "awaiting_admin",
          last_message_at: new Date("2025-04-02T12:00:00Z").toISOString(),
          created_at: new Date("2025-04-01T11:00:00Z").toISOString(),
          assigned_admin_user_id: null,
          assigned_at: null,
          priority: "normal",
          sla_due_at: null,
          escalated_at: null,
          escalation_reason: null,
        },
      ],
      count: 1,
    });
    // Bulk-fetch the joined identity rows (patients only — no
    // customer_id on this conversation).
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: PATIENT_ID,
          legal_first_name: "Alice",
          legal_last_name: "Smith",
        },
      ],
    });

    const res = await request(makeApp()).get(
      "/resupply-api/conversations?status=awaiting_admin&limit=25",
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      id: CONV_ID,
      patientId: PATIENT_ID,
      patientFirstName: "Alice",
      patientLastName: "Smith",
      channel: "sms",
      status: "awaiting_admin",
    });
  });

  it("filters by patientId", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("conversations", "select", {
      data: [],
      count: 0,
    });
    // No conversations on the page → no identity-table round-trips,
    // so we don't need to stage them.
    const res = await request(makeApp()).get(
      `/resupply-api/conversations?patientId=${PATIENT_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

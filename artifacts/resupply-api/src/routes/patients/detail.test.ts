// Route tests for GET /patients/:id.

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

const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

import detailRouter from "./detail";

const ALLOWED_EMAIL = "ops@penn.example.com";
const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const RX_ID = "22222222-2222-4222-8222-222222222222";
const EPISODE_ID = "33333333-3333-4333-8333-333333333333";
const CONV_ID = "44444444-4444-4444-8444-444444444444";
const FUL_ID = "55555555-5555-4555-8555-555555555555";

function makeApp(): Express {
  const app = express();
  app.use("/resupply-api", detailRouter);
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

describe("GET /patients/:id", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];

    process.env.NODE_ENV = "test";
    process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
    mockAdmin.current = null;
    supabaseMock.reset();
    logAuditMock.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("returns 401 with no session", async () => {
    const res = await request(makeApp()).get(
      `/resupply-api/patients/${PATIENT_ID}`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-uuid id", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp()).get(
      "/resupply-api/patients/not-a-uuid",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 404 when patient row is empty", async () => {
    stubVerifiedAdmin();
    // First Promise.all: header + four child collections.
    stageSupabaseResponse("patients", "select", { data: null });
    stageSupabaseResponse("prescriptions", "select", { data: [] });
    stageSupabaseResponse("episodes", "select", { data: [] });
    stageSupabaseResponse("conversations", "select", { data: [] });
    stageSupabaseResponse("fulfillments", "select", { data: [] });
    const res = await request(makeApp()).get(
      `/resupply-api/patients/${PATIENT_ID}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("returns full detail and writes a patient.view audit row", async () => {
    stubVerifiedAdmin();
    // First parallel block: header + four child collections.
    stageSupabaseResponse("patients", "select", {
      data: {
        id: PATIENT_ID,
        pacware_id: "PAC-001",
        legal_first_name: "Alice",
        legal_last_name: "Smith",
        status: "active",
        phone_e164: "+14155551212",
        email: "alice@example.com",
        insurance_payer: null,
        cadence_override_days: null,
        channel_preference: null,
        created_at: new Date("2025-01-15T10:00:00Z").toISOString(),
        updated_at: new Date("2025-01-15T10:00:00Z").toISOString(),
        portal_auth_user_id: null,
        portal_invited_at: null,
      },
    });
    stageSupabaseResponse("prescriptions", "select", {
      data: [
        {
          id: RX_ID,
          item_sku: "MASK-001",
          cadence_days: 90,
          valid_from: new Date("2025-01-01T00:00:00Z").toISOString(),
          valid_until: null,
          status: "active",
          created_at: new Date("2025-01-01T00:00:00Z").toISOString(),
          attachment_filename: null,
          attachment_content_type: null,
          attachment_size_bytes: null,
          attachment_uploaded_at: null,
        },
      ],
    });
    stageSupabaseResponse("episodes", "select", {
      data: [
        {
          id: EPISODE_ID,
          prescription_id: RX_ID,
          status: "outreach_pending",
          due_at: new Date("2025-04-01T00:00:00Z").toISOString(),
          expires_at: null,
          created_at: new Date("2025-04-01T00:00:00Z").toISOString(),
        },
      ],
    });
    stageSupabaseResponse("conversations", "select", {
      data: [
        {
          id: CONV_ID,
          episode_id: EPISODE_ID,
          channel: "sms",
          status: "open",
          last_message_at: new Date("2025-04-02T12:00:00Z").toISOString(),
          created_at: new Date("2025-04-02T11:00:00Z").toISOString(),
        },
      ],
    });
    stageSupabaseResponse("fulfillments", "select", {
      data: [
        {
          id: FUL_ID,
          episode_id: EPISODE_ID,
          item_sku: "MASK-001",
          quantity: "1",
          status: "queued",
          pacware_order_ref: null,
          submitted_at: null,
          shipped_at: null,
          delivered_at: null,
          created_at: new Date("2025-04-03T00:00:00Z").toISOString(),
        },
      ],
    });
    // Second parallel block: latest_message + auth + episode-rx bulk.
    stageSupabaseResponse("patient_latest_message", "select", { data: null });
    // No portal_auth_user_id → users skip is hit (resolved already).
    // Bulk lookup of episode prescriptions by id IN (...).
    stageSupabaseResponse("prescriptions", "select", {
      data: [{ id: RX_ID, item_sku: "MASK-001" }],
    });

    const res = await request(makeApp()).get(
      `/resupply-api/patients/${PATIENT_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(PATIENT_ID);
    expect(res.body.firstName).toBe("Alice");
    expect(res.body.hasPhone).toBe(true);
    expect(res.body.prescriptions).toHaveLength(1);
    expect(res.body.episodes).toHaveLength(1);
    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.fulfillments).toHaveLength(1);
    expect(res.body.episodes[0].itemSku).toBe("MASK-001");
    // No phone or email leaks.
    expect(res.body).not.toHaveProperty("phoneE164");
    expect(res.body).not.toHaveProperty("email");

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "patient.view",
        targetTable: "patients",
        targetId: PATIENT_ID,
        adminEmail: ALLOWED_EMAIL,
      }),
    );
  });
});

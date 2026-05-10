// Route tests for GET /patients.

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
const PATIENT_A = "11111111-1111-4111-8111-111111111111";
const PATIENT_B = "22222222-2222-4222-8222-222222222222";

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

function rowA() {
  return {
    id: PATIENT_A,
    pacware_id: "PAC-001",
    legal_first_name: "Alice",
    legal_last_name: "Smith",
    status: "active",
    phone_e164: "+14155551212",
    email: null,
    created_at: new Date("2025-01-15T10:00:00Z").toISOString(),
    updated_at: new Date("2025-01-15T10:00:00Z").toISOString(),
  };
}
function rowB() {
  return {
    id: PATIENT_B,
    pacware_id: "PAC-002",
    legal_first_name: "Bob",
    legal_last_name: "Jones",
    status: "paused",
    phone_e164: null,
    email: "bob@example.com",
    created_at: new Date("2025-01-10T10:00:00Z").toISOString(),
    updated_at: new Date("2025-01-12T10:00:00Z").toISOString(),
  };
}

describe("GET /patients", () => {
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
    const res = await request(makeApp()).get("/resupply-api/patients");
    expect(res.status).toBe(401);
  });

  it("returns 400 invalid_query on bad limit", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp()).get(
      "/resupply-api/patients?limit=999",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("returns 400 invalid_query on bad status", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp()).get(
      "/resupply-api/patients?status=zzz",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("returns paginated, decrypted-name page with hasPhone/hasEmail booleans", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("patients", "select", {
      data: [rowA(), rowB()],
      count: 2,
    });
    // Bulk-fetch the latest-message projection.
    stageSupabaseResponse("patient_latest_message", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/resupply-api/patients?limit=10&offset=0",
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(0);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({
      id: PATIENT_A,
      pacwareId: "PAC-001",
      firstName: "Alice",
      lastName: "Smith",
      status: "active",
      hasPhone: true,
      hasEmail: false,
    });
    // No phone or email VALUES leak — only booleans.
    expect(res.body.items[0]).not.toHaveProperty("phoneE164");
    expect(res.body.items[0]).not.toHaveProperty("email");
  });

  it("applies status + search filters without crashing", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("patients", "select", { data: [], count: 0 });

    const res = await request(makeApp()).get(
      "/resupply-api/patients?status=active&search=alice",
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it("uses defaults limit=25 offset=0 when not supplied", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("patients", "select", { data: [], count: 0 });

    const res = await request(makeApp()).get("/resupply-api/patients");
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(25);
    expect(res.body.offset).toBe(0);
  });

  // ----- Search by phone (HMAC-indexed, exact match) -----------------
  it("returns the matched patient when search is a valid E.164 phone", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("patients", "select", {
      data: [rowA()],
      count: 1,
    });
    stageSupabaseResponse("patient_latest_message", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/resupply-api/patients?search=%2B14155551212",
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: PATIENT_A,
      firstName: "Alice",
      hasPhone: true,
    });
  });

  it("returns empty page when phone search has no match", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("patients", "select", { data: [], count: 0 });

    const res = await request(makeApp()).get(
      "/resupply-api/patients?search=%2B14155550000",
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });

  // Loose-format phone normalises and uses the equality path. The
  // mock ignores the predicate shape — we only assert the response
  // is well-formed.
  it("accepts loose-formatted phone input via the equality path", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("patients", "select", { data: [], count: 0 });

    const res = await request(makeApp()).get(
      "/resupply-api/patients?search=%28415%29%20555-1212",
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  // ----- Search by email substring (ILIKE union path) ----------------
  it("accepts email-fragment search via the ILIKE path", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("patients", "select", {
      data: [rowB()],
      count: 1,
    });
    stageSupabaseResponse("patient_latest_message", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/resupply-api/patients?search=%40gmail.com",
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      id: PATIENT_B,
      hasEmail: true,
    });
  });
});

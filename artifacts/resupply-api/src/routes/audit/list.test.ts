// Route tests for GET /audit.

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
  getSupabaseFilterCalls,
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
const AUDIT_ID = "11111111-1111-4111-8111-111111111111";

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

describe("GET /audit", () => {
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
    const res = await request(makeApp()).get("/resupply-api/audit");
    expect(res.status).toBe(401);
  });

  it("returns 400 invalid_query on bad since", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp()).get("/resupply-api/audit?since=nope");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("returns 400 invalid_query on bad limit", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp()).get("/resupply-api/audit?limit=999");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("returns paginated audit rows with metadata as-is", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("audit_log", "select", {
      data: [
        {
          id: AUDIT_ID,
          occurred_at: new Date("2025-04-15T10:00:00Z").toISOString(),
          operator_email: "ops@penn.example.com",
          operator_user_id: "user_op",
          action: "patient.view",
          target_table: "patients",
          target_id: "22222222-2222-4222-8222-222222222222",
          metadata: { source: "console" },
          ip: "10.0.0.1",
          user_agent: "Mozilla/5.0",
        },
      ],
      count: 1,
    });

    const res = await request(makeApp()).get("/resupply-api/audit?limit=25");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      id: AUDIT_ID,
      action: "patient.view",
      targetTable: "patients",
      metadata: { source: "console" },
    });
  });

  it("translates filter params into the expected PostgREST chain", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("audit_log", "select", { data: [], count: 0 });
    const res = await request(makeApp()).get(
      "/resupply-api/audit?action=patient&targetTable=patients&since=2025-01-01T00:00:00Z",
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);

    // Each filter param must produce its corresponding chained verb on
    // the audit_log select; a regression that drops one would silently
    // return a wider result set.
    const filters = getSupabaseFilterCalls("audit_log", "select");
    expect(filters).toEqual(
      expect.arrayContaining([
        { verb: "ilike", args: ["action", "%patient%"] },
        { verb: "eq", args: ["target_table", "patients"] },
        {
          verb: "gte",
          args: ["occurred_at", "2025-01-01T00:00:00.000Z"],
        },
      ]),
    );
  });

  it("returns metadata={} when row has nullish metadata", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("audit_log", "select", {
      data: [
        {
          id: AUDIT_ID,
          occurred_at: new Date("2025-04-15T10:00:00Z").toISOString(),
          operator_email: null,
          operator_user_id: null,
          action: "system.heartbeat",
          target_table: null,
          target_id: null,
          metadata: null,
          ip: null,
          user_agent: null,
        },
      ],
      count: 1,
    });

    const res = await request(makeApp()).get("/resupply-api/audit");
    expect(res.status).toBe(200);
    expect(res.body.items[0].metadata).toEqual({});
  });
});

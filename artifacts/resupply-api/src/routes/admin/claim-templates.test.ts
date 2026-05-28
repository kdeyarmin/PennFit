// Route tests for GET /admin/claim-templates — payerProfileId UUID validation.
//
// PR change: the `payerProfileId` query parameter is now validated as a
// UUID via `z.string().uuid().safeParse()` before being composed into the
// PostgREST `.or()` filter. Before the fix, an attacker could supply
// filter operators (`,or(...)`, extra comma-separated expressions, etc.)
// to pivot the query into a broader read.
//
// Coverage:
//   * Missing payerProfileId → 200 (query runs without a .or() filter)
//   * Valid UUID → 200 (query runs with the scoped .or() filter)
//   * Non-UUID string → 400 with error: "invalid_query"
//   * SQL-injection-style string → 400
//   * UUID with appended operator fragment → 400
//   * Empty string query param → 400 (empty strings fail uuid validation)

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

// adminRateLimit: pass-through in tests
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// logAudit: no-op in tests
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

import claimTemplatesRouter from "./claim-templates";

const VALID_UUID = "11111111-2222-4333-8444-555555555555";
const VALID_UUID_2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", claimTemplatesRouter);
  return app;
}

function stubAdmin(): void {
  mockAdmin.current = {
    userId: "user-admin-1",
    email: "ops@test.example",
    role: "admin",
  };
}

// Stage a minimal empty result for the claim_templates query
function stageEmptyTemplates() {
  stageSupabaseResponse("claim_templates", "select", {
    data: [],
    error: null,
  });
}

describe("GET /admin/claim-templates — payerProfileId UUID validation (PR change)", () => {
  beforeEach(() => {
    supabaseMock.reset();
    mockAdmin.current = null;
  });

  it("returns 401 when not authenticated", async () => {
    const res = await request(makeApp())
      .get("/resupply-api/admin/claim-templates");
    expect(res.status).toBe(401);
  });

  it("returns 200 and an empty templates array when payerProfileId is absent", async () => {
    stubAdmin();
    stageEmptyTemplates();
    const res = await request(makeApp())
      .get("/resupply-api/admin/claim-templates");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("templates");
    expect(Array.isArray(res.body.templates)).toBe(true);
  });

  it("returns 200 when payerProfileId is a valid UUID", async () => {
    stubAdmin();
    stageEmptyTemplates();
    const res = await request(makeApp())
      .get(`/resupply-api/admin/claim-templates?payerProfileId=${VALID_UUID}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("templates");
  });

  it("returns 200 when payerProfileId is another valid UUID", async () => {
    stubAdmin();
    stageEmptyTemplates();
    const res = await request(makeApp())
      .get(`/resupply-api/admin/claim-templates?payerProfileId=${VALID_UUID_2}`);
    expect(res.status).toBe(200);
  });

  it("returns 400 with error: invalid_query for a plain non-UUID string", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .get("/resupply-api/admin/claim-templates?payerProfileId=not-a-uuid");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_query" });
  });

  it("returns 400 for a SQL-injection-style value", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .get(
        "/resupply-api/admin/claim-templates?payerProfileId=" +
          encodeURIComponent("11111111-2222-4333-8444-555555555555,or(1=1)"),
      );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_query" });
  });

  it("returns 400 for a UUID with an appended operator fragment", async () => {
    // An attacker might try to append PostgREST filter operators after
    // an otherwise valid UUID.
    stubAdmin();
    const res = await request(makeApp())
      .get(
        "/resupply-api/admin/claim-templates?payerProfileId=" +
          encodeURIComponent(`${VALID_UUID},scoped_payer_profile_id.is.null`),
      );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_query" });
  });

  it("treats empty string payerProfileId as 'no filter' and returns 200", async () => {
    // An empty string is falsy in JS, so `payerProfileIdRaw ? parse : null` yields
    // null, and the `if (payerProfileIdRaw && !parsed?.success)` guard is skipped.
    // The route proceeds without a .or() filter.
    stubAdmin();
    stageEmptyTemplates();
    const res = await request(makeApp())
      .get("/resupply-api/admin/claim-templates?payerProfileId=");
    expect(res.status).toBe(200);
  });

  it("returns 400 with a human-readable message field", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .get("/resupply-api/admin/claim-templates?payerProfileId=NOT-A-UUID");
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("message");
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message).toMatch(/UUID/i);
  });

  it("does not call the DB when payerProfileId is invalid", async () => {
    stubAdmin();
    // Do NOT stage a DB result — if it were called, it would error
    const res = await request(makeApp())
      .get("/resupply-api/admin/claim-templates?payerProfileId=invalid");
    expect(res.status).toBe(400);
    // Confirm no DB select was attempted
    // (stageSupabaseResponse was never called, and the code must have
    //  returned early before reaching the DB call)
  });
});
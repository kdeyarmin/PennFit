// Tests for era-ingest route — adminRateLimit removal.
//
// Scope: only the code changed in this PR:
//   - POST /admin/billing/era-ingest
//     (adminRateLimit with preset "sensitive" was REMOVED)
//
// The route still requires requireAdminOnly.
//
// Tests verify:
//   1. adminRateLimit is no longer wired (the spy is never invoked).
//   2. Route remains protected by requireAdminOnly (401/403).
//   3. Route functions normally without returning 429.
//   4. Duplicate detection, parse failures, and validation still work.

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

// ── Supabase mock (module-scoped) ────────────────────────────────────────────
const supabaseMock = installSupabaseMock();

// ── Auth mock ────────────────────────────────────────────────────────────────
const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// ── adminRateLimit spy — verifies it is NOT called ───────────────────────────
const adminRateLimitSpy = vi.hoisted(() =>
  vi.fn(
    (_opts: { name: string; preset?: string }) =>
      (
        _req: import("express").Request,
        _res: import("express").Response,
        next: import("express").NextFunction,
      ) => {
        next();
      },
  ),
);
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: adminRateLimitSpy,
}));

// ── Audit mock ───────────────────────────────────────────────────────────────
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

// ── ERA library mocks ────────────────────────────────────────────────────────
const parse835Mock = vi.hoisted(() =>
  vi.fn(() => ({
    checkOrEftNumber: "CHK123456",
    paymentDate: "2026-01-15",
    totalPaidCents: 50000,
    claims: [],
  })),
);
vi.mock("@workspace/resupply-integrations-office-ally", () => ({
  parse835: parse835Mock,
}));

const reconcileEraMock = vi.hoisted(() =>
  vi.fn(async () => ({
    paidClaims: 3,
    deniedClaims: 1,
    unmatchedClaims: 0,
    linesUpdated: 4,
  })),
);
vi.mock("../../lib/billing/era-reconciler", () => ({
  reconcileEra: reconcileEraMock,
}));

vi.mock("../../lib/webhooks/publisher", () => ({
  publishEvent: vi.fn(async () => undefined),
}));

import eraIngestRouter from "./era-ingest";

const ERA_FILE_UUID = "11111111-aaaa-4bbb-8000-000000000001";

// Minimal valid 835 EDI payload (> 50 chars to pass the min length check).
const VALID_PAYLOAD =
  "ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260115*1200*^*00501*000000001*0*P*:~";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(eraIngestRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "billing@example.com",
    role: "admin",
  };
}

function stubAgent() {
  mockAdmin.current = {
    userId: "u_agent_1",
    email: "agent@example.com",
    role: "agent",
  };
}

const validBody = {
  fileName: "era-2026-01-15.835",
  payload: VALID_PAYLOAD,
};

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  adminRateLimitSpy.mockClear();
  parse835Mock.mockClear();
  reconcileEraMock.mockClear();
});

// ── POST /admin/billing/era-ingest ───────────────────────────────────────────

describe("POST /admin/billing/era-ingest — adminRateLimit removed", () => {
  it("adminRateLimit is NOT called (middleware was removed from this route)", async () => {
    await request(makeApp()).post("/admin/billing/era-ingest").send(validBody);
    expect(adminRateLimitSpy).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated (requireAdminOnly still gates the route)", async () => {
    const res = await request(makeApp())
      .post("/admin/billing/era-ingest")
      .send(validBody);
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent (requireAdminOnly blocks non-admin)", async () => {
    stubAgent();
    const res = await request(makeApp())
      .post("/admin/billing/era-ingest")
      .send(validBody);
    expect(res.status).toBe(403);
  });

  it("does NOT return 429 when authenticated (no rate limiter present)", async () => {
    stubAdmin();
    stageSupabaseResponse("era_files", "select", { data: null }); // no duplicate
    stageSupabaseResponse("era_files", "insert", {
      data: { id: ERA_FILE_UUID },
    });
    stageSupabaseResponse("era_files", "update", { data: null });
    const res = await request(makeApp())
      .post("/admin/billing/era-ingest")
      .send(validBody);
    expect(res.status).not.toBe(429);
  });

  it("returns 201 with summary on successful ingest", async () => {
    stubAdmin();
    stageSupabaseResponse("era_files", "select", { data: null }); // no dup
    stageSupabaseResponse("era_files", "insert", {
      data: { id: ERA_FILE_UUID },
    });
    stageSupabaseResponse("era_files", "update", { data: null });
    const res = await request(makeApp())
      .post("/admin/billing/era-ingest")
      .send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.eraFileId).toBe(ERA_FILE_UUID);
    expect(res.body.status).toBe("processed");
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.paidClaims).toBe(3);
  });

  it("returns 409 when duplicate ERA file (same SHA-256)", async () => {
    stubAdmin();
    stageSupabaseResponse("era_files", "select", {
      data: { id: ERA_FILE_UUID, status: "processed" },
    });
    const res = await request(makeApp())
      .post("/admin/billing/era-ingest")
      .send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("duplicate");
    expect(res.body.eraFileId).toBe(ERA_FILE_UUID);
  });

  it("returns 400 when payload is too short (< 50 chars)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/billing/era-ingest")
      .send({ fileName: "test.835", payload: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when parse835 throws (corrupt file)", async () => {
    stubAdmin();
    stageSupabaseResponse("era_files", "select", { data: null });
    parse835Mock.mockImplementationOnce(() => {
      throw new Error("Invalid EDI segment");
    });
    const res = await request(makeApp())
      .post("/admin/billing/era-ingest")
      .send(validBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("parse_failed");
  });

  it("returns 400 for missing required fields", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/billing/era-ingest")
      .send({ fileName: "test.835" }); // missing payload
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 'partial' status when some claims are unmatched", async () => {
    stubAdmin();
    stageSupabaseResponse("era_files", "select", { data: null });
    stageSupabaseResponse("era_files", "insert", {
      data: { id: ERA_FILE_UUID },
    });
    stageSupabaseResponse("era_files", "update", { data: null });
    reconcileEraMock.mockResolvedValueOnce({
      paidClaims: 2,
      deniedClaims: 0,
      unmatchedClaims: 1, // has unmatched claim
      linesUpdated: 2,
    });
    const res = await request(makeApp())
      .post("/admin/billing/era-ingest")
      .send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("partial");
  });
});

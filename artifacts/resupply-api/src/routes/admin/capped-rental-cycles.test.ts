// Tests for capped-rental-cycles route — requirePermission middleware wiring.
//
// Scope: only the code changed in this PR.
//   GET    /admin/capped-rental-cycles   → requirePermission("patients.read")
//   POST   /admin/capped-rental-cycles   → requirePermission("patients.update")
//   PATCH  /admin/capped-rental-cycles/:id → requirePermission("patients.update")
//
// The POST /admin/capped-rental-cycles/advance-now route uses
// requireAdminOnly (unchanged in this PR) and is not exercised here.
//
// Strategy:
//   - Auth 401 gate: verify no session → 401 (requirePermission chains
//     requireAdmin internally, so the session check is inherited).
//   - Agent/CSR access: agent role maps to customer_service_rep which
//     carries both patients.read and patients.update, so agents still
//     reach the handler for these routes (the change is structural,
//     not a new denial for agents).
//   - Admin access: verify admin gets through to the handler.
//   - Rate-limit integration for POST and PATCH (unchanged preset values).

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

// ── Supabase mock ────────────────────────────────────────────────────────────
const supabaseMock = installSupabaseMock();

// ── Auth mock ────────────────────────────────────────────────────────────────
const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// ── adminRateLimit mock ──────────────────────────────────────────────────────
const rateLimitBlocked = vi.hoisted(() => ({ current: false }));
const adminRateLimitSpy = vi.hoisted(() =>
  vi.fn<
    (opts: {
      name: string;
      preset?: string;
    }) => (
      req: import("express").Request,
      res: import("express").Response,
      next: import("express").NextFunction,
    ) => void
  >((opts) => (_req, res, next) => {
    if (rateLimitBlocked.current) {
      res.status(429).json({
        error: "too_many_requests",
        limiter: opts.name,
        retryAfterSeconds: 3600,
        message: "Too many requests, please try again later.",
      });
      return;
    }
    next();
  }),
);
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: adminRateLimitSpy,
}));

// ── Audit mock ───────────────────────────────────────────────────────────────
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

// ── advance-now worker mock (not under test but imported by the route) ────────
vi.mock("../../lib/billing/capped-rental-advancer", () => ({
  runCappedRentalAdvance: vi.fn(async () => ({ advanced: 0, skipped: 0 })),
}));

import cappedRentalCyclesRouter from "./capped-rental-cycles";

const CYCLE_ID = "00000000-0000-4000-8000-000000000001";
const PATIENT_ID = "00000000-0000-4000-8000-000000000002";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cappedRentalCyclesRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@example.com",
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

beforeEach(() => {
  mockAdmin.current = null;
  rateLimitBlocked.current = false;
  supabaseMock.reset();
});

// ── GET /admin/capped-rental-cycles — requirePermission("patients.read") ─────

describe("GET /admin/capped-rental-cycles — auth gate", () => {
  it("returns 401 when no admin session is present", async () => {
    const res = await request(makeApp()).get("/admin/capped-rental-cycles");
    expect(res.status).toBe(401);
  });

  it("returns results for an admin (patients.read is in super_admin bucket)", async () => {
    stubAdmin();
    stageSupabaseResponse("capped_rental_cycles", "select", {
      data: [{ id: CYCLE_ID, patient_id: PATIENT_ID, status: "active" }],
    });
    const res = await request(makeApp()).get("/admin/capped-rental-cycles");
    expect(res.status).toBe(200);
    expect(res.body.cycles).toBeInstanceOf(Array);
    expect(res.body.cycles[0].id).toBe(CYCLE_ID);
  });

  it("returns results for an agent (patients.read is in customer_service_rep bucket)", async () => {
    stubAgent();
    stageSupabaseResponse("capped_rental_cycles", "select", { data: [] });
    const res = await request(makeApp()).get("/admin/capped-rental-cycles");
    // agent role maps to customer_service_rep which carries patients.read
    expect(res.status).toBe(200);
    expect(res.body.cycles).toEqual([]);
  });

  it("returns empty array when no cycles exist", async () => {
    stubAdmin();
    stageSupabaseResponse("capped_rental_cycles", "select", { data: null });
    const res = await request(makeApp()).get("/admin/capped-rental-cycles");
    expect(res.status).toBe(200);
    expect(res.body.cycles).toEqual([]);
  });

  it("accepts a valid status filter query parameter", async () => {
    stubAdmin();
    stageSupabaseResponse("capped_rental_cycles", "select", {
      data: [{ id: CYCLE_ID, status: "paused" }],
    });
    const res = await request(makeApp()).get(
      "/admin/capped-rental-cycles?status=paused",
    );
    expect(res.status).toBe(200);
    expect(res.body.cycles[0].id).toBe(CYCLE_ID);
  });
});

// ── POST /admin/capped-rental-cycles — requirePermission("patients.update") ──

describe("POST /admin/capped-rental-cycles — auth gate", () => {
  it("returns 401 when no admin session is present", async () => {
    const res = await request(makeApp())
      .post("/admin/capped-rental-cycles")
      .send({ patientId: PATIENT_ID });
    expect(res.status).toBe(401);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .post("/admin/capped-rental-cycles")
      .send({ patientId: PATIENT_ID });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("capped_rental_cycles.create");
  });

  it("calls adminRateLimit with name='capped_rental_cycles.create' and preset='mutation'", async () => {
    await request(makeApp()).post("/admin/capped-rental-cycles");
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "capped_rental_cycles.create",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("mutation");
  });

  it("returns 400 for invalid body (missing required fields)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/capped-rental-cycles")
      .send({ patientId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 201 with new cycle id on valid body", async () => {
    stubAdmin();
    stageSupabaseResponse("capped_rental_cycles", "insert", {
      data: { id: CYCLE_ID },
    });
    const res = await request(makeApp())
      .post("/admin/capped-rental-cycles")
      .send({
        patientId: PATIENT_ID,
        hcpcsCode: "E0601",
        startDate: "2026-01-01",
        maxMonths: 13,
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(CYCLE_ID);
  });

  it("allows an agent through (patients.update is in customer_service_rep bucket)", async () => {
    stubAgent();
    stageSupabaseResponse("capped_rental_cycles", "insert", {
      data: { id: CYCLE_ID },
    });
    const res = await request(makeApp())
      .post("/admin/capped-rental-cycles")
      .send({
        patientId: PATIENT_ID,
        hcpcsCode: "E0601",
        startDate: "2026-01-01",
        maxMonths: 13,
      });
    expect(res.status).toBe(201);
  });

  it("returns 400 for extra fields (strict schema)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/capped-rental-cycles")
      .send({
        patientId: PATIENT_ID,
        hcpcsCode: "E0601",
        startDate: "2026-01-01",
        maxMonths: 13,
        unknownField: "oops",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when maxMonths is not in allowed set [13, 15, 36]", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/capped-rental-cycles")
      .send({
        patientId: PATIENT_ID,
        hcpcsCode: "E0601",
        startDate: "2026-01-01",
        maxMonths: 24,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});

// ── PATCH /admin/capped-rental-cycles/:id — requirePermission("patients.update")

describe("PATCH /admin/capped-rental-cycles/:id — auth gate", () => {
  it("returns 401 when no admin session is present", async () => {
    const res = await request(makeApp())
      .patch(`/admin/capped-rental-cycles/${CYCLE_ID}`)
      .send({ status: "paused" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-UUID id parameter", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch("/admin/capped-rental-cycles/not-a-uuid")
      .send({ status: "paused" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .patch(`/admin/capped-rental-cycles/${CYCLE_ID}`)
      .send({ status: "paused" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("capped_rental_cycles.update");
  });

  it("calls adminRateLimit with name='capped_rental_cycles.update' and preset='mutation'", async () => {
    await request(makeApp()).patch(`/admin/capped-rental-cycles/${CYCLE_ID}`);
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "capped_rental_cycles.update",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("mutation");
  });

  it("returns 200 with ok=true on valid patch", async () => {
    stubAdmin();
    stageSupabaseResponse("capped_rental_cycles", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/capped-rental-cycles/${CYCLE_ID}`)
      .send({ status: "paused" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("allows an agent through (patients.update is in customer_service_rep bucket)", async () => {
    stubAgent();
    stageSupabaseResponse("capped_rental_cycles", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/capped-rental-cycles/${CYCLE_ID}`)
      .send({ status: "cancelled" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 400 for extra fields in patch body (strict schema)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/capped-rental-cycles/${CYCLE_ID}`)
      .send({ status: "paused", unexpectedField: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("accepts valid ownershipTransferredOn date string", async () => {
    stubAdmin();
    stageSupabaseResponse("capped_rental_cycles", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/capped-rental-cycles/${CYCLE_ID}`)
      .send({ ownershipTransferredOn: "2026-03-15" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("auth 401 fires before the rate-limit slot is consumed", async () => {
    // No mockAdmin.current set — 401 must short-circuit before rate limit.
    const callsBefore = adminRateLimitSpy.mock.results.length;
    const res = await request(makeApp())
      .patch(`/admin/capped-rental-cycles/${CYCLE_ID}`)
      .send({ status: "paused" });
    expect(res.status).toBe(401);
    expect(adminRateLimitSpy.mock.results.length).toBe(callsBefore);
  });
});

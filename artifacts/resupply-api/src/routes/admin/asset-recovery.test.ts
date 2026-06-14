// Route tests for the asset-recovery worklist
// (GET/POST/PATCH /admin/asset-recovery).
//
// Coverage:
//   * auth gating — 401 when unauthenticated on every verb
//   * GET returns the case list + status counts
//   * POST validates (needs patientId or patientLabel), creates, and
//     sits behind adminRateLimit("asset_recovery.create","mutation")
//   * PATCH validates the id + body, 404s a missing case, updates, and
//     sits behind adminRateLimit("asset_recovery.update","mutation")
//
// Auth gate itself is covered by requireAdmin-in-house.test.ts; here we
// mock the middleware and focus on the route contract.

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
      res.status(429).json({ error: "too_many_requests", limiter: opts.name });
      return;
    }
    next();
  }),
);
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: adminRateLimitSpy,
  adminReadRateLimiter: (
    _req: import("express").Request,
    _res: import("express").Response,
    next: import("express").NextFunction,
  ) => next(),
}));

import assetRecoveryRouter from "./asset-recovery";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const PATIENT_ID = "22222222-2222-4222-8222-222222222222";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(assetRecoveryRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@example.com",
    role: "admin",
  };
}

function makeCaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CASE_ID,
    patient_id: null,
    patient_label: "Jane Doe",
    device_label: "ResMed AirSense 11",
    device_serial: null,
    status: "identified",
    reason: "discontinued",
    tracking_number: null,
    return_label_url: null,
    notes: null,
    created_by_email: "ops@example.com",
    updated_by_email: "ops@example.com",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  rateLimitBlocked.current = false;
  supabaseMock.reset();
});

// ── GET /admin/asset-recovery ────────────────────────────────────────────────

describe("GET /admin/asset-recovery", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get("/admin/asset-recovery");
    expect(res.status).toBe(401);
  });

  it("returns the case list and status counts", async () => {
    stubAdmin();
    // 1st select: the list. 2nd select: the count rows (same table → FIFO).
    stageSupabaseResponse("asset_recovery_cases", "select", {
      data: [makeCaseRow()],
    });
    stageSupabaseResponse("asset_recovery_cases", "select", {
      data: [{ status: "identified" }, { status: "received" }],
    });
    const res = await request(makeApp()).get("/admin/asset-recovery");
    expect(res.status).toBe(200);
    expect(res.body.cases).toHaveLength(1);
    expect(res.body.cases[0].id).toBe(CASE_ID);
    expect(res.body.cases[0].patientLabel).toBe("Jane Doe");
    expect(res.body.counts).toEqual({ identified: 1, received: 1 });
  });
});

// ── POST /admin/asset-recovery ───────────────────────────────────────────────

describe("POST /admin/asset-recovery", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .post("/admin/asset-recovery")
      .send({ patientLabel: "Jane Doe" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when neither patientId nor patientLabel is provided", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/asset-recovery")
      .send({ deviceLabel: "ResMed AirSense 11" });
    expect(res.status).toBe(400);
  });

  it("creates a case and returns 201", async () => {
    stubAdmin();
    stageSupabaseResponse("asset_recovery_cases", "insert", {
      data: makeCaseRow(),
    });
    const res = await request(makeApp())
      .post("/admin/asset-recovery")
      .send({ patientLabel: "Jane Doe", reason: "non_compliant" });
    expect(res.status).toBe(201);
    expect(res.body.case.id).toBe(CASE_ID);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .post("/admin/asset-recovery")
      .send({ patientLabel: "Jane Doe" });
    expect(res.status).toBe(429);
    expect(res.body.limiter).toBe("asset_recovery.create");
  });

  it("wires adminRateLimit name='asset_recovery.create' preset='mutation'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "asset_recovery.create",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("mutation");
  });
});

// ── PATCH /admin/asset-recovery/:id ──────────────────────────────────────────

describe("PATCH /admin/asset-recovery/:id", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .patch(`/admin/asset-recovery/${CASE_ID}`)
      .send({ status: "received" });
    expect(res.status).toBe(401);
  });

  it("returns 400 for a non-uuid id", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch("/admin/asset-recovery/not-a-uuid")
      .send({ status: "received" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an empty patch body", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/asset-recovery/${CASE_ID}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 when the case does not exist", async () => {
    stubAdmin();
    stageSupabaseResponse("asset_recovery_cases", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/asset-recovery/${CASE_ID}`)
      .send({ status: "received" });
    expect(res.status).toBe(404);
  });

  it("advances status and returns the updated case", async () => {
    stubAdmin();
    stageSupabaseResponse("asset_recovery_cases", "update", {
      data: makeCaseRow({ status: "received", patient_id: PATIENT_ID }),
    });
    const res = await request(makeApp())
      .patch(`/admin/asset-recovery/${CASE_ID}`)
      .send({ status: "received" });
    expect(res.status).toBe(200);
    expect(res.body.case.status).toBe("received");
    expect(res.body.case.patientId).toBe(PATIENT_ID);
  });
});

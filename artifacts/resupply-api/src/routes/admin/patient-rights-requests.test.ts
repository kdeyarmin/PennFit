// Tests for patient-rights-requests route — adminRateLimit integration.
//
// Scope: only the code added in this PR:
//   - POST  /admin/compliance/patient-rights-requests
//     (requirePermission("compliance.resolve"), preset: sensitive)
//   - PATCH /admin/compliance/patient-rights-requests/:id
//     (requirePermission("compliance.resolve"), preset: sensitive)
//
// Both routes use "sensitive" preset (30/hr) — PHI-touching compliance data.
//
// Tests verify:
//   1. Auth/permission gate fires before rate limiting.
//   2. When adminRateLimit blocks, the route returns 429 with the correct limiter.
//   3. When adminRateLimit passes through, the handler runs normally.
//   4. adminRateLimit is invoked with the exact options from the PR diff.

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

// ── adminRateLimit mock ──────────────────────────────────────────────────────
const rateLimitBlocked = vi.hoisted(() => ({ current: false }));
const adminRateLimitSpy = vi.hoisted(() =>
  vi.fn<
    (opts: { name: string; preset?: string }) => (
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

// ── Compliance helper mock ────────────────────────────────────────────────────
vi.mock("../../lib/compliance/patient-rights-clock", () => ({
  computeDueByIso: vi.fn(() => "2026-06-30T00:00:00.000Z"),
}));

import patientRightsRouter from "./patient-rights-requests";

const REQUEST_UUID = "22222222-bbbb-4000-8000-000000000001";
const PATIENT_UUID = "33333333-cccc-4000-8000-000000000001";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(patientRightsRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "compliance@example.com",
    role: "admin",
  };
}

const validCreateBody = {
  patientId: PATIENT_UUID,
  requestKind: "access",
  submittedVia: "email",
  requestBody: "Patient requests a copy of all their records.",
};

beforeEach(() => {
  mockAdmin.current = null;
  rateLimitBlocked.current = false;
  supabaseMock.reset();
});

// ── POST /admin/compliance/patient-rights-requests ───────────────────────────

describe("POST /admin/compliance/patient-rights-requests — adminRateLimit integration (sensitive)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .post("/admin/compliance/patient-rights-requests")
      .send(validCreateBody);
    expect(res.status).toBe(401);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .post("/admin/compliance/patient-rights-requests")
      .send(validCreateBody);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("patient_rights_requests.create");
  });

  it("calls adminRateLimit with name='patient_rights_requests.create' and preset='sensitive'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "patient_rights_requests.create",
    );
    expect(call).toBeDefined();
    // PHI-adjacent compliance data uses the more conservative "sensitive" preset (30/hr).
    expect(call![0].preset).toBe("sensitive");
  });

  it("passes through and creates the rights request when not rate-limited", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_rights_requests", "insert", {
      data: { id: REQUEST_UUID },
    });
    const res = await request(makeApp())
      .post("/admin/compliance/patient-rights-requests")
      .send(validCreateBody);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(REQUEST_UUID);
  });

  it("returns 400 for invalid body (missing required fields)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/compliance/patient-rights-requests")
      .send({ patientId: PATIENT_UUID }); // missing requestKind, submittedVia, requestBody
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("does not reach the DB when 429 fires", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    await request(makeApp())
      .post("/admin/compliance/patient-rights-requests")
      .send(validCreateBody);
    // No DB insert should have been staged or consumed.
    expect(supabaseMock.callCount("patient_rights_requests", "insert")).toBe(0);
  });
});

// ── PATCH /admin/compliance/patient-rights-requests/:id ─────────────────────

describe("PATCH /admin/compliance/patient-rights-requests/:id — adminRateLimit integration (sensitive)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .patch(`/admin/compliance/patient-rights-requests/${REQUEST_UUID}`)
      .send({ status: "in_review" });
    expect(res.status).toBe(401);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .patch(`/admin/compliance/patient-rights-requests/${REQUEST_UUID}`)
      .send({ status: "in_review" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("patient_rights_requests.update");
  });

  it("calls adminRateLimit with name='patient_rights_requests.update' and preset='sensitive'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "patient_rights_requests.update",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("sensitive");
  });

  it("passes through and updates the rights request when not rate-limited", async () => {
    stubAdmin();
    // The PATCH handler does a direct .update().select("id") without a prior read.
    // Stage the update to return a non-empty array (row found and updated).
    stageSupabaseResponse("patient_rights_requests", "update", {
      data: [{ id: REQUEST_UUID }],
    });
    const res = await request(makeApp())
      .patch(`/admin/compliance/patient-rights-requests/${REQUEST_UUID}`)
      .send({ status: "in_review" });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.id).toBe(REQUEST_UUID);
  });

  it("both POST and PATCH use the same 'sensitive' preset (compliance parity)", () => {
    const postCall = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "patient_rights_requests.create",
    );
    const patchCall = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "patient_rights_requests.update",
    );
    expect(postCall![0].preset).toBe("sensitive");
    expect(patchCall![0].preset).toBe("sensitive");
  });
});
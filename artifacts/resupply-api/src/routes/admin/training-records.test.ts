// Tests for training-records route — adminRateLimit integration.
//
// Scope: only the code added in this PR:
//   - POST  /admin/compliance/training-records
//     (requirePermission("training.manage"), preset: mutation)
//   - PATCH /admin/compliance/training-records/:id
//     (requirePermission("training.manage"), preset: mutation)
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

// ── Training expiry helper mock ───────────────────────────────────────────────
vi.mock("../../lib/compliance/training-expiry", () => ({
  bucketizeTrainingExpiry: vi.fn((expiresAt: string | null) => {
    if (!expiresAt) return "never";
    return "valid";
  }),
}));

import trainingRecordsRouter from "./training-records";

const RECORD_UUID = "66666666-ffff-0000-0000-000000000001";
const STAFF_UUID = "77777777-aaaa-0000-0000-000000000001";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(trainingRecordsRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "training@example.com",
    role: "admin",
  };
}

const validCreateBody = {
  staffUserId: STAFF_UUID,
  trainingType: "hipaa_annual",
  completedAt: "2026-01-15T00:00:00.000Z",
};

beforeEach(() => {
  mockAdmin.current = null;
  rateLimitBlocked.current = false;
  supabaseMock.reset();
});

// ── POST /admin/compliance/training-records ──────────────────────────────────

describe("POST /admin/compliance/training-records — adminRateLimit integration", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .post("/admin/compliance/training-records")
      .send(validCreateBody);
    expect(res.status).toBe(401);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .post("/admin/compliance/training-records")
      .send(validCreateBody);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("training_records.create");
  });

  it("calls adminRateLimit with name='training_records.create' and preset='mutation'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "training_records.create",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("mutation");
  });

  it("passes through and creates training record when not rate-limited", async () => {
    stubAdmin();
    stageSupabaseResponse("staff_training_records", "insert", {
      data: { id: RECORD_UUID },
    });
    const res = await request(makeApp())
      .post("/admin/compliance/training-records")
      .send(validCreateBody);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(RECORD_UUID);
  });

  it("returns 400 for invalid body (missing required fields)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/compliance/training-records")
      .send({ staffUserId: STAFF_UUID }); // missing trainingType, completedAt
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when expiresAt precedes completedAt", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/compliance/training-records")
      .send({
        ...validCreateBody,
        completedAt: "2026-12-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:00:00.000Z", // before completedAt
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("does not reach the DB when 429 fires", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    await request(makeApp())
      .post("/admin/compliance/training-records")
      .send(validCreateBody);
    expect(supabaseMock.callCount("staff_training_records", "insert")).toBe(0);
  });
});

// ── PATCH /admin/compliance/training-records/:id ─────────────────────────────

describe("PATCH /admin/compliance/training-records/:id — adminRateLimit integration", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .patch(`/admin/compliance/training-records/${RECORD_UUID}`)
      .send({ creditHours: 2 });
    expect(res.status).toBe(401);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .patch(`/admin/compliance/training-records/${RECORD_UUID}`)
      .send({ creditHours: 2 });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("training_records.update");
  });

  it("calls adminRateLimit with name='training_records.update' and preset='mutation'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "training_records.update",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("mutation");
  });

  it("passes through and updates training record when not rate-limited", async () => {
    stubAdmin();
    // The PATCH handler does a direct .update().select("id") without a prior read.
    // Stage the update to return a non-empty array (row found and updated).
    stageSupabaseResponse("staff_training_records", "update", {
      data: [{ id: RECORD_UUID }],
    });
    const res = await request(makeApp())
      .patch(`/admin/compliance/training-records/${RECORD_UUID}`)
      // patchBody accepts: notes, provider, certificateReference, expiresAt
      .send({ notes: "Completed via portal" });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.id).toBe(RECORD_UUID);
  });

  it("returns 404 when record does not exist", async () => {
    stubAdmin();
    // Stage the update to return empty (record not found).
    stageSupabaseResponse("staff_training_records", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/compliance/training-records/${RECORD_UUID}`)
      .send({ notes: "Updated note" });
    expect(res.status).toBe(404);
  });

  it("both POST and PATCH use the 'mutation' preset (training parity)", () => {
    const postCall = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "training_records.create",
    );
    const patchCall = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "training_records.update",
    );
    expect(postCall![0].preset).toBe("mutation");
    expect(patchCall![0].preset).toBe("mutation");
  });
});

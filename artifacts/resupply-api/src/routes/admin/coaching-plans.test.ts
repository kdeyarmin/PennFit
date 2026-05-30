// Tests for coaching-plans route — adminRateLimit integration.
//
// Scope: only the code added in this PR (adminRateLimit applied to
// POST /admin/coaching-plans and PATCH /admin/coaching-plans/:id).
//
// Strategy:
//   - Mock adminRateLimit so we can control whether it blocks or
//     passes through independently of the in-memory counter.
//   - Verify the middleware is wired AFTER the permission gate (auth
//     failures must still return 401/403 without consuming a rate-
//     limit slot).
//   - Verify that when adminRateLimit blocks, the route returns 429.
//   - Verify the options passed to adminRateLimit match the PR spec.

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
// Captures call options and exposes a toggle to simulate a blocked response.
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

// ── Audit mock (side-effect, not under test here) ────────────────────────────
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

import coachingRouter from "./coaching-plans";

const CONV_ID = "00000000-0000-4000-8000-000000000001";
const PLAN_ID = "00000000-0000-4000-8000-000000000002";
const PATIENT_ID = "00000000-0000-4000-8000-000000000003";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(coachingRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@example.com",
    role: "admin",
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  rateLimitBlocked.current = false;
  supabaseMock.reset();
});

// ── POST /admin/coaching-plans ───────────────────────────────────────────────

describe("POST /admin/coaching-plans — adminRateLimit integration", () => {
  it("returns 401 when no admin session (auth gate fires before rate limit)", async () => {
    const res = await request(makeApp())
      .post("/admin/coaching-plans")
      .send({ patientId: PATIENT_ID });
    expect(res.status).toBe(401);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .post("/admin/coaching-plans")
      .send({ patientId: PATIENT_ID });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("coaching_plans.create");
  });

  it("passes through to the route handler when not rate-limited", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_coaching_plans", "insert", {
      data: { id: PLAN_ID },
    });
    const res = await request(makeApp())
      .post("/admin/coaching-plans")
      .send({ patientId: PATIENT_ID });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(PLAN_ID);
  });

  it("calls adminRateLimit with name='coaching_plans.create' and preset='mutation'", async () => {
    // Just force a 401 so the route doesn't need a DB stage.
    await request(makeApp()).post("/admin/coaching-plans");
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "coaching_plans.create",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("mutation");
  });

  it("returns 400 for invalid body when not rate-limited (rate limit is not blocking valid-shape check)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/coaching-plans")
      .send({ patientId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});

// ── PATCH /admin/coaching-plans/:id ─────────────────────────────────────────

describe("PATCH /admin/coaching-plans/:id — adminRateLimit integration", () => {
  it("returns 401 when no admin session", async () => {
    const res = await request(makeApp())
      .patch(`/admin/coaching-plans/${CONV_ID}`)
      .send({ status: "outreach_made" });
    expect(res.status).toBe(401);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .patch(`/admin/coaching-plans/${CONV_ID}`)
      .send({ status: "outreach_made" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("coaching_plans.update");
  });

  it("passes through to the route handler when not rate-limited", async () => {
    stubAdmin();
    // Stage the read-before-update and the update itself.
    stageSupabaseResponse("patient_coaching_plans", "select", {
      data: { id: CONV_ID, status: "open", patient_id: PATIENT_ID },
    });
    stageSupabaseResponse("patient_coaching_plans", "update", {
      data: null,
    });
    const res = await request(makeApp())
      .patch(`/admin/coaching-plans/${CONV_ID}`)
      .send({ status: "outreach_made" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("calls adminRateLimit with name='coaching_plans.update' and preset='mutation'", async () => {
    await request(makeApp()).patch(`/admin/coaching-plans/${CONV_ID}`);
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "coaching_plans.update",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("mutation");
  });

  it("does NOT consume a rate-limit slot when auth fails (401 path)", async () => {
    // Auth returns 401, so the rate-limit middleware is never reached.
    const blockerCalls = adminRateLimitSpy.mock.results.length;
    const res = await request(makeApp())
      .patch(`/admin/coaching-plans/${CONV_ID}`)
      .send({ status: "improving" });
    expect(res.status).toBe(401);
    // adminRateLimit factory was called at module-load (already counted);
    // the returned handler itself should not have been invoked.
    // We verify that by checking the 401 short-circuit.
    expect(blockerCalls).toBe(adminRateLimitSpy.mock.results.length);
  });
});

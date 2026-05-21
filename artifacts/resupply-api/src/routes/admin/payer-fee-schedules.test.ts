// Tests for payer-fee-schedules route — adminRateLimit integration.
//
// Scope: only the code added in this PR:
//   - POST  /admin/payer-fee-schedules       (requireAdminOnly, preset: sensitive)
//   - PATCH /admin/payer-fee-schedules/:id   (requireAdminOnly, preset: sensitive)
//
// Both routes use the "sensitive" preset (30/hr) — financial/billing data.
//
// Tests verify:
//   1. requireAdminOnly gates fire before rate limiting (agents blocked).
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

import payerFeeSchedulesRouter from "./payer-fee-schedules";

const FEE_SCHEDULE_UUID = "44444444-dddd-0000-0000-000000000001";
const PAYER_PROFILE_UUID = "55555555-eeee-0000-0000-000000000001";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(payerFeeSchedulesRouter);
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

const validCreateBody = {
  payerProfileId: PAYER_PROFILE_UUID,
  hcpcsCode: "A7030",
  allowedCents: 2500,
  effectiveFrom: "2026-01-01",
  source: "cms_published",
};

beforeEach(() => {
  mockAdmin.current = null;
  rateLimitBlocked.current = false;
  supabaseMock.reset();
});

// ── POST /admin/payer-fee-schedules ──────────────────────────────────────────

describe("POST /admin/payer-fee-schedules — adminRateLimit integration (sensitive preset)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .post("/admin/payer-fee-schedules")
      .send(validCreateBody);
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent (requireAdminOnly blocks non-admin)", async () => {
    stubAgent();
    const res = await request(makeApp())
      .post("/admin/payer-fee-schedules")
      .send(validCreateBody);
    expect(res.status).toBe(403);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .post("/admin/payer-fee-schedules")
      .send(validCreateBody);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("payer_fee_schedules.create");
  });

  it("calls adminRateLimit with name='payer_fee_schedules.create' and preset='sensitive'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "payer_fee_schedules.create",
    );
    expect(call).toBeDefined();
    // Financial billing data uses "sensitive" preset (30/hr).
    expect(call![0].preset).toBe("sensitive");
  });

  it("passes through and creates fee schedule when not rate-limited", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_fee_schedules", "insert", {
      data: { id: FEE_SCHEDULE_UUID },
    });
    const res = await request(makeApp())
      .post("/admin/payer-fee-schedules")
      .send(validCreateBody);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(FEE_SCHEDULE_UUID);
  });

  it("returns 400 for invalid body", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-fee-schedules")
      .send({ payerProfileId: PAYER_PROFILE_UUID }); // missing required fields
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when effectiveThrough precedes effectiveFrom", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-fee-schedules")
      .send({
        ...validCreateBody,
        effectiveFrom: "2026-12-01",
        effectiveThrough: "2026-01-01", // before effectiveFrom
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});

// ── PATCH /admin/payer-fee-schedules/:id ─────────────────────────────────────

describe("PATCH /admin/payer-fee-schedules/:id — adminRateLimit integration (sensitive preset)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .patch(`/admin/payer-fee-schedules/${FEE_SCHEDULE_UUID}`)
      .send({ allowedCents: 3000 });
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent (requireAdminOnly blocks non-admin)", async () => {
    stubAgent();
    const res = await request(makeApp())
      .patch(`/admin/payer-fee-schedules/${FEE_SCHEDULE_UUID}`)
      .send({ allowedCents: 3000 });
    expect(res.status).toBe(403);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .patch(`/admin/payer-fee-schedules/${FEE_SCHEDULE_UUID}`)
      .send({ allowedCents: 3000 });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("payer_fee_schedules.update");
  });

  it("calls adminRateLimit with name='payer_fee_schedules.update' and preset='sensitive'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "payer_fee_schedules.update",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("sensitive");
  });

  it("passes through and updates fee schedule when not rate-limited", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_fee_schedules", "update", {
      data: null,
    });
    const res = await request(makeApp())
      .patch(`/admin/payer-fee-schedules/${FEE_SCHEDULE_UUID}`)
      .send({ allowedCents: 3000 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("both POST and PATCH use the 'sensitive' preset (financial parity)", () => {
    const postCall = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "payer_fee_schedules.create",
    );
    const patchCall = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "payer_fee_schedules.update",
    );
    expect(postCall![0].preset).toBe("sensitive");
    expect(patchCall![0].preset).toBe("sensitive");
  });
});
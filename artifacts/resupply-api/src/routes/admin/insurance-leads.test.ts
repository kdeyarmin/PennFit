// Tests for insurance-leads route — adminRateLimit integration.
//
// Scope: only the code added in this PR:
//   - PATCH /admin/shop/insurance-leads/:id
//     (requirePermission("conversations.manage"), preset: mutation)
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

import insuranceLeadsRouter from "./insurance-leads";

// The route validates :id against a UUID regex (ID_RE in the source).
const LEAD_ID = "aabbccdd-1122-4000-8000-000000000099";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(insuranceLeadsRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@example.com",
    role: "admin",
  };
}

function makeLeadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LEAD_ID,
    patient_id: "p_001",
    status: "contacted",
    csr_note: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    moderated_at: "2026-01-01T00:00:00.000Z",
    moderated_by: "ops@example.com",
    ...overrides,
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  rateLimitBlocked.current = false;
  supabaseMock.reset();
});

// ── PATCH /admin/shop/insurance-leads/:id ────────────────────────────────────

describe("PATCH /admin/shop/insurance-leads/:id — adminRateLimit integration", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .patch(`/admin/shop/insurance-leads/${LEAD_ID}`)
      .send({ status: "contacted" });
    expect(res.status).toBe(401);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .patch(`/admin/shop/insurance-leads/${LEAD_ID}`)
      .send({ status: "contacted" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("insurance_leads.update");
  });

  it("calls adminRateLimit with name='insurance_leads.update' and preset='mutation'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "insurance_leads.update",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("mutation");
  });

  it("passes through and updates lead status when not rate-limited", async () => {
    stubAdmin();
    // Route uses .maybeSingle() — stage a single object, not an array.
    stageSupabaseResponse("insurance_leads", "update", {
      data: makeLeadRow({ status: "contacted" }),
    });
    const res = await request(makeApp())
      .patch(`/admin/shop/insurance-leads/${LEAD_ID}`)
      .send({ status: "contacted" });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(LEAD_ID);
    expect(res.body.status).toBe("contacted");
  });

  it("returns 400 for invalid ID format", async () => {
    stubAdmin();
    // ID with invalid characters (spaces, special chars not in the regex).
    const res = await request(makeApp())
      .patch("/admin/shop/insurance-leads/bad id!")
      .send({ status: "contacted" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_id");
  });

  it("returns 400 for invalid body (unknown status value)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/shop/insurance-leads/${LEAD_ID}`)
      .send({ status: "unknown_status" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 404 when the lead is not found", async () => {
    stubAdmin();
    // maybeSingle() returns null when no row matches.
    stageSupabaseResponse("insurance_leads", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/shop/insurance-leads/${LEAD_ID}`)
      .send({ status: "contacted" });
    expect(res.status).toBe(404);
  });
});

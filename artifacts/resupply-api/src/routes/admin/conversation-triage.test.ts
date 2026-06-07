// Tests for conversation-triage route — adminRateLimit integration.
//
// Scope: only the code added in this PR:
//   - PATCH /admin/conversations/:id/snooze  (preset: mutation)
//   - PATCH /admin/conversations/:id/tags    (preset: mutation)
//   - POST  /admin/conversations/:id/claim   (preset: mutation)
//
// All three routes are gated by requirePermission("conversations.manage").
// Tests verify:
//   1. Auth/permission gates still fire before the rate-limit middleware.
//   2. When adminRateLimit blocks, the route returns 429 with the
//      correct limiter name.
//   3. When adminRateLimit passes through, the route handler runs normally.
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

// ── Audit mock ───────────────────────────────────────────────────────────────
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

import triageRouter from "./conversation-triage";

const CONV_UUID = "aaaabbbb-0000-4000-8000-000000000001";
const ADMIN_USER_ID = "u_admin_42";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(triageRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: ADMIN_USER_ID,
    email: "ops@example.com",
    role: "admin",
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  rateLimitBlocked.current = false;
  supabaseMock.reset();
});

// ── PATCH /admin/conversations/:id/snooze ────────────────────────────────────

describe("PATCH /admin/conversations/:id/snooze — adminRateLimit integration", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .patch(`/admin/conversations/${CONV_UUID}/snooze`)
      .send({ snoozedUntil: null });
    expect(res.status).toBe(401);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .patch(`/admin/conversations/${CONV_UUID}/snooze`)
      .send({ snoozedUntil: null });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("conversation_triage.snooze");
  });

  it("calls adminRateLimit with name='conversation_triage.snooze' and preset='mutation'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "conversation_triage.snooze",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("mutation");
  });

  it("passes through and applies snooze when not rate-limited", async () => {
    stubAdmin();
    stageSupabaseResponse("conversations", "update", {
      data: [{ id: CONV_UUID }],
    });
    const snoozedUntil = "2026-06-01T00:00:00.000Z";
    const res = await request(makeApp())
      .patch(`/admin/conversations/${CONV_UUID}/snooze`)
      .send({ snoozedUntil });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 404 when the conversation does not exist", async () => {
    stubAdmin();
    stageSupabaseResponse("conversations", "update", { data: [] });
    const res = await request(makeApp())
      .patch(`/admin/conversations/${CONV_UUID}/snooze`)
      .send({ snoozedUntil: null });
    expect(res.status).toBe(404);
  });

  it("resolves a relative snoozeSpec server-side and echoes the instant", async () => {
    stubAdmin();
    stageSupabaseResponse("conversations", "update", {
      data: [{ id: CONV_UUID }],
    });
    const res = await request(makeApp())
      .patch(`/admin/conversations/${CONV_UUID}/snooze`)
      .send({ snoozeSpec: "1d" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // A resolved future ISO instant is returned (not echoed verbatim).
    expect(typeof res.body.snoozedUntil).toBe("string");
    expect(Date.parse(res.body.snoozedUntil)).toBeGreaterThan(Date.now());
  });

  it("400s on an unrecognized snoozeSpec", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/conversations/${CONV_UUID}/snooze`)
      .send({ snoozeSpec: "someday" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_snooze_spec");
  });

  it("400s when neither snoozedUntil nor snoozeSpec is provided", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/conversations/${CONV_UUID}/snooze`)
      .send({});
    expect(res.status).toBe(400);
  });
});

// ── PATCH /admin/conversations/:id/tags ─────────────────────────────────────

describe("PATCH /admin/conversations/:id/tags — adminRateLimit integration", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .patch(`/admin/conversations/${CONV_UUID}/tags`)
      .send({ tags: ["billing"] });
    expect(res.status).toBe(401);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .patch(`/admin/conversations/${CONV_UUID}/tags`)
      .send({ tags: ["billing"] });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("conversation_triage.tags");
  });

  it("calls adminRateLimit with name='conversation_triage.tags' and preset='mutation'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "conversation_triage.tags",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("mutation");
  });

  it("passes through and updates tags when not rate-limited", async () => {
    stubAdmin();
    stageSupabaseResponse("conversations", "update", {
      data: [{ id: CONV_UUID }],
    });
    const res = await request(makeApp())
      .patch(`/admin/conversations/${CONV_UUID}/tags`)
      .send({ tags: ["billing", "urgent"] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.tags)).toBe(true);
  });
});

// ── POST /admin/conversations/:id/claim ─────────────────────────────────────

describe("POST /admin/conversations/:id/claim — adminRateLimit integration", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).post(
      `/admin/conversations/${CONV_UUID}/claim`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp()).post(
      `/admin/conversations/${CONV_UUID}/claim`,
    );
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("conversation_triage.claim");
  });

  it("calls adminRateLimit with name='conversation_triage.claim' and preset='mutation'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "conversation_triage.claim",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("mutation");
  });

  it("passes through and claims the conversation when unassigned", async () => {
    stubAdmin();
    stageSupabaseResponse("conversations", "update", {
      data: [{ id: CONV_UUID }],
    });
    const res = await request(makeApp()).post(
      `/admin/conversations/${CONV_UUID}/claim`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 409 when the conversation is already assigned", async () => {
    stubAdmin();
    // First update returns empty (someone else holds it or row not found).
    stageSupabaseResponse("conversations", "update", { data: [] });
    // Follow-up disambiguating select returns an existing assignee.
    stageSupabaseResponse("conversations", "select", {
      data: { assigned_admin_user_id: "u_other_admin" },
    });
    const res = await request(makeApp()).post(
      `/admin/conversations/${CONV_UUID}/claim`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_assigned");
    expect(res.body.assignedAdminUserId).toBe("u_other_admin");
  });

  it("returns 404 when the conversation does not exist", async () => {
    stubAdmin();
    stageSupabaseResponse("conversations", "update", { data: [] });
    stageSupabaseResponse("conversations", "select", { data: null });
    const res = await request(makeApp()).post(
      `/admin/conversations/${CONV_UUID}/claim`,
    );
    expect(res.status).toBe(404);
  });
});

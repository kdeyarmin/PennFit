// Tests for conversation-coaching-notes route — adminRateLimit removal.
//
// Scope: only the code changed in this PR:
//   - POST /admin/conversations/:id/coaching-notes
//     (adminRateLimit with preset "mutation" was REMOVED)
//
// The route still requires requirePermission("admin_team.manage").
//
// Tests verify:
//   1. adminRateLimit is no longer wired (the spy is never invoked).
//   2. Route remains protected by requirePermission (401).
//   3. Route functions normally without returning 429.
//   4. Business logic constraints (self-coaching, not-found) still apply.

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
      (_req: import("express").Request, _res: import("express").Response, next: import("express").NextFunction) => {
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

import coachingNotesRouter from "./conversation-coaching-notes";

const CONV_UUID = "eeeeeeee-5555-4000-8000-000000000001";
const NOTE_UUID = "ffffffff-6666-4000-8000-000000000001";
const ADMIN_USER_ID = "u_admin_42";
const TARGET_USER_ID = "u_agent_99";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(coachingNotesRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: ADMIN_USER_ID,
    email: "supervisor@example.com",
    role: "admin",
  };
}

const validCreateBody = {
  targetUserId: TARGET_USER_ID,
  kind: "suggestion",
  body: "Great job handling the billing dispute, but next time lead with empathy.",
};

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  adminRateLimitSpy.mockClear();
});

// ── POST /admin/conversations/:id/coaching-notes ─────────────────────────────

describe("POST /admin/conversations/:id/coaching-notes — adminRateLimit removed", () => {
  it("adminRateLimit is NOT called (middleware was removed from this route)", async () => {
    await request(makeApp())
      .post(`/admin/conversations/${CONV_UUID}/coaching-notes`)
      .send(validCreateBody);
    expect(adminRateLimitSpy).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated (requirePermission still gates the route)", async () => {
    const res = await request(makeApp())
      .post(`/admin/conversations/${CONV_UUID}/coaching-notes`)
      .send(validCreateBody);
    expect(res.status).toBe(401);
  });

  it("does NOT return 429 when authenticated (no rate limiter present)", async () => {
    stubAdmin();
    stageSupabaseResponse("conversations", "select", {
      data: { id: CONV_UUID },
    });
    stageSupabaseResponse("conversation_coaching_notes", "insert", {
      data: { id: NOTE_UUID },
    });
    const res = await request(makeApp())
      .post(`/admin/conversations/${CONV_UUID}/coaching-notes`)
      .send(validCreateBody);
    expect(res.status).not.toBe(429);
  });

  it("creates a coaching note and returns 201", async () => {
    stubAdmin();
    stageSupabaseResponse("conversations", "select", {
      data: { id: CONV_UUID },
    });
    stageSupabaseResponse("conversation_coaching_notes", "insert", {
      data: { id: NOTE_UUID },
    });
    const res = await request(makeApp())
      .post(`/admin/conversations/${CONV_UUID}/coaching-notes`)
      .send(validCreateBody);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(NOTE_UUID);
  });

  it("returns 404 when conversation id is not a UUID", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/conversations/not-a-uuid/coaching-notes")
      .send(validCreateBody);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 400 for invalid body (missing required field)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post(`/admin/conversations/${CONV_UUID}/coaching-notes`)
      .send({ targetUserId: TARGET_USER_ID, kind: "praise" }); // missing body
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for invalid kind value", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post(`/admin/conversations/${CONV_UUID}/coaching-notes`)
      .send({ ...validCreateBody, kind: "invalid_kind" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 409 when author tries to coach themselves", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post(`/admin/conversations/${CONV_UUID}/coaching-notes`)
      .send({
        targetUserId: ADMIN_USER_ID, // same as the authenticated user
        kind: "suggestion",
        body: "Self-coaching attempt",
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("self_coaching");
  });

  it("returns 404 when conversation does not exist", async () => {
    stubAdmin();
    stageSupabaseResponse("conversations", "select", { data: null });
    const res = await request(makeApp())
      .post(`/admin/conversations/${CONV_UUID}/coaching-notes`)
      .send(validCreateBody);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });
});
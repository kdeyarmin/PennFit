// Tests for office-ally-submissions route — adminRateLimit removal.
//
// Scope: only the code changed in this PR:
//   - PATCH /admin/office-ally-submissions/:id
//     (adminRateLimit with preset "sensitive" was REMOVED)
//
// The route still requires requireAdminOnly.
//
// Tests verify:
//   1. adminRateLimit is no longer wired (the spy is never invoked).
//   2. Route remains protected by requireAdminOnly (401/403).
//   3. Route functions normally without returning 429.
//   4. Validation errors and status transitions still work.

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

import officeAllySubmissionsRouter from "./office-ally-submissions";

const SUBMISSION_UUID = "33333333-cccc-dddd-0000-000000000001";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(officeAllySubmissionsRouter);
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

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  adminRateLimitSpy.mockClear();
});

// ── PATCH /admin/office-ally-submissions/:id ─────────────────────────────────

describe("PATCH /admin/office-ally-submissions/:id — adminRateLimit removed", () => {
  it("adminRateLimit is NOT called (middleware was removed from this route)", async () => {
    await request(makeApp())
      .patch(`/admin/office-ally-submissions/${SUBMISSION_UUID}`)
      .send({ status: "accepted_999" });
    expect(adminRateLimitSpy).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated (requireAdminOnly still gates the route)", async () => {
    const res = await request(makeApp())
      .patch(`/admin/office-ally-submissions/${SUBMISSION_UUID}`)
      .send({ status: "accepted_999" });
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent (requireAdminOnly blocks non-admin)", async () => {
    stubAgent();
    const res = await request(makeApp())
      .patch(`/admin/office-ally-submissions/${SUBMISSION_UUID}`)
      .send({ status: "accepted_999" });
    expect(res.status).toBe(403);
  });

  it("does NOT return 429 when authenticated (no rate limiter present)", async () => {
    stubAdmin();
    stageSupabaseResponse("office_ally_submissions", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/office-ally-submissions/${SUBMISSION_UUID}`)
      .send({ status: "accepted_999" });
    expect(res.status).not.toBe(429);
  });

  it("returns 200 with ok=true when update succeeds", async () => {
    stubAdmin();
    stageSupabaseResponse("office_ally_submissions", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/office-ally-submissions/${SUBMISSION_UUID}`)
      .send({ status: "accepted_999" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("updates ack file fields successfully", async () => {
    stubAdmin();
    stageSupabaseResponse("office_ally_submissions", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/office-ally-submissions/${SUBMISSION_UUID}`)
      .send({
        status: "accepted_999",
        ack999FileName: "ack-999-20260115.edi",
        ack999ReceivedAt: "2026-01-15T12:00:00.000Z",
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 404 when id param is not a UUID", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch("/admin/office-ally-submissions/not-a-uuid")
      .send({ status: "accepted_999" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 400 for invalid status value", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/office-ally-submissions/${SUBMISSION_UUID}`)
      .send({ status: "invalid_status" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for unknown field (strict schema)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/office-ally-submissions/${SUBMISSION_UUID}`)
      .send({ unknownField: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("accepts all valid status values", async () => {
    const validStatuses = [
      "queued",
      "uploaded",
      "accepted_999",
      "rejected_999",
      "accepted_277ca",
      "rejected_277ca",
      "transport_failed",
    ];
    for (const status of validStatuses) {
      stubAdmin();
      stageSupabaseResponse("office_ally_submissions", "update", { data: null });
      const res = await request(makeApp())
        .patch(`/admin/office-ally-submissions/${SUBMISSION_UUID}`)
        .send({ status });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    }
  });
});
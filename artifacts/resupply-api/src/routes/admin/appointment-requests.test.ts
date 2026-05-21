// Tests for appointment-requests route — RBAC migration.
//
// Scope: code changed in this PR:
//   - GET   /admin/appointment-requests         (requireAdmin → requirePermission("patients.update"))
//   - PATCH /admin/appointment-requests/:id     (no middleware change; requirePermission("conversations.manage") already present)
//
// Tests verify:
//   1. GET returns 401 when unauthenticated.
//   2. GET returns 403 when caller lacks patients.update permission.
//   3. GET happy path returns requests array for an admin.
//   4. GET respects the `include=closed` query parameter.
//   5. PATCH returns 401 when unauthenticated.
//   6. PATCH returns 403 when caller lacks conversations.manage permission.
//   7. PATCH validates body and returns 400 for invalid input.
//   8. PATCH returns 404 for non-UUID :id.
//   9. PATCH happy path succeeds and returns { ok: true }.

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

// ── adminRateLimit spy ───────────────────────────────────────────────────────
const adminRateLimitSpy = vi.hoisted(() =>
  vi.fn(
    (_opts: { name: string; preset?: string }) =>
      (
        _req: import("express").Request,
        _res: import("express").Response,
        next: import("express").NextFunction,
      ) => {
        next();
      },
  ),
);
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: adminRateLimitSpy,
}));

import appointmentRequestsRouter from "./appointment-requests";

const REQUEST_UUID = "cccccccc-3333-4000-8000-000000000001";
const PATIENT_UUID = "dddddddd-4444-4000-8000-000000000001";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(appointmentRequestsRouter);
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

function makeRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_UUID,
    requester_email: "patient@example.com",
    requester_name: "Alice Patient",
    requester_phone: "+15550001234",
    topic: "equipment",
    preferred_window: "morning",
    notes: null,
    status: "new",
    attached_patient_id: null,
    assigned_admin_user_id: null,
    triaged_at: null,
    scheduled_for: null,
    meeting_url: null,
    meeting_provider: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  adminRateLimitSpy.mockClear();
});

// ── GET /admin/appointment-requests ──────────────────────────────────────────

describe("GET /admin/appointment-requests — requirePermission(patients.update)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get("/admin/appointment-requests");
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent lacks patients.update permission", async () => {
    stubAgent();
    const res = await request(makeApp()).get("/admin/appointment-requests");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("permission_denied");
  });

  it("returns 200 with requests array for admin", async () => {
    stubAdmin();
    stageSupabaseResponse("appointment_requests", "select", {
      data: [makeRequestRow()],
    });
    const res = await request(makeApp()).get("/admin/appointment-requests");
    expect(res.status).toBe(200);
    expect(res.body.requests).toBeInstanceOf(Array);
    expect(res.body.requests).toHaveLength(1);
  });

  it("returns empty requests array when none found", async () => {
    stubAdmin();
    stageSupabaseResponse("appointment_requests", "select", { data: [] });
    const res = await request(makeApp()).get("/admin/appointment-requests");
    expect(res.status).toBe(200);
    expect(res.body.requests).toEqual([]);
  });

  it("maps snake_case row fields to camelCase in response", async () => {
    stubAdmin();
    stageSupabaseResponse("appointment_requests", "select", {
      data: [
        makeRequestRow({
          attached_patient_id: PATIENT_UUID,
          assigned_admin_user_id: "u_admin_99",
        }),
      ],
    });
    const res = await request(makeApp()).get("/admin/appointment-requests");
    expect(res.status).toBe(200);
    const row = res.body.requests[0];
    expect(row.requesterEmail).toBe("patient@example.com");
    expect(row.requesterName).toBe("Alice Patient");
    expect(row.attachedPatientId).toBe(PATIENT_UUID);
    expect(row.assignedAdminUserId).toBe("u_admin_99");
  });

  it("passes include=closed query param and still returns 200", async () => {
    stubAdmin();
    stageSupabaseResponse("appointment_requests", "select", {
      data: [makeRequestRow({ status: "declined" })],
    });
    const res = await request(makeApp()).get(
      "/admin/appointment-requests?include=closed",
    );
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
  });

  it("returns null-coalesced empty array when Supabase returns null", async () => {
    stubAdmin();
    stageSupabaseResponse("appointment_requests", "select", { data: null });
    const res = await request(makeApp()).get("/admin/appointment-requests");
    expect(res.status).toBe(200);
    expect(res.body.requests).toEqual([]);
  });
});

// ── PATCH /admin/appointment-requests/:id ────────────────────────────────────

describe("PATCH /admin/appointment-requests/:id — requirePermission(conversations.manage)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .patch(`/admin/appointment-requests/${REQUEST_UUID}`)
      .send({ status: "contacted" });
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent lacks conversations.manage permission", async () => {
    stubAgent();
    const res = await request(makeApp())
      .patch(`/admin/appointment-requests/${REQUEST_UUID}`)
      .send({ status: "contacted" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("permission_denied");
  });

  it("returns 404 for non-UUID :id", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch("/admin/appointment-requests/not-a-uuid")
      .send({ status: "contacted" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 400 for invalid status value", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/appointment-requests/${REQUEST_UUID}`)
      .send({ status: "invalid_status" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for unknown field (strict schema)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/appointment-requests/${REQUEST_UUID}`)
      .send({ unknownField: "value" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for invalid meetingUrl (not a valid URL)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/appointment-requests/${REQUEST_UUID}`)
      .send({ meetingUrl: "not-a-url" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 200 with { ok: true } on successful update", async () => {
    stubAdmin();
    stageSupabaseResponse("appointment_requests", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/appointment-requests/${REQUEST_UUID}`)
      .send({ status: "contacted" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("accepts all valid status values", async () => {
    const validStatuses = ["new", "contacted", "scheduled", "declined", "cancelled"];
    for (const status of validStatuses) {
      stubAdmin();
      stageSupabaseResponse("appointment_requests", "update", { data: null });
      const res = await request(makeApp())
        .patch(`/admin/appointment-requests/${REQUEST_UUID}`)
        .send({ status });
      expect(res.status).toBe(200);
    }
  });

  it("accepts valid meeting URL", async () => {
    stubAdmin();
    stageSupabaseResponse("appointment_requests", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/appointment-requests/${REQUEST_UUID}`)
      .send({ meetingUrl: "https://meet.example.com/room-123" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("accepts null values for optional fields", async () => {
    stubAdmin();
    stageSupabaseResponse("appointment_requests", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/appointment-requests/${REQUEST_UUID}`)
      .send({
        attachedPatientId: null,
        assignedAdminUserId: null,
        scheduledFor: null,
        notes: null,
        meetingUrl: null,
        meetingProvider: null,
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
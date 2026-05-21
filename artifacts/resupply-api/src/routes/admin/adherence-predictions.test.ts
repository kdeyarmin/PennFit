// Tests for adherence-predictions route — RBAC migration.
//
// Scope: code changed in this PR:
//   - POST /admin/patients/:id/adherence/score       (requireAdmin → requirePermission("patients.read"))
//   - GET  /admin/patients/:id/adherence/history     (requireAdmin → requirePermission("patients.read"))
//   - GET  /admin/adherence/at-risk                  (requireAdmin → requirePermission("patients.read"))
//
// Tests verify:
//   1. All three routes return 401 when unauthenticated.
//   2. All three routes return 403 when caller is an agent without patients.read.
//   3. Happy paths succeed for admin callers.
//   4. Validation (non-UUID :id) still returns 404.

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

// ── Audit mock ───────────────────────────────────────────────────────────────
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

// ── scoreAndPersistAdherence mock ────────────────────────────────────────────
const scoreAndPersistAdherenceMock = vi.hoisted(() =>
  vi.fn(async (_patientId: string) => ({
    probabilityCompliant: 0.85,
    daysOfTherapy: 90,
    scoredAt: "2026-01-01T00:00:00Z",
  })),
);
vi.mock("../../lib/clinical/adherence-predictor", () => ({
  scoreAndPersistAdherence: scoreAndPersistAdherenceMock,
}));

import adherencePredictionsRouter from "./adherence-predictions";

const PATIENT_UUID = "aaaaaaaa-1111-4000-8000-000000000001";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(adherencePredictionsRouter);
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

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  adminRateLimitSpy.mockClear();
  scoreAndPersistAdherenceMock.mockClear();
});

// ── POST /admin/patients/:id/adherence/score ─────────────────────────────────

describe("POST /admin/patients/:id/adherence/score — requirePermission(patients.read)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).post(
      `/admin/patients/${PATIENT_UUID}/adherence/score`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent lacks patients.read permission", async () => {
    stubAgent();
    const res = await request(makeApp()).post(
      `/admin/patients/${PATIENT_UUID}/adherence/score`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("permission_denied");
  });

  it("returns 404 for non-UUID patient id", async () => {
    stubAdmin();
    const res = await request(makeApp()).post(
      "/admin/patients/not-a-uuid/adherence/score",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 404 when patient not found (scoreAndPersistAdherence returns null)", async () => {
    stubAdmin();
    scoreAndPersistAdherenceMock.mockResolvedValueOnce(null);
    const res = await request(makeApp()).post(
      `/admin/patients/${PATIENT_UUID}/adherence/score`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("patient_not_found");
  });

  it("returns the score object on success", async () => {
    stubAdmin();
    const res = await request(makeApp()).post(
      `/admin/patients/${PATIENT_UUID}/adherence/score`,
    );
    expect(res.status).toBe(200);
    expect(res.body.probabilityCompliant).toBe(0.85);
    expect(res.body.daysOfTherapy).toBe(90);
  });

  it("calls scoreAndPersistAdherence with the patient UUID", async () => {
    stubAdmin();
    await request(makeApp()).post(
      `/admin/patients/${PATIENT_UUID}/adherence/score`,
    );
    expect(scoreAndPersistAdherenceMock).toHaveBeenCalledWith(PATIENT_UUID);
  });
});

// ── GET /admin/patients/:id/adherence/history ────────────────────────────────

describe("GET /admin/patients/:id/adherence/history — requirePermission(patients.read)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get(
      `/admin/patients/${PATIENT_UUID}/adherence/history`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent lacks patients.read permission", async () => {
    stubAgent();
    const res = await request(makeApp()).get(
      `/admin/patients/${PATIENT_UUID}/adherence/history`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("permission_denied");
  });

  it("returns 404 for non-UUID patient id", async () => {
    stubAdmin();
    const res = await request(makeApp()).get(
      "/admin/patients/not-a-uuid/adherence/history",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 200 with predictions array on success", async () => {
    stubAdmin();
    stageSupabaseResponse("adherence_predictions", "select", {
      data: [
        {
          patient_id: PATIENT_UUID,
          probability_compliant: 0.75,
          days_of_therapy: 60,
          scored_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get(
      `/admin/patients/${PATIENT_UUID}/adherence/history`,
    );
    expect(res.status).toBe(200);
    expect(res.body.predictions).toBeInstanceOf(Array);
    expect(res.body.predictions).toHaveLength(1);
  });

  it("returns empty predictions array when none exist", async () => {
    stubAdmin();
    stageSupabaseResponse("adherence_predictions", "select", { data: [] });
    const res = await request(makeApp()).get(
      `/admin/patients/${PATIENT_UUID}/adherence/history`,
    );
    expect(res.status).toBe(200);
    expect(res.body.predictions).toEqual([]);
  });

  it("returns predictions even when data is null (Supabase null coalesces to empty array)", async () => {
    stubAdmin();
    stageSupabaseResponse("adherence_predictions", "select", { data: null });
    const res = await request(makeApp()).get(
      `/admin/patients/${PATIENT_UUID}/adherence/history`,
    );
    expect(res.status).toBe(200);
    expect(res.body.predictions).toEqual([]);
  });
});

// ── GET /admin/adherence/at-risk ─────────────────────────────────────────────

describe("GET /admin/adherence/at-risk — requirePermission(patients.read)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get("/admin/adherence/at-risk");
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent lacks patients.read permission", async () => {
    stubAgent();
    const res = await request(makeApp()).get("/admin/adherence/at-risk");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("permission_denied");
  });

  it("returns 200 with at-risk predictions on success", async () => {
    stubAdmin();
    stageSupabaseResponse("adherence_predictions", "select", {
      data: [
        {
          patient_id: "bbbbbbbb-2222-4000-8000-000000000001",
          probability_compliant: 0.3,
          days_of_therapy: 30,
          scored_at: "2026-01-10T00:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get("/admin/adherence/at-risk");
    expect(res.status).toBe(200);
    expect(res.body.predictions).toBeInstanceOf(Array);
    expect(res.body.predictions).toHaveLength(1);
  });

  it("returns empty predictions array when no at-risk patients", async () => {
    stubAdmin();
    stageSupabaseResponse("adherence_predictions", "select", { data: [] });
    const res = await request(makeApp()).get("/admin/adherence/at-risk");
    expect(res.status).toBe(200);
    expect(res.body.predictions).toEqual([]);
  });

  it("returns empty predictions when Supabase returns null", async () => {
    stubAdmin();
    stageSupabaseResponse("adherence_predictions", "select", { data: null });
    const res = await request(makeApp()).get("/admin/adherence/at-risk");
    expect(res.status).toBe(200);
    expect(res.body.predictions).toEqual([]);
  });
});
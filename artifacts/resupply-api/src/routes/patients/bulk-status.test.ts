// Route tests for POST /patients/bulk-status.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const logAuditMock = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

import bulkStatusRouter from "./bulk-status";

const ALLOWED_EMAIL = "ops@penn.example.com";
const PATIENT_A = "11111111-1111-4111-8111-111111111111";
const PATIENT_B = "22222222-2222-4222-8222-222222222222";
const PATIENT_C = "33333333-3333-4333-8333-333333333333";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", bulkStatusRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  mockAdmin.current = {
    userId: "user_op",
    email: ALLOWED_EMAIL,
    role: "admin",
  };
}

const ENV_KEYS = ["RESUPPLY_ADMIN_EMAILS", "NODE_ENV"] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

describe("POST /patients/bulk-status", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
    process.env.NODE_ENV = "test";
    mockAdmin.current = null;
    supabaseMock.reset();
    logAuditMock.mockClear();
    stubVerifiedAdmin();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("updates all matched ids and returns updated[] with new status", async () => {
    const nowIso = "2026-04-28T12:00:00.000Z";
    stageSupabaseResponse("patients", "update", {
      data: [
        { id: PATIENT_A, updated_at: nowIso },
        { id: PATIENT_B, updated_at: nowIso },
      ],
    });

    const res = await request(makeApp())
      .post("/resupply-api/patients/bulk-status")
      .send({ ids: [PATIENT_A, PATIENT_B], status: "paused" });

    expect(res.status).toBe(200);
    expect(res.body.updated).toHaveLength(2);
    expect(res.body.updated[0]).toEqual({
      id: PATIENT_A,
      status: "paused",
      updatedAt: nowIso,
    });
    expect(res.body.failed).toEqual([]);
    // Per-row audit + summary audit = 3 calls total.
    expect(logAuditMock).toHaveBeenCalledTimes(3);
    const calls = logAuditMock.mock.calls as unknown as Array<
      [{ action: string; metadata: { updated_count: number } }]
    >;
    const summaryCall = calls.find(
      (c) => c[0].action === "patient.bulk_status_change",
    );
    expect(summaryCall).toBeDefined();
    expect(summaryCall![0].metadata.updated_count).toBe(2);
  });

  it("reports ids that didn't match as failed: not_found, partial success", async () => {
    const nowIso = "2026-04-28T12:00:00.000Z";
    // DB only returns 2 of the 3 ids — the missing one is the failure.
    stageSupabaseResponse("patients", "update", {
      data: [
        { id: PATIENT_A, updated_at: nowIso },
        { id: PATIENT_C, updated_at: nowIso },
      ],
    });

    const res = await request(makeApp())
      .post("/resupply-api/patients/bulk-status")
      .send({ ids: [PATIENT_A, PATIENT_B, PATIENT_C], status: "closed" });

    expect(res.status).toBe(200);
    expect(res.body.updated).toHaveLength(2);
    expect(res.body.failed).toEqual([{ id: PATIENT_B, error: "not_found" }]);
  });

  it("dedupes repeated ids before counting failures", async () => {
    const nowIso = "2026-04-28T12:00:00.000Z";
    stageSupabaseResponse("patients", "update", {
      data: [{ id: PATIENT_A, updated_at: nowIso }],
    });

    const res = await request(makeApp())
      .post("/resupply-api/patients/bulk-status")
      .send({ ids: [PATIENT_A, PATIENT_A, PATIENT_A], status: "active" });

    expect(res.status).toBe(200);
    // After dedupe → 1 id requested, 1 updated, 0 failed.
    expect(res.body.updated).toHaveLength(1);
    expect(res.body.failed).toEqual([]);
  });

  it("rejects empty id array with 400", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/patients/bulk-status")
      .send({ ids: [], status: "active" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("rejects oversize batch (>100) with 400", async () => {
    const ids: string[] = [];
    // Build 101 distinct uuids by varying the second hex digit.
    for (let i = 0; i < 101; i++) {
      const hex = (i + 0x10).toString(16).padStart(8, "0");
      ids.push(`${hex}-aaaa-4aaa-8aaa-${hex}aaaaaaaa`);
    }
    const res = await request(makeApp())
      .post("/resupply-api/patients/bulk-status")
      .send({ ids, status: "active" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("rejects unknown status with 400", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/patients/bulk-status")
      .send({ ids: [PATIENT_A], status: "deleted" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("rejects unauthenticated callers with 401", async () => {
    mockAdmin.current = null;
    const res = await request(makeApp())
      .post("/resupply-api/patients/bulk-status")
      .send({ ids: [PATIENT_A], status: "active" });
    expect(res.status).toBe(401);
  });
});

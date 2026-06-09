// Route tests for PATCH /patients/:id, focusing on optimistic
// concurrency (B2). Drives the three branches of the optimistic-
// concurrency logic via the shared Supabase mock.

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
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

import updateRouter from "./update";

const ALLOWED_EMAIL = "ops@penn.example.com";
const PATIENT = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", updateRouter);
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

describe("PATCH /patients/:id (optimistic concurrency)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;

    process.env.NODE_ENV = "test";
    mockAdmin.current = null;
    supabaseMock.reset();
    stubVerifiedAdmin();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("succeeds without a precondition (back-compat)", async () => {
    const newUpdatedAt = "2026-04-28T13:00:00.000Z";
    // UPDATE … RETURNING returns the row.
    stageSupabaseResponse("patients", "update", {
      data: [{ id: PATIENT, updated_at: newUpdatedAt }],
    });

    const res = await request(makeApp())
      .patch(`/resupply-api/patients/${PATIENT}`)
      .send({ status: "paused" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: PATIENT,
      changed: ["status"],
      updatedAt: newUpdatedAt,
    });
  });

  it("succeeds when expectedUpdatedAt matches the row", async () => {
    const expected = "2026-04-28T12:00:00.000Z";
    const newUpdatedAt = "2026-04-28T13:00:00.000Z";
    stageSupabaseResponse("patients", "update", {
      data: [{ id: PATIENT, updated_at: newUpdatedAt }],
    });

    const res = await request(makeApp())
      .patch(`/resupply-api/patients/${PATIENT}`)
      .send({ status: "active", expectedUpdatedAt: expected });

    expect(res.status).toBe(200);
    expect(res.body.updatedAt).toBe(newUpdatedAt);
  });

  it("returns 409 stale_patient when expectedUpdatedAt is stale but the row exists", async () => {
    // UPDATE returns 0 rows (stale precondition) → re-SELECT finds
    // the row → 409.
    stageSupabaseResponse("patients", "update", { data: [] });
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT } });

    const res = await request(makeApp())
      .patch(`/resupply-api/patients/${PATIENT}`)
      .send({
        status: "closed",
        expectedUpdatedAt: "2026-04-28T11:00:00.000Z",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("stale_patient");
  });

  it("returns 404 when the row truly doesn't exist (precondition supplied)", async () => {
    // UPDATE returns 0 rows AND re-SELECT finds nothing → 404.
    stageSupabaseResponse("patients", "update", { data: [] });
    stageSupabaseResponse("patients", "select", { data: null });

    const res = await request(makeApp())
      .patch(`/resupply-api/patients/${PATIENT}`)
      .send({
        status: "closed",
        expectedUpdatedAt: "2026-04-28T11:00:00.000Z",
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 404 without a precondition when the row doesn't exist", async () => {
    stageSupabaseResponse("patients", "update", { data: [] });

    const res = await request(makeApp())
      .patch(`/resupply-api/patients/${PATIENT}`)
      .send({ status: "active" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns the current updatedAt for a no-op (empty body)", async () => {
    const currentIso = "2026-04-28T12:00:00.000Z";
    stageSupabaseResponse("patients", "select", {
      data: { id: PATIENT, updated_at: currentIso },
    });

    const res = await request(makeApp())
      .patch(`/resupply-api/patients/${PATIENT}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: PATIENT,
      changed: [],
      updatedAt: currentIso,
    });
  });

  it("rejects malformed expectedUpdatedAt with 400", async () => {
    const res = await request(makeApp())
      .patch(`/resupply-api/patients/${PATIENT}`)
      .send({ status: "active", expectedUpdatedAt: "yesterday" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});

describe("PATCH /patients/:id — location assignment (multi-location)", () => {
  const LOCATION = "99999999-9999-4999-8999-999999999999";

  beforeEach(() => {
    process.env.NODE_ENV = "test";
    mockAdmin.current = null;
    supabaseMock.reset();
    stubVerifiedAdmin();
  });

  it("assigns an active location and writes location_id", async () => {
    // Validation lookup: an active location.
    stageSupabaseResponse("locations", "select", {
      data: { id: LOCATION, name: "Pittsburgh", is_active: true },
    });
    stageSupabaseResponse("patients", "update", {
      data: [{ id: PATIENT, updated_at: "2026-05-01T00:00:00.000Z" }],
    });

    const res = await request(makeApp())
      .patch(`/resupply-api/patients/${PATIENT}`)
      .send({ locationId: LOCATION });

    expect(res.status).toBe(200);
    expect(res.body.changed).toContain("location_id");
    const writes = getSupabaseWritePayloads("patients", "update");
    expect(writes[0]).toMatchObject({ location_id: LOCATION });
  });

  it("422s when the location is deactivated", async () => {
    stageSupabaseResponse("locations", "select", {
      data: { id: LOCATION, name: "Old Branch", is_active: false },
    });

    const res = await request(makeApp())
      .patch(`/resupply-api/patients/${PATIENT}`)
      .send({ locationId: LOCATION });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: "invalid_location",
      reason: "inactive",
    });
    // No patient write happened.
    expect(getSupabaseWritePayloads("patients", "update")).toEqual([]);
  });

  it("422s when the location does not exist", async () => {
    stageSupabaseResponse("locations", "select", { data: null });

    const res = await request(makeApp())
      .patch(`/resupply-api/patients/${PATIENT}`)
      .send({ locationId: LOCATION });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: "invalid_location",
      reason: "not_found",
    });
  });

  it("clears the assignment with null (no location lookup)", async () => {
    stageSupabaseResponse("patients", "update", {
      data: [{ id: PATIENT, updated_at: "2026-05-01T00:00:00.000Z" }],
    });

    const res = await request(makeApp())
      .patch(`/resupply-api/patients/${PATIENT}`)
      .send({ locationId: null });

    expect(res.status).toBe(200);
    expect(res.body.changed).toContain("location_id");
    const writes = getSupabaseWritePayloads("patients", "update");
    expect(writes[0]).toMatchObject({ location_id: null });
  });
});

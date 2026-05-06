// Route tests for PATCH /patients/:id, focusing on optimistic
// concurrency (B2). The fluent stub implements just enough of
// drizzle's UPDATE...RETURNING + SELECT shape to drive the three
// branches of the optimistic-concurrency logic.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const updateReturningQueue: unknown[][] = [];
const selectQueue: unknown[][] = [];
const dbStub = {
  update: vi.fn(() => {
    const obj: Record<string, unknown> = {
      set: () => obj,
      where: () => obj,
      returning: () => Promise.resolve(updateReturningQueue.shift() ?? []),
    };
    return obj;
  }),
  select: vi.fn(() => {
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      limit: () => obj,
      then: (
        resolve: (v: unknown) => unknown,
        reject: (e: unknown) => unknown,
      ) => Promise.resolve(selectQueue.shift() ?? []).then(resolve, reject),
    };
    return obj;
  }),
  insert: vi.fn(() => {
    const obj: Record<string, unknown> = {
      values: () => obj,
      onConflictDoUpdate: () => obj,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(undefined).then(resolve),
    };
    return obj;
  }),
};
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return {
    ...actual,
    getDbPool: () => ({}) as never,
  };
});

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
    updateReturningQueue.length = 0;
    selectQueue.length = 0;
    dbStub.update.mockClear();
    dbStub.select.mockClear();
    stubVerifiedAdmin();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("succeeds without a precondition (back-compat)", async () => {
    const newUpdatedAt = new Date("2026-04-28T13:00:00Z");
    updateReturningQueue.push([{ id: PATIENT, updatedAt: newUpdatedAt }]);

    const res = await request(makeApp())
      .patch(`/resupply-api/patients/${PATIENT}`)
      .send({ status: "paused" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: PATIENT,
      changed: ["status"],
      updatedAt: newUpdatedAt.toISOString(),
    });
  });

  it("succeeds when expectedUpdatedAt matches the row", async () => {
    const expected = "2026-04-28T12:00:00.000Z";
    const newUpdatedAt = new Date("2026-04-28T13:00:00Z");
    updateReturningQueue.push([{ id: PATIENT, updatedAt: newUpdatedAt }]);

    const res = await request(makeApp())
      .patch(`/resupply-api/patients/${PATIENT}`)
      .send({ status: "active", expectedUpdatedAt: expected });

    expect(res.status).toBe(200);
    expect(res.body.updatedAt).toBe(newUpdatedAt.toISOString());
  });

  it("returns 409 stale_patient when expectedUpdatedAt is stale but the row exists", async () => {
    // UPDATE returns 0 rows (stale precondition) → re-SELECT finds
    // the row → 409.
    updateReturningQueue.push([]);
    selectQueue.push([{ id: PATIENT }]);

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
    updateReturningQueue.push([]);
    selectQueue.push([]);

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
    updateReturningQueue.push([]);

    const res = await request(makeApp())
      .patch(`/resupply-api/patients/${PATIENT}`)
      .send({ status: "active" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns the current updatedAt for a no-op (empty body)", async () => {
    const current = new Date("2026-04-28T12:00:00Z");
    selectQueue.push([{ id: PATIENT, updatedAt: current }]);

    const res = await request(makeApp())
      .patch(`/resupply-api/patients/${PATIENT}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: PATIENT,
      changed: [],
      updatedAt: current.toISOString(),
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

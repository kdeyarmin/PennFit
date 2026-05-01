// Route tests for GET /episodes.

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

function fluent(result: unknown) {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    leftJoin: () => obj,
    orderBy: () => obj,
    limit: () => obj,
    offset: () => obj,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}
const selectQueue: unknown[] = [];
const dbStub = {
  select: vi.fn(() => fluent(selectQueue.shift() ?? [])),
};
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

vi.mock("@workspace/resupply-db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-db")>(
      "@workspace/resupply-db",
    );
  return { ...actual, getDbPool: () => ({}) as never };
});

import listRouter from "./list";

const ALLOWED_EMAIL = "ops@penn.example.com";
const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const RX_ID = "22222222-2222-4222-8222-222222222222";
const EP_ID = "33333333-3333-4333-8333-333333333333";

function makeApp(): Express {
  const app = express();
  app.use("/resupply-api", listRouter);
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

describe("GET /episodes", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NODE_ENV = "test";
    process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
    selectQueue.length = 0;
    mockAdmin.current = null;
    dbStub.select.mockClear();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("returns 401 with no session", async () => {    const res = await request(makeApp()).get("/resupply-api/episodes");
    expect(res.status).toBe(401);
  });

  it("returns 400 invalid_query on bad status", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp()).get("/resupply-api/episodes?status=zzz");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("returns paginated episodes joined with patient + prescription", async () => {
    stubVerifiedAdmin();
    selectQueue.push([{ count: 1 }]);
    selectQueue.push([
      {
        id: EP_ID,
        patientId: PATIENT_ID,
        patientFirstName: "Alice",
        patientLastName: "Smith",
        prescriptionId: RX_ID,
        itemSku: "MASK-001",
        cadenceDays: 90,
        status: "outreach_pending",
        dueAt: new Date("2025-04-01T00:00:00Z"),
        daysOverdue: 27,
        expiresAt: null,
        createdAt: new Date("2025-04-01T00:00:00Z"),
      },
    ]);

    const res = await request(makeApp()).get(
      "/resupply-api/episodes?status=overdue&limit=25",
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      id: EP_ID,
      patientId: PATIENT_ID,
      patientFirstName: "Alice",
      patientLastName: "Smith",
      itemSku: "MASK-001",
      cadenceDays: 90,
      status: "outreach_pending",
      daysOverdue: 27,
    });
  });

  it("returns empty page on no results", async () => {
    stubVerifiedAdmin();
    selectQueue.push([{ count: 0 }]);
    selectQueue.push([]);
    const res = await request(makeApp()).get(
      "/resupply-api/episodes?status=confirmed",
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

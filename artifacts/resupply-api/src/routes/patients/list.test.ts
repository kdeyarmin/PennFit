// Route tests for GET /patients.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const getAuthMock = vi.fn();
const getUserMock = vi.fn();
vi.mock("@clerk/express", () => ({
  getAuth: (...a: unknown[]) => getAuthMock(...a),
  clerkClient: {
    users: { getUser: (...a: unknown[]) => getUserMock(...a) },
  },
}));

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
  return {
    ...actual,
    getDbPool: () => ({}) as never,
  };
});

import listRouter from "./list";

const ALLOWED_EMAIL = "ops@penn.example.com";
const PATIENT_A = "11111111-1111-4111-8111-111111111111";
const PATIENT_B = "22222222-2222-4222-8222-222222222222";

function makeApp(): Express {
  const app = express();
  app.use("/resupply-api", listRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  getAuthMock.mockReturnValue({ userId: "user_op" });
  getUserMock.mockResolvedValue({
    primaryEmailAddressId: "eml_1",
    emailAddresses: [
      {
        id: "eml_1",
        emailAddress: ALLOWED_EMAIL,
        verification: { status: "verified" },
      },
    ],
  });
}

const ENV_KEYS = ["RESUPPLY_ADMIN_EMAILS", "NODE_ENV"] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

describe("GET /patients", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NODE_ENV = "test";
    process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
    selectQueue.length = 0;
    getAuthMock.mockReset();
    getUserMock.mockReset();
    dbStub.select.mockClear();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("returns 401 with no Clerk session", async () => {
    getAuthMock.mockReturnValue({ userId: null });
    const res = await request(makeApp()).get("/resupply-api/patients");
    expect(res.status).toBe(401);
  });

  it("returns 400 invalid_query on bad limit", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp()).get(
      "/resupply-api/patients?limit=999",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("returns 400 invalid_query on bad status", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp()).get(
      "/resupply-api/patients?status=zzz",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("returns paginated, decrypted-name page with hasPhone/hasEmail booleans", async () => {
    stubVerifiedAdmin();
    selectQueue.push([{ count: 2 }]);
    selectQueue.push([
      {
        id: PATIENT_A,
        pacwareId: "PAC-001",
        firstName: "Alice",
        lastName: "Smith",
        status: "active",
        hasPhone: true,
        hasEmail: false,
        createdAt: new Date("2025-01-15T10:00:00Z"),
        updatedAt: new Date("2025-01-15T10:00:00Z"),
      },
      {
        id: PATIENT_B,
        pacwareId: "PAC-002",
        firstName: "Bob",
        lastName: "Jones",
        status: "paused",
        hasPhone: false,
        hasEmail: true,
        createdAt: new Date("2025-01-10T10:00:00Z"),
        updatedAt: new Date("2025-01-12T10:00:00Z"),
      },
    ]);

    const res = await request(makeApp()).get(
      "/resupply-api/patients?limit=10&offset=0",
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(0);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({
      id: PATIENT_A,
      pacwareId: "PAC-001",
      firstName: "Alice",
      lastName: "Smith",
      status: "active",
      hasPhone: true,
      hasEmail: false,
    });
    // No phone or email VALUES leak — only booleans.
    expect(res.body.items[0]).not.toHaveProperty("phoneE164");
    expect(res.body.items[0]).not.toHaveProperty("email");
  });

  it("applies status + search filters without crashing", async () => {
    stubVerifiedAdmin();
    selectQueue.push([{ count: 0 }]);
    selectQueue.push([]);

    const res = await request(makeApp()).get(
      "/resupply-api/patients?status=active&search=alice",
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it("uses defaults limit=25 offset=0 when not supplied", async () => {
    stubVerifiedAdmin();
    selectQueue.push([{ count: 0 }]);
    selectQueue.push([]);

    const res = await request(makeApp()).get("/resupply-api/patients");
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(25);
    expect(res.body.offset).toBe(0);
  });
});

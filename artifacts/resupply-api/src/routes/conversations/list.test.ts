// Route tests for GET /conversations.

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
  return { ...actual, getDbPool: () => ({}) as never };
});

import listRouter from "./list";

const ALLOWED_EMAIL = "ops@penn.example.com";
const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const EPISODE_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "33333333-3333-4333-8333-333333333333";

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

describe("GET /conversations", () => {
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
    const res = await request(makeApp()).get("/resupply-api/conversations");
    expect(res.status).toBe(401);
  });

  it("returns 400 invalid_query on bad channel", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp()).get(
      "/resupply-api/conversations?channel=foo",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("returns paginated page joined with patient name", async () => {
    stubVerifiedAdmin();
    selectQueue.push([{ count: 1 }]);
    selectQueue.push([
      {
        id: CONV_ID,
        patientId: PATIENT_ID,
        patientFirstName: "Alice",
        patientLastName: "Smith",
        episodeId: EPISODE_ID,
        channel: "sms",
        status: "awaiting_admin",
        lastMessageAt: new Date("2025-04-02T12:00:00Z"),
        createdAt: new Date("2025-04-01T11:00:00Z"),
      },
    ]);

    const res = await request(makeApp()).get(
      "/resupply-api/conversations?status=awaiting_admin&limit=25",
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      id: CONV_ID,
      patientId: PATIENT_ID,
      patientFirstName: "Alice",
      patientLastName: "Smith",
      channel: "sms",
      status: "awaiting_admin",
    });
  });

  it("filters by patientId", async () => {
    stubVerifiedAdmin();
    selectQueue.push([{ count: 0 }]);
    selectQueue.push([]);
    const res = await request(makeApp()).get(
      `/resupply-api/conversations?patientId=${PATIENT_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

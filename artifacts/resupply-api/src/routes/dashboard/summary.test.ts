// Route tests for GET /dashboard/summary.
//
// Same fluent-stub pattern as sms/inbound.test.ts. We queue one
// `[{ count }]` row per COUNT(*) query in the order the handler
// runs them: activeConversations, awaitingAdmin, overdueEpisodes,
// fulfillmentsThisWeek, pausedPatients.

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

import summaryRouter from "./summary";

const ALLOWED_EMAIL = "ops@penn.example.com";

function makeApp(): Express {
  const app = express();
  app.use("/resupply-api", summaryRouter);
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

describe("GET /dashboard/summary", () => {
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
    const res = await request(makeApp()).get("/resupply-api/dashboard/summary");
    expect(res.status).toBe(401);
  });

  it("returns the five COUNT(*) values in the response body", async () => {
    stubVerifiedAdmin();
    selectQueue.push([{ count: 7 }]); // activeConversations
    selectQueue.push([{ count: 3 }]); // awaitingAdmin
    selectQueue.push([{ count: 12 }]); // overdueEpisodes
    selectQueue.push([{ count: 41 }]); // fulfillmentsThisWeek
    selectQueue.push([{ count: 2 }]); // pausedPatients

    const res = await request(makeApp()).get("/resupply-api/dashboard/summary");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      activeConversations: 7,
      awaitingAdmin: 3,
      overdueEpisodes: 12,
      fulfillmentsThisWeek: 41,
      pausedPatients: 2,
    });
  });

  it("defaults a missing count row to 0", async () => {
    stubVerifiedAdmin();
    selectQueue.push([]);
    selectQueue.push([{ count: 1 }]);
    selectQueue.push([]);
    selectQueue.push([]);
    selectQueue.push([]);

    const res = await request(makeApp()).get("/resupply-api/dashboard/summary");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      activeConversations: 0,
      awaitingAdmin: 1,
      overdueEpisodes: 0,
      fulfillmentsThisWeek: 0,
      pausedPatients: 0,
    });
  });
});

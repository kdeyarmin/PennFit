// Route tests for GET /conversations/:id.

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

const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

import detailRouter from "./detail";

const ALLOWED_EMAIL = "ops@penn.example.com";
const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const EPISODE_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "33333333-3333-4333-8333-333333333333";
const MSG_A = "44444444-4444-4444-8444-444444444444";
const MSG_B = "55555555-5555-4555-8555-555555555555";

function makeApp(): Express {
  const app = express();
  app.use("/resupply-api", detailRouter);
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

describe("GET /conversations/:id", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NODE_ENV = "test";
    process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
    selectQueue.length = 0;
    getAuthMock.mockReset();
    getUserMock.mockReset();
    dbStub.select.mockClear();
    logAuditMock.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("returns 401 with no Clerk session", async () => {
    getAuthMock.mockReturnValue({ userId: null });
    const res = await request(makeApp()).get(
      `/resupply-api/conversations/${CONV_ID}`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when conversation row is empty", async () => {
    stubVerifiedAdmin();
    selectQueue.push([]);
    const res = await request(makeApp()).get(
      `/resupply-api/conversations/${CONV_ID}`,
    );
    expect(res.status).toBe(404);
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("returns conversation + decrypted messages and writes a conversation.view audit row", async () => {
    stubVerifiedAdmin();
    selectQueue.push([
      {
        id: CONV_ID,
        patientId: PATIENT_ID,
        patientFirstName: "Alice",
        patientLastName: "Smith",
        episodeId: EPISODE_ID,
        channel: "sms",
        status: "open",
        lastMessageAt: new Date("2025-04-02T12:00:00Z"),
        createdAt: new Date("2025-04-01T11:00:00Z"),
      },
    ]);
    selectQueue.push([
      {
        id: MSG_A,
        direction: "outbound",
        senderRole: "admin",
        body: "Hi Alice, your CPAP supplies are due. Reply YES to confirm.",
        deliveryStatus: "delivered",
        sentAt: new Date("2025-04-01T11:01:00Z"),
        deliveredAt: new Date("2025-04-01T11:01:05Z"),
        createdAt: new Date("2025-04-01T11:01:00Z"),
      },
      {
        id: MSG_B,
        direction: "inbound",
        senderRole: "patient",
        body: "YES",
        deliveryStatus: null,
        sentAt: null,
        deliveredAt: null,
        createdAt: new Date("2025-04-02T12:00:00Z"),
      },
    ]);

    const res = await request(makeApp()).get(
      `/resupply-api/conversations/${CONV_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(CONV_ID);
    expect(res.body.patientFirstName).toBe("Alice");
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[0].body).toMatch(/CPAP supplies/);
    expect(res.body.messages[1].body).toBe("YES");

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.view",
        targetTable: "conversations",
        targetId: CONV_ID,
        adminEmail: ALLOWED_EMAIL,
        metadata: expect.objectContaining({
          source: "console",
          channel: "sms",
          status: "open",
          messageCount: 2,
        }),
      }),
    );
  });
});

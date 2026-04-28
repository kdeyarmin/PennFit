// Route tests for GET /patients/:id.

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

const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

import detailRouter from "./detail";

const ALLOWED_EMAIL = "ops@penn.example.com";
const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const RX_ID = "22222222-2222-4222-8222-222222222222";
const EPISODE_ID = "33333333-3333-4333-8333-333333333333";
const CONV_ID = "44444444-4444-4444-8444-444444444444";
const FUL_ID = "55555555-5555-4555-8555-555555555555";

function makeApp(): Express {
  const app = express();
  app.use("/resupply-api", detailRouter);
  return app;
}

function stubVerifiedOperator(): void {
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

const ENV_KEYS = ["RESUPPLY_OPERATOR_EMAILS", "NODE_ENV"] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

describe("GET /patients/:id", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NODE_ENV = "test";
    process.env.RESUPPLY_OPERATOR_EMAILS = ALLOWED_EMAIL;
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
      `/resupply-api/patients/${PATIENT_ID}`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-uuid id", async () => {
    stubVerifiedOperator();
    const res = await request(makeApp()).get("/resupply-api/patients/not-a-uuid");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 404 when patient row is empty", async () => {
    stubVerifiedOperator();
    selectQueue.push([]); // patient
    const res = await request(makeApp()).get(
      `/resupply-api/patients/${PATIENT_ID}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("returns full detail and writes a patient.view audit row", async () => {
    stubVerifiedOperator();
    selectQueue.push([
      {
        id: PATIENT_ID,
        pacwareId: "PAC-001",
        firstName: "Alice",
        lastName: "Smith",
        status: "active",
        hasPhone: true,
        hasEmail: true,
        createdAt: new Date("2025-01-15T10:00:00Z"),
        updatedAt: new Date("2025-01-15T10:00:00Z"),
      },
    ]); // patient
    selectQueue.push([
      {
        id: RX_ID,
        itemSku: "MASK-001",
        cadenceDays: 90,
        validFrom: new Date("2025-01-01T00:00:00Z"),
        validUntil: null,
        status: "active",
        createdAt: new Date("2025-01-01T00:00:00Z"),
      },
    ]); // prescriptions
    selectQueue.push([
      {
        id: EPISODE_ID,
        prescriptionId: RX_ID,
        itemSku: "MASK-001",
        status: "outreach_pending",
        dueAt: new Date("2025-04-01T00:00:00Z"),
        expiresAt: null,
        createdAt: new Date("2025-04-01T00:00:00Z"),
      },
    ]); // episodes
    selectQueue.push([
      {
        id: CONV_ID,
        episodeId: EPISODE_ID,
        channel: "sms",
        status: "open",
        lastMessageAt: new Date("2025-04-02T12:00:00Z"),
        createdAt: new Date("2025-04-02T11:00:00Z"),
      },
    ]); // conversations
    selectQueue.push([
      {
        id: FUL_ID,
        episodeId: EPISODE_ID,
        itemSku: "MASK-001",
        quantity: "1",
        status: "queued",
        pacwareOrderRef: null,
        submittedAt: null,
        shippedAt: null,
        deliveredAt: null,
        createdAt: new Date("2025-04-03T00:00:00Z"),
      },
    ]); // fulfillments

    const res = await request(makeApp()).get(
      `/resupply-api/patients/${PATIENT_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(PATIENT_ID);
    expect(res.body.firstName).toBe("Alice");
    expect(res.body.hasPhone).toBe(true);
    expect(res.body.prescriptions).toHaveLength(1);
    expect(res.body.episodes).toHaveLength(1);
    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.fulfillments).toHaveLength(1);
    expect(res.body.episodes[0].itemSku).toBe("MASK-001");
    // No phone or email leaks.
    expect(res.body).not.toHaveProperty("phoneE164");
    expect(res.body).not.toHaveProperty("email");

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "patient.view",
        targetTable: "patients",
        targetId: PATIENT_ID,
        operatorEmail: ALLOWED_EMAIL,
      }),
    );
  });
});

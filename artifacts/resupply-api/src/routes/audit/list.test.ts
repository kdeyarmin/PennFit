// Route tests for GET /audit.

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

// Queue of fake pg query results (FIFO). Each entry corresponds to
// one pool.query() call (count first, then rows).
const queryQueue: Array<{ rows: unknown[] }> = [];
const poolQuery = vi.fn(async () => {
  return queryQueue.shift() ?? { rows: [] };
});

vi.mock("@workspace/resupply-db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-db")>(
      "@workspace/resupply-db",
    );
  return {
    ...actual,
    getDbPool: () => ({ query: poolQuery }) as never,
  };
});

import listRouter from "./list";

const ALLOWED_EMAIL = "ops@penn.example.com";
const AUDIT_ID = "11111111-1111-4111-8111-111111111111";

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

describe("GET /audit", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NODE_ENV = "test";
    process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
    queryQueue.length = 0;
    getAuthMock.mockReset();
    getUserMock.mockReset();
    poolQuery.mockClear();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("returns 401 with no session", async () => {
    getAuthMock.mockReturnValue({ userId: null });
    const res = await request(makeApp()).get("/resupply-api/audit");
    expect(res.status).toBe(401);
  });

  it("returns 400 invalid_query on bad since", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp()).get("/resupply-api/audit?since=nope");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("returns 400 invalid_query on bad limit", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp()).get("/resupply-api/audit?limit=999");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("returns paginated audit rows with metadata as-is", async () => {
    stubVerifiedAdmin();
    queryQueue.push({ rows: [{ count: 1 }] });
    queryQueue.push({
      rows: [
        {
          id: AUDIT_ID,
          occurred_at: new Date("2025-04-15T10:00:00Z"),
          operator_email: "ops@penn.example.com",
          operator_clerk_id: "user_op",
          action: "patient.view",
          target_table: "patients",
          target_id: "22222222-2222-4222-8222-222222222222",
          metadata: { source: "console" },
          ip: "10.0.0.1",
          user_agent: "Mozilla/5.0",
        },
      ],
    });

    const res = await request(makeApp()).get("/resupply-api/audit?limit=25");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      id: AUDIT_ID,
      action: "patient.view",
      targetTable: "patients",
      metadata: { source: "console" },
    });
  });

  it("filters by action + targetTable + since without crashing", async () => {
    stubVerifiedAdmin();
    queryQueue.push({ rows: [{ count: 0 }] });
    queryQueue.push({ rows: [] });
    const res = await request(makeApp()).get(
      "/resupply-api/audit?action=patient&targetTable=patients&since=2025-01-01T00:00:00Z",
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    // Sanity-check: filter params were threaded into the SQL
    // bindings (action LIKE wildcard, targetTable equality, since
    // as Date).
    const firstCall = poolQuery.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(firstCall[1]).toEqual([
      "%patient%",
      "patients",
      new Date("2025-01-01T00:00:00Z"),
    ]);
  });

  it("returns metadata={} when row has nullish metadata", async () => {
    stubVerifiedAdmin();
    queryQueue.push({ rows: [{ count: 1 }] });
    queryQueue.push({
      rows: [
        {
          id: AUDIT_ID,
          occurred_at: new Date("2025-04-15T10:00:00Z"),
          operator_email: null,
          operator_clerk_id: null,
          action: "system.heartbeat",
          target_table: null,
          target_id: null,
          metadata: null,
          ip: null,
          user_agent: null,
        },
      ],
    });

    const res = await request(makeApp()).get("/resupply-api/audit");
    expect(res.status).toBe(200);
    expect(res.body.items[0].metadata).toEqual({});
  });
});

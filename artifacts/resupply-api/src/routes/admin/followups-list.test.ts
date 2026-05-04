// Route tests for /admin/followups (Phase 18) — cross-customer
// daily queue of open followups.

import { describe, it, expect, vi, beforeEach } from "vitest";
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

const selectQueue: unknown[][] = [];
const dbStub = {
  select: vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      innerJoin: () => obj,
      where: () => obj,
      orderBy: () => obj,
      limit: () => Promise.resolve(result),
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
  return { ...actual, getDbPool: () => ({}) as never };
});

import followupsListRouter from "./followups-list";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(followupsListRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  selectQueue.length = 0;
});

describe("GET /admin/followups", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get("/admin/followups");
    expect(res.status).toBe(401);
  });

  it("returns empty list when nothing is open", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([]);
    const res = await request(makeApp()).get("/admin/followups");
    expect(res.status).toBe(200);
    expect(res.body.followups).toEqual([]);
  });

  it("returns rows joined with customer display name + email", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([
      {
        id: "11111111-1111-4111-8111-111111111111",
        customerId: "user_1",
        body: "Call about UPS claim",
        dueAt: new Date("2026-05-01T16:00:00Z"),
        createdByEmail: "ops@penn.example.com",
        createdAt: new Date("2026-04-30T12:00:00Z"),
        customerDisplayName: "Anna Singh",
        customerEmail: "anna@example.com",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        customerId: "user_2",
        body: "Check replacement mask shipment",
        dueAt: new Date("2026-05-04T10:00:00Z"),
        createdByEmail: "csr2@penn.example.com",
        createdAt: new Date("2026-05-02T09:00:00Z"),
        customerDisplayName: null,
        customerEmail: "ben@example.com",
      },
    ]);

    const res = await request(makeApp()).get("/admin/followups");
    expect(res.status).toBe(200);
    expect(res.body.followups).toHaveLength(2);
    expect(res.body.followups[0]).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      customerId: "user_1",
      customerDisplayName: "Anna Singh",
      customerEmail: "anna@example.com",
      body: "Call about UPS claim",
      dueAt: "2026-05-01T16:00:00.000Z",
    });
    expect(res.body.followups[1].customerDisplayName).toBeNull();
    expect(res.body.followups[1].customerEmail).toBe("ben@example.com");
  });
});

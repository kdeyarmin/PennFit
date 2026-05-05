// Route tests for /admin/followups (Phase 18 + 20) — cross-flow
// daily queue of open followups across shop_customers AND patients.

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

// Two-side queue: the route runs Promise.all([shop, patient]) so
// each test pushes both arrays in order.
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

  it("returns empty list when both surfaces are empty", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([]); // shop side
    selectQueue.push([]); // patient side
    const res = await request(makeApp()).get("/admin/followups");
    expect(res.status).toBe(200);
    expect(res.body.followups).toEqual([]);
  });

  it("merges + sorts shop and patient rows by due_at ascending, kind-discriminated", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([
      // Shop-side rows
      {
        id: "11111111-1111-4111-8111-111111111111",
        subjectId: "user_1",
        body: "Call about UPS claim",
        // Earliest — should land first after sort.
        dueAt: new Date("2026-05-01T16:00:00Z"),
        createdByEmail: "ops@penn.example.com",
        createdAt: new Date("2026-04-30T12:00:00Z"),
        displayName: "Anna Singh",
        email: "anna@example.com",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        subjectId: "user_2",
        body: "Check replacement mask shipment",
        dueAt: new Date("2026-05-04T10:00:00Z"),
        createdByEmail: "csr2@penn.example.com",
        createdAt: new Date("2026-05-02T09:00:00Z"),
        displayName: null,
        email: "ben@example.com",
      },
    ]);
    selectQueue.push([
      // Patient-side row, dueAt between the two shop rows
      {
        id: "33333333-3333-4333-8333-333333333333",
        subjectId: "44444444-4444-4444-8444-444444444444",
        body: "Confirm Rx renewal",
        dueAt: new Date("2026-05-02T12:00:00Z"),
        createdByEmail: "rx@penn.example.com",
        createdAt: new Date("2026-05-01T08:00:00Z"),
        legalFirstName: "Carla",
        legalLastName: "Rivera",
      },
    ]);

    const res = await request(makeApp()).get("/admin/followups");
    expect(res.status).toBe(200);
    expect(res.body.followups).toHaveLength(3);

    // Sort order: shop_2026-05-01, patient_2026-05-02, shop_2026-05-04.
    expect(res.body.followups[0]).toMatchObject({
      kind: "shop_customer",
      id: "11111111-1111-4111-8111-111111111111",
      subjectId: "user_1",
      subjectDisplayName: "Anna Singh",
      subjectEmail: "anna@example.com",
      dueAt: "2026-05-01T16:00:00.000Z",
    });
    expect(res.body.followups[1]).toMatchObject({
      kind: "patient",
      id: "33333333-3333-4333-8333-333333333333",
      subjectId: "44444444-4444-4444-8444-444444444444",
      subjectDisplayName: "Carla Rivera",
      // Patient surface deliberately doesn't expose email here —
      // PHI minimization for the cross-flow queue.
      subjectEmail: null,
      dueAt: "2026-05-02T12:00:00.000Z",
    });
    expect(res.body.followups[2]).toMatchObject({
      kind: "shop_customer",
      subjectId: "user_2",
      subjectDisplayName: null,
      subjectEmail: "ben@example.com",
      dueAt: "2026-05-04T10:00:00.000Z",
    });
  });
});

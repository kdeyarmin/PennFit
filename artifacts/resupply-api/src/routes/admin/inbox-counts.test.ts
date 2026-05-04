// Route tests for /admin/inbox-counts (Phase 16).
// Coverage:
//   * 401 without admin
//   * Returns the three count buckets in shape, with zeros when no rows
//   * Surfaces non-zero counts when the SQL stub returns them

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

// Each call to db.select() returns a fluent stub whose terminal
// resolves with the next row in `selectQueue`. The route does three
// COUNT queries (awaiting-reply convs, pending returns, pending
// reviews) so the test pushes three rows.
const selectQueue: unknown[][] = [];
const dbStub = {
  select: vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => Promise.resolve(result),
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

import inboxCountsRouter from "./inbox-counts";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(inboxCountsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  selectQueue.length = 0;
  dbStub.select.mockClear();
});

describe("GET /admin/inbox-counts", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get("/admin/inbox-counts");
    expect(res.status).toBe(401);
  });

  it("returns zero counts when no actionable rows exist", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ count: 0 }]); // awaiting-reply
    selectQueue.push([{ count: 0 }]); // pending returns
    selectQueue.push([{ count: 0 }]); // pending reviews

    const res = await request(makeApp()).get("/admin/inbox-counts");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      awaitingReplyConversations: 0,
      pendingReturns: 0,
      pendingReviews: 0,
    });
    expect(typeof res.body.serverTime).toBe("string");
  });

  it("surfaces non-zero counts in the right buckets", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ count: 7 }]); // awaiting-reply
    selectQueue.push([{ count: 3 }]); // pending returns
    selectQueue.push([{ count: 12 }]); // pending reviews

    const res = await request(makeApp()).get("/admin/inbox-counts");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      awaitingReplyConversations: 7,
      pendingReturns: 3,
      pendingReviews: 12,
    });
  });
});

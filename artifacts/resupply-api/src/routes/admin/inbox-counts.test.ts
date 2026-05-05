// Route tests for /admin/inbox-counts (Phase 16).
// Coverage:
//   * 401 without admin
//   * Returns the three count buckets in shape, with zeros when no rows
//   * Surfaces non-zero counts when the SQL stub returns them
//   * SQL predicates: conversations count is cross-channel (no channel
//     filter); returns count includes `received`; verifies each status
//     bucket in the single-round-trip SELECT

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

// The route uses a single db.execute(sql`...`) call for the main three
// counts (one round-trip), plus two db.select() calls for overdue
// followups (shop + patient). We capture the serialised SQL passed to
// execute so tests can assert on the predicates (which channels /
// statuses are included). Matches the pattern used in
// abandoned-carts.test.ts.
const executeQueue: Array<{ rows: unknown[] }> = [];
let lastExecuteSql: string | null = null;

// Each call to db.select() returns a fluent stub whose terminal
// resolves with the next row-set in `selectQueue`. The route does two
// COUNT selects (overdue shop followups, overdue patient followups).
const selectQueue: unknown[][] = [];

function sqlToString(query: { queryChunks?: unknown[] }): string {
  // Walk Drizzle's SQL object chunks to produce a plain string.
  if (!query || !Array.isArray(query.queryChunks)) return String(query);
  return query.queryChunks
    .map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object" && "value" in c)
        return String((c as { value: unknown }).value);
      return "";
    })
    .join("");
}

function makeSelectStub(): unknown {
  const rows = selectQueue.shift() ?? [];
  const stub = {
    from: () => stub,
    where: () => Promise.resolve(rows),
  };
  return stub;
}

const dbStub = {
  execute: vi.fn((query: unknown) => {
    lastExecuteSql = sqlToString(query as { queryChunks?: unknown[] });
    return Promise.resolve(executeQueue.shift() ?? { rows: [] });
  }),
  select: vi.fn(() => makeSelectStub()),
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

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

beforeEach(() => {
  mockAdmin.current = null;
  executeQueue.length = 0;
  selectQueue.length = 0;
  lastExecuteSql = null;
  dbStub.execute.mockClear();
  dbStub.select.mockClear();
});

describe("GET /admin/inbox-counts", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get("/admin/inbox-counts");
    expect(res.status).toBe(401);
  });

  it("returns zero counts when no actionable rows exist", async () => {
    mockAdmin.current = ADMIN;
    executeQueue.push({
      rows: [
        {
          awaiting_reply_conversations: 0,
          pending_returns: 0,
          pending_reviews: 0,
        },
      ],
    });
    selectQueue.push([{ count: 0 }]); // overdue shop followups
    selectQueue.push([{ count: 0 }]); // overdue patient followups

    const res = await request(makeApp()).get("/admin/inbox-counts");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      awaitingReplyConversations: 0,
      pendingReturns: 0,
      pendingReviews: 0,
      overdueFollowups: 0,
    });
    expect(typeof res.body.serverTime).toBe("string");
  });

  it("surfaces non-zero counts in the right buckets", async () => {
    mockAdmin.current = ADMIN;
    executeQueue.push({
      rows: [
        {
          awaiting_reply_conversations: 7,
          pending_returns: 3,
          pending_reviews: 12,
        },
      ],
    });
    selectQueue.push([{ count: 5 }]); // overdue shop followups
    selectQueue.push([{ count: 2 }]); // overdue patient followups

    const res = await request(makeApp()).get("/admin/inbox-counts");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      awaitingReplyConversations: 7,
      pendingReturns: 3,
      pendingReviews: 12,
      // Sums shop + patient overdue across both surfaces.
      overdueFollowups: 7,
    });
  });

  it("issues exactly one db.execute call (one round-trip)", async () => {
    mockAdmin.current = ADMIN;
    executeQueue.push({ rows: [{ awaiting_reply_conversations: 0, pending_returns: 0, pending_reviews: 0 }] });

    await request(makeApp()).get("/admin/inbox-counts");
    expect(dbStub.execute).toHaveBeenCalledTimes(1);
  });

  it("SQL does not filter by channel — counts all awaiting_admin conversations", async () => {
    mockAdmin.current = ADMIN;
    executeQueue.push({ rows: [{ awaiting_reply_conversations: 0, pending_returns: 0, pending_reviews: 0 }] });

    await request(makeApp()).get("/admin/inbox-counts");
    const sqlStr = lastExecuteSql ?? "";
    // Must filter on awaiting_admin status...
    expect(sqlStr).toContain("awaiting_admin");
    // ...but must NOT restrict to a single channel.
    expect(sqlStr).not.toContain("in_app");
    expect(sqlStr).not.toContain("channel");
  });

  it("SQL includes `received` in the returns status set", async () => {
    mockAdmin.current = ADMIN;
    executeQueue.push({ rows: [{ awaiting_reply_conversations: 0, pending_returns: 0, pending_reviews: 0 }] });

    await request(makeApp()).get("/admin/inbox-counts");
    const sqlStr = lastExecuteSql ?? "";
    expect(sqlStr).toContain("received");
    // Also verify the other expected statuses are present.
    expect(sqlStr).toContain("requested");
    expect(sqlStr).toContain("shipped_back");
  });

  it("SQL filters reviews to `pending` status", async () => {
    mockAdmin.current = ADMIN;
    executeQueue.push({ rows: [{ awaiting_reply_conversations: 0, pending_returns: 0, pending_reviews: 0 }] });

    await request(makeApp()).get("/admin/inbox-counts");
    const sqlStr = lastExecuteSql ?? "";
    expect(sqlStr).toContain("pending");
    expect(sqlStr).toContain("shop_reviews");
  });
});

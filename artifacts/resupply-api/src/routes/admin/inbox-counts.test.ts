// Route tests for /admin/inbox-counts (Phase 16).
// Coverage:
//   * 401 without admin
//   * Returns the count buckets in shape, with zeros when no rows
//   * Surfaces non-zero counts when the staged probes return them
//   * Each of the six tables is touched exactly once per request
//     (regression guard against silently dropping a bucket)

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

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

// The six count probes the route issues in parallel. Stage all six
// each test (even when they all return zero) so missing stages can't
// silently make assertions pass against a `null` count default.
function stageAllZero(): void {
  for (const t of [
    "conversations",
    "shop_returns",
    "shop_reviews",
    "patient_documents",
    "shop_customer_followups",
    "patient_followups",
  ]) {
    stageSupabaseResponse(t, "select", { data: null, count: 0 });
  }
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/inbox-counts", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get("/admin/inbox-counts");
    expect(res.status).toBe(401);
  });

  it("returns zero counts when no actionable rows exist", async () => {
    mockAdmin.current = ADMIN;
    stageAllZero();

    const res = await request(makeApp()).get("/admin/inbox-counts");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      awaitingReplyConversations: 0,
      pendingReturns: 0,
      pendingReviews: 0,
      overdueFollowups: 0,
      newPatientDocuments: 0,
    });
    expect(typeof res.body.serverTime).toBe("string");
  });

  it("surfaces non-zero counts in the right buckets", async () => {
    mockAdmin.current = ADMIN;
    // Order matches the route's Promise.all destructuring:
    //   conversations, shop_returns, shop_reviews,
    //   patient_documents, shop_customer_followups, patient_followups
    stageSupabaseResponse("conversations", "select", { data: null, count: 7 });
    stageSupabaseResponse("shop_returns", "select", { data: null, count: 3 });
    stageSupabaseResponse("shop_reviews", "select", { data: null, count: 12 });
    stageSupabaseResponse("patient_documents", "select", {
      data: null,
      count: 4,
    });
    stageSupabaseResponse("shop_customer_followups", "select", {
      data: null,
      count: 5,
    });
    stageSupabaseResponse("patient_followups", "select", {
      data: null,
      count: 2,
    });

    const res = await request(makeApp()).get("/admin/inbox-counts");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      awaitingReplyConversations: 7,
      pendingReturns: 3,
      pendingReviews: 12,
      newPatientDocuments: 4,
      // Sums shop + patient overdue across both surfaces.
      overdueFollowups: 7,
    });
  });

  it("issues exactly one SELECT per bucket — six tables touched", async () => {
    mockAdmin.current = ADMIN;
    stageAllZero();

    await request(makeApp()).get("/admin/inbox-counts");
    // Regression guard: if a future refactor drops any of these the
    // corresponding bucket would silently report zero.
    expect(getSupabaseCallCount("conversations", "select")).toBe(1);
    expect(getSupabaseCallCount("shop_returns", "select")).toBe(1);
    expect(getSupabaseCallCount("shop_reviews", "select")).toBe(1);
    expect(getSupabaseCallCount("patient_documents", "select")).toBe(1);
    expect(getSupabaseCallCount("shop_customer_followups", "select")).toBe(1);
    expect(getSupabaseCallCount("patient_followups", "select")).toBe(1);
  });

  it("treats a null count from PostgREST as zero in the response", async () => {
    mockAdmin.current = ADMIN;
    // PostgREST can return `count: null` if the count header was
    // dropped (e.g. transient transport hiccup); the route must
    // coerce to 0 rather than emit `null` in the JSON body.
    stageSupabaseResponse("conversations", "select", {
      data: null,
      count: null,
    });
    stageSupabaseResponse("shop_returns", "select", {
      data: null,
      count: null,
    });
    stageSupabaseResponse("shop_reviews", "select", {
      data: null,
      count: null,
    });
    stageSupabaseResponse("patient_documents", "select", {
      data: null,
      count: null,
    });
    stageSupabaseResponse("shop_customer_followups", "select", {
      data: null,
      count: null,
    });
    stageSupabaseResponse("patient_followups", "select", {
      data: null,
      count: null,
    });

    const res = await request(makeApp()).get("/admin/inbox-counts");
    expect(res.status).toBe(200);
    expect(res.body.awaitingReplyConversations).toBe(0);
    expect(res.body.pendingReturns).toBe(0);
    expect(res.body.pendingReviews).toBe(0);
    expect(res.body.newPatientDocuments).toBe(0);
    expect(res.body.overdueFollowups).toBe(0);
  });
});

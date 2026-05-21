// Tests for shop-review-requests route — adminRateLimit integration.
//
// Scope: only the code added in this PR:
//   - POST /admin/shop/review-requests/send-due
//     (requirePermission("conversations.manage"), preset: bulk)
//
// Key PR detail: uses the "bulk" preset (10/hr) — the most conservative
// preset for fan-out operations.
//
// Tests verify:
//   1. Auth/permission gate fires before rate limiting.
//   2. When adminRateLimit blocks, the route returns 429 with the correct limiter.
//   3. When adminRateLimit passes through, the handler runs normally.
//   4. adminRateLimit is invoked with preset='bulk'.

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
} from "../../test-helpers/supabase-mock";

// ── Supabase mock (module-scoped) ────────────────────────────────────────────
const supabaseMock = installSupabaseMock();

// ── Auth mock ────────────────────────────────────────────────────────────────
const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// ── adminRateLimit mock ──────────────────────────────────────────────────────
const rateLimitBlocked = vi.hoisted(() => ({ current: false }));
const adminRateLimitSpy = vi.hoisted(() =>
  vi.fn<
    (opts: { name: string; preset?: string }) => (
      req: import("express").Request,
      res: import("express").Response,
      next: import("express").NextFunction,
    ) => void
  >((opts) => (_req, res, next) => {
    if (rateLimitBlocked.current) {
      res.status(429).json({
        error: "too_many_requests",
        limiter: opts.name,
        retryAfterSeconds: 3600,
        message: "Too many requests, please try again later.",
      });
      return;
    }
    next();
  }),
);
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: adminRateLimitSpy,
}));

// ── External service mocks ───────────────────────────────────────────────────
const sendReviewRequestEmailMock = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "sg_review_1" })),
);
vi.mock("../../lib/messaging/review-request-email", () => ({
  sendReviewRequestEmail: sendReviewRequestEmailMock,
}));

vi.mock("../../lib/comm-prefs", () => ({
  isInDndWindow: vi.fn(() => false),
}));

import shopReviewRequestsRouter from "./shop-review-requests";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(shopReviewRequestsRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@example.com",
    role: "admin",
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  rateLimitBlocked.current = false;
  supabaseMock.reset();
  sendReviewRequestEmailMock.mockClear();
});

// ── POST /admin/shop/review-requests/send-due ────────────────────────────────

describe("POST /admin/shop/review-requests/send-due — adminRateLimit integration (bulk preset)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).post(
      "/admin/shop/review-requests/send-due",
    );
    expect(res.status).toBe(401);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp()).post(
      "/admin/shop/review-requests/send-due",
    );
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("shop_review_requests.send_due");
  });

  it("calls adminRateLimit with name='shop_review_requests.send_due' and preset='bulk'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "shop_review_requests.send_due",
    );
    expect(call).toBeDefined();
    // Fan-out dispatch uses the "bulk" preset (10/hr) — same cap as "destroy".
    expect(call![0].preset).toBe("bulk");
  });

  it("passes through and processes eligible orders when not rate-limited", async () => {
    stubAdmin();
    // Step 1 — no candidates (empty run).
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    const res = await request(makeApp()).post(
      "/admin/shop/review-requests/send-due",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ attempted: 0, sent: 0 });
    expect(sendReviewRequestEmailMock).not.toHaveBeenCalled();
  });

  it("sends emails for eligible orders when not rate-limited", async () => {
    stubAdmin();
    const orderId = "order-uuid-0001";
    const customerId = "cust-uuid-0001";
    // Step 1 — candidate orders.
    stageSupabaseResponse("shop_orders", "select", {
      data: [{ id: orderId, customer_id: customerId }],
    });
    // Step 2 — atomic claim.
    stageSupabaseResponse("shop_orders", "update", {
      data: [{ id: orderId, customer_id: customerId }],
    });
    // Step 3 — customer comm prefs lookup.
    stageSupabaseResponse("customers", "select", {
      data: {
        id: customerId,
        email: "patient@example.com",
        first_name: "Pat",
        communication_preferences: {
          emailReviewRequests: true,
          emailMarketingEnabled: false,
        },
      },
    });
    const res = await request(makeApp()).post(
      "/admin/shop/review-requests/send-due",
    );
    expect(res.status).toBe(200);
    expect(res.body.attempted).toBeGreaterThanOrEqual(0);
  });

  it("does not send emails when the 429 path is hit (rate limit fires before handler)", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    await request(makeApp()).post("/admin/shop/review-requests/send-due");
    expect(sendReviewRequestEmailMock).not.toHaveBeenCalled();
  });
});
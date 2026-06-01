// Tests for /admin/shop/customers/:id/timeline (CSR #12) — the pure
// merge + the HTTP route.

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

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import customerTimelineRouter, {
  buildCustomerTimeline,
} from "./customer-timeline";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "csr@penn.example.com",
  role: "admin",
};
// rt (clinician) lacks conversations.manage → 403.
const RT: MockAdminCtx = {
  userId: "u_rt",
  email: "rt@penn.example.com",
  role: "agent",
  granularRole: "rt",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(customerTimelineRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("buildCustomerTimeline (pure)", () => {
  it("merges every source newest-first and labels each kind", () => {
    const events = buildCustomerTimeline({
      conversations: [
        { id: "c1", channel: "sms", status: "open", created_at: "2026-05-10" },
      ],
      orders: [{ id: "o1", status: "paid", created_at: "2026-05-12" }],
      returns: [{ id: "r1", status: "requested", created_at: "2026-05-08" }],
      followups: [
        {
          id: "f1",
          due_at: "2026-05-15",
          completed_at: null,
          created_at: "2026-05-01",
        },
      ],
      reviews: [
        { id: "rv1", rating: 5, status: "approved", created_at: "2026-05-05" },
      ],
    });

    // Newest first: followup due 05-15, order 05-12, conversation 05-10,
    // return 05-08, review 05-05.
    expect(events.map((e) => e.refId)).toEqual(["f1", "o1", "c1", "r1", "rv1"]);
    expect(events.find((e) => e.kind === "order")!.label).toBe("paid");
    expect(events.find((e) => e.kind === "review")!.label).toBe(
      "5★ · approved",
    );
    expect(events.find((e) => e.kind === "followup")!.label).toBe("open");
    expect(events.find((e) => e.kind === "conversation")!.label).toBe(
      "sms · open",
    );
  });

  it("skips rows missing an id or timestamp", () => {
    const events = buildCustomerTimeline({
      conversations: [{ id: "", channel: "sms", created_at: "2026-05-10" }],
      orders: [{ id: "o1", status: "paid", created_at: "" }],
      returns: [],
      followups: [],
      reviews: [],
    });
    expect(events).toHaveLength(0);
  });
});

describe("GET /admin/shop/customers/:id/timeline", () => {
  it("401s without admin", async () => {
    expect(
      (await request(makeApp()).get("/admin/shop/customers/cust_1/timeline"))
        .status,
    ).toBe(401);
  });

  it("403s for a role without conversations.manage (rt)", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp()).get(
      "/admin/shop/customers/cust_1/timeline",
    );
    expect(res.status).toBe(403);
  });

  it("unions the customer's sources into one feed", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("conversations", "select", {
      data: [
        {
          id: "c1",
          channel: "email",
          status: "open",
          created_at: "2026-05-10",
        },
      ],
    });
    stageSupabaseResponse("shop_orders", "select", {
      data: [{ id: "o1", status: "paid", created_at: "2026-05-12" }],
    });
    stageSupabaseResponse("shop_returns", "select", { data: [] });
    stageSupabaseResponse("shop_customer_followups", "select", { data: [] });
    stageSupabaseResponse("shop_reviews", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/admin/shop/customers/cust_1/timeline",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.events[0].refId).toBe("o1"); // newest
    expect(res.body.events[1].refId).toBe("c1");
  });
});

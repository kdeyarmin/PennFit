// Route tests for /admin/productivity.
//
// Coverage:
//   * 401 without a session
//   * 403 when the caller lacks reports.read (fulfillment role)
//   * 400 on a malformed window
//   * Happy path: per-agent counts fan out from the supplied
//     PostgREST rows and the response array is sorted by
//     window-throughput desc

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

import productivityRouter from "./productivity";

const SUPERVISOR: MockAdminCtx = {
  userId: "u_super",
  email: "sup@penn.example.com",
  role: "agent",
  granularRole: "supervisor",
};
const FULFILLMENT: MockAdminCtx = {
  userId: "u_fulfillment",
  email: "ship@penn.example.com",
  role: "agent",
  granularRole: "fulfillment",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(productivityRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/productivity", () => {
  it("401s without a session", async () => {
    const res = await request(makeApp()).get("/admin/productivity");
    expect(res.status).toBe(401);
  });

  it("403s for a role that lacks reports.read", async () => {
    mockAdmin.current = FULFILLMENT;
    const res = await request(makeApp()).get("/admin/productivity");
    expect(res.status).toBe(403);
  });

  it("400s on an invalid window value", async () => {
    mockAdmin.current = SUPERVISOR;
    const res = await request(makeApp()).get("/admin/productivity?window=99d");
    expect(res.status).toBe(400);
  });

  it("returns an empty list when no active admins exist", async () => {
    mockAdmin.current = SUPERVISOR;
    stageSupabaseResponse("admin_users", "select", { data: [] });
    const res = await request(makeApp()).get("/admin/productivity?window=7d");
    expect(res.status).toBe(200);
    expect(res.body.agents).toEqual([]);
    expect(res.body.window.kind).toBe("7d");
  });

  it("aggregates and sorts by window-throughput desc", async () => {
    mockAdmin.current = SUPERVISOR;
    // Two active admins.
    stageSupabaseResponse("admin_users", "select", {
      data: [
        {
          id: "u_alice",
          email_lower: "alice@penn.example.com",
          display_name: "Alice",
          role: "csr",
        },
        {
          id: "u_bob",
          email_lower: "bob@penn.example.com",
          display_name: "Bob",
          role: "csr",
        },
      ],
    });
    // Six staged signal queries in order: assignedOpen, closedInWindow,
    // returnsApproved, returnsRejected, alertsResolved, followupsCompleted.
    // Alice has more throughput in the window (4 vs 1), so she sorts
    // first. Bob has a larger open queue (15 vs 2), which the row
    // doesn't influence the order but is rendered.
    stageSupabaseResponse("conversations", "select", {
      data: [
        { assigned_admin_user_id: "u_alice" },
        { assigned_admin_user_id: "u_alice" },
        { assigned_admin_user_id: "u_bob" },
        ...Array.from({ length: 14 }, () => ({
          assigned_admin_user_id: "u_bob",
        })),
      ],
    });
    stageSupabaseResponse("conversations", "select", {
      data: [
        { assigned_admin_user_id: "u_alice" },
        { assigned_admin_user_id: "u_alice" },
        { assigned_admin_user_id: "u_bob" },
      ],
    });
    stageSupabaseResponse("shop_returns", "select", {
      data: [{ admin_user_id: "u_alice" }],
    });
    stageSupabaseResponse("shop_returns", "select", {
      data: [],
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: [{ resolved_by_user_id: "u_alice" }],
    });
    stageSupabaseResponse("patient_followups", "select", {
      data: [],
    });

    const res = await request(makeApp()).get("/admin/productivity?window=7d");
    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(2);
    expect(res.body.agents[0].displayName).toBe("Alice");
    expect(res.body.agents[0].assignedConversationsOpen).toBe(2);
    expect(res.body.agents[0].conversationsClosedInWindow).toBe(2);
    expect(res.body.agents[0].returnsApproved).toBe(1);
    expect(res.body.agents[0].complianceAlertsResolved).toBe(1);
    expect(res.body.agents[1].displayName).toBe("Bob");
    expect(res.body.agents[1].assignedConversationsOpen).toBe(15);
    expect(res.body.agents[1].conversationsClosedInWindow).toBe(1);
  });
});

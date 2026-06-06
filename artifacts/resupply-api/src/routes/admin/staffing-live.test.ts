// Route test for GET /admin/staffing/live (CSR #C3).
//
// The per-agent counting/sorting is covered by
// lib/staffing/build-live-staffing.test.ts. This pins the route wiring:
// it reads the active roster, every open conversation's assignee, and the
// on-shift set, then returns the snapshot.

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

import staffingLiveRouter from "./staffing-live";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(staffingLiveRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  mockAdmin.current = ADMIN;
});

describe("GET /admin/staffing/live", () => {
  it("returns per-agent open load, on-shift flags, and unassigned backlog", async () => {
    stageSupabaseResponse("admin_users", "select", {
      data: [
        {
          id: "a",
          email_lower: "a@penn.example.com",
          display_name: "Alice",
          role: "csr",
          availability: "available",
        },
        {
          id: "b",
          email_lower: "b@penn.example.com",
          display_name: "Bob",
          role: "csr",
          availability: "away",
        },
      ],
    });
    stageSupabaseResponse("conversations", "select", {
      data: [
        { assigned_admin_user_id: "a" },
        { assigned_admin_user_id: "a" },
        { assigned_admin_user_id: "b" },
        { assigned_admin_user_id: null },
      ],
    });
    stageSupabaseResponse("csr_shifts", "select", {
      data: [{ staff_user_id: "a" }],
    });

    const res = await request(makeApp()).get("/admin/staffing/live");

    expect(res.status).toBe(200);
    expect(res.body.agents[0]).toMatchObject({
      adminUserId: "a",
      openConversations: 2,
      onShift: true,
      availability: "available",
    });
    expect(res.body.agents[1]).toMatchObject({
      adminUserId: "b",
      openConversations: 1,
      onShift: false,
    });
    expect(res.body.unassignedOpenConversations).toBe(1);
    expect(res.body.totalOpenConversations).toBe(4);
    expect(res.body.activeAgents).toBe(2);
    expect(res.body.onShiftAgents).toBe(1);
  });

  it("returns an empty snapshot when there is no active roster", async () => {
    stageSupabaseResponse("admin_users", "select", { data: [] });
    stageSupabaseResponse("conversations", "select", { data: [] });
    stageSupabaseResponse("csr_shifts", "select", { data: [] });

    const res = await request(makeApp()).get("/admin/staffing/live");
    expect(res.status).toBe(200);
    expect(res.body.agents).toEqual([]);
    expect(res.body.totalOpenConversations).toBe(0);
  });
});

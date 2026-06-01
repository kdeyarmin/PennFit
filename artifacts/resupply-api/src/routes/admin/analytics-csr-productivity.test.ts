// Route test for the REINSTATED /admin/analytics/csr-productivity.
//
// Historically this rolled up resupply.audit_log and — after that table
// was retired — short-circuited to `unavailable: true`. It now
// re-derives per-operator productivity from the live EVENT tables (the
// same sources as /admin/productivity), so this pins the new behavior:
// real rows, no `unavailable` flag.

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

import analyticsRouter from "./analytics";

const SUPERVISOR: MockAdminCtx = {
  userId: "u_super",
  email: "sup@penn.example.com",
  role: "agent",
  granularRole: "supervisor",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(analyticsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/analytics/csr-productivity (reinstated)", () => {
  it("401s without a session", async () => {
    const res = await request(makeApp()).get(
      "/admin/analytics/csr-productivity",
    );
    expect(res.status).toBe(401);
  });

  it("re-derives per-operator productivity from event tables (no unavailable flag)", async () => {
    mockAdmin.current = SUPERVISOR;
    stageSupabaseResponse("admin_users", "select", {
      data: [
        { id: "a1", email_lower: "csr1@penn.example.com" },
        { id: "a2", email_lower: "csr2@penn.example.com" },
      ],
    });
    stageSupabaseResponse("conversations", "select", {
      data: [
        {
          assigned_admin_user_id: "a1",
          updated_at: "2026-05-20T09:00:00.000Z",
        },
        {
          assigned_admin_user_id: "a1",
          updated_at: "2026-05-22T09:00:00.000Z",
        },
      ],
    });
    // shop_returns (x2), csr_compliance_alerts, patient_followups unstaged
    // → empty, so a1's only actions are the two closed conversations and
    // a2 has none (and is filtered out).

    const res = await request(makeApp()).get(
      "/admin/analytics/csr-productivity?days=30",
    );
    expect(res.status).toBe(200);
    expect(res.body.unavailable).toBeUndefined();
    expect(res.body.windowDays).toBe(30);
    expect(res.body.totalActions).toBe(2);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toEqual({
      operator: "csr1@penn.example.com",
      total: 2,
      byAction: { conversation_closed: 2 },
      lastActiveDate: "2026-05-22",
    });
  });
});

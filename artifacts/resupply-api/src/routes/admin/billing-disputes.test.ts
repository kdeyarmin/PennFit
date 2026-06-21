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

import disputesRouter from "./billing-disputes";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(disputesRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/billing/disputes", () => {
  it("401 unauthenticated", async () => {
    const res = await request(makeApp()).get("/admin/billing/disputes");
    expect(res.status).toBe(401);
  });

  it("returns the dispute list and filters to open by default", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("stripe_disputes", "select", {
      data: [{ id: "d1", stripe_dispute_id: "dp_1", status: "needs_response" }],
    });
    const res = await request(makeApp()).get("/admin/billing/disputes");
    expect(res.status).toBe(200);
    expect(res.body.disputes).toHaveLength(1);
    // default status=open → a closed_at IS NULL filter is applied
    const filters = supabaseMock.filterCalls("stripe_disputes", "select");
    expect(filters.some((f) => f.verb === "is")).toBe(true);
  });

  it("status=all skips the open filter", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("stripe_disputes", "select", { data: [] });
    const res = await request(makeApp()).get(
      "/admin/billing/disputes?status=all",
    );
    expect(res.status).toBe(200);
    const filters = supabaseMock.filterCalls("stripe_disputes", "select");
    expect(filters.some((f) => f.verb === "is")).toBe(false);
  });
});

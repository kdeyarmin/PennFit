// Route tests for /admin/agent-availability (Phase 1, CSR #16).

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
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import agentAvailabilityRouter from "./agent-availability";

const AGENT: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(agentAvailabilityRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/agent-availability", () => {
  it("401s without admin", async () => {
    expect(
      (await request(makeApp()).get("/admin/agent-availability")).status,
    ).toBe(401);
  });

  it("returns the team availability board", async () => {
    mockAdmin.current = AGENT;
    stageSupabaseResponse("admin_users", "select", {
      data: [
        {
          id: "a1",
          email_lower: "csr@penn.example.com",
          display_name: "CSR One",
          role: "csr",
          availability: "available",
        },
        {
          id: "a2",
          email_lower: "sup@penn.example.com",
          display_name: "Sup",
          role: "supervisor",
          availability: "away",
        },
      ],
    });
    const res = await request(makeApp()).get("/admin/agent-availability");
    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(2);
    expect(res.body.agents[1]).toMatchObject({
      adminUserId: "a2",
      availability: "away",
    });
  });
});

describe("PATCH /admin/agent-availability/me", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .patch("/admin/agent-availability/me")
      .send({ availability: "away" });
    expect(res.status).toBe(401);
  });

  it("400s on an invalid availability", async () => {
    mockAdmin.current = AGENT;
    const res = await request(makeApp())
      .patch("/admin/agent-availability/me")
      .send({ availability: "lunch" });
    expect(res.status).toBe(400);
    expect(getSupabaseCallCount("admin_users", "update")).toBe(0);
  });

  it("sets the caller's own availability", async () => {
    mockAdmin.current = AGENT;
    stageSupabaseResponse("admin_users", "update", {
      data: { id: "u_csr", availability: "away" },
    });
    const res = await request(makeApp())
      .patch("/admin/agent-availability/me")
      .send({ availability: "away" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ adminUserId: "u_csr", availability: "away" });

    // The update is scoped to the caller's own admin id.
    const payload = getSupabaseWritePayloads("admin_users", "update")[0] as
      | Record<string, unknown>
      | undefined;
    expect(payload).toMatchObject({ availability: "away" });
  });
});

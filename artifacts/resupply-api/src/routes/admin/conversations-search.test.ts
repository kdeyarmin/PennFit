// Route tests for /admin/conversations-search (CSR #13).

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

import conversationsSearchRouter from "./conversations-search";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};
// rt (clinician bucket) lacks conversations.manage → 403.
const RT: MockAdminCtx = {
  userId: "u_rt",
  email: "rt@penn.example.com",
  role: "agent",
  granularRole: "rt",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(conversationsSearchRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/conversations-search", () => {
  it("401s without admin", async () => {
    expect(
      (await request(makeApp()).get("/admin/conversations-search?q=mask"))
        .status,
    ).toBe(401);
  });

  it("403s for a role without conversations.manage (rt)", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp()).get(
      "/admin/conversations-search?q=mask",
    );
    expect(res.status).toBe(403);
    expect(res.body.requiredPermission).toBe("conversations.manage");
  });

  it("400s when q is too short", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get("/admin/conversations-search?q=m");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("dedupes to the most-recent match per conversation", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("messages", "select", {
      data: [
        {
          conversation_id: "c1",
          body: "leaking mask issue — opened a return",
          direction: "inbound",
          created_at: "2026-05-31T10:00:00Z",
        },
        {
          conversation_id: "c1",
          body: "older mask message",
          direction: "inbound",
          created_at: "2026-05-30T10:00:00Z",
        },
        {
          conversation_id: "c2",
          body: "mask fit question",
          direction: "outbound",
          created_at: "2026-05-29T10:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get(
      "/admin/conversations-search?q=mask",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.results[0]).toMatchObject({
      conversationId: "c1",
      direction: "inbound",
    });
    expect(res.body.results[0].snippet).toContain("leaking mask");
    expect(res.body.results[1].conversationId).toBe("c2");
  });
});

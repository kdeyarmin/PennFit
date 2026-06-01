// Tests for POST /admin/conversations/:id/draft-reply (CSR #15) — the
// route's gate + wiring + soft-degrade shape. The drafter itself is
// mocked (its own pure logic is covered in draft-reply.test.ts) so these
// tests never make a model call and stay deterministic.

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
import type { DraftReplyResult } from "../../lib/conversations/draft-reply";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const { draftResult } = vi.hoisted(() => ({
  draftResult: { current: null as DraftReplyResult | null },
}));
vi.mock("../../lib/conversations/draft-reply", async (importActual) => {
  const actual =
    await importActual<typeof import("../../lib/conversations/draft-reply")>();
  return {
    ...actual,
    draftConversationReply: vi.fn(
      async (): Promise<DraftReplyResult> =>
        draftResult.current ?? {
          ok: false,
          reason: "offline",
          redactions: 0,
        },
    ),
  };
});

import conversationDraftReplyRouter from "./conversation-draft-reply";

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

// Valid RFC-4122 v4 uuid (version nibble 4, variant nibble 8) — matches
// what gen_random_uuid() produces, so z.string().uuid() accepts it.
const CONVO_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(conversationDraftReplyRouter);
  return app;
}

function stageConvoAndMessages() {
  stageSupabaseResponse("conversations", "select", {
    data: { id: CONVO_ID, channel: "sms", status: "open" },
  });
  stageSupabaseResponse("messages", "select", {
    data: [
      {
        direction: "inbound",
        sender_role: "patient",
        body: "Where's my order?",
        created_at: "2026-05-20T00:00:00.000Z",
      },
    ],
  });
}

beforeEach(() => {
  mockAdmin.current = null;
  draftResult.current = null;
  supabaseMock.reset();
});

describe("POST /admin/conversations/:id/draft-reply", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).post(
      `/admin/conversations/${CONVO_ID}/draft-reply`,
    );
    expect(res.status).toBe(401);
  });

  it("403s for a role without conversations.manage (rt)", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp()).post(
      `/admin/conversations/${CONVO_ID}/draft-reply`,
    );
    expect(res.status).toBe(403);
  });

  it("400s on a non-uuid conversation id", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).post(
      "/admin/conversations/not-a-uuid/draft-reply",
    );
    expect(res.status).toBe(400);
  });

  it("404s when the conversation doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("conversations", "select", { data: null });
    const res = await request(makeApp()).post(
      `/admin/conversations/${CONVO_ID}/draft-reply`,
    );
    expect(res.status).toBe(404);
  });

  it("returns the draft when the model is available", async () => {
    mockAdmin.current = ADMIN;
    stageConvoAndMessages();
    draftResult.current = {
      ok: true,
      draft: "Hi! Your order shipped yesterday — want the tracking link?",
      provider: "anthropic",
      redactions: 0,
    };
    const res = await request(makeApp()).post(
      `/admin/conversations/${CONVO_ID}/draft-reply`,
    );
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.draft).toContain("order shipped");
  });

  it("degrades to available:false when the model is offline", async () => {
    mockAdmin.current = ADMIN;
    stageConvoAndMessages();
    draftResult.current = { ok: false, reason: "offline", redactions: 1 };
    const res = await request(makeApp()).post(
      `/admin/conversations/${CONVO_ID}/draft-reply`,
    );
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe("offline");
  });
});

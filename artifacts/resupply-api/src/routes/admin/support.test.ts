// /admin/support/* — tenant-facing support tickets.
//
// The bot (lib/support-bot) and the feature flag are mocked so the test
// focuses on the route contract: gate, validation, the create→bot→status
// flow, and org-scoped reads.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminRef,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null } as MockAdminRef,
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const { flag } = vi.hoisted(() => ({ flag: { enabled: true } }));
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => flag.enabled),
}));

const { bot } = vi.hoisted(() => ({
  bot: { result: { kind: "handoff" } as Record<string, unknown> },
}));
vi.mock("../../lib/support-bot/support-bot", () => ({
  answerSupportTicket: vi.fn(async () => bot.result),
}));

import supportRouter from "./support";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(supportRouter);
  return app;
}

const TICKET_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  supabaseMock.reset();
  mockAdmin.current = {
    userId: "u_admin",
    email: "owner@acme.test",
    role: "admin",
  };
  flag.enabled = true;
  bot.result = { kind: "handoff" };
});

describe("POST /admin/support/tickets", () => {
  it("401s without an admin session", async () => {
    mockAdmin.current = null;
    const res = await request(makeApp())
      .post("/admin/support/tickets")
      .send({ subject: "Hi", body: "How do I add a teammate?" });
    expect(res.status).toBe(401);
  });

  it("403s when the feature flag is off", async () => {
    flag.enabled = false;
    const res = await request(makeApp())
      .post("/admin/support/tickets")
      .send({ subject: "Hi", body: "How do I add a teammate?" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("feature_disabled");
  });

  it("400s on an empty body", async () => {
    const res = await request(makeApp())
      .post("/admin/support/tickets")
      .send({ subject: "Hi", body: "" });
    expect(res.status).toBe(400);
  });

  it("auto-answers and posts a bot message when the bot is confident", async () => {
    bot.result = {
      kind: "answer",
      reply: "Open Settings → Team.",
      confidence: 0.92,
    };
    stageSupabaseResponse("support_tickets", "insert", {
      data: {
        id: TICKET_ID,
        subject: "Add a teammate",
        status: "awaiting_tenant",
        bot_answered: true,
        bot_confidence: 0.92,
        created_by_email: "owner@acme.test",
        created_at: "2026-06-18T00:00:00Z",
        updated_at: "2026-06-18T00:00:00Z",
        last_activity_at: "2026-06-18T00:00:00Z",
      },
    });
    stageSupabaseResponse("support_ticket_messages", "insert", {
      data: [
        {
          id: "m1",
          author_role: "tenant",
          author_email: "owner@acme.test",
          body: "How do I add a teammate?",
          created_at: "2026-06-18T00:00:00Z",
        },
        {
          id: "m2",
          author_role: "bot",
          author_email: null,
          body: "Open Settings → Team.",
          created_at: "2026-06-18T00:00:01Z",
        },
      ],
    });

    const res = await request(makeApp())
      .post("/admin/support/tickets")
      .send({ subject: "Add a teammate", body: "How do I add a teammate?" });

    expect(res.status).toBe(201);
    expect(res.body.ticket).toMatchObject({
      status: "awaiting_tenant",
      botAnswered: true,
      botConfidence: 0.92,
    });
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[1]).toMatchObject({ authorRole: "bot" });
  });

  it("escalates to the platform queue when the bot hands off", async () => {
    bot.result = { kind: "handoff" };
    stageSupabaseResponse("support_tickets", "insert", {
      data: {
        id: TICKET_ID,
        subject: "Bug",
        status: "awaiting_platform",
        bot_answered: false,
        bot_confidence: null,
        created_by_email: "owner@acme.test",
        created_at: "2026-06-18T00:00:00Z",
        updated_at: "2026-06-18T00:00:00Z",
        last_activity_at: "2026-06-18T00:00:00Z",
      },
    });
    stageSupabaseResponse("support_ticket_messages", "insert", {
      data: [
        {
          id: "m1",
          author_role: "tenant",
          author_email: "owner@acme.test",
          body: "The orders page 500s",
          created_at: "2026-06-18T00:00:00Z",
        },
      ],
    });

    const res = await request(makeApp())
      .post("/admin/support/tickets")
      .send({ subject: "Bug", body: "The orders page 500s" });

    expect(res.status).toBe(201);
    expect(res.body.ticket).toMatchObject({
      status: "awaiting_platform",
      botAnswered: false,
    });
    expect(res.body.messages).toHaveLength(1);
  });
});

describe("GET /admin/support/tickets", () => {
  it("lists the tenant's tickets", async () => {
    stageSupabaseResponse("support_tickets", "select", {
      data: [
        {
          id: TICKET_ID,
          subject: "Add a teammate",
          status: "awaiting_tenant",
          bot_answered: true,
          bot_confidence: 0.9,
          created_by_email: "owner@acme.test",
          created_at: "2026-06-18T00:00:00Z",
          updated_at: "2026-06-18T00:00:00Z",
          last_activity_at: "2026-06-18T00:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get("/admin/support/tickets");
    expect(res.status).toBe(200);
    expect(res.body.tickets).toHaveLength(1);
    expect(res.body.tickets[0]).toMatchObject({ botAnswered: true });
  });
});

describe("GET /admin/support/tickets/:id", () => {
  it("404s a missing ticket", async () => {
    stageSupabaseResponse("support_tickets", "select", { data: null });
    const res = await request(makeApp()).get(
      `/admin/support/tickets/${TICKET_ID}`,
    );
    expect(res.status).toBe(404);
  });

  it("returns the ticket and its thread", async () => {
    stageSupabaseResponse("support_tickets", "select", {
      data: {
        id: TICKET_ID,
        subject: "Add a teammate",
        status: "awaiting_tenant",
        bot_answered: true,
        bot_confidence: 0.9,
        created_by_email: "owner@acme.test",
        created_at: "2026-06-18T00:00:00Z",
        updated_at: "2026-06-18T00:00:00Z",
        last_activity_at: "2026-06-18T00:00:00Z",
      },
    });
    stageSupabaseResponse("support_ticket_messages", "select", {
      data: [
        {
          id: "m1",
          author_role: "tenant",
          author_email: "owner@acme.test",
          body: "How?",
          created_at: "2026-06-18T00:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get(
      `/admin/support/tickets/${TICKET_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ticket.id).toBe(TICKET_ID);
    expect(res.body.messages).toHaveLength(1);
  });
});

describe("POST /admin/support/tickets/:id/resolve", () => {
  it("marks a ticket resolved", async () => {
    stageSupabaseResponse("support_tickets", "update", {
      data: {
        id: TICKET_ID,
        subject: "Add a teammate",
        status: "resolved",
        bot_answered: true,
        bot_confidence: 0.9,
        created_by_email: "owner@acme.test",
        created_at: "2026-06-18T00:00:00Z",
        updated_at: "2026-06-18T01:00:00Z",
        last_activity_at: "2026-06-18T01:00:00Z",
      },
    });
    const res = await request(makeApp()).post(
      `/admin/support/tickets/${TICKET_ID}/resolve`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ticket.status).toBe("resolved");
  });
});

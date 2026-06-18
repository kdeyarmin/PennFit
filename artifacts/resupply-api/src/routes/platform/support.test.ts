// /platform/support/* — the cross-tenant support queue.
//
// The gate is mocked (covered by its own in-house test); this focuses on
// the queue/reply/status contract over the staged Supabase mock.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequirePlatformAdminMock,
  type MockPlatformAdminRef,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockPlatformAdmin } = vi.hoisted(() => ({
  mockPlatformAdmin: { current: null } as MockPlatformAdminRef,
}));
vi.mock("../../middlewares/requirePlatformAdmin", () =>
  makeRequirePlatformAdminMock(mockPlatformAdmin),
);

import supportRouter from "./support";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(supportRouter);
  return app;
}

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  supabaseMock.reset();
  mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
});

function ticketRow(over: Record<string, unknown> = {}) {
  return {
    id: TICKET_ID,
    org_id: ORG_ID,
    subject: "The orders page 500s",
    status: "awaiting_platform",
    bot_answered: false,
    bot_confidence: null,
    created_by_email: "owner@acme.test",
    created_at: "2026-06-18T00:00:00Z",
    updated_at: "2026-06-18T00:00:00Z",
    last_activity_at: "2026-06-18T00:00:00Z",
    ...over,
  };
}

describe("GET /platform/support/tickets", () => {
  it("401s without a platform admin", async () => {
    mockPlatformAdmin.current = null;
    const res = await request(makeApp()).get("/platform/support/tickets");
    expect(res.status).toBe(401);
  });

  it("lists tickets with tenant info and status counts", async () => {
    stageSupabaseResponse("support_tickets", "select", {
      data: [ticketRow()],
    });
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: ORG_ID, slug: "acme", name: "Acme DME" }],
    });
    const res = await request(makeApp()).get("/platform/support/tickets");
    expect(res.status).toBe(200);
    expect(res.body.tickets).toHaveLength(1);
    expect(res.body.tickets[0]).toMatchObject({
      orgId: ORG_ID,
      tenant: { slug: "acme", name: "Acme DME" },
    });
    expect(res.body.counts).toMatchObject({ awaiting_platform: 1 });
  });
});

describe("POST /platform/support/tickets/:id/reply", () => {
  it("400s on an empty reply", async () => {
    const res = await request(makeApp())
      .post(`/platform/support/tickets/${TICKET_ID}/reply`)
      .send({ body: "" });
    expect(res.status).toBe(400);
  });

  it("404s a missing ticket", async () => {
    stageSupabaseResponse("support_tickets", "select", { data: null });
    const res = await request(makeApp())
      .post(`/platform/support/tickets/${TICKET_ID}/reply`)
      .send({ body: "We pushed a fix." });
    expect(res.status).toBe(404);
  });

  it("posts the operator reply and flips status to awaiting_tenant", async () => {
    // loadTicket (select) → update → messages (select)
    stageSupabaseResponse("support_tickets", "select", {
      data: { id: TICKET_ID, org_id: ORG_ID, status: "awaiting_platform" },
    });
    stageSupabaseResponse("support_ticket_messages", "insert", { data: null });
    stageSupabaseResponse("support_tickets", "update", {
      data: ticketRow({ status: "awaiting_tenant" }),
    });
    stageSupabaseResponse("support_ticket_messages", "select", {
      data: [
        {
          id: "m1",
          author_role: "platform",
          author_email: "ops@cm",
          body: "We pushed a fix.",
          created_at: "2026-06-18T01:00:00Z",
        },
      ],
    });

    const res = await request(makeApp())
      .post(`/platform/support/tickets/${TICKET_ID}/reply`)
      .send({ body: "We pushed a fix." });

    expect(res.status).toBe(200);
    expect(res.body.ticket.status).toBe("awaiting_tenant");
    expect(res.body.messages[0]).toMatchObject({ authorRole: "platform" });
  });
});

describe("POST /platform/support/tickets/:id/status", () => {
  it("rejects an invalid status", async () => {
    const res = await request(makeApp())
      .post(`/platform/support/tickets/${TICKET_ID}/status`)
      .send({ status: "banana" });
    expect(res.status).toBe(400);
  });

  it("updates the status", async () => {
    stageSupabaseResponse("support_tickets", "update", {
      data: ticketRow({ status: "resolved" }),
    });
    const res = await request(makeApp())
      .post(`/platform/support/tickets/${TICKET_ID}/status`)
      .send({ status: "resolved" });
    expect(res.status).toBe(200);
    expect(res.body.ticket.status).toBe("resolved");
  });
});

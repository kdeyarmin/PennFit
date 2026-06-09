// Route tests for GET /admin/email-inbox.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

import emailInboxRouter from "./email-inbox";

const ALLOWED_EMAIL = "ops@penn.example.com";
const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const EPISODE_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "33333333-3333-4333-8333-333333333333";

function makeApp(): Express {
  const app = express();
  app.use("/resupply-api", emailInboxRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  mockAdmin.current = {
    userId: "user_op",
    email: ALLOWED_EMAIL,
    role: "admin",
  };
}

describe("GET /admin/email-inbox", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    mockAdmin.current = null;
    supabaseMock.reset();
  });
  afterEach(() => {
    mockAdmin.current = null;
  });

  it("returns 401 with no session", async () => {
    const res = await request(makeApp()).get("/resupply-api/admin/email-inbox");
    expect(res.status).toBe(401);
  });

  it("returns 400 invalid_query on a bad mailbox", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp()).get(
      "/resupply-api/admin/email-inbox?mailbox=spam",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("lists the needs_response mailbox enriched with subject + preview + counts", async () => {
    stubVerifiedAdmin();
    // 1) page of email conversations
    stageSupabaseResponse("conversations", "select", {
      data: [
        {
          id: CONV_ID,
          patient_id: PATIENT_ID,
          episode_id: EPISODE_ID,
          status: "awaiting_admin",
          last_message_at: new Date("2025-04-02T12:00:00Z").toISOString(),
          created_at: new Date("2025-04-01T11:00:00Z").toISOString(),
        },
      ],
      count: 1,
    });
    // 2) needs-response count (Promise.all, fires before responded)
    stageSupabaseResponse("conversations", "select", { count: 1 });
    // 3) responded count
    stageSupabaseResponse("conversations", "select", { count: 4 });
    // patient identity
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: PATIENT_ID,
          legal_first_name: "Alice",
          legal_last_name: "Smith",
          email: "alice@example.com",
        },
      ],
    });
    // messages for enrichment (newest-first)
    stageSupabaseResponse("messages", "select", {
      data: [
        {
          conversation_id: CONV_ID,
          direction: "inbound",
          sender_role: "patient",
          body: "Do your nasal masks work for mouth breathers?",
          vendor_metadata: {
            sendgrid_inbound: true,
            subject: "Mask question",
          },
          created_at: new Date("2025-04-02T12:00:00Z").toISOString(),
        },
      ],
    });

    const res = await request(makeApp()).get(
      "/resupply-api/admin/email-inbox?mailbox=needs_response&limit=25",
    );
    expect(res.status).toBe(200);
    expect(res.body.mailbox).toBe("needs_response");
    expect(res.body.total).toBe(1);
    expect(res.body.counts).toEqual({ needsResponse: 1, responded: 4 });
    expect(res.body.items[0]).toMatchObject({
      id: CONV_ID,
      patientId: PATIENT_ID,
      patientFirstName: "Alice",
      patientLastName: "Smith",
      patientEmail: "alice@example.com",
      status: "awaiting_admin",
      subject: "Mask question",
      lastMessageDirection: "inbound",
      lastMessageSenderRole: "patient",
      lastMessageAutoReply: false,
    });
    expect(res.body.items[0].lastMessagePreview).toContain("nasal masks");
  });

  it("flags an auto-reply as the last message in the responded mailbox", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("conversations", "select", {
      data: [
        {
          id: CONV_ID,
          patient_id: PATIENT_ID,
          episode_id: EPISODE_ID,
          status: "awaiting_patient",
          last_message_at: new Date("2025-04-02T12:05:00Z").toISOString(),
          created_at: new Date("2025-04-01T11:00:00Z").toISOString(),
        },
      ],
      count: 1,
    });
    stageSupabaseResponse("conversations", "select", { count: 0 });
    stageSupabaseResponse("conversations", "select", { count: 1 });
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: PATIENT_ID,
          legal_first_name: "Bob",
          legal_last_name: "Jones",
          email: "bob@example.com",
        },
      ],
    });
    // Newest message is the bot's auto-reply; the inbound carries subject.
    stageSupabaseResponse("messages", "select", {
      data: [
        {
          conversation_id: CONV_ID,
          direction: "outbound",
          sender_role: "agent",
          body: "Great question — a full-face mask is the way to go.\n— The PennPaps Team",
          vendor_metadata: { auto_reply: true, sendgrid_message_id: "sg-1" },
          created_at: new Date("2025-04-02T12:05:00Z").toISOString(),
        },
        {
          conversation_id: CONV_ID,
          direction: "inbound",
          sender_role: "patient",
          body: "Do nasal masks work?",
          vendor_metadata: { sendgrid_inbound: true, subject: "Masks" },
          created_at: new Date("2025-04-02T12:00:00Z").toISOString(),
        },
      ],
    });

    const res = await request(makeApp()).get(
      "/resupply-api/admin/email-inbox?mailbox=responded",
    );
    expect(res.status).toBe(200);
    expect(res.body.mailbox).toBe("responded");
    expect(res.body.items[0]).toMatchObject({
      status: "awaiting_patient",
      subject: "Masks",
      lastMessageDirection: "outbound",
      lastMessageSenderRole: "agent",
      lastMessageAutoReply: true,
    });
    expect(res.body.items[0].lastMessagePreview).toContain("full-face mask");
  });

  it("returns an empty page without identity round-trips", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("conversations", "select", { data: [], count: 0 });
    stageSupabaseResponse("conversations", "select", { count: 0 });
    stageSupabaseResponse("conversations", "select", { count: 0 });
    const res = await request(makeApp()).get(
      "/resupply-api/admin/email-inbox?mailbox=needs_response",
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.counts).toEqual({ needsResponse: 0, responded: 0 });
  });
});

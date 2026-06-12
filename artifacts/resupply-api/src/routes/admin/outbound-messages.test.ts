// Tests for routes/admin/outbound-messages.ts — the outbound SMS/email
// send log.
//
// Coverage:
//   1. Auth: 401 unauthenticated, 403 for roles without
//      `admin.tools.manage` (CSR), 200 for supervisor + super-admin.
//   2. Query validation: bad channel / result / sinceDays → 400.
//   3. Response shape: items serialized from the embedded
//      conversations/patients join, result bucketing, counts, paging
//      echo.

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

// ── Supabase mock (module-scoped) ─────────────────────────────────────────────
const supabaseMock = installSupabaseMock();

// ── Auth mock ─────────────────────────────────────────────────────────────────
const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import outboundMessagesRouter from "./outbound-messages";

// `admin.tools.manage` is held by the admin + super_admin effective
// roles only (supervisor / compliance_officer / admin DB roles).
const SUPERVISOR: MockAdminCtx = {
  userId: "u_sup_1",
  email: "sup@penn.example.com",
  role: "agent",
  granularRole: "supervisor",
};
const SUPER_ADMIN: MockAdminCtx = {
  userId: "u_admin_1",
  email: "owner@penn.example.com",
  role: "admin",
  granularRole: "admin",
};
const CSR: MockAdminCtx = {
  userId: "u_csr_1",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(outboundMessagesRouter);
  return app;
}

// The route makes five `messages` selects in order: the main page
// query, then four head-only bucket counts (delivered, sent, failed,
// pending).
function stageEmptyResponses() {
  stageSupabaseResponse("messages", "select", {
    data: [],
    count: 0,
    error: null,
  });
  for (const count of [0, 0, 0, 0]) {
    stageSupabaseResponse("messages", "select", {
      data: null,
      count,
      error: null,
    });
  }
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/outbound-messages — auth", () => {
  it("401s when no session is present", async () => {
    const res = await request(makeApp()).get("/admin/outbound-messages");
    expect(res.status).toBe(401);
  });

  it("403s for a CSR (no admin.tools.manage)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).get("/admin/outbound-messages");
    expect(res.status).toBe(403);
    expect(res.body.requiredPermission).toBe("admin.tools.manage");
  });

  it("200s for a supervisor (admin effective role)", async () => {
    mockAdmin.current = SUPERVISOR;
    stageEmptyResponses();
    const res = await request(makeApp()).get("/admin/outbound-messages");
    expect(res.status).toBe(200);
  });

  it("200s for a super-admin", async () => {
    mockAdmin.current = SUPER_ADMIN;
    stageEmptyResponses();
    const res = await request(makeApp()).get("/admin/outbound-messages");
    expect(res.status).toBe(200);
  });
});

describe("GET /admin/outbound-messages — query validation", () => {
  beforeEach(() => {
    mockAdmin.current = SUPER_ADMIN;
  });

  it("400s on an unknown channel", async () => {
    const res = await request(makeApp()).get(
      "/admin/outbound-messages?channel=voice",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("400s on an unknown result bucket", async () => {
    const res = await request(makeApp()).get(
      "/admin/outbound-messages?result=bogus",
    );
    expect(res.status).toBe(400);
  });

  it("400s on a non-numeric sinceDays", async () => {
    const res = await request(makeApp()).get(
      "/admin/outbound-messages?sinceDays=abc",
    );
    expect(res.status).toBe(400);
  });

  it("400s on an out-of-range limit", async () => {
    const res = await request(makeApp()).get(
      "/admin/outbound-messages?limit=500",
    );
    expect(res.status).toBe(400);
  });

  it("400s on unknown query params (strict schema)", async () => {
    const res = await request(makeApp()).get(
      "/admin/outbound-messages?foo=bar",
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /admin/outbound-messages — response shape", () => {
  const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
  const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
  const PATIENT_ID = "33333333-3333-4333-8333-333333333333";

  beforeEach(() => {
    mockAdmin.current = SUPER_ADMIN;
  });

  it("echoes defaults and returns empty items + counts", async () => {
    stageEmptyResponses();
    const res = await request(makeApp()).get("/admin/outbound-messages");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sinceDays: 14,
      channel: "all",
      result: "all",
      limit: 50,
      offset: 0,
      total: 0,
      counts: { delivered: 0, sent: 0, failed: 0, pending: 0 },
      items: [],
    });
  });

  it("echoes the supplied filters", async () => {
    stageEmptyResponses();
    const res = await request(makeApp()).get(
      "/admin/outbound-messages?channel=sms&result=failed&sinceDays=7&limit=25&offset=25",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sinceDays: 7,
      channel: "sms",
      result: "failed",
      limit: 25,
      offset: 25,
    });
  });

  it("serializes rows from the embedded conversation/patient join", async () => {
    stageSupabaseResponse("messages", "select", {
      data: [
        {
          id: MESSAGE_ID,
          conversation_id: CONVERSATION_ID,
          sender_role: "system",
          delivery_status: "undelivered",
          delivery_error: "30005",
          sent_at: "2026-06-11T12:00:00.000Z",
          delivered_at: null,
          created_at: "2026-06-11T11:59:58.000Z",
          conversations: {
            channel: "sms",
            patient_id: PATIENT_ID,
            patients: {
              legal_first_name: "Pat",
              legal_last_name: "Example",
            },
          },
        },
      ],
      count: 1,
      error: null,
    });
    for (const count of [0, 0, 1, 0]) {
      stageSupabaseResponse("messages", "select", {
        data: null,
        count,
        error: null,
      });
    }

    const res = await request(makeApp()).get("/admin/outbound-messages");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.counts).toEqual({
      delivered: 0,
      sent: 0,
      failed: 1,
      pending: 0,
    });
    expect(res.body.items).toEqual([
      {
        id: MESSAGE_ID,
        occurredAt: "2026-06-11T12:00:00.000Z",
        channel: "sms",
        senderRole: "system",
        deliveryStatus: "undelivered",
        deliveryError: "30005",
        deliveredAt: null,
        result: "failed",
        conversationId: CONVERSATION_ID,
        patientId: PATIENT_ID,
        patientName: "Pat Example",
      },
    ]);
  });

  it("buckets NULL delivery_status as pending and 'delivered' as delivered", async () => {
    stageSupabaseResponse("messages", "select", {
      data: [
        {
          id: MESSAGE_ID,
          conversation_id: CONVERSATION_ID,
          sender_role: "admin",
          delivery_status: null,
          delivery_error: null,
          sent_at: null,
          delivered_at: null,
          created_at: "2026-06-11T11:00:00.000Z",
          conversations: { channel: "email", patient_id: null, patients: null },
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          conversation_id: CONVERSATION_ID,
          sender_role: "system",
          delivery_status: "delivered",
          delivery_error: null,
          sent_at: "2026-06-11T10:00:00.000Z",
          delivered_at: "2026-06-11T10:00:05.000Z",
          created_at: "2026-06-11T10:00:00.000Z",
          conversations: { channel: "email", patient_id: null, patients: null },
        },
      ],
      count: 2,
      error: null,
    });
    for (const count of [1, 0, 0, 1]) {
      stageSupabaseResponse("messages", "select", {
        data: null,
        count,
        error: null,
      });
    }

    const res = await request(makeApp()).get("/admin/outbound-messages");
    expect(res.status).toBe(200);
    const results = (res.body.items as Array<{ result: string }>).map(
      (i) => i.result,
    );
    expect(results).toEqual(["pending", "delivered"]);
    // NULL sent_at falls back to created_at for the timeline column.
    expect(res.body.items[0].occurredAt).toBe("2026-06-11T11:00:00.000Z");
    expect(res.body.items[0].patientId).toBeNull();
    expect(res.body.items[0].patientName).toBeNull();
  });
});

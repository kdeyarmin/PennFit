// Route tests for the in-app branch of POST /conversations/:id/reply.
// The SMS/email branch is exercised by the upstream
// `replyInConversation` tests in @workspace/resupply-reminders;
// these tests focus on the new in_app dispatch split.
//
// Coverage:
//   * 401 without admin
//   * 400 with empty body
//   * 404 when the conversation doesn't exist
//   * In-app reply: persists, audits with non-PHI metadata,
//     attempts to send notification email, returns 201
//   * In-app reply on a closed conversation → 409
//   * Notification email is best-effort: a SendGrid throw doesn't
//     fail the route (the message is already in the DB)

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

// Bypass idempotency middleware — this test isn't about
// idempotency semantics.
vi.mock("../../middlewares/idempotency", () => ({
  withIdempotency: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

const appendAdminInAppReplyMock = vi.hoisted(() =>
  vi.fn(async () => ({
    status: "ok" as const,
    result: { messageId: "msg_admin_1" },
  })),
);
vi.mock("../../lib/messaging/in-app-conversation", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/messaging/in-app-conversation")
  >("../../lib/messaging/in-app-conversation");
  return {
    ...actual,
    appendAdminInAppReply: appendAdminInAppReplyMock,
  };
});

const sendEmailMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<{ messageId: string }>>(async () => ({
    messageId: "sg_1",
  })),
);
vi.mock("@workspace/resupply-email", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-email")
  >("@workspace/resupply-email");
  return {
    ...actual,
    createSendgridClient: () => ({ sendEmail: sendEmailMock }),
  };
});

const sendPushToCustomerMock = vi.hoisted(() =>
  vi.fn<
    (
      customerId: string,
      payload: {
        title: string;
        body: string;
        url?: string;
        tag?: string;
      },
    ) => Promise<{ delivered: number; expired: number; transient: number }>
  >(async () => ({ delivered: 0, expired: 0, transient: 0 })),
);
vi.mock("../../lib/web-push", () => ({
  sendPushToCustomer: sendPushToCustomerMock,
  isPushConfigured: () => false,
}));

import replyRouter from "./reply";

const CONV_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(replyRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
  appendAdminInAppReplyMock.mockClear();
  appendAdminInAppReplyMock.mockResolvedValue({
    status: "ok",
    result: { messageId: "msg_admin_1" },
  });
  sendEmailMock.mockClear();
  sendEmailMock.mockResolvedValue({ messageId: "sg_1" });
  sendPushToCustomerMock.mockClear();
});

describe("POST /conversations/:id/reply (in_app)", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/reply`)
      .send({ body: "ping" });
    expect(res.status).toBe(401);
  });

  it("404s when the conversation doesn't exist", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    stageSupabaseResponse("conversations", "select", { data: null });
    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/reply`)
      .send({ body: "ping" });
    expect(res.status).toBe(404);
  });

  it("400s with empty body", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/reply`)
      .send({ body: "  " });
    expect(res.status).toBe(400);
    expect(appendAdminInAppReplyMock).not.toHaveBeenCalled();
  });

  it("persists, audits, emails, and returns 201 on the in_app branch", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    // Early channel check.
    stageSupabaseResponse("conversations", "select", {
      data: { channel: "in_app" },
    });
    // tryNotifyCustomerOfReply — conversations.customer_id +
    // last_in_app_notification_at lookup.
    stageSupabaseResponse("conversations", "select", {
      data: {
        customer_id: "user_anna",
        last_in_app_notification_at: null,
      },
    });
    // shop_customers lookup.
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: "user_anna",
        email_lower: "shopper@example.com",
        display_name: "Anna Singh",
        communication_preferences: null,
      },
    });
    // Throttle stamp.
    stageSupabaseResponse("conversations", "update", { error: null });

    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/reply`)
      .send({
        body: "Thanks for reaching out — your replacement ships today.",
      });

    expect(res.status).toBe(201);
    expect(res.body.messageId).toBe("msg_admin_1");
    expect(res.body.vendorRef).toBeNull();

    expect(appendAdminInAppReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONV_ID,
        body: "Thanks for reaching out — your replacement ships today.",
      }),
    );

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("messaging.reply.sent");
    expect(audit.metadata.channel).toBe("in_app");
    expect(audit.metadata.status).toBe("ok");
    expect(audit.metadata.message_id).toBe("msg_admin_1");
    // No PHI — never the body content.
    expect(JSON.stringify(audit.metadata)).not.toContain("replacement");

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const sendCall = sendEmailMock.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      text: string;
    };
    expect(sendCall.to).toBe("shopper@example.com");
    // Subject + body never include the message content.
    expect(sendCall.subject).not.toContain("replacement");
    expect(sendCall.text).not.toContain("replacement");

    // Phase G.2 — push fan-out runs alongside email; payload carries
    // no PHI and links to the in-app thread.
    expect(sendPushToCustomerMock).toHaveBeenCalledTimes(1);
    const [pushCustId, pushPayload] = sendPushToCustomerMock.mock.calls[0]!;
    expect(pushCustId).toBe("user_anna");
    expect(pushPayload.title).toBe("New message from PennPaps");
    expect(pushPayload.url).toBe("/account/messages");
    expect(pushPayload.tag).toMatch(/^csr_reply:/);
    expect(JSON.stringify(pushPayload)).not.toContain("replacement");
  });

  it("still pushes and returns 201 when notification email throws", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    stageSupabaseResponse("conversations", "select", {
      data: { channel: "in_app" },
    });
    stageSupabaseResponse("conversations", "select", {
      data: {
        customer_id: "user_anna",
        last_in_app_notification_at: null,
      },
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: "user_anna",
        email_lower: "shopper@example.com",
        display_name: "Anna Singh",
        communication_preferences: null,
      },
    });
    stageSupabaseResponse("conversations", "update", { error: null });
    sendEmailMock.mockRejectedValueOnce(new Error("SendGrid unavailable"));

    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/reply`)
      .send({
        body: "Thanks for reaching out — your replacement ships today.",
      });

    expect(res.status).toBe(201);
    expect(res.body.messageId).toBe("msg_admin_1");

    expect(sendEmailMock).toHaveBeenCalledTimes(1);

    // Push fan-out is independent of best-effort email delivery.
    expect(sendPushToCustomerMock).toHaveBeenCalledTimes(1);
    const [pushCustId, pushPayload] = sendPushToCustomerMock.mock.calls[0]!;
    expect(pushCustId).toBe("user_anna");
    expect(pushPayload.title).toBe("New message from PennPaps");
    expect(pushPayload.url).toBe("/account/messages");
    expect(pushPayload.tag).toMatch(/^csr_reply:/);
    expect(JSON.stringify(pushPayload)).not.toContain("replacement");
  });

  it("returns 409 on a closed in_app thread", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    stageSupabaseResponse("conversations", "select", {
      data: { channel: "in_app" },
    });
    appendAdminInAppReplyMock.mockResolvedValueOnce({
      status: "conversation_closed",
    } as unknown as { status: "ok"; result: { messageId: string } });
    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/reply`)
      .send({ body: "ping" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("conversation_closed");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("skips the notification email when the customer has opted out", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    stageSupabaseResponse("conversations", "select", {
      data: { channel: "in_app" },
    });
    stageSupabaseResponse("conversations", "select", {
      data: {
        customer_id: "user_anna",
        last_in_app_notification_at: null,
      },
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: "user_anna",
        email_lower: "shopper@example.com",
        display_name: "Anna Singh",
        communication_preferences: { emailInAppReplyNotifications: false },
      },
    });

    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/reply`)
      .send({ body: "Thanks — your replacement ships today." });

    expect(res.status).toBe(201);
    // Message persisted + audit written, but no notification email sent.
    expect(appendAdminInAppReplyMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Phase G.2 — push is its own channel governed by the browser
    // permission, not the email opt-in. It should still fire.
    expect(sendPushToCustomerMock).toHaveBeenCalledTimes(1);
  });

  it("sends the notification email when prefs are missing entirely (default-on)", async () => {
    // Pre-Phase-12 customer rows have a null prefs blob; the
    // coalesce-against-defaults logic must keep them in the "send"
    // bucket rather than fail-closed.
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    stageSupabaseResponse("conversations", "select", {
      data: { channel: "in_app" },
    });
    stageSupabaseResponse("conversations", "select", {
      data: {
        customer_id: "user_anna",
        last_in_app_notification_at: null,
      },
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: "user_anna",
        email_lower: "shopper@example.com",
        display_name: "Anna Singh",
        communication_preferences: null,
      },
    });
    stageSupabaseResponse("conversations", "update", { error: null });

    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/reply`)
      .send({ body: "ping" });

    expect(res.status).toBe(201);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("skips the notification email when a recent notification is within the throttle window", async () => {
    // Phase 13: a "lastNotifiedAt" 60 seconds ago should suppress
    // the next email (default throttle window is 15 min).
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    stageSupabaseResponse("conversations", "select", {
      data: { channel: "in_app" },
    });
    stageSupabaseResponse("conversations", "select", {
      data: {
        customer_id: "user_anna",
        last_in_app_notification_at: new Date(
          Date.now() - 60_000,
        ).toISOString(),
      },
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: "user_anna",
        email_lower: "shopper@example.com",
        display_name: "Anna Singh",
        communication_preferences: null,
      },
    });

    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/reply`)
      .send({ body: "follow-up to the previous reply" });

    expect(res.status).toBe(201);
    expect(appendAdminInAppReplyMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    // No email, no throttle UPDATE — we never sent.
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(getSupabaseCallCount("conversations", "update")).toBe(0);
  });

  it("sends and stamps when the prior notification was outside the throttle window", async () => {
    // 30 min ago — well past the 15 min window — so the email fires
    // and the throttle column is stamped.
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    stageSupabaseResponse("conversations", "select", {
      data: { channel: "in_app" },
    });
    stageSupabaseResponse("conversations", "select", {
      data: {
        customer_id: "user_anna",
        last_in_app_notification_at: new Date(
          Date.now() - 30 * 60_000,
        ).toISOString(),
      },
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: "user_anna",
        email_lower: "shopper@example.com",
        display_name: "Anna Singh",
        communication_preferences: null,
      },
    });
    stageSupabaseResponse("conversations", "update", { error: null });

    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/reply`)
      .send({ body: "ping" });

    expect(res.status).toBe(201);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(getSupabaseCallCount("conversations", "update")).toBe(1);
    // The route stamps `last_in_app_notification_at` on the row;
    // the patch payload is an ISO string under PostgREST.
    const updates = getSupabaseWritePayloads(
      "conversations",
      "update",
    ) as Record<string, unknown>[];
    expect(typeof updates[0]?.last_in_app_notification_at).toBe("string");
  });

  it("treats notification email failure as best-effort (still 201)", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    stageSupabaseResponse("conversations", "select", {
      data: { channel: "in_app" },
    });
    stageSupabaseResponse("conversations", "select", {
      data: {
        customer_id: "user_anna",
        last_in_app_notification_at: null,
      },
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: "user_anna",
        email_lower: "shopper@example.com",
        display_name: "Anna Singh",
        communication_preferences: null,
      },
    });
    stageSupabaseResponse("conversations", "update", { error: null });
    sendEmailMock.mockRejectedValueOnce(new Error("sendgrid down"));

    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/reply`)
      .send({ body: "ping" });

    expect(res.status).toBe(201);
    expect(res.body.messageId).toBe("msg_admin_1");
    // Audit still wrote even though email failed.
    expect(logAuditMock).toHaveBeenCalledTimes(1);
  });
});

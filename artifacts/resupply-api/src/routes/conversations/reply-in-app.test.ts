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
import { SQL } from "drizzle-orm";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// Drizzle stub. The route does up to two SELECTs and one UPDATE:
//   1. Early channel check: SELECT channel FROM conversations …
//   2. Email-resolution join: SELECT email, displayName, prefs,
//      lastNotifiedAt FROM conversations JOIN shop_customers …
//   3. Throttle stamp (post-send only): UPDATE conversations SET
//      last_in_app_notification_at = now() …  (DB-side expression)
// All three run through the fluent stub; the test pushes select
// results in order and inspects updateCalls for throttle stamping.
const selectQueue: unknown[][] = [];
const updateCalls: Array<Record<string, unknown>> = [];
const dbStub = {
  select: vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      innerJoin: () => obj,
      where: () => obj,
      limit: () => Promise.resolve(result),
    };
    return obj;
  }),
  update: vi.fn(() => {
    const obj: Record<string, unknown> = {
      set: (vals: Record<string, unknown>) => {
        updateCalls.push(vals);
        return obj;
      },
      where: () => Promise.resolve(),
    };
    return obj;
  }),
};
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return { ...actual, getDbPool: () => ({}) as never };
});

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
  selectQueue.length = 0;
  updateCalls.length = 0;
  logAuditMock.mockClear();
  appendAdminInAppReplyMock.mockClear();
  appendAdminInAppReplyMock.mockResolvedValue({
    status: "ok",
    result: { messageId: "msg_admin_1" },
  });
  sendEmailMock.mockClear();
  sendEmailMock.mockResolvedValue({ messageId: "sg_1" });
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
    selectQueue.push([]); // early channel check returns nothing
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
    selectQueue.push([{ channel: "in_app" }]); // early channel check
    selectQueue.push([
      { email: "shopper@example.com", displayName: "Anna Singh" },
    ]); // email-resolution join

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
  });

  it("returns 409 on a closed in_app thread", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ channel: "in_app" }]); // early channel check
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
    selectQueue.push([{ channel: "in_app" }]); // early channel check
    selectQueue.push([
      {
        email: "shopper@example.com",
        displayName: "Anna Singh",
        prefs: { emailInAppReplyNotifications: false },
      },
    ]);

    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/reply`)
      .send({ body: "Thanks — your replacement ships today." });

    expect(res.status).toBe(201);
    // Message persisted + audit written, but no notification email sent.
    expect(appendAdminInAppReplyMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
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
    selectQueue.push([{ channel: "in_app" }]);
    selectQueue.push([
      {
        email: "shopper@example.com",
        displayName: "Anna Singh",
        prefs: null,
      },
    ]);

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
    selectQueue.push([{ channel: "in_app" }]);
    selectQueue.push([
      {
        email: "shopper@example.com",
        displayName: "Anna Singh",
        prefs: null,
        lastNotifiedAt: new Date(Date.now() - 60_000),
      },
    ]);

    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/reply`)
      .send({ body: "follow-up to the previous reply" });

    expect(res.status).toBe(201);
    expect(appendAdminInAppReplyMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    // No email, no throttle UPDATE — we never sent.
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
  });

  it("sends and stamps when the prior notification was outside the throttle window", async () => {
    // 30 min ago — well past the 15 min window — so the email fires
    // and the throttle column is stamped.
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ channel: "in_app" }]);
    selectQueue.push([
      {
        email: "shopper@example.com",
        displayName: "Anna Singh",
        prefs: null,
        lastNotifiedAt: new Date(Date.now() - 30 * 60_000),
      },
    ]);

    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/reply`)
      .send({ body: "ping" });

    expect(res.status).toBe(201);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.lastInAppNotificationAt).toBeInstanceOf(SQL);
  });

  it("treats notification email failure as best-effort (still 201)", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ channel: "in_app" }]);
    selectQueue.push([
      { email: "shopper@example.com", displayName: "Anna Singh" },
    ]);
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

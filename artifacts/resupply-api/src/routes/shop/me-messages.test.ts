// Route tests for routes/shop/me-messages.ts.
//
// Coverage:
//   * 401 when no session (both GET and POST)
//   * GET returns { thread: null, messages: [] } for a fresh customer
//   * GET returns the thread + messages for an existing thread
//   * POST validation rejects empty + over-limit bodies
//   * POST persists + audits with non-PHI metadata; first POST creates
//     the thread (threadCreated: true) and reuses it on the next call
//
// We mock the helper module so the test focuses on the route's
// validation + audit envelope contract, not on the SQL of the helper
// itself (covered separately by the helper-aware integration tests).

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInProfile,
} from "../../test-helpers/auth-mocks";
import { installSupabaseMock } from "../../test-helpers/supabase-mock";

// Install the shared Supabase stub so any code path the route pulls
// in transitively (audit log, ensureShopCustomerRow, etc.) gets a
// no-op client instead of attempting a real PostgREST round-trip.
// All meaningful DB work in this suite happens through the mocked
// `in-app-conversation` helper below.
installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: {
    current: null as null | string | MockSignedInProfile,
  },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

const ensureShopCustomerRowMock = vi.hoisted(() =>
  vi.fn(async () => undefined),
);
vi.mock("../../lib/stripe/customer", () => ({
  ensureShopCustomerRow: ensureShopCustomerRowMock,
}));

const fetchInAppThreadMock = vi.hoisted(() =>
  vi.fn(async () => ({
    thread: null as null | {
      id: string;
      status: "open" | "awaiting_patient" | "awaiting_admin" | "closed";
      lastMessageAt: string | null;
      createdAt: string;
    },
    messages: [] as Array<{
      id: string;
      direction: "inbound" | "outbound";
      senderRole: "customer" | "admin" | "agent" | "system";
      body: string;
      createdAt: string;
      deliveryStatus: string | null;
    }>,
    unreadFromCsr: 0,
  })),
);
const fetchInAppUnreadCountMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<number>>(async () => 0),
);
const markInAppThreadReadMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<boolean>>(async () => true),
);
const appendCustomerMessageMock = vi.hoisted(() =>
  vi.fn(async () => ({
    threadId: "conv_1",
    messageId: "msg_1",
    threadCreated: true,
  })),
);
vi.mock("../../lib/messaging/in-app-conversation", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/messaging/in-app-conversation")
  >("../../lib/messaging/in-app-conversation");
  return {
    ...actual,
    fetchInAppThread: fetchInAppThreadMock,
    fetchInAppUnreadCount: fetchInAppUnreadCountMock,
    markInAppThreadRead: markInAppThreadReadMock,
    appendCustomerMessage: appendCustomerMessageMock,
  };
});

// SendGrid notification — Phase 6. The test toggles
// SHOP_CSR_INBOX_EMAIL in beforeEach; the mocked client lets us
// assert the subject + recipient without real env vars.
const sendEmailMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<{ messageId: string }>>(async () => ({
    messageId: "sg_csr_1",
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

import meMessagesRouter from "./me-messages";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(meMessagesRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  logAuditMock.mockClear();
  ensureShopCustomerRowMock.mockClear();
  fetchInAppThreadMock.mockClear();
  fetchInAppThreadMock.mockResolvedValue({
    thread: null,
    messages: [],
    unreadFromCsr: 0,
  });
  fetchInAppUnreadCountMock.mockClear();
  fetchInAppUnreadCountMock.mockResolvedValue(0);
  markInAppThreadReadMock.mockClear();
  markInAppThreadReadMock.mockResolvedValue(true);
  appendCustomerMessageMock.mockClear();
  appendCustomerMessageMock.mockResolvedValue({
    threadId: "conv_1",
    messageId: "msg_1",
    threadCreated: true,
  });
  sendEmailMock.mockClear();
  sendEmailMock.mockResolvedValue({ messageId: "sg_csr_1" });
  // Default: notification disabled. Individual tests opt in.
  delete process.env["SHOP_CSR_INBOX_EMAIL"];
  delete process.env["SHOP_PUBLIC_BASE_URL"];
});

describe("GET /shop/me/messages", () => {
  it("401s when no session", async () => {
    const res = await request(makeApp()).get("/shop/me/messages");
    expect(res.status).toBe(401);
  });

  it("returns empty shape for a fresh customer", async () => {
    mockSignedIn.current = "cust_1";
    const res = await request(makeApp()).get("/shop/me/messages");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      thread: null,
      messages: [],
      unreadFromCsr: 0,
    });
    expect(fetchInAppThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cust_1" }),
    );
  });

  it("returns the thread + messages from the helper", async () => {
    mockSignedIn.current = "cust_1";
    fetchInAppThreadMock.mockResolvedValueOnce({
      thread: {
        id: "conv_1",
        status: "awaiting_admin",
        lastMessageAt: "2026-05-01T00:00:00.000Z",
        createdAt: "2026-04-30T00:00:00.000Z",
      },
      messages: [
        {
          id: "msg_1",
          direction: "inbound",
          senderRole: "customer",
          body: "Hi, my mask is leaking on the bridge of my nose.",
          createdAt: "2026-05-01T00:00:00.000Z",
          deliveryStatus: null,
        },
      ],
      unreadFromCsr: 0,
    });
    const res = await request(makeApp()).get("/shop/me/messages");
    expect(res.status).toBe(200);
    expect(res.body.thread.status).toBe("awaiting_admin");
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].senderRole).toBe("customer");
  });
});

describe("POST /shop/me/messages", () => {
  it("401s when no session", async () => {
    const res = await request(makeApp())
      .post("/shop/me/messages")
      .send({ body: "hi" });
    expect(res.status).toBe(401);
  });

  it("rejects an empty body", async () => {
    mockSignedIn.current = "cust_1";
    const res = await request(makeApp())
      .post("/shop/me/messages")
      .send({ body: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(appendCustomerMessageMock).not.toHaveBeenCalled();
  });

  it("rejects an over-limit body", async () => {
    mockSignedIn.current = "cust_1";
    const res = await request(makeApp())
      .post("/shop/me/messages")
      .send({ body: "x".repeat(4001) });
    expect(res.status).toBe(400);
  });

  it("persists, audits, and returns the result envelope", async () => {
    mockSignedIn.current = "cust_1";
    const res = await request(makeApp())
      .post("/shop/me/messages")
      .send({ body: "I think my CPAP pressure is too high." });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      threadId: "conv_1",
      messageId: "msg_1",
      threadCreated: true,
    });
    expect(appendCustomerMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cust_1",
        body: "I think my CPAP pressure is too high.",
      }),
    );
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const auditCall = logAuditMock.mock.calls[0]?.[0] as unknown as {
      action: string;
      targetTable: string;
      targetId: string;
      metadata: Record<string, unknown>;
    };
    expect(auditCall.action).toBe("shop_customer.message.send");
    expect(auditCall.targetTable).toBe("messages");
    expect(auditCall.targetId).toBe("msg_1");
    expect(auditCall.metadata.thread_created).toBe(true);
    // Critical: NO actual message body in the audit envelope.
    expect(JSON.stringify(auditCall.metadata)).not.toContain("CPAP");
    expect(JSON.stringify(auditCall.metadata)).not.toContain("pressure");
    // body_length crumb DOES surface (length of the trimmed body).
    expect(auditCall.metadata.body_length).toBe(
      "I think my CPAP pressure is too high.".length,
    );
  });

  it("trims the body before passing to the helper", async () => {
    mockSignedIn.current = "cust_1";
    await request(makeApp())
      .post("/shop/me/messages")
      .send({ body: "  hello there  " });
    expect(appendCustomerMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: "hello there" }),
    );
  });
});

describe("POST /shop/me/messages — CSR-inbox notification (Phase 6)", () => {
  it("does NOT send when SHOP_CSR_INBOX_EMAIL is unset", async () => {
    mockSignedIn.current = "cust_1";
    // No env var set — notification disabled.
    const res = await request(makeApp())
      .post("/shop/me/messages")
      .send({ body: "hi" });
    expect(res.status).toBe(201);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("sends a subject-only notification when SHOP_CSR_INBOX_EMAIL is set", async () => {
    process.env["SHOP_CSR_INBOX_EMAIL"] = "csr-inbox@pennpaps.com";
    process.env["SHOP_PUBLIC_BASE_URL"] = "https://pennpaps.com";
    mockSignedIn.current = {
      customerId: "cust_1",
      email: "shopper@example.com",
      displayName: "Anna Singh",
    };

    const res = await request(makeApp())
      .post("/shop/me/messages")
      .send({ body: "I have a question about my mask seal." });

    expect(res.status).toBe(201);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = sendEmailMock.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      text: string;
      html: string;
    };
    expect(call.to).toBe("csr-inbox@pennpaps.com");
    // First message → "New customer message"
    expect(call.subject).toContain("New customer message");
    expect(call.subject).toContain("Anna Singh");
    // Critical: NO message body in subject or body text/html.
    expect(call.subject).not.toContain("mask seal");
    expect(call.text).not.toContain("mask seal");
    expect(call.html).not.toContain("mask seal");
    // Link to the inbox thread surfaces.
    expect(call.text).toContain(
      "https://pennpaps.com/admin/conversations/conv_1",
    );
  });

  it("uses 'Reply on customer message' subject for follow-ups", async () => {
    process.env["SHOP_CSR_INBOX_EMAIL"] = "csr-inbox@pennpaps.com";
    appendCustomerMessageMock.mockResolvedValueOnce({
      threadId: "conv_1",
      messageId: "msg_2",
      threadCreated: false, // follow-up on existing thread
    });
    mockSignedIn.current = {
      customerId: "cust_1",
      email: "shopper@example.com",
      displayName: "Anna",
    };

    await request(makeApp()).post("/shop/me/messages").send({ body: "ping" });

    const call = sendEmailMock.mock.calls[0]?.[0] as { subject: string };
    expect(call.subject).toContain("Reply on customer message");
  });

  it("falls back to email when displayName is missing", async () => {
    process.env["SHOP_CSR_INBOX_EMAIL"] = "csr-inbox@pennpaps.com";
    mockSignedIn.current = {
      customerId: "cust_1",
      email: "shopper@example.com",
      displayName: null,
    };

    await request(makeApp()).post("/shop/me/messages").send({ body: "ping" });

    const call = sendEmailMock.mock.calls[0]?.[0] as { subject: string };
    expect(call.subject).toContain("shopper@example.com");
  });

  it("treats SendGrid failure as best-effort (still 201)", async () => {
    process.env["SHOP_CSR_INBOX_EMAIL"] = "csr-inbox@pennpaps.com";
    sendEmailMock.mockRejectedValueOnce(new Error("sendgrid down"));
    mockSignedIn.current = {
      customerId: "cust_1",
      email: "shopper@example.com",
      displayName: "Anna",
    };

    const res = await request(makeApp())
      .post("/shop/me/messages")
      .send({ body: "ping" });

    expect(res.status).toBe(201);
    expect(res.body.threadId).toBe("conv_1");
    // Audit still wrote even though notification email failed.
    expect(logAuditMock).toHaveBeenCalledTimes(1);
  });
});

describe("GET /shop/me/messages/unread-count (Phase 7)", () => {
  it("401s when no session", async () => {
    const res = await request(makeApp()).get("/shop/me/messages/unread-count");
    expect(res.status).toBe(401);
  });

  it("returns 0 when the customer has no thread", async () => {
    mockSignedIn.current = "cust_1";
    fetchInAppUnreadCountMock.mockResolvedValueOnce(0);
    const res = await request(makeApp()).get("/shop/me/messages/unread-count");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unreadFromCsr: 0 });
  });

  it("returns the helper's count for an existing thread", async () => {
    mockSignedIn.current = "cust_1";
    fetchInAppUnreadCountMock.mockResolvedValueOnce(3);
    const res = await request(makeApp()).get("/shop/me/messages/unread-count");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unreadFromCsr: 3 });
    expect(fetchInAppUnreadCountMock).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cust_1" }),
    );
  });
});

describe("POST /shop/me/messages/mark-read (Phase 7)", () => {
  it("401s when no session", async () => {
    const res = await request(makeApp())
      .post("/shop/me/messages/mark-read")
      .send({});
    expect(res.status).toBe(401);
  });

  it("returns ok + threadUpdated true when the helper updated a row", async () => {
    mockSignedIn.current = "cust_1";
    markInAppThreadReadMock.mockResolvedValueOnce(true);
    const res = await request(makeApp())
      .post("/shop/me/messages/mark-read")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, threadUpdated: true });
    expect(markInAppThreadReadMock).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cust_1" }),
    );
  });

  it("returns ok + threadUpdated false when the customer has no thread (no-op)", async () => {
    mockSignedIn.current = "cust_1";
    markInAppThreadReadMock.mockResolvedValueOnce(false);
    const res = await request(makeApp())
      .post("/shop/me/messages/mark-read")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, threadUpdated: false });
  });
});

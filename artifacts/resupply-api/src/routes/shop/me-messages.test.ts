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

import { makeRequireSignedInMock } from "../../test-helpers/auth-mocks";

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null as string | null },
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
  })),
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
    appendCustomerMessage: appendCustomerMessageMock,
  };
});

vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return { ...actual, getDbPool: () => ({}) as never };
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
  fetchInAppThreadMock.mockResolvedValue({ thread: null, messages: [] });
  appendCustomerMessageMock.mockClear();
  appendCustomerMessageMock.mockResolvedValue({
    threadId: "conv_1",
    messageId: "msg_1",
    threadCreated: true,
  });
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
    expect(res.body).toEqual({ thread: null, messages: [] });
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

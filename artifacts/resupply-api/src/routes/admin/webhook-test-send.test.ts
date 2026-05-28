// Route tests for POST /admin/webhook-subscriptions/:id/test-send.
//
// Coverage:
//   * 401 without admin sign-in
//   * 403 when caller is an agent (requireAdminOnly)
//   * 404 on malformed id
//   * 404 when subscription doesn't exist
//   * 409 when subscription is inactive
//   * 409 when target_url is not https://
//   * 202 happy path inserts a webhook_deliveries row + audits
//   * Audit metadata carries the target_url + delivery_id, never the
//     synthesised payload body

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  getSupabaseWritePayloads,
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

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

import testSendRouter from "./webhook-test-send";

const SUB_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(testSendRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  logAuditMock.mockClear();
  supabaseMock.reset();
});

describe("POST /admin/webhook-subscriptions/:id/test-send", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp())
      .post(`/admin/webhook-subscriptions/${SUB_ID}/test-send`)
      .send({});
    expect(res.status).toBe(401);
  });

  it("403s when caller is an agent (requireAdminOnly)", async () => {
    mockAdmin.current = { userId: "u_1", email: "a@a", role: "agent" };
    const res = await request(makeApp())
      .post(`/admin/webhook-subscriptions/${SUB_ID}/test-send`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("404s on malformed id", async () => {
    mockAdmin.current = { userId: "u_1", email: "a@a", role: "admin" };
    const res = await request(makeApp())
      .post("/admin/webhook-subscriptions/not-a-uuid/test-send")
      .send({});
    expect(res.status).toBe(404);
  });

  it("404s when subscription is not found", async () => {
    mockAdmin.current = { userId: "u_1", email: "a@a", role: "admin" };
    stageSupabaseResponse("webhook_subscriptions", "select", { data: null });
    const res = await request(makeApp())
      .post(`/admin/webhook-subscriptions/${SUB_ID}/test-send`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("409s when subscription is inactive", async () => {
    mockAdmin.current = { userId: "u_1", email: "a@a", role: "admin" };
    stageSupabaseResponse("webhook_subscriptions", "select", {
      data: {
        id: SUB_ID,
        name: "Partner X",
        is_active: false,
        target_url: "https://partner.example/webhook",
      },
    });
    const res = await request(makeApp())
      .post(`/admin/webhook-subscriptions/${SUB_ID}/test-send`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("subscription_inactive");
  });

  it("409s when target_url is not https", async () => {
    mockAdmin.current = { userId: "u_1", email: "a@a", role: "admin" };
    stageSupabaseResponse("webhook_subscriptions", "select", {
      data: {
        id: SUB_ID,
        name: "Partner X",
        is_active: true,
        target_url: "http://partner.example/webhook",
      },
    });
    const res = await request(makeApp())
      .post(`/admin/webhook-subscriptions/${SUB_ID}/test-send`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("non_https_target");
  });

  it("202 happy path inserts delivery + audits", async () => {
    mockAdmin.current = {
      userId: "u_1",
      email: "ops@pennpaps.com",
      role: "admin",
    };
    stageSupabaseResponse("webhook_subscriptions", "select", {
      data: {
        id: SUB_ID,
        name: "Partner X",
        is_active: true,
        target_url: "https://partner.example/webhook",
      },
    });
    stageSupabaseResponse("webhook_deliveries", "insert", {
      data: { id: "del_1" },
    });

    const res = await request(makeApp())
      .post(`/admin/webhook-subscriptions/${SUB_ID}/test-send`)
      .send({});
    expect(res.status).toBe(202);
    expect(res.body.deliveryId).toBe("del_1");

    const writes = getSupabaseWritePayloads("webhook_deliveries", "insert");
    const payload = writes[0] as {
      subscription_id: string;
      event_type: string;
      event_payload: { type: string; data: Record<string, unknown> };
    };
    expect(payload.event_type).toBe("webhook.test");
    expect(payload.event_payload.type).toBe("webhook.test");
    expect(payload.event_payload.data.subscription_id).toBe(SUB_ID);
    expect(payload.event_payload.data.sent_by).toBe("ops@pennpaps.com");

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: { delivery_id: string; target_url: string };
    };
    expect(audit.action).toBe("webhook_subscription.test_send");
    expect(audit.metadata.delivery_id).toBe("del_1");
    expect(audit.metadata.target_url).toBe("https://partner.example/webhook");
  });
});

// Route test for GET /admin/analytics/channel-engagement. The math is
// pinned in lib/analytics/channel-engagement.test.ts; this covers the
// gate, window validation, the DB->aggregate shim, the window-too-large
// guard, and the CSV shape.

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

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import channelEngagementRouter from "./analytics-channel-engagement";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "owner@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(channelEngagementRouter);
  return app;
}

function stageFullWindow() {
  stageSupabaseResponse("conversations", "select", {
    data: [
      { id: "sms1", channel: "sms" },
      { id: "em1", channel: "email" },
      { id: "chat1", channel: "in_app" },
      { id: "voice1", channel: "voice" },
    ],
    count: 4,
  });
  stageSupabaseResponse("messages", "select", {
    data: [
      {
        conversation_id: "sms1",
        direction: "outbound",
        delivery_status: "delivered",
      },
      {
        conversation_id: "sms1",
        direction: "inbound",
        delivery_status: "received",
      },
      {
        conversation_id: "em1",
        direction: "outbound",
        delivery_status: "bounced",
      },
    ],
    count: 3,
  });
  stageSupabaseResponse("voice_calls", "select", {
    data: [
      {
        status: "completed",
        direction: "outbound",
        duration_seconds: 60,
        initiated_at: "2026-06-01T00:00:00.000Z",
        answered_at: "2026-06-01T00:00:05.000Z",
      },
      {
        status: "no-answer",
        direction: "inbound",
        duration_seconds: null,
        initiated_at: null,
        answered_at: null,
      },
    ],
    count: 2,
  });
  stageSupabaseResponse("shop_orders", "select", {
    data: [
      { status: "paid", amount_total_cents: 1999 },
      { status: "pending", amount_total_cents: 500 },
    ],
    count: 2,
  });
}

beforeEach(() => {
  mockAdmin.current = ADMIN;
  supabaseMock.reset();
});

describe("GET /admin/analytics/channel-engagement", () => {
  it("401s without admin", async () => {
    mockAdmin.current = null;
    const res = await request(makeApp()).get(
      "/admin/analytics/channel-engagement",
    );
    expect(res.status).toBe(401);
  });

  it("400s on an out-of-range window", async () => {
    const res = await request(makeApp()).get(
      "/admin/analytics/channel-engagement?days=0",
    );
    expect(res.status).toBe(400);
  });

  it("aggregates messaging + voice + outcomes", async () => {
    stageFullWindow();
    const res = await request(makeApp()).get(
      "/admin/analytics/channel-engagement?days=30",
    );
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(30);

    const sms = res.body.messaging.find(
      (m: { channel: string }) => m.channel === "sms",
    );
    expect(sms).toMatchObject({
      conversations: 1,
      outbound: 1,
      inbound: 1,
      delivered: 1,
      failed: 0,
    });
    const email = res.body.messaging.find(
      (m: { channel: string }) => m.channel === "email",
    );
    expect(email).toMatchObject({ outbound: 1, failed: 1, delivered: 0 });

    expect(res.body.voice).toMatchObject({
      totalCalls: 2,
      answeredCalls: 1,
      missedCalls: 1,
      outboundCalls: 1,
      inboundCalls: 1,
    });
    expect(res.body.outcomes).toEqual({
      purchases: 1,
      purchaseRevenueCents: 1999,
    });
    expect(res.body.summary.totalReplies).toBe(2); // 1 sms reply + 1 answered call
  });

  it("422s when a window exceeds the read cap", async () => {
    stageSupabaseResponse("conversations", "select", {
      data: [],
      count: 999_999,
    });
    stageSupabaseResponse("messages", "select", { data: [], count: 0 });
    stageSupabaseResponse("voice_calls", "select", { data: [], count: 0 });
    stageSupabaseResponse("shop_orders", "select", { data: [], count: 0 });
    const res = await request(makeApp()).get(
      "/admin/analytics/channel-engagement?days=365",
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("window_too_large");
  });

  it("serves a CSV export", async () => {
    stageFullWindow();
    const res = await request(makeApp()).get(
      "/admin/analytics/channel-engagement.csv?days=30",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text).toContain(
      "channel,conversations,outbound,inbound,reply_rate,delivered,failed,delivery_rate",
    );
    expect(res.text).toContain("Phone (voice)");
    expect(res.text).toContain("Purchases,1");
  });
});

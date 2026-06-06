// Route test for GET /admin/voice/metrics. The math is pinned in
// lib/analytics/voice-metrics.test.ts; this covers the gate, the window
// validation, and the DB->aggregate shim.

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
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminReadRateLimiter: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  adminRateLimit: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

import voiceMetricsRouter from "./voice-metrics";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(voiceMetricsRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  mockAdmin.current = { userId: "u", email: "ops@x", role: "admin" };
});

describe("GET /admin/voice/metrics", () => {
  it("401s without admin", async () => {
    mockAdmin.current = null;
    const res = await request(makeApp()).get("/admin/voice/metrics");
    expect(res.status).toBe(401);
  });

  it("400s on an out-of-range window", async () => {
    const res = await request(makeApp()).get("/admin/voice/metrics?days=0");
    expect(res.status).toBe(400);
  });

  it("aggregates the ledger rows", async () => {
    stageSupabaseResponse("voice_calls", "select", {
      data: [
        {
          status: "completed",
          direction: "outbound-api",
          duration_seconds: 100,
          initiated_at: "2026-06-06T00:00:00.000Z",
          answered_at: "2026-06-06T00:00:10.000Z",
        },
        {
          status: "no-answer",
          direction: "outbound-api",
          duration_seconds: null,
          initiated_at: null,
          answered_at: null,
        },
      ],
    });
    const res = await request(makeApp()).get("/admin/voice/metrics?days=30");
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(30);
    expect(res.body.totalCalls).toBe(2);
    expect(res.body.answeredCalls).toBe(1);
    expect(res.body.answerRate).toBe(0.5);
    expect(res.body.avgHandleSeconds).toBe(100);
    expect(res.body.avgRingSeconds).toBe(10);
  });
});

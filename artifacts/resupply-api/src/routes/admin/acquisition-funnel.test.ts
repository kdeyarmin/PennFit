// Route tests for GET /admin/analytics/acquisition-funnel and the pure
// buildFunnel helper (Growth #G1 surfacing).

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseRpcResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import acquisitionFunnelRouter, { buildFunnel } from "./acquisition-funnel";

const SUPERVISOR: MockAdminCtx = {
  userId: "u_super",
  email: "sup@penn.example.com",
  role: "agent",
  granularRole: "supervisor",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(acquisitionFunnelRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("buildFunnel (pure)", () => {
  it("computes step-to-step and top-of-funnel conversion", () => {
    const def = [
      { step: "a", label: "A" },
      { step: "b", label: "B" },
      { step: "c", label: "C" },
    ];
    const byStep = new Map([
      ["a", { step: "a", sessions: 100, events: 120 }],
      ["b", { step: "b", sessions: 40, events: 45 }],
      // "c" intentionally missing → treated as zero
    ]);
    const out = buildFunnel(def, byStep);
    expect(out.topSessions).toBe(100);
    expect(out.stages[0].conversionFromPrev).toBeNull();
    expect(out.stages[0].conversionFromTop).toBe(1);
    expect(out.stages[1].conversionFromPrev).toBeCloseTo(0.4);
    expect(out.stages[1].conversionFromTop).toBeCloseTo(0.4);
    expect(out.stages[2].sessions).toBe(0);
    expect(out.stages[2].conversionFromPrev).toBe(0);
    expect(out.overallConversion).toBe(0);
  });

  it("returns null conversions when the top of funnel is empty", () => {
    const def = [
      { step: "a", label: "A" },
      { step: "b", label: "B" },
    ];
    const out = buildFunnel(def, new Map());
    expect(out.topSessions).toBe(0);
    expect(out.overallConversion).toBeNull();
    expect(out.stages[0].conversionFromTop).toBeNull();
  });
});

describe("GET /admin/analytics/acquisition-funnel", () => {
  it("401s without a session", async () => {
    const res = await request(makeApp()).get(
      "/admin/analytics/acquisition-funnel",
    );
    expect(res.status).toBe(401);
  });

  it("returns ordered fitter + checkout funnels from the RPC rows", async () => {
    mockAdmin.current = SUPERVISOR;
    stageSupabaseRpcResponse("acquisition_funnel_steps", {
      data: [
        { step: "home_view", sessions: 200, events: 260 },
        { step: "consent_given", sessions: 80, events: 80 },
        { step: "capture_taken", sessions: 60, events: 70 },
        { step: "order_submitted_success", sessions: 12, events: 12 },
        { step: "checkout_started", sessions: 50, events: 55 },
        { step: "checkout_completed", sessions: 30, events: 30 },
        { step: "measurement_error", sessions: 5, events: 9 },
      ],
      error: null,
    });

    const res = await request(makeApp()).get(
      "/admin/analytics/acquisition-funnel?days=7",
    );
    expect(res.status).toBe(200);
    expect(res.body.window.days).toBe(7);

    const fitter = res.body.fitter;
    expect(fitter.topSessions).toBe(200);
    expect(fitter.stages[0].step).toBe("home_view");
    expect(fitter.stages[1].step).toBe("consent_given");
    expect(fitter.stages[1].conversionFromTop).toBeCloseTo(0.4);
    // last stage = order_submitted_success
    expect(fitter.overallConversion).toBeCloseTo(12 / 200);

    const checkout = res.body.checkout;
    expect(checkout.topSessions).toBe(50);
    expect(checkout.overallConversion).toBeCloseTo(30 / 50);

    const errSignal = res.body.signals.find(
      (s: { step: string }) => s.step === "measurement_error",
    );
    expect(errSignal.events).toBe(9);
  });

  it("400s on an out-of-range window", async () => {
    mockAdmin.current = SUPERVISOR;
    const res = await request(makeApp()).get(
      "/admin/analytics/acquisition-funnel?days=9999",
    );
    expect(res.status).toBe(400);
  });
});

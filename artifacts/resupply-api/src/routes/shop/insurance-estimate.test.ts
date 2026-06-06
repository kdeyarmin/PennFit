// Route test for POST /shop/insurance-estimates — focuses on the O2
// learned-range branch (static range + lead capture + email are the
// pre-existing behavior; here we pin that a robust learned stat is
// surfaced and a thin/absent one is not).

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const { recordMock, emailMock } = vi.hoisted(() => ({
  recordMock: vi.fn(async () => ({ id: "lead_1", error: null })),
  emailMock: vi.fn(async () => ({ configured: false, delivered: false })),
}));
vi.mock("../../lib/fitter-lead-record", () => ({
  recordFitterLead: recordMock,
}));
vi.mock("../../lib/order-emails/send-insurance-estimate-email", () => ({
  sendInsuranceEstimateEmail: emailMock,
}));

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import insuranceEstimateRouter, {
  _resetInsuranceEstimateRateBucketForTests,
} from "./insurance-estimate";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(insuranceEstimateRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  recordMock.mockClear();
  emailMock.mockClear();
  _resetInsuranceEstimateRateBucketForTests();
});

describe("POST /shop/insurance-estimates — learned range", () => {
  it("surfaces a learned range when the stat is robust", async () => {
    stageSupabaseResponse("payer_estimate_stats", "select", {
      data: { p50_cents: 1850, p90_cents: 6400, sample_size: 42 },
    });
    const res = await request(makeApp())
      .post("/shop/insurance-estimates")
      .send({ email: "p@example.com", payerSlug: "aetna" });
    expect(res.status).toBe(200);
    expect(res.body.estimate.slug).toBe("aetna");
    expect(res.body.learned).toEqual({
      typicalDollars: 19, // round(1850/100)
      upToDollars: 64,
      sampleSize: 42,
    });
  });

  it("omits the learned range when the sample is below the display floor", async () => {
    stageSupabaseResponse("payer_estimate_stats", "select", {
      data: { p50_cents: 1850, p90_cents: 6400, sample_size: 5 },
    });
    const res = await request(makeApp())
      .post("/shop/insurance-estimates")
      .send({ email: "p@example.com", payerSlug: "aetna" });
    expect(res.status).toBe(200);
    expect(res.body.learned).toBeNull();
  });

  it("falls back to null learned when no stat row exists", async () => {
    stageSupabaseResponse("payer_estimate_stats", "select", { data: null });
    const res = await request(makeApp())
      .post("/shop/insurance-estimates")
      .send({ email: "p@example.com", payerSlug: "cigna" });
    expect(res.status).toBe(200);
    expect(res.body.estimate.slug).toBe("cigna");
    expect(res.body.learned).toBeNull();
  });
});

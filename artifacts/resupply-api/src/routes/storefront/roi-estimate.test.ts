// POST /api/roi-estimate — anonymous "email me my ROI estimate".
//
// Covers: happy-path lead capture (lowercased email, source="breathe-roi"),
// input-range validation, honeypot fake-success, the best-effort contract
// (a DB failure still resolves 200), and the email-config posture — with no
// SENDGRID_API_KEY the route still succeeds and reports emailed:false.

import { describe, it, expect, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  getSupabaseCallCount,
  getSupabaseWritePayloads,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import roiEstimateRouter from "./roi-estimate.js";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", roiEstimateRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  // Guarantee the email path is "not configured" so emailed:false is
  // deterministic regardless of the developer's local env.
  delete process.env.SENDGRID_API_KEY;
});

describe("POST /api/roi-estimate", () => {
  it("captures the lowercased lead tagged breathe-roi and reports emailed:false without a key", async () => {
    stageSupabaseResponse("newsletter_subscribers", "upsert", { data: null });
    const app = buildApp();

    const res = await request(app)
      .post("/api/roi-estimate")
      .send({ email: "Owner@DME.COM", patients: 5000, staff: 12 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, emailed: false });
    const payloads = getSupabaseWritePayloads(
      "newsletter_subscribers",
      "upsert",
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      email: "owner@dme.com",
      source: "breathe-roi",
      unsubscribed_at: null,
    });
  });

  it("400s on a malformed email without touching the DB", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/roi-estimate")
      .send({ email: "not-an-email", patients: 5000, staff: 12 });
    expect(res.status).toBe(400);
    expect(getSupabaseCallCount("newsletter_subscribers", "upsert")).toBe(0);
  });

  it("400s when the inputs fall outside the calculator's slider ranges", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/roi-estimate")
      .send({ email: "owner@dme.com", patients: 100, staff: 12 });
    expect(res.status).toBe(400);
    expect(getSupabaseCallCount("newsletter_subscribers", "upsert")).toBe(0);
  });

  it("honeypot submissions get fake success and write nothing", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/roi-estimate").send({
      email: "bot@example.com",
      patients: 5000,
      staff: 12,
      website: "https://spam.example",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, emailed: false });
    expect(getSupabaseCallCount("newsletter_subscribers", "upsert")).toBe(0);
  });

  it("still resolves 200 (best-effort) when the capture upsert fails", async () => {
    stageSupabaseResponse("newsletter_subscribers", "upsert", {
      error: { code: "08006", message: "connection failure" },
    });
    const app = buildApp();
    const res = await request(app)
      .post("/api/roi-estimate")
      .send({ email: "owner@dme.com", patients: 8000, staff: 20 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, emailed: false });
    expect(getSupabaseCallCount("newsletter_subscribers", "upsert")).toBe(1);
  });
});

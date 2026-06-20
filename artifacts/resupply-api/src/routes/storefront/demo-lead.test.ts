// POST /api/demo-lead — anonymous Breathe demo-gate email capture.
//
// Covers: happy-path upsert (lowercased email, default source, cleared
// unsubscribed_at), an explicit source override, validation, honeypot
// fake-success, and the best-effort contract — unlike the newsletter
// route, a DB failure must STILL resolve 200 so the visitor is never
// blocked from entering the demo.

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

import demoLeadRouter from "./demo-lead.js";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", demoLeadRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
});

describe("POST /api/demo-lead", () => {
  it("upserts the lowercased email with the default breathe-demo source", async () => {
    stageSupabaseResponse("newsletter_subscribers", "upsert", { data: null });
    const app = buildApp();

    const res = await request(app)
      .post("/api/demo-lead")
      .send({ email: "Owner@DME.COM" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const payloads = getSupabaseWritePayloads(
      "newsletter_subscribers",
      "upsert",
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      email: "owner@dme.com",
      source: "breathe-demo",
      unsubscribed_at: null,
    });
  });

  it("honors an explicit source", async () => {
    stageSupabaseResponse("newsletter_subscribers", "upsert", { data: null });
    const app = buildApp();
    const res = await request(app)
      .post("/api/demo-lead")
      .send({ email: "owner@dme.com", source: "breathe-pricing" });
    expect(res.status).toBe(200);
    const payloads = getSupabaseWritePayloads(
      "newsletter_subscribers",
      "upsert",
    );
    expect(payloads[0]).toMatchObject({ source: "breathe-pricing" });
  });

  it("400s on a malformed email without touching the DB", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/demo-lead")
      .send({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(getSupabaseCallCount("newsletter_subscribers", "upsert")).toBe(0);
  });

  it("honeypot submissions get fake success and write nothing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/demo-lead")
      .send({ email: "bot@example.com", website: "https://spam.example" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(getSupabaseCallCount("newsletter_subscribers", "upsert")).toBe(0);
  });

  it("still resolves 200 (best-effort) when the upsert fails", async () => {
    stageSupabaseResponse("newsletter_subscribers", "upsert", {
      error: { code: "08006", message: "connection failure" },
    });
    const app = buildApp();
    const res = await request(app)
      .post("/api/demo-lead")
      .send({ email: "owner@dme.com" });
    // The demo must open regardless of a transient capture failure.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(getSupabaseCallCount("newsletter_subscribers", "upsert")).toBe(1);
  });
});

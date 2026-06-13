// POST /api/newsletter/subscribe — anonymous marketing email capture.
//
// Covers: happy-path upsert (lowercased email + source + cleared
// unsubscribed_at), validation, honeypot fake-success, and an honest
// 500 when the upsert fails (the old frontend faked success — the
// backend must never do the same).

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

import newsletterRouter from "./newsletter.js";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", newsletterRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
});

describe("POST /api/newsletter/subscribe", () => {
  it("upserts the lowercased email with source and returns success", async () => {
    stageSupabaseResponse("newsletter_subscribers", "upsert", { data: null });
    const app = buildApp();

    const res = await request(app)
      .post("/api/newsletter/subscribe")
      .send({ email: "Reader@Example.COM", source: "learn-newsletter" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const payloads = getSupabaseWritePayloads("newsletter_subscribers", "upsert");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      email: "reader@example.com",
      source: "learn-newsletter",
      unsubscribed_at: null,
    });
  });

  it("400s on a malformed email without touching the DB", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/newsletter/subscribe")
      .send({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(getSupabaseCallCount("newsletter_subscribers", "upsert")).toBe(0);
  });

  it("honeypot submissions get fake success and write nothing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/newsletter/subscribe")
      .send({ email: "bot@example.com", website: "https://spam.example" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(getSupabaseCallCount("newsletter_subscribers", "upsert")).toBe(0);
  });

  it("returns 500 (not fake success) when the upsert fails", async () => {
    stageSupabaseResponse("newsletter_subscribers", "upsert", {
      error: { code: "08006", message: "connection failure" },
    });
    const app = buildApp();
    const res = await request(app)
      .post("/api/newsletter/subscribe")
      .send({ email: "reader@example.com" });
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });
});

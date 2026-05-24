// Route tests for routes/storefront/track-order.ts
//
// PR change:
//   The orderReference validator regex changed from /^(PENN-)?[A-Z0-9]{4,12}$/
//   to /^(PENN-)?[A-Z0-9]{6}$/.
//
//   Rationale from the diff: a 4-char tail is brute-forceable in tens of
//   thousands of guesses; 6 alphanumerics is ~36^6 ≈ 2 billion which,
//   combined with rate limiting + the email guard, is the deterrent the
//   API wants. The regex now accepts EXACTLY 6 trailing alphanumerics — no
//   shorter, no longer.
//
// Coverage matrix:
//   POST /orders/track — body validation (regex boundary values, valid/invalid
//                        reference formats), no-match (404), email mismatch (404
//                        same as not-found), happy path (200).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import trackOrderRouter, {
  _resetTrackOrderRateBucketForTests,
} from "./track-order";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", trackOrderRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  _resetTrackOrderRateBucketForTests();
});

afterEach(() => {
  _resetTrackOrderRateBucketForTests();
});

// ===========================================================================
// Body validation — orderReference regex (PR change)
// ===========================================================================
describe("POST /orders/track — orderReference validation (PR change: {6} only)", () => {
  // -----------------------------------------------------------------------
  // Inputs that MUST be accepted by the new /^(PENN-)?[A-Z0-9]{6}$/ regex
  // -----------------------------------------------------------------------
  it("accepts a 6-char alphanumeric tail (e.g. AB1234)", async () => {
    stageSupabaseResponse("orders", "select", { data: null });

    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "AB1234", email: "a@a.com" });

    // 404 is correct here (no matching row) — the point is it's NOT 400.
    expect(res.status).not.toBe(400);
  });

  it("accepts the full 'PENN-' prefix + 6 alphanumerics (PENN-AB1234)", async () => {
    stageSupabaseResponse("orders", "select", { data: null });

    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "PENN-AB1234", email: "a@a.com" });

    expect(res.status).not.toBe(400);
  });

  it("accepts all digits in the 6-char tail (000000)", async () => {
    stageSupabaseResponse("orders", "select", { data: null });

    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "000000", email: "a@a.com" });

    expect(res.status).not.toBe(400);
  });

  it("accepts all letters in the 6-char tail (AAAAAA)", async () => {
    stageSupabaseResponse("orders", "select", { data: null });

    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "AAAAAA", email: "a@a.com" });

    expect(res.status).not.toBe(400);
  });

  it("accepts lowercase letters (schema calls .toUpperCase() internally)", async () => {
    stageSupabaseResponse("orders", "select", { data: null });

    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "ab1234", email: "a@a.com" });

    expect(res.status).not.toBe(400);
  });

  it("accepts full lowercase prefix too (penn-ab1234)", async () => {
    stageSupabaseResponse("orders", "select", { data: null });

    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "penn-ab1234", email: "a@a.com" });

    expect(res.status).not.toBe(400);
  });

  // -----------------------------------------------------------------------
  // Inputs that MUST be REJECTED by the new regex
  // -----------------------------------------------------------------------
  it("rejects a 4-char tail (too short — brute-forceable per PR comment)", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "AB12", email: "a@a.com" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("rejects a 5-char tail (too short)", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "AB123", email: "a@a.com" });

    expect(res.status).toBe(400);
  });

  it("rejects a 7-char tail (too long — exactly 6 is required)", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "AB12345", email: "a@a.com" });

    expect(res.status).toBe(400);
  });

  it("rejects a 12-char tail (previously allowed by {4,12}, now rejected)", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "AB1234567890", email: "a@a.com" });

    expect(res.status).toBe(400);
  });

  it("rejects an 8-char tail (previously allowed, now rejected)", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "AB123456", email: "a@a.com" });

    expect(res.status).toBe(400);
  });

  it("rejects a PENN- prefix with 4-char tail (PENN-AB12)", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "PENN-AB12", email: "a@a.com" });

    expect(res.status).toBe(400);
  });

  it("rejects a PENN- prefix with 7-char tail (PENN-AB12345)", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "PENN-AB12345", email: "a@a.com" });

    expect(res.status).toBe(400);
  });

  it("rejects a reference with special characters in the tail", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "AB-123", email: "a@a.com" });

    expect(res.status).toBe(400);
  });

  it("rejects an empty string", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "", email: "a@a.com" });

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// Email validation
// ===========================================================================
describe("POST /orders/track — email validation", () => {
  it("rejects a missing email field", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "AB1234" });

    expect(res.status).toBe(400);
  });

  it("rejects a malformed email", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "AB1234", email: "not-an-email" });

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// Order lookup
// ===========================================================================
describe("POST /orders/track — order lookup", () => {
  it("returns 404 when no order matches the reference", async () => {
    stageSupabaseResponse("orders", "select", { data: null });

    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "AB1234", email: "alice@example.com" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 404 when the reference exists but the email doesn't match (privacy guard)", async () => {
    stageSupabaseResponse("orders", "select", {
      data: {
        order_reference: "PENN-AB1234",
        patient_email: "alice@example.com",
        mask_name: "AirFit P10",
        mask_manufacturer: "ResMed",
        email_status: "delivered",
        email_delivered_at: "2026-04-01T12:00:00Z",
        created_at: "2026-04-01T10:00:00Z",
      },
    });

    // Wrong email — should behave identically to not-found so an attacker
    // can't infer which email belongs to a reference.
    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "AB1234", email: "eve@evil.example.com" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 200 with order details when reference and email match", async () => {
    const orderRow = {
      order_reference: "PENN-AB1234",
      patient_email: "alice@example.com",
      mask_name: "AirFit P10",
      mask_manufacturer: "ResMed",
      email_status: "delivered",
      email_delivered_at: "2026-04-01T12:00:00Z",
      created_at: "2026-04-01T10:00:00Z",
    };
    stageSupabaseResponse("orders", "select", { data: orderRow });

    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "AB1234", email: "alice@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.orderReference).toBe("PENN-AB1234");
    expect(res.body.mask).toMatchObject({
      name: "AirFit P10",
      manufacturer: "ResMed",
    });
    expect(res.body.emailStatus).toBe("delivered");
  });

  it("normalises the reference to PENN- prefix before looking up", async () => {
    stageSupabaseResponse("orders", "select", {
      data: {
        order_reference: "PENN-AB1234",
        patient_email: "alice@example.com",
        mask_name: "DreamWear",
        mask_manufacturer: "Philips",
        email_status: "sent",
        email_delivered_at: null,
        created_at: "2026-04-02T10:00:00Z",
      },
    });

    // Submitting just the 6-char tail.
    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "ab1234", email: "alice@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.orderReference).toBe("PENN-AB1234");
  });

  it("does not expose patient email or PHI fields in the response", async () => {
    stageSupabaseResponse("orders", "select", {
      data: {
        order_reference: "PENN-AB1234",
        patient_email: "alice@example.com",
        mask_name: "AirFit P10",
        mask_manufacturer: "ResMed",
        email_status: "delivered",
        email_delivered_at: "2026-04-01T12:00:00Z",
        created_at: "2026-04-01T10:00:00Z",
      },
    });

    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "AB1234", email: "alice@example.com" });

    expect(res.status).toBe(200);
    // The route deliberately omits patient_email from the response.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("alice@example.com");
    expect(body).not.toContain("patient_email");
  });
});

// ===========================================================================
// Rate limiting
// ===========================================================================
describe("POST /orders/track — rate limiting", () => {
  it("returns 429 after exceeding 10 requests from the same IP", async () => {
    stageSupabaseResponse("orders", "select", { data: null });

    const app = makeApp();
    // The in-memory rate bucket uses req.ip. supertest uses 127.0.0.1.
    // Make 10 requests (the limit) then assert the 11th is 429.
    for (let i = 0; i < 10; i++) {
      stageSupabaseResponse("orders", "select", { data: null });
      await request(app)
        .post("/resupply-api/orders/track")
        .send({ orderReference: "AB1234", email: `user${i}@example.com` });
    }

    const res = await request(app)
      .post("/resupply-api/orders/track")
      .send({ orderReference: "AB1234", email: "overflow@example.com" });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limited");
  });
});

// ===========================================================================
// PR change: mask_model_number included in response (previously omitted)
// ===========================================================================
describe("POST /orders/track — mask.modelNumber (PR change)", () => {
  it("returns mask.modelNumber when the row carries a model number", async () => {
    stageSupabaseResponse("orders", "select", {
      data: {
        order_reference: "PENN-AB1234",
        patient_email: "alice@example.com",
        mask_name: "AirFit P10",
        mask_manufacturer: "ResMed",
        mask_model_number: "63600",
        email_status: "delivered",
        email_delivered_at: "2026-04-01T12:00:00Z",
        created_at: "2026-04-01T10:00:00Z",
      },
    });

    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "AB1234", email: "alice@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.mask.modelNumber).toBe("63600");
  });

  it("returns mask.modelNumber as null when the DB column is null", async () => {
    stageSupabaseResponse("orders", "select", {
      data: {
        order_reference: "PENN-AB1234",
        patient_email: "alice@example.com",
        mask_name: "AirFit P10",
        mask_manufacturer: "ResMed",
        mask_model_number: null,
        email_status: "sent",
        email_delivered_at: null,
        created_at: "2026-04-01T10:00:00Z",
      },
    });

    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "AB1234", email: "alice@example.com" });

    expect(res.status).toBe(200);
    // The field should be present (not omitted) so callers can distinguish
    // null (no model number stored) from missing (field not returned at all).
    expect(res.body.mask).toHaveProperty("modelNumber");
    expect(res.body.mask.modelNumber).toBeNull();
  });

  it("includes modelNumber alongside the existing mask.name and mask.manufacturer fields", async () => {
    stageSupabaseResponse("orders", "select", {
      data: {
        order_reference: "PENN-XY9876",
        patient_email: "bob@example.com",
        mask_name: "DreamWear",
        mask_manufacturer: "Philips",
        mask_model_number: "DWF-M",
        email_status: "delivered",
        email_delivered_at: "2026-04-10T08:00:00Z",
        created_at: "2026-04-10T07:00:00Z",
      },
    });

    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "XY9876", email: "bob@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.mask).toMatchObject({
      name: "DreamWear",
      manufacturer: "Philips",
      modelNumber: "DWF-M",
    });
  });

  it("does not expose mask_model_number as a raw DB column key (proper casing)", async () => {
    stageSupabaseResponse("orders", "select", {
      data: {
        order_reference: "PENN-AB1234",
        patient_email: "alice@example.com",
        mask_name: "AirFit P10",
        mask_manufacturer: "ResMed",
        mask_model_number: "63600",
        email_status: "delivered",
        email_delivered_at: null,
        created_at: "2026-04-01T10:00:00Z",
      },
    });

    const res = await request(makeApp())
      .post("/resupply-api/orders/track")
      .send({ orderReference: "AB1234", email: "alice@example.com" });

    expect(res.status).toBe(200);
    // Response uses camelCase (modelNumber), never the raw DB snake_case.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("mask_model_number");
    expect(body).toContain("modelNumber");
  });
});

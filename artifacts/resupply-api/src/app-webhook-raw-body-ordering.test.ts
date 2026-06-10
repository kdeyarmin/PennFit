// Regression tests for the SendGrid-events + integrations-webhooks
// body-parser ordering (the sibling of app-stripe-webhook-ordering).
//
// Both routes verify a signature over the EXACT raw bytes the vendor
// sent, and both register express.raw() at ROUTER level — but their
// routers are mounted inside the /resupply-api tree, AFTER the global
// express.json(). Without the app-level raw() mounts in app.ts, the
// global parser consumes the stream first, req.body arrives as a
// parsed object, and (a) the SendGrid signature middleware 400s every
// event ("requires raw body"), (b) the integrations route 400s with
// missing_signature_or_body. That shipped to production unnoticed
// because the route unit tests mount the routers WITHOUT the app-level
// middleware chain (docs/app-review-2026-06-10.md P0-2). These tests
// go through the real app so the ordering can't silently regress.

import { createHmac } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Same posture as app-stripe-webhook-ordering.test.ts: app.ts needs
  // these at import time, but nothing connects at construction and the
  // requests below never reach a real DB / PostgREST call.
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://test:test@localhost:5432/test";
  process.env.SUPABASE_URL =
    process.env.SUPABASE_URL ?? "http://localhost:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "test-service-role-key";
  process.env.AIRVIEW_WEBHOOK_SECRET = "test-airview-webhook-secret";
});

const captured = vi.hoisted(() => ({
  body: null as unknown,
  isBuffer: false,
}));

// Replace ONLY the SendGrid signature middleware with a spy that
// records what shape req.body arrived in; every other export of the
// email package stays real (the app import graph uses several).
vi.mock("@workspace/resupply-email", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    requireSendgridSignature:
      () => (req: Request, res: Response, _next: NextFunction) => {
        captured.body = req.body;
        captured.isBuffer = Buffer.isBuffer(req.body);
        res.status(200).send("ok");
      },
  };
});

const { default: app } = await import("./app");

describe("SendGrid event webhook middleware ordering", () => {
  it("delivers a raw Buffer body to the signature middleware", async () => {
    const payload = '[{"event":"delivered","sg_message_id":"x.filter1"}]';

    await request(app)
      .post("/resupply-api/email/sendgrid-events")
      .set("content-type", "application/json")
      .send(payload)
      .expect(200);

    expect(captured.isBuffer).toBe(true);
    expect((captured.body as Buffer).toString("utf8")).toBe(payload);
  });
});

describe("integrations webhook middleware ordering", () => {
  it("verifies the vendor HMAC over the raw bytes end-to-end", async () => {
    // No partnerPatientId → the handler skips its DB lookup entirely,
    // so a valid signature walks the whole route without PostgREST.
    const payload = '{"eventType":"therapy.night.available"}';
    const signature = createHmac("sha256", "test-airview-webhook-secret")
      .update(payload)
      .digest("hex");

    const res = await request(app)
      .post("/resupply-api/integrations/webhooks/airview")
      .set("content-type", "application/json")
      .set("x-airview-signature", signature)
      .send(payload);

    // Broken ordering manifests as 400 missing_signature_or_body
    // (req.body is a parsed object, not a Buffer) before the HMAC is
    // ever checked.
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
  });

  it("still rejects a wrong signature with 401 (not a raw-body 400)", async () => {
    const payload = '{"eventType":"therapy.night.available"}';

    const res = await request(app)
      .post("/resupply-api/integrations/webhooks/airview")
      .set("content-type", "application/json")
      .set("x-airview-signature", "sha256=" + "0".repeat(64))
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid_signature" });
  });
});

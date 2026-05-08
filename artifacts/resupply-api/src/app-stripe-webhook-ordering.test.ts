// Regression test for the Stripe webhook body-parser ordering.
//
// Stripe verifies its webhook signatures over the EXACT bytes Stripe
// sent. If the global `express.json()` middleware runs before the
// webhook route, `req.body` becomes a parsed object and the raw bytes
// are gone — `Stripe.webhooks.constructEvent` would then throw
// "No signatures found matching the expected signature for payload"
// for every event Stripe sends.
//
// `app.ts` mounts `app.post("/resupply-api/stripe/webhook",
// express.raw(...), stripeWebhookHandler)` BEFORE `app.use(express.
// json())`. This test pins that ordering so a future middleware
// re-shuffle fails CI loud, instead of silently breaking webhook
// signature verification in production.
//
// Strategy: mock the webhook handler with a spy that captures
// `req.body`, then issue an HTTP request through the actual app. If
// the body arrives as a Buffer, `express.raw()` (registered with the
// route) ran before any global JSON parser. If it arrives as a parsed
// object, the order has been broken.

import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import request from "supertest";

vi.hoisted(() => {
  // app.ts -> getAuthDeps() -> getDbPool() throws unless DATABASE_URL
  // is set. The pool does NOT connect at construction, so a syntactic
  // URL is enough; no real DB is touched by this test.
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://test:test@localhost:5432/test";
});

const captured = vi.hoisted(() => ({
  body: null as unknown,
  isBuffer: false,
}));

vi.mock("./lib/stripe/webhook-handler", () => ({
  stripeWebhookHandler: (req: Request, res: Response) => {
    captured.body = req.body;
    captured.isBuffer = Buffer.isBuffer(req.body);
    res.status(200).send("ok");
  },
}));

const { default: app } = await import("./app");

describe("Stripe webhook middleware ordering", () => {
  it("delivers a raw Buffer body to the handler (raw parser runs before global JSON parser)", async () => {
    const payload = '{"id":"evt_test_ordering","type":"ping"}';

    await request(app)
      .post("/resupply-api/stripe/webhook")
      .set("content-type", "application/json")
      .send(payload)
      .expect(200);

    expect(captured.isBuffer).toBe(true);
    expect((captured.body as Buffer).toString("utf8")).toBe(payload);
  });
});

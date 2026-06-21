// Route wiring for the carrier webhook (the lib helpers are unit-tested in
// lib/shipping/carrier-tracking.test.ts; here we pin the 503 / 401 / 200 branches).

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

vi.mock("../../lib/shipping/carrier-tracking", () => ({
  readCarrierWebhookConfigOrNull: vi.fn(),
  verifyCarrierSignature: vi.fn(),
  parseCarrierEvent: vi.fn(),
  applyCarrierTrackingEvent: vi.fn(),
}));

import * as lib from "../../lib/shipping/carrier-tracking";
import carrierRouter from "./carrier-tracking";

const readConfig = vi.mocked(lib.readCarrierWebhookConfigOrNull);
const verify = vi.mocked(lib.verifyCarrierSignature);
const parse = vi.mocked(lib.parseCarrierEvent);
const apply = vi.mocked(lib.applyCarrierTrackingEvent);

function makeApp(): Express {
  const app = express();
  app.use(
    "/",
    express.raw({ type: "application/json", limit: "256kb" }),
    carrierRouter,
  );
  return app;
}

beforeEach(() => {
  readConfig.mockReset();
  verify.mockReset();
  parse.mockReset();
  apply.mockReset();
});

const send = (body: object) =>
  request(makeApp())
    .post("/")
    .set("Content-Type", "application/json")
    .send(JSON.stringify(body));

describe("POST /webhooks/carrier", () => {
  it("503 when no secret is configured", async () => {
    readConfig.mockReturnValue(null);
    const res = await send({ tracking_number: "1Z", status: "delivered" });
    expect(res.status).toBe(503);
  });

  it("401 on an invalid signature (fail-closed once configured)", async () => {
    readConfig.mockReturnValue({ secret: "s" });
    verify.mockReturnValue(false);
    const res = await send({ tracking_number: "1Z", status: "delivered" });
    expect(res.status).toBe(401);
  });

  it("200 + ack for an authentic but non-actionable event", async () => {
    readConfig.mockReturnValue({ secret: "s" });
    verify.mockReturnValue(true);
    parse.mockReturnValue(null);
    const res = await send({ foo: "bar" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, matched: false, updated: false });
    expect(apply).not.toHaveBeenCalled();
  });

  it("200 + applies an authentic delivered event", async () => {
    readConfig.mockReturnValue({ secret: "s" });
    verify.mockReturnValue(true);
    parse.mockReturnValue({ trackingNumber: "1Z", status: "delivered" });
    apply.mockResolvedValue({ matched: true, updated: true });
    const res = await send({ tracking_number: "1Z", status: "delivered" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, matched: true, updated: true });
    expect(apply).toHaveBeenCalledWith({
      trackingNumber: "1Z",
      status: "delivered",
    });
  });
});

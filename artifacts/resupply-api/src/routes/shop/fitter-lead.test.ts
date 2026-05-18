// Tests for the public POST /shop/fitter-leads route.
// Covers validation, the marketing-opt-in guard, the honeypot
// short-circuit, the rate-limit ceiling, and the happy-path call
// into the DB record helper. The helper itself is stubbed so the
// test doesn't need a real Supabase client.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const recordMock = vi.fn();
vi.mock("../../lib/fitter-lead-record", () => ({
  recordFitterLead: (...args: unknown[]) => recordMock(...args),
}));

import fitterLeadRouter, {
  _resetFitterLeadRateBucketForTests,
} from "./fitter-lead";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", fitterLeadRouter);
  return app;
}

const VALID = {
  email: "alice@example.com",
  marketingOptIn: true,
};

beforeEach(() => {
  recordMock.mockReset();
  recordMock.mockResolvedValue({ id: "fitter_lead_test_1" });
  _resetFitterLeadRateBucketForTests();
});

describe("POST /shop/fitter-leads", () => {
  it("accepts a valid submission and persists once", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-leads")
      .send(VALID);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(recordMock).toHaveBeenCalledTimes(1);
    const payload = recordMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      // email is lowercased + trimmed by the zod transform
      email: "alice@example.com",
      marketingOptIn: true,
    });
  });

  it("rejects an obviously invalid email with 400", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-leads")
      .send({ ...VALID, email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("rejects an opt-out with 400 (the page only POSTs on opt-in)", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-leads")
      .send({ ...VALID, marketingOptIn: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("marketing_opt_in_required");
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("short-circuits with a fake 200 when the honeypot is filled", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-leads")
      .send({ ...VALID, website: "http://spam.example" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("rate-limits a single sender after 3 submissions in the window", async () => {
    const app = makeApp();
    for (let i = 0; i < 3; i++) {
      const ok = await request(app)
        .post("/resupply-api/shop/fitter-leads")
        .send(VALID);
      expect(ok.status).toBe(200);
    }
    const limited = await request(app)
      .post("/resupply-api/shop/fitter-leads")
      .send(VALID);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("rate_limited");
    expect(recordMock).toHaveBeenCalledTimes(3);
  });

  it("still 200s the user when the DB insert fails best-effort", async () => {
    recordMock.mockResolvedValueOnce({ id: null, error: "db down" });
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-leads")
      .send(VALID);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
  it("lowercases and trims the email before persisting", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-leads")
      .send({ ...VALID, email: "  Alice@EXAMPLE.COM  " });
    expect(res.status).toBe(200);
    const payload = recordMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.email).toBe("alice@example.com");
  });

  it("rejects missing email field with 400 invalid_body", async () => {
    const { email: _omit, ...noEmail } = VALID;
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-leads")
      .send(noEmail);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("rejects unknown extra fields (strict schema)", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-leads")
      .send({ ...VALID, extraField: "should-fail" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("does NOT trip the honeypot for a whitespace-only website value", async () => {
    // The route trims the website field before checking length.
    // A blank/whitespace string is not a bot signal.
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-leads")
      .send({ ...VALID, website: "   " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(recordMock).toHaveBeenCalledTimes(1);
  });
});

// Tests for the public POST /shop/insurance-leads route.
// Covers validation, honeypot short-circuit, rate limit, and the
// happy path that fires both SendGrid emails. We mock the email
// helper directly so SendGrid env vars aren't required.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const sendMock = vi.fn();
vi.mock("../../lib/insurance-lead-email", () => ({
  sendInsuranceLeadEmails: (...args: unknown[]) => sendMock(...args),
}));

import insuranceLeadRouter, {
  _resetInsuranceLeadRateBucketForTests,
} from "./insurance-lead";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", insuranceLeadRouter);
  return app;
}

const VALID = {
  fullName: "Alice Walker",
  email: "alice@example.com",
  phone: "555-555-1212",
  dateOfBirth: "1959-04-12",
  insuranceCarrier: "Aetna",
  memberId: "W123456789",
};

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({
    configured: true,
    notificationDelivered: true,
    confirmationDelivered: true,
  });
  _resetInsuranceLeadRateBucketForTests();
});

describe("POST /shop/insurance-leads", () => {
  it("accepts a valid submission and fires the email helper once", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/insurance-leads")
      .send(VALID);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.delivered).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      fullName: "Alice Walker",
      // email is lowercased by the zod transform
      email: "alice@example.com",
      memberId: "W123456789",
      groupNumber: null,
      prescribingPhysician: null,
      notes: null,
    });
  });

  it("rejects an obviously invalid payload with 400", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/insurance-leads")
      .send({ ...VALID, email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("short-circuits with a fake 200 when the honeypot is filled", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/insurance-leads")
      .send({ ...VALID, website: "http://spam.example" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rate-limits a single sender after 3 submissions in the window", async () => {
    const app = makeApp();
    for (let i = 0; i < 3; i++) {
      const ok = await request(app)
        .post("/resupply-api/shop/insurance-leads")
        .send(VALID);
      expect(ok.status).toBe(200);
    }
    const limited = await request(app)
      .post("/resupply-api/shop/insurance-leads")
      .send(VALID);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("rate_limited");
    expect(sendMock).toHaveBeenCalledTimes(3);
  });

  it("still 200s the user when SendGrid is unconfigured", async () => {
    sendMock.mockResolvedValueOnce({
      configured: false,
      notificationDelivered: false,
      confirmationDelivered: false,
      error: "missing key",
    });
    const res = await request(makeApp())
      .post("/resupply-api/shop/insurance-leads")
      .send(VALID);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.delivered).toBe(false);
  });

  it("optional fields round-trip when provided", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/insurance-leads")
      .send({
        ...VALID,
        groupNumber: "GRP-99",
        prescribingPhysician: "Dr. Patel",
        notes: "Prefers morning calls.",
      });
    expect(res.status).toBe(200);
    const payload = sendMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      groupNumber: "GRP-99",
      prescribingPhysician: "Dr. Patel",
      notes: "Prefers morning calls.",
    });
  });
});

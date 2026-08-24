// Tests for the public POST /shop/fitter-requests route — the endpoint
// that replaced the fitter's self-serve order form.
//
// What matters here, in order:
//   1. The invitation gate (this is a PHI-writing public endpoint).
//   2. That a failed WRITE is reported to the patient rather than
//      papered over with a thank-you page. This is the behaviour that
//      distinguishes it from its best-effort marketing sibling: there is
//      no order number to chase a lost request with.
//   3. That a callback request — name + phone, no insurance — is a
//      first-class success, not a validation failure.
//
// The record + email helpers are stubbed so the test needs neither a
// Supabase client nor SendGrid.

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const recordMock = vi.fn();
vi.mock("../../lib/fit-request-record", () => ({
  recordFitRequest: (...args: unknown[]) => recordMock(...args),
}));

const emailMock = vi.fn();
vi.mock("../../lib/fit-request-email", () => ({
  sendFitRequestEmails: (...args: unknown[]) => emailMock(...args),
}));

const SEED_ORG = "00000000-0000-4000-8000-000000000000";
const orgResolveMock = vi.fn();
vi.mock("../../lib/storefront/signed-link-org", () => ({
  resolveOrgIdForSignedRecord: (...args: unknown[]) => orgResolveMock(...args),
}));

import fitterRequestRouter from "./fitter-request";
import { signFitterInviteToken } from "../../lib/fitter-invite-token";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", fitterRequestRouter);
  return app;
}

const INVITE_ID = "33333333-3333-4333-8333-333333333333";

let savedLinkHmacKey: string | undefined;
beforeAll(() => {
  savedLinkHmacKey = process.env.RESUPPLY_LINK_HMAC_KEY;
  process.env.RESUPPLY_LINK_HMAC_KEY = "test-link-hmac-key-value-1234567890";
});
afterAll(() => {
  if (savedLinkHmacKey === undefined) delete process.env.RESUPPLY_LINK_HMAC_KEY;
  else process.env.RESUPPLY_LINK_HMAC_KEY = savedLinkHmacKey;
});

const FULL_DETAILS = {
  requestType: "full_details" as const,
  fullName: "Alice Nguyen",
  email: "Alice@Example.com",
  phone: "(555) 123-4567",
  preferredContactMethod: "phone" as const,
  dateOfBirth: "1970-04-12",
  insuranceCarrier: "Highmark",
  memberId: "HM12345",
  population: "adult" as const,
  recommendedMaskId: "resmed-airfit-f20",
  recommendedMaskName: "AirFit F20",
  recommendedMaskType: "fullFace",
  recommendedMaskSize: "M",
};

function post(body: object, token = signFitterInviteToken(INVITE_ID)) {
  return request(makeApp())
    .post("/resupply-api/shop/fitter-requests")
    .set("x-fitter-invite-token", token)
    .send(body);
}

beforeEach(() => {
  recordMock.mockReset();
  recordMock.mockResolvedValue({ id: "fit_request_1" });
  emailMock.mockReset();
  emailMock.mockResolvedValue({
    configured: true,
    notificationDelivered: true,
    confirmationDelivered: true,
  });
  orgResolveMock.mockReset();
  orgResolveMock.mockResolvedValue(SEED_ORG);
});

describe("POST /shop/fitter-requests — invitation gate", () => {
  it("rejects a request with no invite token", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-requests")
      .send(FULL_DETAILS);
    expect(res.status).toBe(403);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("rejects a mis-signed token", async () => {
    const res = await post(FULL_DETAILS, "not.a.real.token");
    expect(res.status).toBe(403);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("files against the tenant resolved from the INVITE, not the host", async () => {
    await post(FULL_DETAILS);
    expect(orgResolveMock).toHaveBeenCalledWith("fitter_invites", INVITE_ID);
    expect(recordMock.mock.calls[0]?.[0]).toMatchObject({ orgId: SEED_ORG });
  });

  it("503s rather than filing against a guessed tenant", async () => {
    orgResolveMock.mockResolvedValue(null);
    const res = await post(FULL_DETAILS);
    expect(res.status).toBe(503);
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe("POST /shop/fitter-requests — the two request shapes", () => {
  it("files a full-details request and normalises the email", async () => {
    const res = await post(FULL_DETAILS);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.requestType).toBe("full_details");
    // No order reference, deliberately: this is not an order, and an
    // order-shaped identifier would set the wrong expectation.
    expect(res.body.orderReference).toBeUndefined();
    expect(recordMock.mock.calls[0]?.[0]).toMatchObject({
      requestType: "full_details",
      email: "alice@example.com",
      insuranceCarrier: "Highmark",
      recommendedMaskName: "AirFit F20",
    });
  });

  it("accepts a callback request with NO insurance at all", async () => {
    // The point of the callback mode: a patient who cannot find their
    // member ID must not be stuck. Staff verify benefits either way.
    const res = await post({
      requestType: "callback",
      fullName: "Bob Smith",
      email: "bob@example.com",
      phone: "5551230000",
      population: "adult",
    });
    expect(res.status).toBe(200);
    expect(res.body.requestType).toBe("callback");
    const filed = recordMock.mock.calls[0]?.[0];
    expect(filed).toMatchObject({ requestType: "callback" });
    expect(filed.insuranceCarrier).toBeNull();
    expect(filed.memberId).toBeNull();
    expect(filed.dateOfBirth).toBeNull();
  });

  it("carries the pediatric service line through to the record", async () => {
    await post({ ...FULL_DETAILS, population: "pediatric" });
    expect(recordMock.mock.calls[0]?.[0]).toMatchObject({
      population: "pediatric",
    });
  });

  it("rejects a body missing the contact fields staff need", async () => {
    const res = await post({
      requestType: "callback",
      fullName: "B",
      email: "not-an-email",
      phone: "1",
    });
    expect(res.status).toBe(400);
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe("POST /shop/fitter-requests — failure handling", () => {
  it("tells the patient when the request could NOT be filed", async () => {
    // The distinguishing behaviour of this endpoint. Its marketing
    // sibling is best-effort because the patient advances regardless;
    // here a dropped write means nothing at the DME knows the patient is
    // waiting, and they have no reference to chase it with.
    recordMock.mockResolvedValue({ id: null, error: "db down" });
    const res = await post(FULL_DETAILS);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("request_not_recorded");
    expect(res.body.message).toMatch(/try again/i);
    // Nothing is emailed for a request that does not exist.
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("still succeeds when the confirmation email fails to send", async () => {
    // The queue is the record; email is the fast path. A SendGrid outage
    // must not fail a request that is already filed and already visible.
    emailMock.mockResolvedValue({
      configured: false,
      notificationDelivered: false,
      confirmationDelivered: false,
    });
    const res = await post(FULL_DETAILS);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.confirmationEmailed).toBe(false);
  });

  it("survives the email helper throwing outright", async () => {
    emailMock.mockRejectedValue(new Error("boom"));
    const res = await post(FULL_DETAILS);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("fake-succeeds on a honeypot trip without filing anything", async () => {
    const res = await post({ ...FULL_DETAILS, website: "http://spam" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(recordMock).not.toHaveBeenCalled();
    expect(emailMock).not.toHaveBeenCalled();
  });
});

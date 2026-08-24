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

// The STATEFUL invite check. `db.invite` is what the fitter_invites read
// returns — set it to a revoked or expired row to exercise those
// branches, or make the read fail to exercise the retryable one.
const db = vi.hoisted(() => ({
  invite: {
    status: "opened",
    expires_at: null as string | null,
  } as Record<string, unknown> | null,
  readFails: false,
  /** Whether a claimed fit_session resolves for THIS tenant. */
  ownsFitSession: true,
}));
vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "limit", "order"]) {
        chain[m] = () => chain;
      }
      chain.maybeSingle = async () => {
        if (table === "fit_sessions") {
          // The org-scoped client is what enforces ownership: a session
          // belonging to another tenant simply doesn't resolve.
          return { data: db.ownsFitSession ? { id: "x" } : null, error: null };
        }
        return db.readFails
          ? { data: null, error: { message: "db unreachable" } }
          : { data: db.invite, error: null };
      };
      return chain;
    },
  }),
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

/**
 * Post under a FRESH invite id.
 *
 * The route's rate limiter is keyed per invite and its bucket is
 * module-level, so it persists across tests in this file. Reusing one id
 * everywhere means later tests 429 on the limiter rather than exercising
 * what they are about — a fresh id per case keeps each in its own bucket.
 * The org resolver is mocked, so any well-formed uuid resolves the same.
 */
let inviteSeq = 0;
function postFreshInvite(body: object) {
  inviteSeq += 1;
  const id = `44444444-4444-4444-8444-${String(inviteSeq).padStart(12, "0")}`;
  return post(body, signFitterInviteToken(id));
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
  db.invite = { status: "opened", expires_at: null };
  db.readFails = false;
  db.ownsFitSession = true;
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

describe("POST /shop/fitter-requests — the invite must still STAND", () => {
  // The signed token stays cryptographically valid for its whole
  // lifetime, so the HMAC alone cannot see a revoke. This endpoint
  // persists PHI and emails staff, so it has to load the row — the same
  // reasoning /api/fit/assess documents for itself.
  it("refuses a REVOKED invite before writing or emailing anything", async () => {
    db.invite = { status: "revoked", expires_at: null };
    const res = await postFreshInvite(FULL_DETAILS);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invite_invalid");
    expect(recordMock).not.toHaveBeenCalled();
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("refuses an EXPIRED invite", async () => {
    db.invite = {
      status: "opened",
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    };
    const res = await postFreshInvite(FULL_DETAILS);
    expect(res.status).toBe(403);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("refuses an invite whose row is gone", async () => {
    db.invite = null;
    const res = await postFreshInvite(FULL_DETAILS);
    expect(res.status).toBe(403);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("treats a failed LOOKUP as retryable, not as a dead link", async () => {
    // The patient has just typed a form. A DB blip must not tell them
    // their fitting link is dead — that is a permanent-sounding dead end
    // for a transient fault.
    db.readFails = true;
    const res = await postFreshInvite(FULL_DETAILS);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("invite_lookup_unavailable");
    expect(res.body.message).toMatch(/try again/i);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("accepts a live invite", async () => {
    db.invite = {
      status: "opened",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const res = await postFreshInvite(FULL_DETAILS);
    expect(res.status).toBe(200);
    expect(recordMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /shop/fitter-requests — the fitting context is verified, not trusted", () => {
  const SESSION = "77777777-7777-4777-8777-777777777777";

  it("keeps a fit-session link that belongs to this tenant", async () => {
    const res = await postFreshInvite({
      ...FULL_DETAILS,
      fitSessionId: SESSION,
    });
    expect(res.status).toBe(200);
    expect(recordMock.mock.calls[0]?.[0]).toMatchObject({
      fitSessionId: SESSION,
    });
  });

  it("DROPS a session id that does not resolve for this tenant", async () => {
    // Staff act on this — the queue links it and the email cites it — so
    // a caller holding one valid invite must not be able to attach
    // another fitting's session. The request is still filed: it is the
    // patient's, and a legacy-path request legitimately has no session
    // either.
    db.ownsFitSession = false;
    const res = await postFreshInvite({
      ...FULL_DETAILS,
      fitSessionId: SESSION,
    });
    expect(res.status).toBe(200);
    expect(recordMock.mock.calls[0]?.[0]).toMatchObject({ fitSessionId: null });
  });
});

describe("POST /shop/fitter-requests — a phone is asked for only when it is the channel", () => {
  it("accepts an email-only request when they chose email", async () => {
    const res = await postFreshInvite({
      requestType: "callback",
      fullName: "Bob Smith",
      email: "bob@example.com",
      preferredContactMethod: "email",
      population: "adult",
    });
    expect(res.status).toBe(200);
    expect(recordMock.mock.calls[0]?.[0]).toMatchObject({ phone: null });
  });

  it("requires a number when they asked to be phoned", async () => {
    const res = await postFreshInvite({
      requestType: "callback",
      fullName: "Bob Smith",
      email: "bob@example.com",
      preferredContactMethod: "phone",
      population: "adult",
    });
    expect(res.status).toBe(400);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("requires a number when they asked to be texted", async () => {
    const res = await postFreshInvite({
      requestType: "callback",
      fullName: "Bob Smith",
      email: "bob@example.com",
      preferredContactMethod: "text",
      population: "adult",
    });
    expect(res.status).toBe(400);
  });
});

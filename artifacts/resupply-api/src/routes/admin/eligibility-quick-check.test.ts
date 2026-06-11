// Route tests for POST /admin/billing/eligibility-quick-check.
//
// Coverage:
//   * 401 when unauthenticated
//   * 400 on malformed bodies (missing member id, impossible DOB,
//     unknown extra keys)
//   * 404 when the payer profile is unknown
//   * 200 happy path returns the parsed benefits straight through
//   * 409 realtime_not_configured when the quick-check lib reports
//     `unavailable`
//   * 409 quick_check_failed on a transport failure
//   * csr role (patients.update) can run it
//
// NOTE: the route's rate limiter (10 req / 15 min) is module-level and
// its memory store persists across makeApp() calls — authenticated
// requests in this file count against ONE shared budget. Keep the
// authenticated-request count under 10 or 429s will bleed across tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

vi.mock("../../lib/billing/eligibility-quick-check", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/billing/eligibility-quick-check")
  >("../../lib/billing/eligibility-quick-check");
  return {
    PayerProfileNotFoundError: actual.PayerProfileNotFoundError,
    quickCheckEligibility: vi.fn(),
  };
});

import {
  PayerProfileNotFoundError,
  quickCheckEligibility,
} from "../../lib/billing/eligibility-quick-check";
import eligibilityQuickCheckRouter from "./eligibility-quick-check";

const PAYER_PROFILE_ID = "44444444-aaaa-4444-8444-aaaaaaaaaaaa";

const VALID_BODY = {
  payerProfileId: PAYER_PROFILE_ID,
  firstName: "Alice",
  lastName: "Walkin",
  memberId: "MEM-99",
  dateOfBirth: "1965-04-12",
};

const PARSED_RESULT = {
  status: "parsed" as const,
  payerName: "Acme Health",
  traceReference: "TRACE-1",
  latencyMs: 850,
  benefits: {
    isActive: true,
    inNetwork: true,
    deductibleCents: 50000,
    deductibleMetCents: 10000,
    deductibleRemainingCents: 40000,
    oopMaxCents: 200000,
    oopMetCents: 25000,
    oopRemainingCents: 175000,
    copayCents: null,
    coinsurancePct: 20,
    requiresPriorAuth: false,
    messages: [],
  },
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", eligibilityQuickCheckRouter);
  return app;
}

function post(app: Express, body: unknown) {
  return request(app)
    .post("/resupply-api/admin/billing/eligibility-quick-check")
    .set("Accept", "application/json")
    .send(body as object);
}

describe("POST /admin/billing/eligibility-quick-check", () => {
  beforeEach(() => {
    mockAdmin.current = null;
    vi.mocked(quickCheckEligibility).mockReset();
  });

  it("401s when no admin session", async () => {
    const res = await post(makeApp(), VALID_BODY);
    expect(res.status).toBe(401);
    expect(vi.mocked(quickCheckEligibility)).not.toHaveBeenCalled();
  });

  it("400s on a missing member id", async () => {
    mockAdmin.current = { userId: "u1", email: "ops@x.com", role: "admin" };
    const { memberId: _omitted, ...rest } = VALID_BODY;
    const res = await post(makeApp(), rest);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("400s on an impossible date of birth", async () => {
    mockAdmin.current = { userId: "u1", email: "ops@x.com", role: "admin" };
    const res = await post(makeApp(), {
      ...VALID_BODY,
      dateOfBirth: "2000-02-31",
    });
    expect(res.status).toBe(400);
  });

  it("400s on unknown extra keys (strict body)", async () => {
    mockAdmin.current = { userId: "u1", email: "ops@x.com", role: "admin" };
    const res = await post(makeApp(), { ...VALID_BODY, patientId: "p-1" });
    expect(res.status).toBe(400);
  });

  it("404s when the payer profile is unknown", async () => {
    mockAdmin.current = { userId: "u1", email: "ops@x.com", role: "admin" };
    vi.mocked(quickCheckEligibility).mockRejectedValueOnce(
      new PayerProfileNotFoundError(),
    );
    const res = await post(makeApp(), VALID_BODY);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("payer_not_found");
  });

  it("returns the parsed benefits on the happy path", async () => {
    mockAdmin.current = { userId: "u1", email: "ops@x.com", role: "admin" };
    vi.mocked(quickCheckEligibility).mockResolvedValueOnce(PARSED_RESULT);

    const res = await post(makeApp(), { ...VALID_BODY, hcpcsCode: "E0601" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("parsed");
    expect(res.body.payerName).toBe("Acme Health");
    expect(res.body.benefits.isActive).toBe(true);
    expect(vi.mocked(quickCheckEligibility)).toHaveBeenCalledWith({
      payerProfileId: PAYER_PROFILE_ID,
      subscriber: {
        firstName: "Alice",
        lastName: "Walkin",
        memberId: "MEM-99",
        dateOfBirth: "1965-04-12",
        gender: undefined,
      },
      hcpcsCode: "E0601",
    });
  });

  it("allows the csr role (patients.update)", async () => {
    mockAdmin.current = {
      userId: "u2",
      email: "csr@x.com",
      role: "agent",
      granularRole: "csr",
    };
    vi.mocked(quickCheckEligibility).mockResolvedValueOnce(PARSED_RESULT);
    const res = await post(makeApp(), VALID_BODY);
    expect(res.status).toBe(200);
  });

  it("409s with realtime_not_configured when real-time is unavailable", async () => {
    mockAdmin.current = { userId: "u1", email: "ops@x.com", role: "admin" };
    vi.mocked(quickCheckEligibility).mockResolvedValueOnce({
      status: "unavailable",
      message: "Real-time eligibility is not configured",
    });
    const res = await post(makeApp(), VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("realtime_not_configured");
  });

  it("409s with quick_check_failed on a transport failure", async () => {
    mockAdmin.current = { userId: "u1", email: "ops@x.com", role: "admin" };
    vi.mocked(quickCheckEligibility).mockResolvedValueOnce({
      status: "failed",
      message: "real-time request failed to connect",
    });
    const res = await post(makeApp(), VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("quick_check_failed");
    expect(res.body.message).toMatch(/failed to connect/);
  });
});

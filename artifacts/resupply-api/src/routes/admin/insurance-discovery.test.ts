// Route tests for POST /admin/billing/insurance-discovery.
//
// Coverage:
//   * 401 when unauthenticated
//   * 403 addon_not_enabled when the insurance.discovery flag is off
//   * 400 on malformed bodies (impossible DOB, bad SSN, unknown extra keys)
//   * 200 found / 200 none happy paths pass the lib result straight through
//   * 409 discovery_not_configured when the lib reports `unavailable`
//   * 409 discovery_failed on a transport failure
//   * csr role (patients.update) can run it
//
// NOTE: the route's rate limiter (10 req / 15 min) is module-level and its
// memory store persists across makeApp() calls — authenticated requests in
// this file count against ONE shared budget. Keep the authenticated-request
// count under 10 or 429s will bleed across tests.

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

vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => true),
}));

vi.mock("../../lib/billing/insurance-discovery", () => ({
  runInsuranceDiscovery: vi.fn(),
}));

import { isFeatureEnabled } from "../../lib/feature-flags";
import { runInsuranceDiscovery } from "../../lib/billing/insurance-discovery";
import insuranceDiscoveryRouter from "./insurance-discovery";

const VALID_BODY = {
  firstName: "Alice",
  lastName: "Walkin",
  dateOfBirth: "1965-04-12",
};

const FOUND_RESULT = {
  status: "found" as const,
  coverages: [
    {
      payerName: "Acme Health",
      payerId: "OA123",
      memberId: "MEM-1",
      planName: "PPO",
      isActive: true,
      coverageStart: "2026-01-01",
      coverageEnd: null,
    },
  ],
  activeCount: 1,
  latencyMs: 900,
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", insuranceDiscoveryRouter);
  return app;
}

function post(app: Express, body: unknown) {
  return request(app)
    .post("/resupply-api/admin/billing/insurance-discovery")
    .set("Accept", "application/json")
    .send(body as object);
}

describe("POST /admin/billing/insurance-discovery", () => {
  beforeEach(() => {
    mockAdmin.current = null;
    vi.mocked(runInsuranceDiscovery).mockReset();
    vi.mocked(isFeatureEnabled).mockReset().mockResolvedValue(true);
  });

  it("401s when no admin session", async () => {
    const res = await post(makeApp(), VALID_BODY);
    expect(res.status).toBe(401);
    expect(vi.mocked(runInsuranceDiscovery)).not.toHaveBeenCalled();
  });

  it("403s with addon_not_enabled when the flag is off", async () => {
    mockAdmin.current = { userId: "u1", email: "ops@x.com", role: "admin" };
    vi.mocked(isFeatureEnabled).mockResolvedValueOnce(false);
    const res = await post(makeApp(), VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("addon_not_enabled");
    expect(vi.mocked(runInsuranceDiscovery)).not.toHaveBeenCalled();
  });

  it("400s on an impossible date of birth", async () => {
    mockAdmin.current = { userId: "u1", email: "ops@x.com", role: "admin" };
    const res = await post(makeApp(), {
      ...VALID_BODY,
      dateOfBirth: "2000-02-31",
    });
    expect(res.status).toBe(400);
  });

  it("400s on a malformed SSN", async () => {
    mockAdmin.current = { userId: "u1", email: "ops@x.com", role: "admin" };
    const res = await post(makeApp(), { ...VALID_BODY, ssn: "12-34" });
    expect(res.status).toBe(400);
  });

  it("400s on unknown extra keys (strict body)", async () => {
    mockAdmin.current = { userId: "u1", email: "ops@x.com", role: "admin" };
    const res = await post(makeApp(), { ...VALID_BODY, payerProfileId: "p" });
    expect(res.status).toBe(400);
  });

  it("returns the found coverages on the happy path", async () => {
    mockAdmin.current = { userId: "u1", email: "ops@x.com", role: "admin" };
    vi.mocked(runInsuranceDiscovery).mockResolvedValueOnce(FOUND_RESULT);
    const res = await post(makeApp(), { ...VALID_BODY, ssn: "123-45-6789" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("found");
    expect(res.body.coverages).toHaveLength(1);
    expect(res.body.activeCount).toBe(1);
    // The 9-digit SSN is normalized before reaching the lib.
    expect(
      vi.mocked(runInsuranceDiscovery).mock.calls[0]?.[0].subscriber.ssn,
    ).toBe("123456789");
  });

  it("passes a none result straight through", async () => {
    mockAdmin.current = { userId: "u1", email: "ops@x.com", role: "admin" };
    vi.mocked(runInsuranceDiscovery).mockResolvedValueOnce({
      status: "none",
      latencyMs: 700,
    });
    const res = await post(makeApp(), VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("none");
  });

  it("409s with discovery_not_configured when unavailable", async () => {
    mockAdmin.current = { userId: "u1", email: "ops@x.com", role: "admin" };
    vi.mocked(runInsuranceDiscovery).mockResolvedValueOnce({
      status: "unavailable",
      message: "Insurance discovery isn't configured.",
    });
    const res = await post(makeApp(), VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("discovery_not_configured");
  });

  it("409s with discovery_failed on a transport failure", async () => {
    mockAdmin.current = { userId: "u1", email: "ops@x.com", role: "admin" };
    vi.mocked(runInsuranceDiscovery).mockResolvedValueOnce({
      status: "failed",
      message: "insurance discovery request failed to connect",
    });
    const res = await post(makeApp(), VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("discovery_failed");
    expect(res.body.message).toMatch(/failed to connect/);
  });

  it("allows the csr role (patients.update)", async () => {
    mockAdmin.current = {
      userId: "u2",
      email: "csr@x.com",
      role: "agent",
      granularRole: "csr",
    };
    vi.mocked(runInsuranceDiscovery).mockResolvedValueOnce(FOUND_RESULT);
    const res = await post(makeApp(), VALID_BODY);
    expect(res.status).toBe(200);
  });
});

import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OwnerBusinessAnalytics,
  OwnerFinancialAnalytics,
} from "@workspace/resupply-domain";
import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const state = vi.hoisted(() => ({
  auth: { current: null as MockAdminCtx | null },
  rpc: vi.fn(),
  scope: vi.fn(),
  abort: vi.fn(),
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(state.auth),
);
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: () => (_req: Request, _res: Response, next: NextFunction) =>
    next(),
  adminReadRateLimiter: (_req: Request, _res: Response, next: NextFunction) =>
    next(),
}));
vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: (orgId: string) => {
    state.scope(orgId);
    return {
      raw: () => ({
        schema: () => ({
          rpc: (name: string, args: unknown) => ({
            abortSignal: (signal: AbortSignal) => {
              state.abort(signal);
              return state.rpc(name, args);
            },
          }),
        }),
      }),
    };
  },
}));
import router from "./analytics-owner";

const app = express();
app.use(router);
const owner: MockAdminCtx = {
  userId: "owner",
  email: "owner@example.test",
  role: "admin",
  granularRole: "supervisor",
  orgId: "00000000-0000-4000-8000-000000000001",
};

function businessFixture(): OwnerBusinessAnalytics {
  const period = {
    patientsAdded: 0,
    orderRequestsCreated: 0,
    orderRequestsSigned: 0,
    episodesOpened: 0,
    episodesConfirmed: 0,
    episodesFulfilled: 0,
    episodesAssumedShipped: 0,
    fulfillmentLinesQueued: 0,
    unitsQueued: 0,
    shipmentLinesRecorded: 0,
    patientsServed: 0,
    returningPatientsServed: 0,
    claimsCreated: 0,
    claimBilledCents: 0,
    claimPaidToDateCents: 0,
    fitRequestsCreated: 0,
    fitRequestsFulfilled: 0,
    outboundMessages: 0,
    inboundMessages: 0,
    deliveredMessages: 0,
    failedMessages: 0,
  };
  return {
    current: { ...period, patientsAdded: 12 },
    previous: { ...period, patientsAdded: 8 },
    snapshot: {
      activePatients: 100,
      pausedPatients: 4,
      openConversations: 5,
      awaitingStaffConversations: 2,
      unassignedConversations: 1,
      overdueSlaConversations: 0,
      dueResupplyPatients: 7,
      dueSoonResupplyPatients: 10,
      addressHoldEpisodes: 0,
      pendingSignatures: 3,
      expiredSignatures: 0,
      unbilledShipmentLines: 0,
      draftClaims: 0,
      deniedClaims: 0,
      unacknowledgedClaims: 0,
      openClaims: 0,
      openClaimBilledCents: 0,
      openClaimPaidCents: 0,
      openFitRequests: 0,
      activeProducts: 20,
      trackedProducts: 12,
      untrackedProducts: 8,
      lowStockProducts: 2,
      outOfStockProducts: 1,
    },
    daily: [],
    orderRequestStages: [],
    resupplyStages: [],
    claimStages: [],
    claimAging: [],
    payers: [],
    topProducts: [],
    lowStock: [],
    outreachChannels: [],
  };
}
function financialFixture(): OwnerFinancialAnalytics {
  return {
    current: {
      revenueCents: 50000,
      costCents: 30000,
      eventCount: 4,
      revenueEventCount: 2,
      costEventCount: 2,
      quoteCount: 2,
    },
    previous: {
      revenueCents: -1000,
      costCents: 0,
      eventCount: 1,
      revenueEventCount: 1,
      costEventCount: 0,
      quoteCount: 1,
    },
    settled: {
      boundOrders: 3,
      settledOrders: 2,
      incompleteOrders: 1,
      uncertainOrders: 0,
      costsIncompleteOrders: 1,
      revenueIncompleteOrders: 0,
      netRevenueCents: 100000,
      netCostCents: 110000,
      contributionCents: -10000,
    },
    quality: { undatedEvents: 0, futureDatedEvents: 0 },
    pricing: {
      pendingApprovals: 1,
      openProposals: 0,
      enabled: true,
      enforceQuotes: true,
      policyConfigured: true,
      activePriceListConfigured: false,
    },
    daily: [],
    costSources: [],
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  state.auth.current = owner;
  state.scope.mockClear();
  state.abort.mockClear();
  state.rpc.mockReset();
  state.rpc.mockImplementation(async (name) => ({
    data:
      name === "owner_business_analytics"
        ? businessFixture()
        : financialFixture(),
    error: null,
  }));
});

describe("owner analytics HTTP boundary", () => {
  it("reads both aggregate sources under the authenticated tenant and a common reporting clock", async () => {
    const response = await request(app).get("/admin/analytics/owner?days=30");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body.business.data.current.patientsAdded).toBe(12);
    expect(response.body.financial.data.settled.contributionCents).toBe(-10000);
    expect(state.scope).toHaveBeenCalledWith(owner.orgId);
    expect(state.rpc).toHaveBeenCalledTimes(2);
    const args = state.rpc.mock.calls[0][1];
    expect(args).toMatchObject({
      p_org_id: owner.orgId,
      p_as_of: response.body.generatedAt,
      p_to: response.body.window.to,
      p_from: response.body.window.from,
    });
    expect(state.rpc.mock.calls[1][1]).toEqual(args);
    expect(Date.parse(args.p_to) - Date.parse(args.p_from)).toBe(30 * 86400000);
    expect(
      state.abort.mock.calls.every(([signal]) => signal instanceof AbortSignal),
    ).toBe(true);
  });
  it.each(["csr", "biller", "rt"] as const)(
    "denies %s before reading financial or operational data",
    async (granularRole) => {
      state.auth.current = { ...owner, granularRole };
      const response = await request(app).get("/admin/analytics/owner");
      expect(response.status).toBe(403);
      expect(state.scope).not.toHaveBeenCalled();
      expect(state.rpc).not.toHaveBeenCalled();
    },
  );
  it("rejects anonymous and missing-tenant requests before querying", async () => {
    state.auth.current = null;
    expect((await request(app).get("/admin/analytics/owner")).status).toBe(401);
    state.auth.current = { ...owner, orgId: null };
    expect((await request(app).get("/admin/analytics/owner")).status).toBe(500);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it.each([
    "days=0",
    "days=3650",
    "days=7&days=30",
    "days=7&from=2026-01-01&to=2026-01-02",
    "from=2026-02-30&to=2026-03-01",
    "from=2026-02-02&to=2026-02-01",
    "from=2099-01-01&to=2099-01-02",
    "orgId=another-tenant",
  ])("rejects invalid selectors: %s", async (query) => {
    expect(
      (await request(app).get(`/admin/analytics/owner?${query}`)).status,
    ).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it("uses UTC custom dates and an equal-duration prior window", async () => {
    const response = await request(app).get(
      "/admin/analytics/owner?from=2026-01-01&to=2026-01-31",
    );
    expect(response.status).toBe(200);
    expect(response.body.window).toEqual({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
      previousFrom: "2025-12-01T00:00:00.000Z",
      previousTo: "2026-01-01T00:00:00.000Z",
    });
    expect(response.body.business.data.daily).toHaveLength(31);
    expect(response.body.financial.data.daily).toHaveLength(31);
    expect(response.body.financial.data.daily.at(-1)).toEqual({
      date: "2026-01-31",
      revenueCents: 0,
      costCents: 0,
      eventCount: 0,
    });
  });
  it("preserves dated activity while filling quiet UTC days for every view", async () => {
    const financial = financialFixture();
    financial.daily = [
      { date: "2026-01-02", revenueCents: -100, costCents: 50, eventCount: 2 },
    ];
    state.rpc.mockImplementation(async (name) => ({
      data: name === "owner_business_analytics" ? businessFixture() : financial,
      error: null,
    }));
    const response = await request(app).get(
      "/admin/analytics/owner?from=2026-01-01&to=2026-01-03",
    );
    expect(response.body.financial.data.daily).toEqual([
      { date: "2026-01-01", revenueCents: 0, costCents: 0, eventCount: 0 },
      financial.daily[0],
      { date: "2026-01-03", revenueCents: 0, costCents: 0, eventCount: 0 },
    ]);
  });
  it.each(["owner_business_analytics", "owner_pricing_analytics"])(
    "keeps a healthy section when %s fails without exposing database details",
    async (failed) => {
      state.rpc.mockImplementation(async (name) =>
        name === failed
          ? { data: null, error: { message: "private database detail" } }
          : {
              data:
                name === "owner_business_analytics"
                  ? businessFixture()
                  : financialFixture(),
              error: null,
            },
      );
      const response = await request(app).get("/admin/analytics/owner");
      expect(response.status).toBe(200);
      const bad =
        failed === "owner_business_analytics" ? "business" : "financial";
      expect(response.body[bad]).toEqual({
        status: "unavailable",
        message: expect.any(String),
      });
      expect(
        response.body[bad === "business" ? "financial" : "business"].status,
      ).toBe("available");
      expect(JSON.stringify(response.body)).not.toContain(
        "private database detail",
      );
    },
  );
  it("fails clearly when both reports are unavailable rather than returning zero KPIs", async () => {
    state.rpc.mockRejectedValue(new Error("source unavailable"));
    const response = await request(app).get("/admin/analytics/owner");
    expect(response.status).toBe(503);
    expect(response.body.error).toBe("owner_analytics_unavailable");
    expect(response.body.business).toBeUndefined();
  });
  it.each([
    null,
    {},
    {
      ...businessFixture(),
      current: {
        ...businessFixture().current,
        claimBilledCents: Number.MAX_SAFE_INTEGER + 1,
      },
    },
  ])(
    "rejects incomplete or unsafe aggregate data instead of coercing it",
    async (data) => {
      state.rpc.mockImplementation(async (name) => ({
        data: name === "owner_business_analytics" ? data : financialFixture(),
        error: null,
      }));
      const response = await request(app).get("/admin/analytics/owner");
      expect(response.status).toBe(200);
      expect(response.body.business.status).toBe("unavailable");
      expect(response.body.financial.status).toBe("available");
    },
  );
  it("never reuses another tenant's result", async () => {
    await request(app).get("/admin/analytics/owner");
    state.auth.current = {
      ...owner,
      orgId: "00000000-0000-4000-8000-000000000002",
    };
    await request(app).get("/admin/analytics/owner");
    expect(
      state.rpc.mock.calls
        .slice(2)
        .every(([, args]) => args.p_org_id === state.auth.current?.orgId),
    ).toBe(true);
  });
});

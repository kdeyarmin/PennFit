// Tests for /admin/billing/stripe-connect — G5 Express onboarding.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const ORG = "11111111-1111-4111-8111-111111111111";

const { mockAdmin, state } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
  state: {
    orgRow: null as {
      stripe_account_id: string | null;
      stripe_charges_enabled: boolean;
    } | null,
    createdAccounts: 0,
    boundAccountId: null as string | null,
  },
}));

vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

vi.mock("../../middlewares/admin-rate-limit", () => {
  const passthrough = (
    _req: import("express").Request,
    _res: import("express").Response,
    next: import("express").NextFunction,
  ) => next();
  return {
    adminReadRateLimiter: passthrough,
    adminWriteRateLimiter: passthrough,
  };
});

vi.mock("@workspace/resupply-db", () => ({
  resolveSeedOrgId: async () => ORG,
  getOrgScopedClient: () => ({
    raw: () => ({
      schema: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: state.orgRow, error: null }),
              }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("../../lib/stripe/config", () => ({
  SHOP_UNAVAILABLE_BODY: { error: "shop_unavailable" },
  readStripeConfigOrNull: () => ({ secretKey: "sk_test_x" }),
  readPublicBaseUrl: () => "https://acme.example",
  getStripeClient: () => ({
    accounts: {
      create: async () => {
        state.createdAccounts += 1;
        return { id: "acct_new123" };
      },
    },
    accountLinks: {
      create: async () => ({ url: "https://connect.stripe.com/onboard/abc" }),
    },
  }),
}));

vi.mock("../../lib/stripe/connect", () => ({
  setConnectedAccountId: async (_orgId: string, accountId: string) => {
    state.boundAccountId = accountId;
  },
}));

import stripeConnectRouter from "./stripe-connect";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(stripeConnectRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = {
    email: "owner@acme",
    userId: "u_owner",
    role: "admin",
    granularRole: "admin",
    orgId: ORG,
    permissions: ["system.config.manage"],
  } as MockAdminCtx;
  state.orgRow = {
    stripe_account_id: null,
    stripe_charges_enabled: false,
  };
  state.createdAccounts = 0;
  state.boundAccountId = null;
});

describe("GET /admin/billing/stripe-connect/status", () => {
  it("401s when unauthenticated", async () => {
    mockAdmin.current = null;
    const res = await request(makeApp()).get(
      "/admin/billing/stripe-connect/status",
    );
    expect(res.status).toBe(401);
  });

  it("reports not-connected for a tenant with no account", async () => {
    const res = await request(makeApp()).get(
      "/admin/billing/stripe-connect/status",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      connected: false,
      chargesEnabled: false,
      accountId: null,
    });
  });

  it("reports connected + chargesEnabled once onboarded", async () => {
    state.orgRow = {
      stripe_account_id: "acct_live",
      stripe_charges_enabled: true,
    };
    const res = await request(makeApp()).get(
      "/admin/billing/stripe-connect/status",
    );
    expect(res.body).toEqual({
      connected: true,
      chargesEnabled: true,
      accountId: "acct_live",
    });
  });
});

describe("POST /admin/billing/stripe-connect/start", () => {
  it("creates an Express account (once) and returns an onboarding link", async () => {
    const res = await request(makeApp()).post(
      "/admin/billing/stripe-connect/start",
    );
    expect(res.status).toBe(200);
    expect(res.body.url).toContain("connect.stripe.com");
    expect(res.body.accountId).toBe("acct_new123");
    expect(state.createdAccounts).toBe(1);
    expect(state.boundAccountId).toBe("acct_new123");
  });

  it("reuses the existing account (no second create) on re-entry", async () => {
    state.orgRow = {
      stripe_account_id: "acct_existing",
      stripe_charges_enabled: false,
    };
    const res = await request(makeApp()).post(
      "/admin/billing/stripe-connect/start",
    );
    expect(res.status).toBe(200);
    expect(res.body.accountId).toBe("acct_existing");
    expect(state.createdAccounts).toBe(0);
  });
});

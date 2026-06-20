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
    // Stripe's reported charges_enabled for accounts.retrieve (/refresh).
    retrieveChargesEnabled: false,
    // Last value written by setChargesEnabledByAccount + whether cleared.
    chargesEnabledWrites: [] as boolean[],
    cleared: false,
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
      retrieve: async () => ({
        id: state.orgRow?.stripe_account_id ?? "acct_unknown",
        charges_enabled: state.retrieveChargesEnabled,
      }),
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
  setChargesEnabledByAccount: async (_accountId: string, enabled: boolean) => {
    state.chargesEnabledWrites.push(enabled);
  },
  clearConnectedAccountId: async () => {
    state.cleared = true;
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
  state.retrieveChargesEnabled = false;
  state.chargesEnabledWrites = [];
  state.cleared = false;
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

describe("POST /admin/billing/stripe-connect/refresh", () => {
  it("409s when the tenant has no connected account", async () => {
    const res = await request(makeApp()).post(
      "/admin/billing/stripe-connect/refresh",
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_connected");
  });

  it("reconciles charges_enabled from Stripe and persists it", async () => {
    state.orgRow = {
      stripe_account_id: "acct_live",
      stripe_charges_enabled: false,
    };
    state.retrieveChargesEnabled = true; // Stripe now reports enabled
    const res = await request(makeApp()).post(
      "/admin/billing/stripe-connect/refresh",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      connected: true,
      chargesEnabled: true,
      accountId: "acct_live",
    });
    // The reconciled value was written back through the resolver helper.
    expect(state.chargesEnabledWrites).toEqual([true]);
  });

  it("reports still-disabled when Stripe hasn't enabled charges", async () => {
    state.orgRow = {
      stripe_account_id: "acct_live",
      stripe_charges_enabled: false,
    };
    state.retrieveChargesEnabled = false;
    const res = await request(makeApp()).post(
      "/admin/billing/stripe-connect/refresh",
    );
    expect(res.body.chargesEnabled).toBe(false);
    expect(state.chargesEnabledWrites).toEqual([false]);
  });
});

describe("POST /admin/billing/stripe-connect/disconnect", () => {
  it("clears the connected account and routes back to platform", async () => {
    state.orgRow = {
      stripe_account_id: "acct_live",
      stripe_charges_enabled: true,
    };
    const res = await request(makeApp()).post(
      "/admin/billing/stripe-connect/disconnect",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      connected: false,
      chargesEnabled: false,
      accountId: null,
    });
    expect(state.cleared).toBe(true);
  });

  it("401s when unauthenticated", async () => {
    mockAdmin.current = null;
    const res = await request(makeApp()).post(
      "/admin/billing/stripe-connect/disconnect",
    );
    expect(res.status).toBe(401);
  });
});

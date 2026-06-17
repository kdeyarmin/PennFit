// Stripe Connect resolver (G5) — connected-account lookup + caching.

import { beforeEach, describe, expect, it, vi } from "vitest";

const SEED_ORG = "00000000-0000-4000-8000-000000000000";

// Controllable directory lookup: each `maybeSingle()` returns the next
// staged response and records the filter (column + value) it was called
// with, so we can assert both the result and the query shape + call count.
const { state } = vi.hoisted(() => ({
  state: {
    responses: [] as Array<{ data: unknown; error: unknown }>,
    calls: [] as Array<{ select: string; column: string; value: string }>,
    updates: [] as Array<{
      payload: Record<string, unknown>;
      column: string;
      value: string;
    }>,
  },
}));

vi.mock("@workspace/resupply-db", () => ({
  resolveSeedOrgId: async () => SEED_ORG,
  getOrgScopedClient: () => ({
    raw: () => ({
      schema: () => ({
        from: () => ({
          select: (select: string) => ({
            eq: (column: string, value: string) => ({
              limit: () => ({
                maybeSingle: async () => {
                  state.calls.push({ select, column, value });
                  return state.responses.shift() ?? { data: null, error: null };
                },
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: async (column: string, value: string) => {
              state.updates.push({ payload, column, value });
              return { error: null };
            },
          }),
        }),
      }),
    }),
  }),
}));

import {
  clearConnectedAccountId,
  getConnectedAccountId,
  invalidateStripeConnectCache,
  resolveOrgIdByConnectedAccount,
  stripeAccountRequestOptions,
} from "./connect";

const ORG = "11111111-1111-4111-8111-111111111111";
const ACCT = "acct_test123";

beforeEach(() => {
  state.responses = [];
  state.calls = [];
  state.updates = [];
  invalidateStripeConnectCache();
});

describe("getConnectedAccountId", () => {
  it("returns the connected account id when set", async () => {
    state.responses = [
      {
        data: { stripe_account_id: ACCT, stripe_charges_enabled: true },
        error: null,
      },
    ];
    expect(await getConnectedAccountId(ORG)).toBe(ACCT);
    expect(state.calls[0]).toMatchObject({ column: "id", value: ORG });
  });

  it("returns null when the tenant has no connected account", async () => {
    state.responses = [{ data: { stripe_account_id: null }, error: null }];
    expect(await getConnectedAccountId(ORG)).toBeNull();
  });

  it("returns null when the account exists but charges aren't enabled yet (G5 onboarding gate)", async () => {
    state.responses = [
      {
        data: { stripe_account_id: ACCT, stripe_charges_enabled: false },
        error: null,
      },
    ];
    expect(await getConnectedAccountId(ORG)).toBeNull();
  });

  it("caches the result (no second query within the TTL)", async () => {
    state.responses = [
      {
        data: { stripe_account_id: ACCT, stripe_charges_enabled: true },
        error: null,
      },
    ];
    await getConnectedAccountId(ORG);
    await getConnectedAccountId(ORG);
    expect(state.calls).toHaveLength(1);
  });

  it("fails soft to null on a lookup error", async () => {
    state.responses = [{ data: null, error: { message: "boom" } }];
    expect(await getConnectedAccountId(ORG)).toBeNull();
  });
});

describe("stripeAccountRequestOptions", () => {
  it("yields { stripeAccount } for a connected tenant", async () => {
    state.responses = [
      {
        data: { stripe_account_id: ACCT, stripe_charges_enabled: true },
        error: null,
      },
    ];
    expect(await stripeAccountRequestOptions(ORG)).toEqual({
      stripeAccount: ACCT,
    });
  });

  it("yields {} (platform account) when unconnected", async () => {
    state.responses = [{ data: { stripe_account_id: null }, error: null }];
    expect(await stripeAccountRequestOptions(ORG)).toEqual({});
  });

  it("yields {} for an undefined orgId without querying", async () => {
    expect(await stripeAccountRequestOptions(undefined)).toEqual({});
    expect(state.calls).toHaveLength(0);
  });

  it("yields {} for a blank / whitespace orgId without querying", async () => {
    expect(await stripeAccountRequestOptions("   ")).toEqual({});
    expect(state.calls).toHaveLength(0);
  });
});

describe("resolveOrgIdByConnectedAccount", () => {
  it("reverse-maps an account id to its owning org", async () => {
    state.responses = [{ data: { id: ORG }, error: null }];
    expect(await resolveOrgIdByConnectedAccount(ACCT)).toBe(ORG);
    expect(state.calls[0]).toMatchObject({
      column: "stripe_account_id",
      value: ACCT,
    });
  });

  it("returns null for an unknown account", async () => {
    state.responses = [{ data: null, error: null }];
    expect(await resolveOrgIdByConnectedAccount("acct_unknown")).toBeNull();
  });
});

describe("clearConnectedAccountId", () => {
  it("nulls the account id, resets charges_enabled, and invalidates cache", async () => {
    // Prime the cache with a live connected account.
    state.responses = [
      {
        data: { stripe_account_id: ACCT, stripe_charges_enabled: true },
        error: null,
      },
      // After clearing, the next resolve sees no account.
      { data: { stripe_account_id: null }, error: null },
    ];
    expect(await getConnectedAccountId(ORG)).toBe(ACCT);

    await clearConnectedAccountId(ORG);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ column: "id", value: ORG });
    expect(state.updates[0].payload).toEqual({
      stripe_account_id: null,
      stripe_charges_enabled: false,
    });

    // Cache was invalidated → a fresh query runs and now sees no account.
    expect(await getConnectedAccountId(ORG)).toBeNull();
    expect(state.calls).toHaveLength(2);
  });
});

describe("invalidateStripeConnectCache", () => {
  it("forces a re-query after invalidation", async () => {
    state.responses = [
      {
        data: { stripe_account_id: ACCT, stripe_charges_enabled: true },
        error: null,
      },
      {
        data: { stripe_account_id: ACCT, stripe_charges_enabled: true },
        error: null,
      },
    ];
    await getConnectedAccountId(ORG);
    invalidateStripeConnectCache();
    await getConnectedAccountId(ORG);
    expect(state.calls).toHaveLength(2);
  });
});

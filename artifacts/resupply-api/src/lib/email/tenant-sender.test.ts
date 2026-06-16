// Per-tenant email sender resolver (G6).

import { beforeEach, describe, expect, it, vi } from "vitest";

const SEED_ORG = "00000000-0000-4000-8000-000000000000";

const { state } = vi.hoisted(() => ({
  state: {
    responses: [] as Array<{ data: unknown; error: unknown }>,
    calls: 0,
  },
}));

vi.mock("@workspace/resupply-db", () => ({
  resolveSeedOrgId: async () => SEED_ORG,
  getOrgScopedClient: () => ({
    raw: () => ({
      schema: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: async () => {
                  state.calls += 1;
                  return state.responses.shift() ?? { data: null, error: null };
                },
              }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

import {
  invalidateTenantSenderCache,
  resolveTenantSender,
} from "./tenant-sender";

const ORG = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  state.responses = [];
  state.calls = 0;
  invalidateTenantSenderCache();
});

describe("resolveTenantSender", () => {
  it("returns {} (platform default) for an undefined orgId without querying", async () => {
    expect(await resolveTenantSender(undefined)).toEqual({});
    expect(state.calls).toBe(0);
  });

  it("returns the tenant's from_email + from_name when set", async () => {
    state.responses = [
      {
        data: { from_email: "hi@acme.com", from_name: "Acme Sleep" },
        error: null,
      },
    ];
    expect(await resolveTenantSender(ORG)).toEqual({
      fromEmail: "hi@acme.com",
      fromName: "Acme Sleep",
    });
  });

  it("omits fromName when only from_email is set", async () => {
    state.responses = [
      { data: { from_email: "hi@acme.com", from_name: null }, error: null },
    ];
    expect(await resolveTenantSender(ORG)).toEqual({
      fromEmail: "hi@acme.com",
    });
  });

  it("returns {} (platform default) when from_email is null", async () => {
    state.responses = [
      { data: { from_email: null, from_name: "Stray Name" }, error: null },
    ];
    expect(await resolveTenantSender(ORG)).toEqual({});
  });

  it("ignores a blank from_email", async () => {
    state.responses = [
      { data: { from_email: "   ", from_name: null }, error: null },
    ];
    expect(await resolveTenantSender(ORG)).toEqual({});
  });

  it("caches the result (no second query within the TTL)", async () => {
    state.responses = [
      { data: { from_email: "hi@acme.com", from_name: null }, error: null },
    ];
    await resolveTenantSender(ORG);
    await resolveTenantSender(ORG);
    expect(state.calls).toBe(1);
  });

  it("fails soft to {} on a lookup error", async () => {
    state.responses = [{ data: null, error: { message: "boom" } }];
    expect(await resolveTenantSender(ORG)).toEqual({});
  });

  it("re-queries after cache invalidation", async () => {
    state.responses = [
      { data: { from_email: "hi@acme.com", from_name: null }, error: null },
      { data: { from_email: "hi@acme.com", from_name: null }, error: null },
    ];
    await resolveTenantSender(ORG);
    invalidateTenantSenderCache();
    await resolveTenantSender(ORG);
    expect(state.calls).toBe(2);
  });
});

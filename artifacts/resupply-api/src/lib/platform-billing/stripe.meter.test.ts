// Behavioral tests for the per-fitting Stripe Billing Meter reporter
// (migration 0420).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    config: null as unknown,
    customerRow: null as { stripe_customer_id: string | null } | null,
    queryError: null as unknown,
    meterEvents: [] as Array<Record<string, unknown>>,
    throwOnCreate: false,
  },
}));

vi.mock("../stripe/config", () => ({
  readPlatformBillingStripeConfigOrNull: () => state.config,
  getStripeClient: () => ({
    billing: {
      meterEvents: {
        create: async (params: Record<string, unknown>) => {
          if (state.throwOnCreate) throw new Error("stripe unreachable");
          state.meterEvents.push(params);
          return { id: "mbe_1" };
        },
      },
    },
  }),
}));

// The reporter resolves the seed org, then queries the tenant's customer id
// down: raw → schema → from → select → eq → in → not → limit → maybeSingle.
vi.mock("@workspace/resupply-db", () => ({
  resolveSeedOrgId: async () => "seed-org",
  getOrgScopedClient: () => ({
    raw: () => ({
      schema: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              in: () => ({
                not: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({
                      data: state.customerRow,
                      error: state.queryError,
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("@workspace/resupply-audit", () => ({ logAudit: vi.fn() }));
vi.mock("../logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { reportFitterFittingMeterEvent } from "./stripe";

beforeEach(() => {
  state.config = null;
  state.customerRow = null;
  state.queryError = null;
  state.meterEvents = [];
  state.throwOnCreate = false;
});

describe("reportFitterFittingMeterEvent", () => {
  it("no-ops on a blank orgId", async () => {
    await reportFitterFittingMeterEvent("");
    await reportFitterFittingMeterEvent(undefined);
    await reportFitterFittingMeterEvent(null);
    expect(state.meterEvents).toHaveLength(0);
  });

  it("no-ops when platform Stripe billing is unconfigured", async () => {
    state.config = null;
    state.customerRow = { stripe_customer_id: "cus_1" };
    await reportFitterFittingMeterEvent("org-1");
    expect(state.meterEvents).toHaveLength(0);
  });

  it("no-ops when the tenant has no Stripe customer yet", async () => {
    state.config = { mode: "shared" };
    state.customerRow = null;
    await reportFitterFittingMeterEvent("org-1");
    expect(state.meterEvents).toHaveLength(0);
  });

  it("reports a customer-keyed meter event with value 1", async () => {
    state.config = { mode: "shared" };
    state.customerRow = { stripe_customer_id: "cus_123" };
    await reportFitterFittingMeterEvent("  org-1  ");
    expect(state.meterEvents).toHaveLength(1);
    expect(state.meterEvents[0]).toMatchObject({
      event_name: "fitter_fitting",
      payload: { stripe_customer_id: "cus_123", value: "1" },
    });
  });

  it("never throws when Stripe rejects (fail-soft)", async () => {
    state.config = { mode: "shared" };
    state.customerRow = { stripe_customer_id: "cus_123" };
    state.throwOnCreate = true;
    await expect(
      reportFitterFittingMeterEvent("org-1"),
    ).resolves.toBeUndefined();
  });
});

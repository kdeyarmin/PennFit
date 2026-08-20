// Behavioral tests for the per-fitting Stripe Billing Meter reporter
// (migration 0420).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    config: null as unknown,
    customerRow: null as Record<string, unknown> | null,
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

  // ── Unlimited tenants (pilots, negotiated contracts) ────────────────
  //
  // This reporter is the ONLY biller for fitter fittings: reportMeteredOverage
  // skips the metric entirely (its add-on query filters included_units IS
  // NULL, and the fitter row sets it). So if this path ignored
  // custom_allowances, an "unlimited" tenant would still be charged from
  // fitting 26 — silently, and on the metric most likely to exceed its plan.

  it("does not report when the tenant fitter allowance is UNLIMITED", async () => {
    state.config = { mode: "shared" };
    state.customerRow = {
      stripe_customer_id: "cus_123",
      custom_allowances: { fitterFittingsPerMonth: null },
      billing_plans: { allowances: { fitterFittingsPerMonth: 25 } },
    };
    await reportFitterFittingMeterEvent("org-1");
    expect(state.meterEvents).toHaveLength(0);
  });

  it("still reports when the plan number stands (no override)", async () => {
    state.config = { mode: "shared" };
    state.customerRow = {
      stripe_customer_id: "cus_123",
      custom_allowances: {},
      billing_plans: { allowances: { fitterFittingsPerMonth: 25 } },
    };
    await reportFitterFittingMeterEvent("org-1");
    expect(state.meterEvents).toHaveLength(1);
  });

  it("still reports for a NUMERIC override — the free tier lives in the Stripe price", async () => {
    // Deliberate: withholding events to emulate a different included amount
    // would double-count against the tier Stripe already applies. Changing a
    // tenant's included fittings means changing their price.
    state.config = { mode: "shared" };
    state.customerRow = {
      stripe_customer_id: "cus_123",
      custom_allowances: { fitterFittingsPerMonth: 500 },
      billing_plans: { allowances: { fitterFittingsPerMonth: 25 } },
    };
    await reportFitterFittingMeterEvent("org-1");
    expect(state.meterEvents).toHaveLength(1);
  });

  it("still reports when another metric is unlimited but the fitter is not", async () => {
    state.config = { mode: "shared" };
    state.customerRow = {
      stripe_customer_id: "cus_123",
      custom_allowances: { outboundMessagesPerMonth: null },
      billing_plans: { allowances: { fitterFittingsPerMonth: 25 } },
    };
    await reportFitterFittingMeterEvent("org-1");
    expect(state.meterEvents).toHaveLength(1);
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

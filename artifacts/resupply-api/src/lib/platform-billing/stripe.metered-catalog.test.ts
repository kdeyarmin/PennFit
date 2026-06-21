// Behavioral test for the metered-add-on path of the platform billing
// catalog sync (migration 0420): a usage_type='metered' add-on must mint a
// Stripe Billing Meter + a graduated metered Price, while a flat plan stays
// a licensed price. Drives syncPlatformBillingCatalogToStripe() against a
// mocked Stripe client + catalog and asserts the exact create params.

import { describe, it, expect, vi, beforeEach } from "vitest";

interface StripeCalls {
  meters: Array<Record<string, unknown>>;
  products: Array<Record<string, unknown>>;
  prices: Array<Record<string, unknown>>;
}

const { state } = vi.hoisted(() => ({
  state: {
    plans: [] as Array<Record<string, unknown>>,
    addons: [] as Array<Record<string, unknown>>,
    calls: {
      meters: [],
      products: [],
      prices: [],
    } as StripeCalls,
  },
}));

const stripeMock = {
  accounts: { retrieveCurrent: async () => ({ id: "acct_test" }) },
  billing: {
    meters: {
      create: async (p: Record<string, unknown>) => {
        state.calls.meters.push(p);
        return { id: "mtr_test_1" };
      },
    },
  },
  products: {
    create: async (p: Record<string, unknown>) => {
      state.calls.products.push(p);
      return { id: `prod_${state.calls.products.length}` };
    },
    update: async (id: string) => ({ id }),
  },
  prices: {
    create: async (p: Record<string, unknown>) => {
      state.calls.prices.push(p);
      return { id: `price_${state.calls.prices.length}` };
    },
  },
};

vi.mock("../stripe/config", () => ({
  readPlatformBillingStripeConfigOrNull: () => ({
    mode: "shared",
    secretKey: "sk_test_x",
  }),
  getStripeClient: () => stripeMock,
}));

// Catalog read: from("billing_plans"/"billing_addons").select("*") resolves
// to the seeded rows; the write-back .update(...).eq(...) is a no-op.
vi.mock("@workspace/resupply-db", () => ({
  resolveSeedOrgId: async () => "seed-org",
  getOrgScopedClient: () => ({
    raw: () => ({
      schema: () => ({
        from: (table: string) => ({
          select: () =>
            Promise.resolve({
              data: table === "billing_plans" ? state.plans : state.addons,
              error: null,
            }),
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        }),
      }),
    }),
  }),
}));

vi.mock("@workspace/resupply-audit", () => ({ logAudit: vi.fn() }));
vi.mock("../logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { syncPlatformBillingCatalogToStripe } from "./stripe";

beforeEach(() => {
  state.calls = { meters: [], products: [], prices: [] };
  state.plans = [
    {
      id: "plan-1",
      code: "mask_fitter",
      name: "Virtual Mask Fitter",
      description: "Standalone AI mask fitter",
      monthly_price_cents: 14900,
      stripe_price_id: null,
      stripe_product_id: null,
      stripe_account_ref: null,
    },
  ];
  state.addons = [
    {
      id: "addon-1",
      code: "fitter_fitting_metered",
      name: "Additional mask fittings",
      description: "Per-fitting overage",
      recurring_price_cents: 300,
      usage_type: "metered",
      included_units: 25,
      meter_event_name: "fitter_fitting",
      stripe_price_id: null,
      stripe_product_id: null,
      stripe_meter_id: null,
      stripe_account_ref: null,
    },
  ];
});

describe("syncPlatformBillingCatalogToStripe — metered add-on", () => {
  it("mints a customer-keyed Billing Meter (sum aggregation)", async () => {
    await syncPlatformBillingCatalogToStripe();
    expect(state.calls.meters).toHaveLength(1);
    expect(state.calls.meters[0]).toMatchObject({
      event_name: "fitter_fitting",
      default_aggregation: { formula: "sum" },
      customer_mapping: {
        type: "by_id",
        event_payload_key: "stripe_customer_id",
      },
      value_settings: { event_payload_key: "value" },
    });
  });

  it("creates a graduated metered price (25 free, then $3) tied to the meter", async () => {
    await syncPlatformBillingCatalogToStripe();
    const metered = state.calls.prices.find(
      (p) =>
        (p.recurring as { usage_type?: string } | undefined)?.usage_type ===
        "metered",
    );
    expect(metered).toBeDefined();
    expect(metered).toMatchObject({
      currency: "usd",
      billing_scheme: "tiered",
      tiers_mode: "graduated",
      recurring: {
        interval: "month",
        usage_type: "metered",
        meter: "mtr_test_1",
      },
      tiers: [
        { up_to: 25, unit_amount: 0 },
        { up_to: "inf", unit_amount: 300 },
      ],
    });
    // A tiered price must NOT carry a top-level unit_amount.
    expect(metered).not.toHaveProperty("unit_amount");
  });

  it("leaves a flat plan as a licensed price (no meter)", async () => {
    await syncPlatformBillingCatalogToStripe();
    expect(state.calls.meters).toHaveLength(1); // only the metered add-on
    const flat = state.calls.prices.find((p) => p.unit_amount === 14900);
    expect(flat).toBeDefined();
    expect(flat).toMatchObject({
      unit_amount: 14900,
      recurring: { interval: "month" },
    });
    expect(
      (flat?.recurring as { usage_type?: string } | undefined)?.usage_type,
    ).toBeUndefined();
  });
});

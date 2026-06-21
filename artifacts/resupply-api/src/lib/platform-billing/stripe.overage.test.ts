// Tests for standard-plan metered OVERAGE billing (migration 0421): the pure
// overage-delta math, the env-flag gate, and the Stripe meter-event reporter.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface QueryResult {
  data: unknown;
  error: unknown;
}

const { state } = vi.hoisted(() => ({
  state: {
    config: null as unknown,
    results: {} as Record<string, QueryResult>,
    meterEvents: [] as Array<Record<string, unknown>>,
    throwOnCreate: false,
  },
}));

function makeQuery(result: QueryResult) {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "not", "is", "limit"]) {
    builder[m] = () => builder;
  }
  builder.maybeSingle = async () => result;
  return builder;
}

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

vi.mock("@workspace/resupply-db", () => ({
  resolveSeedOrgId: async () => "seed-org",
  getOrgScopedClient: () => ({
    raw: () => ({
      schema: () => ({
        from: (table: string) =>
          makeQuery(state.results[table] ?? { data: null, error: null }),
      }),
    }),
  }),
}));

vi.mock("@workspace/resupply-audit", () => ({ logAudit: vi.fn() }));
vi.mock("../logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  computeMeteredOverageDelta,
  isMeteredOverageEnabled,
  meteredAddonAttaches,
  reportMeteredOverage,
} from "./stripe";

beforeEach(() => {
  state.config = null;
  state.results = {};
  state.meterEvents = [];
  state.throwOnCreate = false;
  delete process.env.PLATFORM_METERED_OVERAGE_ENABLED;
});
afterEach(() => {
  delete process.env.PLATFORM_METERED_OVERAGE_ENABLED;
});

describe("computeMeteredOverageDelta", () => {
  it("reports 0 when usage stays within the allowance", () => {
    expect(computeMeteredOverageDelta(0, 25, 1000)).toBe(0);
    expect(computeMeteredOverageDelta(999, 1, 1000)).toBe(0);
  });

  it("reports only the part above the allowance when straddling the boundary", () => {
    // prior 998, +5 → 1003, allowance 1000 → only 3 billable.
    expect(computeMeteredOverageDelta(998, 5, 1000)).toBe(3);
    // exactly hitting the allowance then crossing.
    expect(computeMeteredOverageDelta(1000, 10, 1000)).toBe(10);
  });

  it("reports the full increment when already over the allowance", () => {
    expect(computeMeteredOverageDelta(1500, 7, 1000)).toBe(7);
  });

  it("treats a zero allowance as bill-from-unit-1", () => {
    expect(computeMeteredOverageDelta(0, 3, 0)).toBe(3);
  });
});

describe("meteredAddonAttaches", () => {
  const empty = new Set<string>();
  it("attaches when the plan declares the metric's allowance", () => {
    expect(
      meteredAddonAttaches(
        "outboundMessagesPerMonth",
        { outboundMessagesPerMonth: 1000 },
        empty,
      ),
    ).toBe(true);
  });
  it("attaches when an active feature add-on shares the metric (fax/voice)", () => {
    // No plan allowance, but the tenant has fax_automation active (faxEvents).
    expect(meteredAddonAttaches("faxEvents", {}, new Set(["faxEvents"]))).toBe(
      true,
    );
  });
  it("does not attach without a plan allowance or a sibling feature", () => {
    expect(
      meteredAddonAttaches("aiVoiceEvents", {}, new Set(["faxEvents"])),
    ).toBe(false);
  });
  it("does not attach for a null/empty metric", () => {
    expect(
      meteredAddonAttaches(null, { faxEvents: 0 }, new Set(["faxEvents"])),
    ).toBe(false);
  });
});

describe("isMeteredOverageEnabled", () => {
  it("is off when unset", () => {
    expect(isMeteredOverageEnabled()).toBe(false);
  });
  it("parses common truthy values", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      process.env.PLATFORM_METERED_OVERAGE_ENABLED = v;
      expect(isMeteredOverageEnabled()).toBe(true);
    }
  });
  it("stays off for other values", () => {
    for (const v of ["0", "false", "no", ""]) {
      process.env.PLATFORM_METERED_OVERAGE_ENABLED = v;
      expect(isMeteredOverageEnabled()).toBe(false);
    }
  });
});

describe("reportMeteredOverage", () => {
  function wireHappyPath(opts: {
    customer?: string | null;
    allowance: number;
    monthTotal: number;
  }) {
    state.config = { mode: "shared" };
    state.results.billing_addons = {
      data: { meter_event_name: "sms_overage" },
      error: null,
    };
    state.results.tenant_billing_subscriptions = {
      data: {
        stripe_customer_id:
          opts.customer === undefined ? "cus_1" : opts.customer,
        billing_plans: {
          allowances: { outboundMessagesPerMonth: opts.allowance },
        },
      },
      error: null,
    };
    state.results.tenant_usage_monthly_rollups = {
      data: { quantity: opts.monthTotal },
      error: null,
    };
  }

  it("no-ops when the overage flag is off (default)", async () => {
    wireHappyPath({ allowance: 1000, monthTotal: 1010 });
    await reportMeteredOverage({
      orgId: "org-1",
      metricKey: "outboundMessagesPerMonth",
      increment: 10,
    });
    expect(state.meterEvents).toHaveLength(0);
  });

  it("reports only the overage units when the flag is on", async () => {
    process.env.PLATFORM_METERED_OVERAGE_ENABLED = "true";
    // allowance 1000, month total now 1010 after a +10 increment → 10 over.
    wireHappyPath({ allowance: 1000, monthTotal: 1010 });
    await reportMeteredOverage({
      orgId: "org-1",
      metricKey: "outboundMessagesPerMonth",
      increment: 10,
    });
    expect(state.meterEvents).toHaveLength(1);
    expect(state.meterEvents[0]).toMatchObject({
      event_name: "sms_overage",
      payload: { stripe_customer_id: "cus_1", value: "10" },
    });
  });

  it("uses the atomic newTotal when provided, ignoring the rollup read", async () => {
    process.env.PLATFORM_METERED_OVERAGE_ENABLED = "true";
    // The rollup says 500 (within the 1000 allowance → 0 overage), but the
    // atomic post-increment total is 1010, so overage must be 10 from newTotal.
    wireHappyPath({ allowance: 1000, monthTotal: 500 });
    await reportMeteredOverage({
      orgId: "org-1",
      metricKey: "outboundMessagesPerMonth",
      increment: 10,
      newTotal: 1010,
    });
    expect(state.meterEvents).toHaveLength(1);
    expect(state.meterEvents[0]).toMatchObject({
      payload: { stripe_customer_id: "cus_1", value: "10" },
    });
  });

  it("bills ALL usage for a no-allowance metric (fax/voice), from unit 1", async () => {
    process.env.PLATFORM_METERED_OVERAGE_ENABLED = "true";
    state.config = { mode: "shared" };
    state.results.billing_addons = {
      data: { meter_event_name: "fax_usage" },
      error: null,
    };
    state.results.tenant_billing_subscriptions = {
      data: { stripe_customer_id: "cus_1", billing_plans: { allowances: {} } },
      error: null,
    };
    await reportMeteredOverage({
      orgId: "org-1",
      metricKey: "faxEvents",
      increment: 3,
      newTotal: 3,
    });
    expect(state.meterEvents).toHaveLength(1);
    expect(state.meterEvents[0]).toMatchObject({
      event_name: "fax_usage",
      payload: { stripe_customer_id: "cus_1", value: "3" },
    });
  });

  it("does NOT report when usage is still within the allowance", async () => {
    process.env.PLATFORM_METERED_OVERAGE_ENABLED = "true";
    // total 500 after +10, allowance 1000 → no overage.
    wireHappyPath({ allowance: 1000, monthTotal: 500 });
    await reportMeteredOverage({
      orgId: "org-1",
      metricKey: "outboundMessagesPerMonth",
      increment: 10,
    });
    expect(state.meterEvents).toHaveLength(0);
  });

  it("no-ops when the metric has no report-overage metered add-on", async () => {
    process.env.PLATFORM_METERED_OVERAGE_ENABLED = "true";
    state.config = { mode: "shared" };
    state.results.billing_addons = { data: null, error: null };
    await reportMeteredOverage({
      orgId: "org-1",
      metricKey: "faxEvents",
      increment: 5,
    });
    expect(state.meterEvents).toHaveLength(0);
  });

  it("no-ops when the tenant has no Stripe customer", async () => {
    process.env.PLATFORM_METERED_OVERAGE_ENABLED = "true";
    wireHappyPath({ customer: null, allowance: 0, monthTotal: 10 });
    await reportMeteredOverage({
      orgId: "org-1",
      metricKey: "outboundMessagesPerMonth",
      increment: 10,
    });
    expect(state.meterEvents).toHaveLength(0);
  });

  it("never throws when Stripe rejects (fail-soft)", async () => {
    process.env.PLATFORM_METERED_OVERAGE_ENABLED = "true";
    wireHappyPath({ allowance: 0, monthTotal: 10 });
    state.throwOnCreate = true;
    await expect(
      reportMeteredOverage({
        orgId: "org-1",
        metricKey: "outboundMessagesPerMonth",
        increment: 10,
      }),
    ).resolves.toBeUndefined();
  });
});

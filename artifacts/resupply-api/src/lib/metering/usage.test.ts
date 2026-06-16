// Tests for the per-tenant usage metering emitter (G12).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    inserted: [] as Array<Record<string, unknown>>,
    insertError: null as unknown,
    throwOnInsert: false,
  },
}));

vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: (orgId: string) => ({
    raw: () => ({
      schema: () => ({
        from: () => ({
          insert: async (row: Record<string, unknown>) => {
            if (state.throwOnInsert) throw new Error("connection reset");
            state.inserted.push({ ...row, __orgArg: orgId });
            return { error: state.insertError };
          },
        }),
      }),
    }),
  }),
}));

// Silence the fail-soft warn path.
vi.mock("../logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { recordTenantUsage } from "./usage";

beforeEach(() => {
  state.inserted = [];
  state.insertError = null;
  state.throwOnInsert = false;
});

describe("recordTenantUsage", () => {
  it("inserts a usage event with org_id, metric_key, quantity, and source", async () => {
    await recordTenantUsage({
      orgId: "org-1",
      metricKey: "aiTextInteractionsPerMonth",
      source: "storefront.chat",
    });
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      org_id: "org-1",
      metric_key: "aiTextInteractionsPerMonth",
      quantity: 1,
      source: "storefront.chat",
    });
    // occurred_at + metadata defaults are present.
    expect(typeof state.inserted[0].occurred_at).toBe("string");
    expect(state.inserted[0].metadata).toEqual({});
  });

  it("defaults source to 'system' and respects an explicit quantity", async () => {
    await recordTenantUsage({
      orgId: "org-2",
      metricKey: "outboundMessagesPerMonth",
      quantity: 5,
    });
    expect(state.inserted[0]).toMatchObject({ source: "system", quantity: 5 });
  });

  it("trims the orgId before stamping it", async () => {
    await recordTenantUsage({
      orgId: "  org-3  ",
      metricKey: "faxEvents",
    });
    expect(state.inserted[0].org_id).toBe("org-3");
  });

  it("is a no-op when orgId is missing or blank", async () => {
    await recordTenantUsage({ orgId: undefined, metricKey: "faxEvents" });
    await recordTenantUsage({ orgId: "   ", metricKey: "faxEvents" });
    await recordTenantUsage({ orgId: null, metricKey: "faxEvents" });
    expect(state.inserted).toHaveLength(0);
  });

  it("is a no-op when the effective quantity is zero or negative", async () => {
    await recordTenantUsage({
      orgId: "org-4",
      metricKey: "aiVoiceEvents",
      quantity: 0,
    });
    await recordTenantUsage({
      orgId: "org-4",
      metricKey: "aiVoiceEvents",
      quantity: -3,
    });
    await recordTenantUsage({
      orgId: "org-4",
      metricKey: "aiVoiceEvents",
      quantity: Number.NaN,
    });
    expect(state.inserted).toHaveLength(0);
  });

  it("floors a fractional quantity", async () => {
    await recordTenantUsage({
      orgId: "org-5",
      metricKey: "billingTransactionsPerMonth",
      quantity: 2.9,
    });
    expect(state.inserted[0].quantity).toBe(2);
  });

  it("never throws when the insert returns an error (fail-soft)", async () => {
    state.insertError = { code: "23514", message: "check violation" };
    await expect(
      recordTenantUsage({
        orgId: "org-6",
        metricKey: "aiTextInteractionsPerMonth",
      }),
    ).resolves.toBeUndefined();
  });

  it("never throws when the insert call itself throws (fail-soft)", async () => {
    state.throwOnInsert = true;
    await expect(
      recordTenantUsage({
        orgId: "org-7",
        metricKey: "aiTextInteractionsPerMonth",
      }),
    ).resolves.toBeUndefined();
  });
});

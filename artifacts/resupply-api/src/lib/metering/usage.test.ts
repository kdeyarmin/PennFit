// Tests for the per-tenant usage metering emitter (G12).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    // Each captured call is the RPC params object the emitter passed.
    inserted: [] as Array<Record<string, unknown>>,
    insertError: null as unknown,
    throwOnInsert: false,
  },
}));

vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: (orgId: string) => ({
    raw: () => ({
      schema: () => ({
        rpc: async (fn: string, params: Record<string, unknown>) => {
          if (state.throwOnInsert) throw new Error("connection reset");
          state.inserted.push({ ...params, __fn: fn, __orgArg: orgId });
          return { error: state.insertError };
        },
      }),
    }),
  }),
}));

// Silence the fail-soft warn path.
vi.mock("../logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  recordTenantUsage,
  recordOutboundMessageUsage,
  recordAiTokenUsage,
} from "./usage";

// recordAiTokenUsage is fire-and-forget (void recordTenantUsage), so let
// the spawned RPC microtasks settle before asserting.
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  state.inserted = [];
  state.insertError = null;
  state.throwOnInsert = false;
});

describe("recordTenantUsage", () => {
  it("increments the rollup with org_id, metric_key, and quantity", async () => {
    await recordTenantUsage({
      orgId: "org-1",
      metricKey: "aiTextInteractionsPerMonth",
      source: "storefront.chat",
    });
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      __fn: "increment_tenant_usage_rollup",
      p_org_id: "org-1",
      p_metric_key: "aiTextInteractionsPerMonth",
      p_quantity: 1,
    });
  });

  it("respects an explicit quantity", async () => {
    await recordTenantUsage({
      orgId: "org-2",
      metricKey: "outboundMessagesPerMonth",
      quantity: 5,
    });
    expect(state.inserted[0]).toMatchObject({ p_quantity: 5 });
  });

  it("trims the orgId before stamping it", async () => {
    await recordTenantUsage({
      orgId: "  org-3  ",
      metricKey: "faxEvents",
    });
    expect(state.inserted[0].p_org_id).toBe("org-3");
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
    expect(state.inserted[0].p_quantity).toBe(2);
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

describe("recordOutboundMessageUsage", () => {
  beforeEach(() => {
    state.inserted = [];
    state.insertError = null;
    state.throwOnInsert = false;
  });

  it("records one outboundMessagesPerMonth (fire-and-forget, returns void)", async () => {
    const ret = recordOutboundMessageUsage({
      orgId: "org-1",
      channel: "sms",
      source: "reminders.sms",
    });
    expect(ret).toBeUndefined(); // void, not a promise
    // The emit is async under the hood; let it settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      __fn: "increment_tenant_usage_rollup",
      p_org_id: "org-1",
      p_metric_key: "outboundMessagesPerMonth",
      p_quantity: 1,
    });
  });

  it("passes a batch count through as the quantity", async () => {
    recordOutboundMessageUsage({
      orgId: "org-2",
      channel: "email",
      source: "bulk",
      count: 7,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.inserted[0]).toMatchObject({ p_quantity: 7 });
  });
});

describe("recordAiTokenUsage", () => {
  it("records input and output tokens as separate rollup metrics", async () => {
    recordAiTokenUsage({
      orgId: "org-1",
      inputTokens: 1200,
      outputTokens: 340,
      source: "storefront.chat",
    });
    await flush();
    const byKey = new Map(
      state.inserted.map((r) => [r.p_metric_key, r.p_quantity]),
    );
    expect(byKey.get("aiInputTokensPerMonth")).toBe(1200);
    expect(byKey.get("aiOutputTokensPerMonth")).toBe(340);
  });

  it("skips a zero or missing token count", async () => {
    recordAiTokenUsage({
      orgId: "org-1",
      inputTokens: 0,
      outputTokens: null,
      source: "x",
    });
    await flush();
    expect(state.inserted).toHaveLength(0);
  });
});

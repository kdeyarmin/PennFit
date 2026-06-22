// Dunning engine (open-scan + tick): per-tenant flag gate + fan-out.
//
// The full open/escalate bodies run against a real PostgREST surface in the
// integration suite; here we cover the safety-critical control flow — the
// collections.dunning kill switch (checked per tenant) and the fan-out across
// active tenants. Sending is gated behind the flag, so an OFF tenant must
// never reach the statement send path.

import { describe, it, expect, vi, beforeEach } from "vitest";

const isFeatureEnabledMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));

const listActiveOrgIdsMock = vi.hoisted(() => vi.fn());
const getOrgScopedClientMock = vi.hoisted(() => vi.fn());
vi.mock("@workspace/resupply-db", () => ({
  listActiveOrgIds: listActiveOrgIdsMock,
  resolveSeedOrgId: vi.fn(),
  getOrgScopedClient: getOrgScopedClientMock,
  getSupabaseServiceRoleClient: vi.fn(),
}));

const sendStatementMessageMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/billing/statement-send", () => ({
  applyTenantStatementIdentity: vi.fn(async (_o: string, c: unknown) => c),
  pickStatementChannel: vi.fn(() => ({ channel: null, reason: "test" })),
  readStatementMessagingConfig: vi.fn(() => ({})),
  readStatementPrefs: vi.fn(() => ({})),
  sendStatementMessage: sendStatementMessageMock,
}));

import { runDunningOpenScan, runDunningTick } from "./dunning-engine";

beforeEach(() => {
  isFeatureEnabledMock.mockReset();
  listActiveOrgIdsMock.mockReset().mockResolvedValue([]);
  getOrgScopedClientMock.mockReset();
  sendStatementMessageMock.mockReset();
});

describe("dunning open-scan — flag gate + fan-out", () => {
  it("no-ops every tenant when collections.dunning is OFF", async () => {
    listActiveOrgIdsMock.mockResolvedValue(["org-a", "org-b"]);
    isFeatureEnabledMock.mockResolvedValue(false);
    const stats = await runDunningOpenScan();
    expect(stats).toEqual({ candidates: 0, opened: 0 });
    expect(isFeatureEnabledMock).toHaveBeenCalledWith(
      "collections.dunning",
      "org-a",
    );
    expect(getOrgScopedClientMock).not.toHaveBeenCalled();
  });

  it("does nothing with no active tenants", async () => {
    listActiveOrgIdsMock.mockResolvedValue([]);
    isFeatureEnabledMock.mockResolvedValue(true);
    const stats = await runDunningOpenScan();
    expect(stats).toEqual({ candidates: 0, opened: 0 });
  });
});

describe("dunning tick — flag gate (no sends when OFF)", () => {
  it("never reaches the statement send path when the flag is OFF", async () => {
    listActiveOrgIdsMock.mockResolvedValue(["org-a"]);
    isFeatureEnabledMock.mockResolvedValue(false);
    const stats = await runDunningTick();
    expect(stats.processed).toBe(0);
    expect(stats.sent).toBe(0);
    expect(getOrgScopedClientMock).not.toHaveBeenCalled();
    expect(sendStatementMessageMock).not.toHaveBeenCalled();
  });
});

// Bill-hold sweep: flag gate + multi-tenant fan-out.
//
// The full backfill/remind body runs against a real PostgREST surface in
// the integration suite; here we cover the safety-critical control flow:
// the feature-flag kill-switch and that the sweep fans out across active
// tenants (and no-ops cleanly when there are none).

import { describe, it, expect, vi, beforeEach } from "vitest";

const isFeatureEnabledMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));

const listActiveOrgIdsMock = vi.hoisted(() => vi.fn());
vi.mock("@workspace/resupply-db", () => ({
  listActiveOrgIds: listActiveOrgIdsMock,
  resolveSeedOrgId: vi.fn(),
  getOrgScopedClient: vi.fn(),
  getSupabaseServiceRoleClient: vi.fn(),
}));

import { runBillHoldSweep } from "./bill-hold-sweep";

beforeEach(() => {
  isFeatureEnabledMock.mockReset();
  listActiveOrgIdsMock.mockReset().mockResolvedValue([]);
});

describe("runBillHoldSweep — flag gate + fan-out", () => {
  it("skips (no fan-out) when the billing.bill_hold flag is OFF", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    const stats = await runBillHoldSweep();
    expect(stats.skipped).toBe(true);
    expect(isFeatureEnabledMock).toHaveBeenCalledWith("billing.bill_hold");
    // Must short-circuit before fanning out / touching the DB.
    expect(listActiveOrgIdsMock).not.toHaveBeenCalled();
  });

  it("fans out over active tenants when the flag is ON", async () => {
    isFeatureEnabledMock.mockResolvedValue(true);
    listActiveOrgIdsMock.mockResolvedValue([]); // no tenants → no-op body
    const stats = await runBillHoldSweep();
    expect(stats.skipped).toBe(false);
    expect(listActiveOrgIdsMock).toHaveBeenCalled();
  });
});

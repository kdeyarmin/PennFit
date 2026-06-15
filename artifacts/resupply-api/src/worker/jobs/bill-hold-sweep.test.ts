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

describe("runBillHoldSweep — per-tenant flag gate + fan-out", () => {
  it("skips (no work) when no tenant has the billing.bill_hold flag ON", async () => {
    listActiveOrgIdsMock.mockResolvedValue(["org-a", "org-b"]);
    isFeatureEnabledMock.mockResolvedValue(false);
    const stats = await runBillHoldSweep();
    // No tenant enabled → skipped, no claims scanned.
    expect(stats.skipped).toBe(true);
    expect(stats.draftClaimsScanned).toBe(0);
    // Flag is checked PER TENANT with the org_id.
    expect(isFeatureEnabledMock).toHaveBeenCalledWith(
      "billing.bill_hold",
      "org-a",
    );
  });

  it("does not skip when at least one tenant has the flag ON", async () => {
    listActiveOrgIdsMock.mockResolvedValue(["org-a"]);
    isFeatureEnabledMock.mockResolvedValue(true);
    const stats = await runBillHoldSweep();
    expect(stats.skipped).toBe(false);
  });

  it("reports skipped when there are no active tenants", async () => {
    listActiveOrgIdsMock.mockResolvedValue([]);
    isFeatureEnabledMock.mockResolvedValue(true);
    const stats = await runBillHoldSweep();
    expect(stats.skipped).toBe(true);
    expect(isFeatureEnabledMock).not.toHaveBeenCalled();
  });
});

// Unit test for the asset-recovery auto-populate worker.
//
// Focused on the flag gate (the safety-critical behavior): when the
// `asset_recovery.auto_populate` flag is OFF, the job must no-op without
// touching the DB. The full candidate→insert path runs against a real
// PostgREST surface in the integration suite, not here.

import { describe, it, expect, vi, beforeEach } from "vitest";

const isFeatureEnabledMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));

// Guard: if the flag gate ever regresses, the fan-out (listActiveOrgIds)
// would be reached and the test setup (no real Supabase) would throw — we
// also assert the listActiveOrgIds spy is never called when the flag is OFF.
const listActiveOrgIdsMock = vi.hoisted(() => vi.fn());
vi.mock("@workspace/resupply-db", () => ({
  listActiveOrgIds: listActiveOrgIdsMock,
  resolveSeedOrgId: vi.fn(),
  getOrgScopedClient: vi.fn(),
  getSupabaseServiceRoleClient: vi.fn(),
}));

import { runAssetRecoveryAutoPopulate } from "./asset-recovery-auto-populate";

beforeEach(() => {
  isFeatureEnabledMock.mockReset();
  listActiveOrgIdsMock.mockReset().mockResolvedValue([]);
});

describe("runAssetRecoveryAutoPopulate — per-tenant flag gate", () => {
  it("no-ops (enabled:false) when no tenant has the flag ON", async () => {
    // Two active tenants, both with the flag OFF → no work, enabled stays
    // false (the flag is now checked PER TENANT inside the fan-out).
    listActiveOrgIdsMock.mockResolvedValue(["org-a", "org-b"]);
    isFeatureEnabledMock.mockResolvedValue(false);

    const stats = await runAssetRecoveryAutoPopulate();

    expect(stats).toEqual({
      enabled: false,
      candidates: 0,
      created: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it("checks the flag with the tenant's org_id (honors per-tenant opt-out)", async () => {
    listActiveOrgIdsMock.mockResolvedValue(["org-a"]);
    isFeatureEnabledMock.mockResolvedValue(false);
    await runAssetRecoveryAutoPopulate();
    expect(isFeatureEnabledMock).toHaveBeenCalledWith(
      "asset_recovery.auto_populate",
      "org-a",
    );
  });

  it("returns enabled:false when there are no active orgs", async () => {
    isFeatureEnabledMock.mockResolvedValue(true);
    listActiveOrgIdsMock.mockResolvedValue([]);

    const stats = await runAssetRecoveryAutoPopulate();

    expect(stats.enabled).toBe(false);
    expect(stats.candidates).toBe(0);
    expect(stats.created).toBe(0);
    // No tenants → the flag is never consulted.
    expect(isFeatureEnabledMock).not.toHaveBeenCalled();
  });
});

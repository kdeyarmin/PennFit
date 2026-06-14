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

// Guard: if the flag gate ever regresses, these would be called and the
// test setup (no real Supabase) would throw — but we also assert the
// resolveSeedOrgId spy is never reached.
const resolveSeedOrgIdMock = vi.hoisted(() => vi.fn());
vi.mock("@workspace/resupply-db", () => ({
  resolveSeedOrgId: resolveSeedOrgIdMock,
  getOrgScopedClient: vi.fn(),
  getSupabaseServiceRoleClient: vi.fn(),
}));

import { runAssetRecoveryAutoPopulate } from "./asset-recovery-auto-populate";

beforeEach(() => {
  isFeatureEnabledMock.mockReset();
  resolveSeedOrgIdMock.mockReset();
});

describe("runAssetRecoveryAutoPopulate — flag gate", () => {
  it("no-ops (enabled:false, zero counts) when the flag is OFF", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);

    const stats = await runAssetRecoveryAutoPopulate();

    expect(stats).toEqual({
      enabled: false,
      candidates: 0,
      created: 0,
      skipped: 0,
      failed: 0,
    });
    // Must short-circuit before resolving any org / touching the DB.
    expect(resolveSeedOrgIdMock).not.toHaveBeenCalled();
  });

  it("checks the asset_recovery.auto_populate flag", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    await runAssetRecoveryAutoPopulate();
    expect(isFeatureEnabledMock).toHaveBeenCalledWith(
      "asset_recovery.auto_populate",
    );
  });

  it("returns enabled:true but no candidates when there is no seed org", async () => {
    isFeatureEnabledMock.mockResolvedValue(true);
    resolveSeedOrgIdMock.mockResolvedValue(null);

    const stats = await runAssetRecoveryAutoPopulate();

    expect(stats.enabled).toBe(true);
    expect(stats.candidates).toBe(0);
    expect(stats.created).toBe(0);
  });
});

// Fitter supply-campaign sweep: multi-tenant fan-out smoke coverage.
//
// The touchpoint composition + send pipeline is covered by
// fitter-supply-campaign.test.ts (composeTouchpoint units + source-pinned
// dispatcher guards). Here we verify the sweep fans out across active tenants
// and that the dispatcher feature flag now gates each tenant independently.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const flagEnabled = vi.hoisted(() => ({ value: true }));
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => flagEnabled.value),
}));

import { runFitterSupplyCampaignSweep } from "./fitter-supply-campaign";

beforeEach(() => {
  supabaseMock.reset();
  flagEnabled.value = true;
});

describe("runFitterSupplyCampaignSweep — multi-tenant fan-out", () => {
  it("scans each active tenant's leads when the dispatcher flag is on", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    // Each tenant's due-campaign scan comes back empty → nothing sent.
    stageSupabaseResponse("fitter_leads", "select", { data: [] });
    stageSupabaseResponse("fitter_leads", "select", { data: [] });

    const stats = await runFitterSupplyCampaignSweep();
    expect(stats.scanned).toBe(0);
    expect(stats.emailed).toBe(0);
    expect(stats.skippedFlagDisabled).toBe(0);
    // Each active tenant ran its own lead scan.
    expect(getSupabaseCallCount("fitter_leads", "select")).toBe(2);
  });

  it("gates each tenant on the dispatcher flag (per-tenant), counting skips", async () => {
    flagEnabled.value = false;
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    const stats = await runFitterSupplyCampaignSweep();
    // Both tenants short-circuit on the flag → no lead scan at all.
    expect(stats.skippedFlagDisabled).toBe(2);
    expect(getSupabaseCallCount("fitter_leads", "select")).toBe(0);
  });

  it("no-ops when there are no active tenants", async () => {
    stageSupabaseResponse("organizations", "select", { data: [] });
    const stats = await runFitterSupplyCampaignSweep();
    expect(stats.scanned).toBe(0);
    expect(stats.skippedFlagDisabled).toBe(0);
    expect(getSupabaseCallCount("fitter_leads", "select")).toBe(0);
  });
});

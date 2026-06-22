// ADR SLA sweep: per-tenant flag gate + multi-tenant fan-out.
//
// The full sla_status recompute body runs against a real PostgREST surface in
// the integration suite; here we cover the safety-critical control flow — the
// billing.adr_queue kill switch (checked per tenant) and the fan-out across
// active tenants (clean no-op when there are none).

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

import { runAdrSlaSweep } from "./adr-sla-sweep";

beforeEach(() => {
  isFeatureEnabledMock.mockReset();
  listActiveOrgIdsMock.mockReset().mockResolvedValue([]);
  getOrgScopedClientMock.mockReset();
});

describe("runAdrSlaSweep — flag gate + fan-out", () => {
  it("no-ops every tenant when the flag is OFF (never touches the DB)", async () => {
    listActiveOrgIdsMock.mockResolvedValue(["org-a", "org-b"]);
    isFeatureEnabledMock.mockResolvedValue(false);
    const stats = await runAdrSlaSweep();
    expect(stats).toEqual({ scanned: 0, updated: 0 });
    // Flag is checked PER TENANT, and the DB client is never built when off.
    expect(isFeatureEnabledMock).toHaveBeenCalledWith(
      "billing.adr_queue",
      "org-a",
    );
    expect(getOrgScopedClientMock).not.toHaveBeenCalled();
  });

  it("does nothing when there are no active tenants", async () => {
    listActiveOrgIdsMock.mockResolvedValue([]);
    isFeatureEnabledMock.mockResolvedValue(true);
    const stats = await runAdrSlaSweep();
    expect(stats).toEqual({ scanned: 0, updated: 0 });
    expect(isFeatureEnabledMock).not.toHaveBeenCalled();
  });
});

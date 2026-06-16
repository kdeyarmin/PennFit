// Quarterly therapy-summary sweep: multi-tenant fan-out smoke coverage.
//
// The per-patient gating + claim/send body is exercised end-to-end against
// a real PostgREST surface elsewhere; here we verify the sweep fans out
// across active tenants (one candidate read per tenant) and no-ops cleanly
// when there are none. The PER_RUN_MAX send budget is tracked per tenant
// (local `sentThisOrg` counter) so no tenant starves another.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { runQuarterlyTherapySummary } from "./quarterly-therapy-summary";

const ZERO = {
  candidates: 0,
  sent: 0,
  skippedNoData: 0,
  skippedOptedOut: 0,
  skippedNoShopCustomer: 0,
  failed: 0,
};

beforeEach(() => supabaseMock.reset());

describe("runQuarterlyTherapySummary — multi-tenant fan-out", () => {
  it("runs once per active tenant (empty candidate sets → zero sends)", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    // Each tenant's first candidate page comes back empty → the sweep
    // breaks immediately for that tenant.
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseResponse("patients", "select", { data: [] });

    const stats = await runQuarterlyTherapySummary();
    expect(stats).toEqual(ZERO);
    // Each active tenant read its own candidate queue.
    expect(getSupabaseCallCount("patients", "select")).toBe(2);
  });

  it("no-ops when there are no active tenants (no candidate read)", async () => {
    stageSupabaseResponse("organizations", "select", { data: [] });
    const stats = await runQuarterlyTherapySummary();
    expect(stats).toEqual(ZERO);
    expect(getSupabaseCallCount("patients", "select")).toBe(0);
  });
});

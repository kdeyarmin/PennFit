// Lapsed-customer win-back sweep: multi-tenant fan-out smoke coverage.
//
// The per-customer gating + claim/send body is exercised end-to-end against
// a real PostgREST surface elsewhere; here we verify the sweep fans out
// across active tenants (one candidate read per tenant) and no-ops cleanly
// when there are none. The per-tenant send cap is asserted by the unit on
// the local `sentThisOrg` counter (no shared starvation across tenants).

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { runLapsedCustomerWinback } from "./lapsed-customer-winback";

beforeEach(() => supabaseMock.reset());

describe("runLapsedCustomerWinback — multi-tenant fan-out", () => {
  it("runs once per active tenant (empty candidate sets → zero sends)", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    // Each tenant's first candidate page comes back empty → the sweep
    // breaks immediately for that tenant.
    stageSupabaseResponse("shop_customers", "select", { data: [] });
    stageSupabaseResponse("shop_customers", "select", { data: [] });

    const stats = await runLapsedCustomerWinback();
    expect(stats).toEqual({
      candidates: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
    });
    // Each active tenant read its own candidate queue.
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(2);
  });

  it("no-ops when there are no active tenants (no candidate read)", async () => {
    stageSupabaseResponse("organizations", "select", { data: [] });
    const stats = await runLapsedCustomerWinback();
    expect(stats).toEqual({
      candidates: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
    });
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(0);
  });
});

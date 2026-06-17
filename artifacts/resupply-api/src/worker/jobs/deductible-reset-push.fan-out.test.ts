// Deductible-reset push: multi-tenant fan-out smoke coverage.
//
// The per-customer gating + claim/send body is covered by the source-pinned
// guards in deductible-reset-push.test.ts and exercised against a real
// PostgREST surface elsewhere. Here we verify the sweep fans out across
// active tenants (one candidate read per tenant), no-ops cleanly when there
// are none, and short-circuits (without scanning any tenant) outside the
// November send window. The PER_RUN_MAX budget is tracked per tenant.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { runDeductibleResetPush } from "./deductible-reset-push";

// A date inside the November send window, and one outside it.
const IN_WINDOW = new Date("2026-11-15T12:00:00Z");
const OUT_OF_WINDOW = new Date("2026-06-15T12:00:00Z");

beforeEach(() => supabaseMock.reset());

describe("runDeductibleResetPush — multi-tenant fan-out", () => {
  it("runs once per active tenant (empty candidate sets → zero sends)", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    // Each tenant's first candidate page is empty → the sweep breaks for it.
    stageSupabaseResponse("shop_customers", "select", { data: [] });
    stageSupabaseResponse("shop_customers", "select", { data: [] });

    const stats = await runDeductibleResetPush(IN_WINDOW);
    expect(stats).toMatchObject({
      candidates: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      outOfWindow: false,
    });
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(2);
  });

  it("no-ops when there are no active tenants (no candidate read)", async () => {
    stageSupabaseResponse("organizations", "select", { data: [] });
    const stats = await runDeductibleResetPush(IN_WINDOW);
    expect(stats.outOfWindow).toBe(false);
    expect(stats.candidates).toBe(0);
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(0);
  });

  it("short-circuits outside the November window without scanning any tenant", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    const stats = await runDeductibleResetPush(OUT_OF_WINDOW);
    expect(stats.outOfWindow).toBe(true);
    // The fan-out is never entered: no tenant enumeration, no candidate read.
    expect(getSupabaseCallCount("organizations", "select")).toBe(0);
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(0);
  });
});

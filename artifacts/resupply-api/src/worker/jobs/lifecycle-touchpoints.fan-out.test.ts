// Lifecycle-touchpoints sweep: multi-tenant fan-out smoke coverage.
//
// The birthday + sleep-anniversary passes (claim/send, opt-in gate, the
// patients_with_therapy_anniversary RPC) are pinned by
// lifecycle-touchpoints.test.ts. Here we verify the sweep fans out across
// active tenants (each runs its own birthday scan + anniversary RPC) and
// no-ops cleanly when there are none. Each pass's PER_KIND_MAX cap is
// tracked per tenant (local counters) so no tenant starves another.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  stageSupabaseRpcResponse,
  getSupabaseCallCount,
  getSupabaseRpcCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { runLifecycleTouchpoints } from "./lifecycle-touchpoints";

const ZERO = {
  birthdayCandidates: 0,
  birthdaySent: 0,
  birthdayFailed: 0,
  anniversaryCandidates: 0,
  anniversarySent: 0,
  anniversaryFailed: 0,
  skippedOptedOut: 0,
  skippedNoShopCustomer: 0,
};

beforeEach(() => supabaseMock.reset());

describe("runLifecycleTouchpoints — multi-tenant fan-out", () => {
  it("runs both passes once per active tenant (empty sets → zero sends)", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    // Per tenant: an empty birthday candidate page + an empty anniversary
    // RPC result → both passes no-op for that tenant.
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseRpcResponse("patients_with_therapy_anniversary", { data: [] });
    stageSupabaseRpcResponse("patients_with_therapy_anniversary", { data: [] });

    const stats = await runLifecycleTouchpoints(
      new Date("2026-06-16T12:00:00Z"),
    );
    expect(stats).toEqual(ZERO);
    // Each active tenant ran its own birthday scan + anniversary RPC.
    expect(getSupabaseCallCount("patients", "select")).toBe(2);
    expect(getSupabaseRpcCallCount("patients_with_therapy_anniversary")).toBe(
      2,
    );
  });

  it("no-ops when there are no active tenants (no scans at all)", async () => {
    stageSupabaseResponse("organizations", "select", { data: [] });
    const stats = await runLifecycleTouchpoints(
      new Date("2026-06-16T12:00:00Z"),
    );
    expect(stats).toEqual(ZERO);
    expect(getSupabaseCallCount("patients", "select")).toBe(0);
    expect(getSupabaseRpcCallCount("patients_with_therapy_anniversary")).toBe(
      0,
    );
  });
});

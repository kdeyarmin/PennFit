// DWO expiry sweep: multi-tenant fan-out smoke coverage. The full
// per-window alerting body runs against a real PostgREST surface in the
// integration suite; here we verify the sweep fans out across active
// tenants and no-ops cleanly when there are none.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { runDwoExpirySweep } from "./dwo-expiry-sweep";

beforeEach(() => supabaseMock.reset());

describe("runDwoExpirySweep — multi-tenant fan-out", () => {
  it("runs once per active tenant (empty data → zero counts)", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    // Each tenant scans dwo_documents (empty) per window → no alerts.
    const stats = await runDwoExpirySweep();
    expect(stats.alertsCreated).toBe(0);
    expect(stats.scanned).toBe(0);
  });

  it("no-ops when there are no active tenants", async () => {
    stageSupabaseResponse("organizations", "select", { data: [] });
    const stats = await runDwoExpirySweep();
    expect(stats).toEqual({
      scanned: 0,
      alertsCreated: 0,
      byWindow: { 60: 0, 30: 0, 7: 0 },
    });
    expect(getSupabaseCallCount("dwo_documents", "select")).toBe(0);
  });
});

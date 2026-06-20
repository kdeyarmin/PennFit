// Outreach-playbook tick: multi-tenant fan-out smoke coverage.
//
// The per-step send pipeline runs against a real PostgREST surface
// elsewhere. Here we verify the sweep fans out across active tenants (each
// scans its own due runs) and that the dispatcher flag gates each tenant
// independently.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const flagEnabled = vi.hoisted(() => ({ value: true }));
vi.mock("../../lib/feature-flags.js", () => ({
  isFeatureEnabled: vi.fn(async () => flagEnabled.value),
}));

import { runOutreachPlaybookSweep } from "./outreach-playbook-tick";

const NOW = new Date("2026-06-16T17:00:00Z");

beforeEach(() => {
  supabaseMock.reset();
  flagEnabled.value = true;
});

describe("runOutreachPlaybookSweep — multi-tenant fan-out", () => {
  it("scans each active tenant's due runs when the dispatcher flag is on", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    // Each tenant's due-run scan comes back empty → nothing sent.
    stageSupabaseResponse("outreach_playbook_runs", "select", { data: [] });
    stageSupabaseResponse("outreach_playbook_runs", "select", { data: [] });

    const stats = await runOutreachPlaybookSweep(NOW);
    expect(stats.scanned).toBe(0);
    expect(stats.flagDisabled).toBe(false);
    // Each active tenant ran its own due-run scan.
    expect(getSupabaseCallCount("outreach_playbook_runs", "select")).toBe(2);
  });

  it("gates each tenant on the dispatcher flag (per-tenant)", async () => {
    flagEnabled.value = false;
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    const stats = await runOutreachPlaybookSweep(NOW);
    expect(stats.flagDisabled).toBe(true);
    // Both tenants short-circuit on the flag → no due-run scan.
    expect(getSupabaseCallCount("outreach_playbook_runs", "select")).toBe(0);
  });

  it("no-ops when there are no active tenants", async () => {
    stageSupabaseResponse("organizations", "select", { data: [] });
    const stats = await runOutreachPlaybookSweep(NOW);
    expect(stats.scanned).toBe(0);
    expect(stats.flagDisabled).toBe(false);
    expect(getSupabaseCallCount("outreach_playbook_runs", "select")).toBe(0);
  });
});

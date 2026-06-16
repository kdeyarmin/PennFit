// Therapy-milestones sweep: multi-tenant fan-out smoke coverage.
//
// The evaluate/insert + claim/send body is pinned by
// therapy-milestones.test.ts (source guards) and exercised against a real
// PostgREST surface elsewhere. Here we verify the sweep fans out across
// active tenants (each runs its own night-activity scan) and no-ops
// cleanly when there are none.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { runTherapyMilestones } from "./therapy-milestones";

const ZERO = {
  patientsScanned: 0,
  inserted: { "100_nights": 0, "365_nights": 0, first_adherence_month: 0 },
  sent: 0,
  sendSkipped: 0,
  sendFailed: 0,
};

beforeEach(() => supabaseMock.reset());

describe("runTherapyMilestones — multi-tenant fan-out", () => {
  it("runs once per active tenant (empty night data → nothing inserted/sent)", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    // Unstaged reads default to an empty result, so each tenant's
    // night-activity scan + pending-milestone send both no-op.
    const stats = await runTherapyMilestones();
    expect(stats).toEqual(ZERO);
    // Each active tenant ran its own night-activity scan.
    expect(getSupabaseCallCount("patient_therapy_nights", "select")).toBe(2);
  });

  it("no-ops when there are no active tenants (no scan at all)", async () => {
    stageSupabaseResponse("organizations", "select", { data: [] });
    const stats = await runTherapyMilestones();
    expect(stats).toEqual(ZERO);
    expect(getSupabaseCallCount("patient_therapy_nights", "select")).toBe(0);
  });

  it("SUMS patientsScanned across tenants (does not overwrite per tenant)", async () => {
    // Regression guard: the per-tenant body accumulates into the shared
    // stats, so patientsScanned must use += not =. Each tenant's activity
    // scan returns one distinct patient that ALREADY holds all milestone
    // kinds — so the body skips the per-patient night reads (which would
    // otherwise consume the next tenant's staged scan data from the shared
    // mock queue) and inserts/sends nothing. The total scanned must be 2,
    // not 1 (the last tenant's count overwriting the first).
    const allKinds = (pid: string) => ({
      data: [
        { patient_id: pid, milestone_kind: "100_nights" },
        { patient_id: pid, milestone_kind: "365_nights" },
        { patient_id: pid, milestone_kind: "first_adherence_month" },
      ],
    });
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    // org-a: activity scan → existing-milestones (all kinds) → pending send
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [{ patient_id: "pa" }],
    });
    stageSupabaseResponse(
      "patient_therapy_milestones",
      "select",
      allKinds("pa"),
    );
    stageSupabaseResponse("patient_therapy_milestones", "select", { data: [] });
    // org-b: same shape
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [{ patient_id: "pb" }],
    });
    stageSupabaseResponse(
      "patient_therapy_milestones",
      "select",
      allKinds("pb"),
    );
    stageSupabaseResponse("patient_therapy_milestones", "select", { data: [] });

    const stats = await runTherapyMilestones();
    expect(stats.patientsScanned).toBe(2);
    expect(stats.sent).toBe(0);
    expect(stats.inserted).toEqual({
      "100_nights": 0,
      "365_nights": 0,
      first_adherence_month: 0,
    });
  });
});

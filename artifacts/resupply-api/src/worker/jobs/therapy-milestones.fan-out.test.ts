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
});

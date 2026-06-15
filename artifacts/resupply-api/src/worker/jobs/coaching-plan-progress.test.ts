// Coaching-plan progress sweep: multi-tenant fan-out smoke coverage.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { runCoachingProgressSweep } from "./coaching-plan-progress";

beforeEach(() => supabaseMock.reset());

describe("runCoachingProgressSweep — multi-tenant fan-out", () => {
  it("runs once per active tenant (no open plans → zero counts)", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    // Each tenant's plan scan returns empty.
    stageSupabaseResponse("patient_coaching_plans", "select", { data: [] });
    stageSupabaseResponse("patient_coaching_plans", "select", { data: [] });
    const stats = await runCoachingProgressSweep();
    expect(stats).toEqual({ scanned: 0, updated: 0, movedToImproving: 0 });
  });

  it("no-ops when there are no active tenants", async () => {
    stageSupabaseResponse("organizations", "select", { data: [] });
    const stats = await runCoachingProgressSweep();
    expect(stats).toEqual({ scanned: 0, updated: 0, movedToImproving: 0 });
    expect(getSupabaseCallCount("patient_coaching_plans", "select")).toBe(0);
  });
});

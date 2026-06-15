// Prescription-request auto-draft: env kill-switch + multi-tenant fan-out.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { runPrescriptionRequestAutoDraft } from "./prescription-request-auto-draft";

const ENV_FLAG = "RESUPPLY_PRESCRIPTION_AUTO_DRAFT_ENABLED";

beforeEach(() => supabaseMock.reset());

describe("runPrescriptionRequestAutoDraft — env gate + fan-out", () => {
  it("skips (no DB access) when the env flag is off", async () => {
    vi.stubEnv(ENV_FLAG, "");
    const stats = await runPrescriptionRequestAutoDraft();
    expect(stats.drafted).toBe(0);
    expect(getSupabaseCallCount("organizations", "select")).toBe(0);
    vi.unstubAllEnvs();
  });

  it("fans out over active tenants when the flag is on", async () => {
    vi.stubEnv(ENV_FLAG, "1");
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    // Each tenant's candidate scan returns empty → no drafts.
    stageSupabaseResponse("prescriptions", "select", { data: [] });
    stageSupabaseResponse("prescriptions", "select", { data: [] });
    const stats = await runPrescriptionRequestAutoDraft();
    expect(stats.drafted).toBe(0);
    vi.unstubAllEnvs();
  });
});

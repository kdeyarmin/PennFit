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

describe("runPrescriptionRequestAutoDraft — diagnosis outcome classification", () => {
  // These two outcomes look alike from the worker's seat and mean opposite
  // things to whoever reads the daily numbers: one is "N patients need a
  // sleep study attached", the other is "the database was unhappy". Nothing
  // covered the split, so a regression could quietly move either into the
  // wrong bucket while every test stayed green.
  function stageOneCandidate() {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }],
    });
    stageSupabaseResponse("prescriptions", "select", {
      data: [
        {
          id: "rx-1",
          patient_id: "p-1",
          provider_id: "prov-1",
          hcpcs_code: "E0601",
          valid_until: "2026-09-01",
        },
      ],
    });
    // Cooldown lookup: nothing recent.
    stageSupabaseResponse("prescription_request_packets", "select", {
      data: [],
    });
    // The builder re-reads the prescription for itself.
    stageSupabaseResponse("prescriptions", "select", {
      data: {
        id: "rx-1",
        patient_id: "p-1",
        provider_id: "prov-1",
        hcpcs_code: "E0601",
        item_sku: "CPAP device",
        cadence_days: 90,
        valid_until: "2026-09-01",
      },
    });
  }

  it("counts a missing diagnosis as skipped_no_diagnosis, not failed", async () => {
    vi.stubEnv(ENV_FLAG, "1");
    stageOneCandidate();
    stageSupabaseResponse("sleep_studies", "select", { data: null });

    const stats = await runPrescriptionRequestAutoDraft();
    expect(stats.skipped_no_diagnosis).toBe(1);
    expect(stats.failed).toBe(0);
    expect(stats.drafted).toBe(0);
    vi.unstubAllEnvs();
  });

  it("counts a diagnosis LOOKUP FAILURE as failed, not skipped", async () => {
    vi.stubEnv(ENV_FLAG, "1");
    stageOneCandidate();
    stageSupabaseResponse("sleep_studies", "select", {
      data: null,
      error: { message: "connection failure" },
    });

    const stats = await runPrescriptionRequestAutoDraft();
    expect(stats.failed).toBe(1);
    expect(stats.skipped_no_diagnosis).toBe(0);
    expect(stats.drafted).toBe(0);
    vi.unstubAllEnvs();
  });
});

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
